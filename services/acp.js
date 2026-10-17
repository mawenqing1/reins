/* ============================================================
   ACP（Agent Client Protocol）客户端 —— 架构照抄 HiFox 的适配器模式
   ------------------------------------------------------------
   把各家 Agent 统一成一套会话协议（ndjson JSON-RPC over stdio）：
   - initialize → session/new → session/prompt → session/update 流 → stopReason
   - 结构化权限请求（session/request_permission）按策略自动应答，不再猜各家 CLI 的 permission flag
   - 会话可取消（session/cancel）、可扩展 resume/fork（后续）
   已验证协议源：codebuddy 家族原生 --acp（ndJsonStream）；HiFox 的
   zcode-acp/codex-acp/claude-agent-acp 适配器（同方法集）。
   ============================================================ */

const { spawn } = require('child_process');

/* 从权限选项里挑放行项：优先 allow_once（本次放行，不沉淀策略），无 allow 项则拒绝 */
const pickAllowOption = options => {
  const opts = Array.isArray(options) ? options : [];
  return opts.find(o => o && o.kind === 'allow_once')
    || opts.find(o => o && String(o.kind || '').includes('allow'))
    || opts.find(o => o && o.kind === 'reject_once')
    || opts[0];
};

const fmtUpdate = u => {
  if (!u || typeof u !== 'object') return null;
  switch (u.sessionUpdate) {
    case 'agent_message_chunk':
      return u.content && u.content.type === 'text' && u.content.text ? { delta: u.content.text } : null;
    case 'tool_call':
      return { note: '⚙ ' + (u.title || u.kind || 'tool') + (u.kind && u.kind !== 'other' ? '（' + u.kind + '）' : '') };
    case 'tool_call_update': {
      if (!u.content) return null;
      const t = u.content.text || (u.content.type === 'diff' ? '[diff]' : '');
      return t ? { note: '  ↳ ' + String(t).slice(0, 120).replace(/\n/g, ' ') } : null;
    }
    case 'current_mode_update':
      return u.mode && u.mode.name ? { note: '◂ 模式切换：' + u.mode.name } : null;
    default:
      return null; // plan / user_message_chunk / available_commands_update 等暂不上屏
  }
};

/* 执行一次 ACP 会话任务。opts：{cmd, args, env, prompt, promptFallback, resumeSessionId, cwd, onEvent, timeoutMs, onSpawn}
   事件流与 runCliTask 对齐：start/delta/note/model/done/error，done 携带 worktree 改动清单。
   会话恢复（第八轮）：resumeSessionId 有值且引擎声明 loadSession 能力时先 session/load 续旧会话
   （codebuddy 实测：load 成功后沿用旧 sessionId，引擎侧记忆延续）；失败则开新会话并用
   promptFallback（全量历史重放）兜底 */
function runAcpTask(opts) {
  const { cmd, args = [], env = null, prompt, promptFallback = null, resumeSessionId = null, cwd, onEvent, timeoutMs = 600000, onSpawn } = opts;
  return new Promise(resolve => {
    const child = spawn(cmd, args, {
      cwd: cwd || undefined,
      env: Object.assign({}, process.env, env || {}, { NO_COLOR: '1' }),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    if (onSpawn) onSpawn(child);
    let buf = '', nextId = 1, sessionId = null, resultText = '', resumed = false, finished = false;
    const pending = new Map(); // id → {res, rej}
    const req = (method, params) => new Promise((res, rej) => {
      const id = nextId++;
      pending.set(id, { res, rej });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
    const notify = (method, params) => { try { child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n'); } catch (e) { } };
    const respond = (id, result) => { try { child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n'); } catch (e) { } };
    let errTail = '';
    const finish = evt => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (evt.type === 'done' && cwd) evt.changes = worktreeChangesSafe(cwd);
      onEvent(evt);
      resolve();
    };
    const timer = setTimeout(() => {
      try { if (sessionId) notify('session/cancel', { sessionId, reason: 'timeout' }); } catch (e) { }
      setTimeout(() => { try { child.kill('SIGKILL'); } catch (e) { } }, 500);
      // 超时≠零产出：引擎往往已完成交付只是收尾迟缓（REINS-126 前端阶段实证：报告已输出仍被掐）。
      // 已积累的会话文本随 partial 带上、附 worktree 改动，上层可判定按完成推进
      finish({
        type: 'error', message: 'ACP 执行超时（' + Math.round(timeoutMs / 1000) + 's），已终止会话',
        acpSessionId: sessionId || null,
        partial: resultText.trim() || null,
        worktree: cwd || null,
        changes: cwd ? worktreeChangesSafe(cwd) : null,
      });
    }, timeoutMs);

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', d => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let m = null;
        try { m = JSON.parse(line); } catch (e) { continue; }
        handleMsg(m);
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', d => { errTail = (errTail + d).slice(-400); });
    child.on('error', e => finish({ type: 'error', message: 'ACP 进程启动失败：' + e.message }));
    child.on('close', code => {
      if (code === 0) finish({ type: 'done', result: resultText.trim() || '（无输出）', usage: null, worktree: cwd || null, acpSessionId: sessionId || null, resumed });
      else finish({ type: 'error', message: 'ACP 进程退出码 ' + code + (errTail ? '：' + errTail.slice(-200).replace(/\n/g, ' ') : ''), acpSessionId: sessionId || null });
    });

    function handleMsg(m) {
      // 服务端 → 客户端请求（权限请求 / 未知请求）
      if (m && m.id !== undefined && m.method) {
        if (m.method === 'session/request_permission') {
          const opt = pickAllowOption(m.params && m.params.options);
          respond(m.id, { outcome: { outcome: 'selected', optionId: opt ? opt.optionId : '' } });
          onEvent({ type: 'note', text: '🔓 已放行：' + ((m.params && m.params.permissionRequest && (m.params.permissionRequest.title || m.params.permissionRequest.kind)) || '权限请求') });
        } else {
          respond(m.id, {}); // 协议留白请求一律空应答，不阻断会话
        }
        return;
      }
      // 服务端通知：会话更新流
      if (m && m.method === 'session/update') {
        const f = fmtUpdate(m.params && m.params.update);
        if (f) {
          if (f.delta) { resultText += f.delta; onEvent({ type: 'delta', text: f.delta }); }
          else onEvent({ type: 'note', text: f.note });
        }
        return;
      }
      // 我们请求的应答
      if (m && m.id !== undefined && pending.has(m.id)) {
        const p = pending.get(m.id);
        pending.delete(m.id);
        if (m.error) p.rej(new Error(m.error.message || JSON.stringify(m.error)));
        else p.res(m.result);
      }
    }

    (async () => {
      try {
        const init = await req('initialize', {
          protocolVersion: 1,
          clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
          authMethods: [],
        });
        const agentName = (init && init.agentInfo && init.agentInfo.name) || 'agent';
        const capLoad = !!(init && init.agentCapabilities && init.agentCapabilities.loadSession);
        onEvent({ type: 'note', text: '✓ ACP 握手成功：' + agentName + ' · protocol v' + ((init && init.protocolVersion) || '?') });

        // 会话恢复：优先续旧会话（引擎侧记忆延续，只发最新要求）；失败/不支持则开新会话全量重放
        let effPrompt = prompt;
        if (resumeSessionId && capLoad) {
          try {
            await req('session/load', { sessionId: resumeSessionId, cwd: cwd || process.cwd(), mcpServers: [] });
            sessionId = resumeSessionId;   // codebuddy 实测：load 不返回新 id，沿用旧 sessionId
            resumed = true;
            onEvent({ type: 'note', text: '↻ 已恢复此前会话（' + String(resumeSessionId).slice(0, 13) + '…），上下文延续，不重喂历史' });
          } catch (e) {
            onEvent({ type: 'note', text: '⚠ 会话恢复失败（' + String(e.message || '').slice(0, 90) + '），已开新会话重放历史' });
          }
        } else if (resumeSessionId && !capLoad) {
          onEvent({ type: 'note', text: '⚠ 该引擎不支持会话恢复（未声明 loadSession），已开新会话' });
        }
        if (!sessionId) {
          if (resumed === false && resumeSessionId && promptFallback) effPrompt = promptFallback;   // 恢复落空 → 全量历史重放
          const s = await req('session/new', { cwd: cwd || process.cwd(), mcpServers: [] });
          sessionId = s && s.sessionId;
          const modeName = s && s.modes && s.modes[0] && s.modes[0].name;
          if (modeName) onEvent({ type: 'model', model: modeName, final: true });
        }
        if (sessionId) onEvent({ type: 'note', text: '🔗 会话锚点 ' + sessionId + (resumed ? '（已恢复）' : '') });

        const r = await req('session/prompt', { sessionId, prompt: [{ type: 'text', text: effPrompt }] });
        notify('session/close', { sessionId });
        finish({
          type: 'done',
          result: resultText.trim() || ('（会话结束 · stopReason=' + ((r && r.stopReason) || '?') + '）'),
          usage: null, worktree: cwd || null,
          acpSessionId: sessionId || null, resumed,
        });
        setTimeout(() => { try { child.kill('SIGTERM'); } catch (e) { } }, 300);
      } catch (e) {
        try { if (sessionId) notify('session/cancel', { sessionId, reason: 'error' }); } catch (x) { }
        finish({ type: 'error', message: 'ACP 会话失败：' + e.message + (errTail ? '｜stderr: ' + errTail.slice(-160).replace(/\n/g, ' ') : ''), acpSessionId: sessionId || null });
        setTimeout(() => { try { child.kill('SIGTERM'); } catch (x) { } }, 300);
      }
    })();
  });
}

/* 与 runner.worktreeChanges 同构（避免循环依赖，这里独立实现一份轻量版） */
function worktreeChangesSafe(cwd) {
  if (!cwd) return null;
  try {
    const out = require('child_process').execSync('git status --porcelain', { cwd, encoding: 'utf8', timeout: 5000 });
    return out.split('\n').map(l => l.trim()).filter(Boolean).slice(0, 100);
  } catch (e) { return null; }
}

module.exports = { runAcpTask, pickAllowOption };
