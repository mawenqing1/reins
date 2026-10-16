/* ============================================================
   Reins — 真实 Agent 执行引擎
   通过 OpenAI 兼容协议（/chat/completions, SSE 流式）调用
   用户自备的模型服务（GLM / DeepSeek / Kimi / Qwen / OpenAI / 自定义）
   ============================================================ */

const PROVIDERS = {
  glm:     { label: '智谱 GLM',    baseURL: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4.7' },
  deepseek:{ label: 'DeepSeek',    baseURL: 'https://api.deepseek.com/v1',           model: 'deepseek-chat' },
  kimi:    { label: '月之暗面 Kimi', baseURL: 'https://api.moonshot.cn/v1',          model: 'moonshot-v1-32k' },
  qwen:    { label: '阿里通义',     baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
  openai:  { label: 'OpenAI',      baseURL: 'https://api.openai.com/v1',             model: 'gpt-4o-mini' },
  custom:  { label: '自定义（OpenAI 兼容）', baseURL: '',                              model: '' },
};

const aborts = new Map();   // taskId -> AbortController

/* 部分服务的 WAF 会按 TLS 指纹丢弃 Node 自带 fetch 的握手（表现为 connect timeout 而 curl 正常）。
   Electron 主进程优先用 net.fetch（Chromium 网络栈，浏览器级指纹），纯 Node 环境回退原生 fetch */
let _netFetch = null;
try { _netFetch = require('electron').net.fetch; } catch (e) { }
const pfetch = (...a) => (_netFetch || global.fetch)(...a);

function buildMessages(task, extraPrompt, scenePrompt) {
  const sys = [
    '你是团队任务看板中的执行 Agent。你收到一张任务卡片，请直接执行并给出交付物。',
    '要求：',
    '- 先给交付物本体（正文/方案/代码/结论，用 Markdown），再附不超过 5 行的执行说明。',
    '- 不要客套、不要复述任务；信息不足时做合理假设并注明「假设：…」。',
    '- 中文任务用中文交付。'
  ].join('\n');
  if (scenePrompt) sys += '\n【场景/角色设定】\n' + scenePrompt;
  const card = [
    `【任务】${task.key} · ${task.title}`,
    `【类型】${task.type}　【优先级】${task.pri}`,
    task.desc ? `【描述/验收标准】\n${task.desc}` : '【描述/验收标准】（无，按标题理解执行）',
    extraPrompt ? `【团队提示词】\n${extraPrompt}` : '',
  ].filter(Boolean).join('\n\n');

  const msgs = [{ role: 'system', content: sys }];
  // 打回重做：带上历史对话与用户反馈
  if (Array.isArray(task.thread) && task.thread.length) {
    msgs.push(...task.thread.map(m => ({ role: m.role, content: m.content })));
    msgs.push({ role: 'user', content: card + '\n\n（以上是此前对话。这是新一轮执行，请按最新要求给出完整交付物。）' });
  } else {
    msgs.push({ role: 'user', content: card });
  }
  return msgs;
}

/* 流式执行一个任务；onEvent(evt) 回调：
   {type:'start',...} {type:'delta',text} {type:'usage',usage}
   {type:'done',result,usage} {type:'error',message} {type:'cancelled'} */
async function runTask(task, agent, extraPrompt, onEvent, opts = {}) {
  if (agent.mode === 'cli') return runCliTask(task, agent, extraPrompt, onEvent, opts.repoRoot);
  const provider = PROVIDERS[agent.provider] || PROVIDERS.custom;
  const baseURL = (agent.baseURL || provider.baseURL).replace(/\/+$/, '');
  const model = agent.model || provider.model;
  const key = agent.apiKey || '';
  if (!baseURL || !key) { onEvent({ type: 'error', message: '未配置 baseURL 或 API Key，请在「设置 → 模型与密钥」补全。' }); return; }

  const ac = new AbortController();
  aborts.set(task.id, ac);
  onEvent({ type: 'start', model, provider: provider.label, baseURL });

  try {
    const resp = await fetch(baseURL + '/chat/completions', {
      method: 'POST',
      signal: ac.signal,
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
      body: JSON.stringify({
        model,
        messages: buildMessages(task, extraPrompt, agent.scenePrompt),
        stream: true,
        stream_options: { include_usage: true },
        temperature: 0.6,
        max_tokens: 4096,
      }),
    });
    if (!resp.ok || !resp.body) {
      const text = await resp.text().catch(() => '');
      throw new Error(`HTTP ${resp.status} ${text.slice(0, 300)}`);
    }

    let result = '';
    let usage = null;
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() || '';
      for (const line of lines) {
        const s = line.trim();
        if (!s.startsWith('data:')) continue;
        const payload = s.slice(5).trim();
        if (payload === '[DONE]') continue;
        let json;
        try { json = JSON.parse(payload); } catch (e) { continue; }
        if (json.usage) usage = json.usage;
        const delta = json.choices?.[0]?.delta?.content;
        if (delta) { result += delta; onEvent({ type: 'delta', text: delta }); }
      }
    }
    if (!result && usage) result = '（模型未返回内容）';
    onEvent({ type: 'done', result, usage });
  } catch (e) {
    if (e.name === 'AbortError' || ac.signal.aborted) onEvent({ type: 'cancelled' });
    else onEvent({ type: 'error', message: e.message });
  } finally {
    aborts.delete(task.id);
  }
}

function cancelTask(taskId) {
  const ac = aborts.get(taskId);
  if (ac) { ac.abort(); return true; }
  return false;
}

/* 连通性测试：发一个极小请求 */
async function testAgent(agent) {
  const provider = PROVIDERS[agent.provider] || PROVIDERS.custom;
  const baseURL = (agent.baseURL || provider.baseURL).replace(/\/+$/, '');
  const model = agent.model || provider.model;
  if (!baseURL || !agent.apiKey) return { ok: false, message: '未配置 baseURL 或 API Key' };
  try {
    const resp = await fetch(baseURL + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + agent.apiKey },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'ping，请回复 pong' }], max_tokens: 8 }),
    });
    if (!resp.ok) return { ok: false, message: `HTTP ${resp.status}：` + (await resp.text().catch(() => '')).slice(0, 200) };
    const data = await resp.json();
    const content = data.choices?.[0]?.message?.content || '';
    return { ok: true, message: `${model} 连接成功：${content.trim().slice(0, 20) || 'ok'}`, usage: data.usage };
  } catch (e) { return { ok: false, message: e.message }; }
}

/* AI 分诊：让 API Agent 对单个任务给出 类型/优先级/经办 建议（一次性调用，严格 JSON） */
async function triageTask(task, agent, roster) {
  const provider = PROVIDERS[agent.provider] || PROVIDERS.custom;
  const baseURL = (agent.baseURL || provider.baseURL).replace(/\/+$/, '');
  const model = agent.model || provider.model;
  const key = agent.apiKey || '';
  if (!baseURL || !key) return { ok: false, message: '未配置 baseURL 或 API Key' };
  const sys = [
    '你是团队任务分诊助手。根据任务信息判断类型与优先级，并从给出的名单中挑选最合适的经办人。',
    '只输出一个 JSON 对象，不要任何其他文字、不要代码块标记。格式：',
    '{"type":"req|bug|support|test|chore|research|writing|data","pri":"P0|P1|P2","assignee":{"kind":"agent|human|null","id":"Agent的id或null","name":"名字或null"},"reason":"一句话理由"}',
    '选不出合适经办人时 assignee 用 {"kind":"null","id":null,"name":null}。理由用中文。',
  ].join('\n');
  const agentList = (roster.agents || []).map(a => `◆${a.name}（id=${a.id}${a.mode === 'api' ? '，API 模型' : a.mode === 'cli' ? '，本机 CLI' : '，演示引擎'}）`).join('；') || '无';
  const memberList = (roster.members || []).join('、') || '无';
  const card = [
    `【任务】${task.key} · ${task.title}`,
    `【当前标记】类型 ${task.type}　优先级 ${task.pri}`,
    task.desc ? `【描述】\n${task.desc}` : '【描述】（无）',
    `【可选经办】Agent：${agentList}。团队成员：${memberList}。`,
  ].join('\n\n');
  try {
    const resp = await fetch(baseURL + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
      body: JSON.stringify({ model, messages: [{ role: 'system', content: sys }, { role: 'user', content: card }], temperature: 0.2, max_tokens: 300 }),
    });
    if (!resp.ok) return { ok: false, message: `HTTP ${resp.status}：` + (await resp.text().catch(() => '')).slice(0, 150) };
    const data = await resp.json();
    let raw = String(data.choices?.[0]?.message?.content || '').trim();
    raw = raw.replace(/^```(json)?\s*/i, '').replace(/```\s*$/, '').trim();
    const m = raw.match(/\{[\s\S]*\}/);
    const sug = JSON.parse(m ? m[0] : raw);
    const TYPES = ['req', 'bug', 'support', 'test', 'chore', 'research', 'writing', 'data'];
    const asg = sug.assignee;
    return {
      ok: true,
      suggestion: {
        type: TYPES.includes(sug.type) ? sug.type : 'chore',
        pri: ['P0', 'P1', 'P2'].includes(sug.pri) ? sug.pri : 'P2',
        assignee: asg && asg.kind === 'agent' && asg.id ? { kind: 'agent', id: String(asg.id), name: String(asg.name || '') }
          : asg && asg.kind === 'human' && asg.name ? { kind: 'human', name: String(asg.name) } : null,
        reason: String(sug.reason || '').slice(0, 120),
      },
      engine: model, usage: data.usage || null,
    };
  } catch (e) { return { ok: false, message: e.message }; }
}

/* ---------- Jev 决策模型（System One：state + 类型化问题 → 结构化判断 + 概率，用于分诊等高频判别） ---------- */
const JEV_TYPES = {
  req: '新功能、接口、页面、配置类开发需求',
  bug: '报错、异常、崩溃、数据丢失等需要修复的缺陷',
  support: '客户咨询、工单、投诉、售后回复',
  test: '测试用例、回归、冒烟、端到端验证',
  chore: '无明显专业特征的琐碎整理、杂务',
  research: '调研、竞品分析、行业研究、信息收集',
  writing: '文案、文章、初稿、周报等内容创作',
  data: '数据清洗、整理、核对、表格处理',
};
async function callJev(cfg, state, questions) {
  const url = String(cfg.jevUrl || 'https://api.typesafe.ai/v1/systemone').trim().replace(/\/+$/, '');
  if (!cfg.jevKey) return { ok: false, message: '未配置 Jev API Key' };
  if (!/^https?:\/\//.test(url)) return { ok: false, message: 'Jev 地址需以 http:// 或 https:// 开头' };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const resp = await pfetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + cfg.jevKey },
      body: JSON.stringify({ state, model: cfg.jevModel || 'jev-latest', questions }),
      signal: ctrl.signal,
    });
    if (!resp.ok) return { ok: false, message: `HTTP ${resp.status}：` + (await resp.text().catch(() => '')).slice(0, 150) };
    const data = await resp.json();
    if (!data || !data.answers) return { ok: false, message: '响应缺少 answers 字段，请确认接入地址正确' };
    return { ok: true, data };
  } catch (e) { return { ok: false, message: e.name === 'AbortError' ? '超时（15s）' : (e.message + (e.cause && e.cause.code ? '（' + e.cause.code + '）' : '')) }; }
  finally { clearTimeout(timer); }
}
async function triageJev(task, roster, cfg) {
  const agents = ((roster && roster.agents) || []).slice(0, 200);
  const members = ((roster && roster.members) || []).slice(0, Math.max(0, 240 - agents.length));
  const cand = { none: '以上都不合适，保持未指派待人工处理' };
  const idx = {};
  agents.forEach(a => { const k = 'a' + a.id; cand[k] = `${a.name}（${a.mode === 'api' ? 'API 模型' : a.mode === 'cli' ? '本机 CLI' : '演示引擎'}）`; idx[k] = { kind: 'agent', id: a.id, name: a.name }; });
  members.forEach(n => { const k = 'm' + n; cand[k] = `${n}（团队成员）`; idx[k] = { kind: 'human', name: n }; });
  const state = [
    `【任务】${task.key} · ${task.title}`,
    `【当前标记】类型 ${task.type}　优先级 ${task.pri}`,
    task.desc ? `【描述】\n${task.desc}` : '【描述】（无）',
    `【候选经办】${Object.keys(cand).filter(k => k !== 'none').map(k => cand[k]).join('、') || '无'}`,
  ].join('\n\n');
  const r = await callJev(cfg, state, {
    type: { type: 'choice', instructions: '判断这条任务的所属类型', criteria: JEV_TYPES },
    pri: { type: 'choice', instructions: '判断处理优先级', criteria: { P0: '线上事故、紧急、需立即处理', P1: '重要或有明确时限，应尽快安排', P2: '常规事项，按正常排期处理' } },
    assignee: { type: 'choice', instructions: '从候选人中挑选最合适的经办人', criteria: cand },
  });
  if (!r.ok) return r;
  const ans = r.data.answers;
  const type = Object.keys(JEV_TYPES).includes(ans.type && ans.type.choice) ? ans.type.choice : 'chore';
  const pri = ['P0', 'P1', 'P2'].includes(ans.pri && ans.pri.choice) ? ans.pri.choice : 'P2';
  const ak = ans.assignee && ans.assignee.choice;
  const assignee = idx[ak] ? { ...idx[ak] } : null;
  const pct = v => Math.round((Number(v) || 0) * 100);
  const reason = `决策概率：类型 ${type} ${pct(ans.type?.probabilities?.[type])}% · 优先级 ${pri} ${pct(ans.pri?.probabilities?.[pri])}% · 经办 ${assignee ? assignee.name : '待指派'} ${pct(ans.assignee?.probabilities?.[ak])}%`.slice(0, 150);
  return {
    ok: true,
    suggestion: { type, pri, assignee, reason },
    engine: r.data.model || cfg.jevModel || 'jev-latest',
    usage: r.data.usage ? { total_tokens: (r.data.usage.input_tokens || 0) + (r.data.usage.output_tokens || 0) } : null,
  };
}
async function testJev(cfg) {
  const r = await callJev(cfg, '这是一条来自 Reins的连通性测试消息。', {
    ping: { type: 'noul', instructions: '这句话表达了一个测试断言' },
  });
  if (!r.ok) return r;
  const mdl = r.data.model || cfg.jevModel || 'jev';
  const brand = /startlux/i.test(mdl) ? 'StartLux' : /^jev/i.test(mdl) ? 'Jev' : '决策引擎';
  const p = r.data.answers?.ping?.noul;
  return { ok: true, message: `${brand} 连接成功（${mdl}）· 测试断言概率 ${typeof p === 'number' ? Math.round(p * 1000) / 1000 : 'ok'}` };
}

module.exports = { PROVIDERS, runTask, runCloudTask, cancelTask, testAgent, triageTask, triageJev, testJev };

/* ============================================================
   本机 CLI Agent 执行（Claude Code / Codex / CodeBuddy …）
   通过命令模板 {prompt} 占位，spawn 子进程并流式读取 stdout
   ============================================================ */
const { spawn, spawnSync } = require('child_process');
const os = require('os');

const CLI_PRESETS = [
  { id: 'claude-code', label: 'Claude Code', cmd: 'claude', template: 'claude -p {prompt} --output-format text' },
  { id: 'codex', label: 'Codex CLI', cmd: 'codex', template: 'codex exec --skip-git-repo-check {prompt}' },
  { id: 'codebuddy', label: '腾讯 CodeBuddy Code', cmd: 'codebuddy', template: 'codebuddy -y -p {prompt} --output-format text', streamJson: true },
  { id: 'workbuddy', label: '腾讯 WorkBuddy', cmd: 'workbuddy', template: 'workbuddy -y -p {prompt} --output-format text' },
  { id: 'zcode', label: 'ZCode', cmd: 'zcode', template: 'zcode -p {prompt} --no-color' },
  { id: 'opencode', label: 'OpenCode', cmd: 'opencode', template: 'opencode run {prompt}' },
  { id: 'gemini-cli', label: 'Gemini CLI', cmd: 'gemini', template: 'gemini {prompt}' },
  { id: 'cursor-cli', label: 'Cursor CLI', cmd: 'cursor-agent', template: 'cursor-agent {prompt}' },
  { id: 'qwen-code', label: 'Qwen Code', cmd: 'qwen', template: 'qwen {prompt}' },
  { id: 'copilot', label: 'GitHub Copilot CLI', cmd: 'copilot', template: 'copilot -p {prompt}' },
  { id: 'droid', label: 'Droid', cmd: 'droid', template: 'droid {prompt}' },
  { id: 'amp', label: 'Amp', cmd: 'amp', template: 'amp {prompt}' },
  { id: 'openclaw', label: 'OpenClaw', cmd: 'openclaw', template: 'openclaw {prompt}' },
  { id: 'cline', label: 'Cline', cmd: 'cline', template: 'cline {prompt}' },
  { id: 'goose', label: 'Goose', cmd: 'goose', template: 'goose run {prompt}' },
  { id: 'grok', label: 'Grok CLI', cmd: 'grok', template: 'grok {prompt}' },
  { id: 'kimi-cli', label: 'Kimi CLI', cmd: 'kimi', template: 'kimi -p {prompt}' },
  { id: 'kilo', label: 'Kilo Code', cmd: 'kilo', template: 'kilo {prompt}' },
  { id: 'kiro', label: 'Kiro', cmd: 'kiro', template: 'kiro {prompt}' },
  { id: 'trae', label: 'Trae', cmd: 'trae', template: 'trae {prompt}' },
  { id: 'qoder', label: 'Qoder', cmd: 'qoder', template: 'qoder {prompt}' },
  { id: 'auggie', label: 'Auggie', cmd: 'auggie', template: 'auggie {prompt}' },
  { id: 'qwenpaw', label: 'QwenPaw', cmd: 'qwenpaw', template: 'qwenpaw {prompt}' },
  { id: 'hermes', label: 'Hermes', cmd: 'hermes', template: 'hermes {prompt}' },
  { id: 'pi', label: 'Pi', cmd: 'pi', template: 'pi {prompt}' },
];

/* 已验证无头模式支持 --model 的 CLI（codebuddy 0.16 系实测：--model <id>，含 glm/kimi/hunyuan/minimax/deepseek 全家） */
const CLI_MODEL_FLAG = { codebuddy: '--model', workbuddy: '--model' };
const cliModelArgs = agent => {
  const flag = CLI_MODEL_FLAG[agent.cliId];
  const m = String(agent.cliModel || '').trim();
  return flag && m ? [flag, m] : [];
};
const cliRunLabel = (cmd, agent) => cmd + (String(agent.cliModel || '').trim() ? ' · ' + String(agent.cliModel).trim() : '');

// GUI 进程 PATH 常缺 homebrew 等用户目录，登录 shell 取一次补齐
let fixedPath = null;
function loginPath() {
  if (fixedPath) return fixedPath;
  try {
    const shell = process.env.SHELL || '/bin/zsh';
    const r = spawnSync(shell, ['-ilc', 'echo $PATH'], { encoding: 'utf8', timeout: 8000 });
    if (r.stdout) fixedPath = r.stdout.trim();
  } catch (e) { }
  return fixedPath;
}
function detectClis(cmds) {
  const pathEnv = loginPath() ? loginPath() + ':' + (process.env.PATH || '') : process.env.PATH;
  const found = {};
  for (const c of cmds) {
    try {
      const r = spawnSync('/bin/sh', ['-c', 'command -v ' + JSON.stringify(c)], { encoding: 'utf8', timeout: 5000, env: { ...process.env, PATH: pathEnv } });
      found[c] = r.status === 0 && !!r.stdout.trim();
    } catch (e) { found[c] = false; }
  }
  return found;
}

function buildCliPrompt(task, extraPrompt, scenePrompt) {
  const parts = [];
  parts.push(`【任务】${task.key} · ${task.title}\n【类型】${task.type}　【优先级】${task.pri}`);
  if (task.desc) parts.push(`【描述/验收标准】\n${task.desc}`);
  if (scenePrompt) parts.push(`【场景要求】\n${scenePrompt}`);
  if (extraPrompt) parts.push(`【团队提示词】\n${extraPrompt}`);
  parts.push('【工作方式】直接动手：在当前工作目录里把任务真正做完——创建/修改代码、文档、配置文件，需要时运行命令验证。不要只写说明文字，不要把成果只放在回复里。');
  if (Array.isArray(task.thread) && task.thread.length) {
    parts.push('【此前对话】\n' + task.thread.map(m => (m.role === 'user' ? '用户: ' : 'Agent: ') + m.content).join('\n---\n'));
    parts.push('（以上是此前对话，请按最新反馈继续实际修改文件并完成交付。）');
  }
  parts.push('【完成后输出】改动报告：逐个列出你创建/修改的文件路径 + 一句话说明改了什么；如有运行验证，附上结果。除此之外不要多余解释。');
  return parts.join('\n\n');
}

/* CLI 家族（codebuddy/zcode 等）要求 node ≥18.20，而系统 PATH 可能只有旧版或垫片丢失——
   给子进程固定垫一个可用 node 目录（优先 18–23：兼容 zcode bundle；其次任意 ≥18），缓存一次 */
let _bestNodeDir;
function bestNodeDir() {
  if (_bestNodeDir !== undefined) return _bestNodeDir;
  _bestNodeDir = '';
  const path = require('path'), fs = require('fs'), os = require('os');
  const cands = [];
  try {
    const base = path.join(os.homedir(), '.workbuddy/binaries/node/versions');
    for (const d of fs.readdirSync(base).sort().reverse()) cands.push(path.join(base, d, 'bin'));
  } catch (e) { }
  cands.push('/opt/homebrew/bin', '/usr/local/bin');
  for (const dir of cands) {
    try {
      const v = require('child_process').execFileSync(path.join(dir, 'node'), ['--version'], { encoding: 'utf8', timeout: 3000 }).trim();
      const major = Number((v.match(/^v(\d+)/) || [])[1] || 0);
      if (major >= 18 && major <= 23) { _bestNodeDir = dir; break; }  // 18–23 全兼容
      if (major >= 18 && !_bestNodeDir) _bestNodeDir = dir;           // 兜底 ≥18（zcode 启动器会自选）
    } catch (e) { }
  }
  return _bestNodeDir;
}

/* 执行后收集真实文件改动（worktree 内 git status），作为"实质进展"凭证随 done 事件带回 */
function worktreeChanges(cwd) {
  if (!cwd) return null;
  try {
    const out = require('child_process').execSync('git status --porcelain', { cwd, encoding: 'utf8', timeout: 5000 });
    return out.split('\n').map(l => l.trim()).filter(Boolean).map(l => ({
      flag: l.slice(0, 2).trim(),
      file: l.slice(3).trim().replace(/^"|"$/g, ''),
    })).slice(0, 100);
  } catch (e) { return null; }
}

/* 把 CLI 事件流（stream-json NDJSON 帧）翻译成人能读的执行过程日志行；返回 null 表示该帧不上屏
   只展示两类信息：工具调用（执行流）与模型叙述文本；thinking/system/快照等噪声全部略过 */
function fmtCliFrame(j) {
  if (!j || typeof j !== 'object') return null;
  if (j.type === 'system' || j.type === 'file-history-snapshot' || j.type === 'result') return null;
  if (j.type === 'user') {
    const arr = Array.isArray(j.message?.content) ? j.message.content : [];
    const errs = arr.filter(b => b.type === 'tool_result' && b.is_error);
    if (!errs.length) return null; // 工具正常返回不上屏，出错才报
    const txt = errs.map(b => (typeof b.content === 'string' ? b.content : JSON.stringify(b.content))).join(' ').slice(0, 160);
    return '  ↳ 出错 ' + txt.replace(/\n/g, ' ');
  }
  if (j.type === 'assistant') {
    const arr = Array.isArray(j.message?.content) ? j.message.content : [];
    const lines = [];
    for (const b of arr) {
      if (b.type === 'tool_use') {
        const inp = b.input || {};
        const f = String(inp.file_path || inp.path || inp.notebook_path || '');
        const base = f.replace(/^.*\//, '');
        let arg;
        if (/^(Bash|PowerShell)$/.test(b.name)) arg = String(inp.command || '').replace(/\n/g, ' ').slice(0, 90);
        else if (b.name === 'Grep' || b.name === 'Glob') arg = String(inp.pattern || '');
        else if (b.name === 'WebFetch') arg = String(inp.url || '');
        else if (b.name === 'WebSearch') arg = String(inp.query || '');
        else if (base) arg = base;
        else arg = JSON.stringify(inp).slice(0, 70);
        lines.push('⚙ ' + b.name + (arg ? '  ' + arg : ''));
      } else if (b.type === 'text' && b.text && b.text.trim()) {
        lines.push(b.text.trim());
      }
    }
    return lines.length ? lines.join('\n') : null;
  }
  return null;
}


async function runCliTask(task, agent, extraPrompt, onEvent, repoRoot) {
  const preset = CLI_PRESETS.find(p => p.id === agent.cliId) || { cmd: agent.cliCommand || 'echo', template: '{prompt}' };
  const template = agent.cliTemplate || preset.template;
  if (!template.includes('{prompt}')) { onEvent({ type: 'error', message: '命令模板缺少 {prompt} 占位符' }); return; }
  const [head, tail = ''] = template.split('{prompt}');
  const argv = head.trim().split(/\s+/).filter(Boolean);
  const prompt = buildCliPrompt(task, extraPrompt, agent.scenePrompt);
  let args = [...argv.slice(1), prompt, ...tail.trim().split(/\s+/).filter(Boolean), ...cliModelArgs(agent)];
  const cmd = argv[0] || preset.cmd;
  // 事件流模式：CLI 输出 NDJSON 帧而非纯文本，主进程逐帧翻译成实时执行日志（模板自带的 --output-format 一律剥掉）
  const streamJson = preset.streamJson === true;
  if (streamJson) {
    args = args.filter((a, i) => a !== '--output-format' && args[i - 1] !== '--output-format');
    args.push('--output-format', 'stream-json');
  }

  const env = { ...process.env };
  const lp = loginPath();
  const nd = bestNodeDir();
  env.PATH = [nd, lp].filter(Boolean).join(':') + ':' + (env.PATH || '');

  onEvent({ type: 'start', model: cliRunLabel(cmd, agent) + (streamJson ? '（本机 CLI · 过程实时回传）' : '（本机 CLI）'), provider: '本机命令', cli: true });
  onEvent({ type: 'model', model: String(agent.cliModel || '').trim() || '默认模型' });

  // 隔离执行：空间配置了仓库根目录时，为任务准备独立 worktree（分支 reins/<KEY>），CLI 在其中改动互不干扰
  // 安全规则：配置了仓库但 worktree 准备失败 → 中止执行，绝不退化到应用目录裸跑；未配置仓库 → 落到独立临时目录
  let cwd = null;
  if (repoRoot) {
    cwd = prepareWorktree(repoRoot, task.key, line => onEvent({ type: 'note', text: line }));
    if (!cwd) {
      onEvent({ type: 'error', message: '隔离工作区准备失败，已中止执行（避免 Agent 误改其他目录）。请检查仓库状态：' + repoRoot });
      return;
    }
  } else {
    cwd = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'reins-run-'));
    onEvent({ type: 'note', text: '⚠ 空间未配置代码仓库，本次在临时目录执行：' + cwd });
  }

  // IDE 派发型 CLI（如 buddycn）：启动 IDE 会话后不退出、stdout 不回传——存活即视为派发成功
  const presetObj = CLI_PRESETS.find(p => p.id === agent.cliId) || {};
  const ideLaunch = presetObj.ideLaunch || agent.cliCommand === 'buddycn';
  const child = spawn(cmd, args, {
    env, cwd: cwd || undefined, detached: ideLaunch,
    // stdin 必须关闭：CLI 型 Agent 会探测 stdin，保持打开的管道会让它一直等待输入
    stdio: ideLaunch ? 'ignore' : ['ignore', 'pipe', 'pipe'],
  });
  const ac = new AbortController();
  aborts.set(task.id, { abort: () => { try { child.kill('SIGTERM'); } catch (e) { } } });

  if (ideLaunch) {
    await new Promise(resolve => {
      const t = setTimeout(() => {
        // 6 秒仍存活：IDE 已带着提示词打开会话
        onEvent({ type: 'note', text: '✓ 已在 CodeBuddy IDE 中打开会话（IDE 模式：执行在 IDE 内进行）' });
        onEvent({ type: 'done', result: '【IDE 派发】任务提示词已在 CodeBuddy IDE 中打开（工作目录' + (cwd ? '：' + cwd : '为本机默认') + '）。请在 IDE 中查看与接管执行；此模式不回传输出，请在完成后手动验收。', usage: null, worktree: cwd || null });
        try { child.unref(); } catch (e) { }
        resolve();
      }, 6000);
      child.on('error', e => { clearTimeout(t); onEvent({ type: 'error', message: '无法启动 ' + cmd + '：' + e.message + '（CodeBuddy 未安装或 CLI 未链接？命令应在 ~/.codebuddy/bin）' }); resolve(); });
      child.on('close', code => {
        clearTimeout(t);
        if (code === 0) {
          // VS Code 式启动器：把会话交给已运行的 IDE 后自身退出，码 0 即派发成功
          onEvent({ type: 'note', text: '✓ 已在 CodeBuddy IDE 中打开会话（IDE 模式：执行在 IDE 内进行）' });
          onEvent({ type: 'done', result: '【IDE 派发】任务提示词已在 CodeBuddy IDE 中打开（工作目录' + (cwd ? '：' + cwd : '为本机默认') + '）。请在 IDE 中查看与接管执行；此模式不回传输出，请在完成后手动验收。', usage: null, worktree: cwd || null });
        } else {
          onEvent({ type: 'error', message: cmd + ' 启动失败（退出码 ' + code + '），请检查 CodeBuddy 登录状态' });
        }
        resolve();
      });
    });
    aborts.delete(task.id);
    return;
  }

  let out = '';
  let errTail = '';
  let buf = '';
  let sawInit = false;      // 首个 system/init 帧含真实模型，只取一次
  let finalResult = null;   // result 帧的干净交付文本
  let resultError = false;
  let resultAt = 0;         // result 帧到达时间：事件流模式下进程可能因 MCP/后台任务滞留，宽限后主动收尾
  await new Promise(resolve => {
    let finished = false;
    const finish = fn => { if (!finished) { finished = true; clearInterval(linger); fn(); resolve(); } };
    const linger = setInterval(() => {
      if (resultAt && Date.now() - resultAt > 8000) { try { child.kill('SIGTERM'); } catch (e) { } resultAt = 0; }
    }, 2000);
    if (streamJson) {
      child.stdout.on('data', d => {
        buf += d.toString();
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (!line) continue;
          let j = null;
          try { j = JSON.parse(line); } catch (e) { }
          if (!j) { out += line + '\n'; onEvent({ type: 'delta', text: line + '\n' }); continue; }
          // init 帧带着本次会话真实使用的模型（连默认模型都能识别），第一时间上报给界面
          if (j.type === 'system' && j.subtype === 'init' && j.model && !sawInit) {
            sawInit = true;
            onEvent({ type: 'model', model: String(j.model), final: true });
            onEvent({ type: 'note', text: '▸ 执行模型 ' + j.model + ' · 会话已建立' });
            continue;
          }
          if (j.type === 'result') {
            finalResult = typeof j.result === 'string' ? j.result : String(j.result ?? '');
            if (j.is_error) resultError = true;
            resultAt = Date.now();
            continue;
          }
          const f = fmtCliFrame(j);
          if (f) { out += f + '\n'; onEvent({ type: 'delta', text: f + '\n' }); }
        }
      });
    } else {
      child.stdout.on('data', d => { const s = d.toString(); out += s; onEvent({ type: 'delta', text: s }); });
    }
    child.stderr.on('data', d => { errTail = (errTail + d.toString()).slice(-500); }); // stderr 不计入交付物，仅用于排错
    child.on('error', e => finish(() => onEvent({ type: 'error', message: '无法启动命令 ' + cmd + '：' + e.message + '（本机未安装？可在配置中修改命令）' })));
    child.on('close', code => finish(() => {
      if (resultError) onEvent({ type: 'error', message: (finalResult || '执行失败').slice(0, 300) });
      else if (code !== 0 && !out && finalResult === null) onEvent({ type: 'error', message: cmd + ' 退出码 ' + code + (errTail ? '：' + errTail.slice(-200) : '') });
      else onEvent({ type: 'done', result: (finalResult !== null ? finalResult : out.trim()) || '（无输出）', usage: null, worktree: cwd || null, changes: worktreeChanges(cwd) });
    }));
  });
  aborts.delete(task.id);
}

/* 在 <仓库>/../.reins-wt/<任务KEY> 创建（或复用）worktree + 分支 reins/<KEY>；
   返回工作目录路径，失败时回报原因并返回 null（退化为当前目录直接执行） */
function prepareWorktree(repoRoot, key, note) {
  try {
    const fs = require('fs');
    const path = require('path');
    const git = (...a) => spawnSync('git', ['-C', repoRoot, ...a], { encoding: 'utf8', timeout: 20000 });

    const chk = git('rev-parse', '--is-inside-work-tree');
    if (!chk || chk.status !== 0 || String(chk.stdout || '').trim() !== 'true') {
      note('⚠ ' + repoRoot + ' 不是 git 仓库，无法创建隔离工作区');
      return null;
    }
    const wtRoot = path.join(repoRoot, '..', '.reins-wt');
    const wt = path.join(wtRoot, key);
    git('worktree', 'prune'); // 清理目录已不存在但注册仍在的陈旧 worktree（否则 add 会失败）
    if (fs.existsSync(wt)) {
      note('↻ 复用隔离工作区 .reins-wt/' + key + '（分支 reins/' + key + '）');
      return wt;
    }
    fs.mkdirSync(wtRoot, { recursive: true });
    let r = git('worktree', 'add', '-b', 'reins/' + key, wt);
    if (r.status !== 0) {
      // 分支已存在（历史任务遗留）：直接按既有分支挂载，不重置
      r = git('worktree', 'add', wt, 'reins/' + key);
      if (r.status !== 0) { note('⚠ 无法创建 worktree：' + String(r.stderr || '').trim().slice(0, 140)); return null; }
      note('✓ 挂载既有分支 reins/' + key);
    } else {
      note('✓ 已创建隔离工作区 .reins-wt/' + key + '（新分支 reins/' + key + '）');
    }
    const nm = path.join(repoRoot, 'node_modules');
    if (fs.existsSync(nm) && !fs.existsSync(path.join(wt, 'node_modules'))) {
      try { fs.symlinkSync(nm, path.join(wt, 'node_modules'), 'dir'); note('✓ 已链接 node_modules（免重装依赖）'); } catch (e) { }
    }
    return wt;
  } catch (e) {
    note('⚠ 工作区准备异常：' + e.message + '，改为直接执行');
    return null;
  }
}
/* ---------- 云端执行：派发到远端节点（reins-node/server.js） ---------- */
async function runCloudTask(task, agent, extraPrompt, onEvent, opts = {}) {
  const cfg = opts.cloud || {};
  const base = String(cfg.url || '').replace(/\/+$/, '');
  if (!base || !cfg.token) { onEvent({ type: 'error', message: '未配置云端节点地址或令牌（设置 → 云端节点）' }); return; }
  const auth = { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + cfg.token };

  const preset = CLI_PRESETS.find(p => p.id === agent.cliId) || { cmd: agent.cliCommand || 'echo', template: '{prompt}' };
  const template = agent.cliTemplate || preset.template;
  const [head, tail = ''] = template.split('{prompt}');
  const argv = head.trim().split(/\s+/).filter(Boolean);
  const prompt = buildCliPrompt(task, extraPrompt, agent.scenePrompt);
  const args = [...argv.slice(1), prompt, ...tail.trim().split(/\s+/).filter(Boolean), ...cliModelArgs(agent)];
  const cmd = argv[0] || preset.cmd;
  const runId = task.id + '-' + Date.now();

  onEvent({ type: 'start', model: cliRunLabel(cmd, agent) + '（云端节点' + (cfg.name ? ' ' + cfg.name : '') + '）', provider: '云端执行', cli: true, cloud: true });

  let resp;
  try {
    resp = await fetch(base + '/run', { method: 'POST', headers: auth, body: JSON.stringify({ runId, taskKey: task.key, cmd, args, repoRoot: opts.repoRoot || '', timeoutMs: 20 * 60 * 1000 }) });
  } catch (e) { onEvent({ type: 'error', message: '云端节点连接失败：' + e.message }); return; }
  if (!resp.ok) { onEvent({ type: 'error', message: '云端节点拒绝派发：HTTP ' + resp.status + ' ' + (await resp.text().catch(() => '')).slice(0, 120) }); return; }

  aborts.set(task.id, { abort: () => { fetch(base + '/run/' + encodeURIComponent(runId) + '/cancel', { method: 'POST', headers: auth }).catch(() => { }); } });

  let out = '', errTail = '';
  try {
    const es = await fetch(base + '/run/' + encodeURIComponent(runId) + '/events', { headers: auth });
    if (!es.ok || !es.body) throw new Error('HTTP ' + es.status);
    const reader = es.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, idx); buf = buf.slice(idx + 2);
        const line = chunk.split('\n').find(l => l.startsWith('data: '));
        if (!line) continue;
        let ev; try { ev = JSON.parse(line.slice(6)); } catch (e) { continue; }
        if (ev.t === 'out') { out += ev.text; onEvent({ type: 'delta', text: ev.text }); }
        else if (ev.t === 'note') onEvent({ type: 'note', text: '[云端] ' + ev.text });
        else if (ev.t === 'err') errTail = (errTail + ev.text).slice(-500);
        else if (ev.t === 'killed') { onEvent({ type: 'cancelled' }); aborts.delete(task.id); return; }
        else if (ev.t === 'done') {
          if (ev.code !== 0 && !out && ev.error) onEvent({ type: 'error', message: '云端执行失败：' + ev.error });
          else if (ev.code !== 0 && !out) onEvent({ type: 'error', message: cmd + ' 云端退出码 ' + ev.code + (errTail ? '：' + errTail.slice(-200) : '') });
          else onEvent({ type: 'done', result: out.trim() || '（无输出）', usage: null, worktree: ev.worktree || null });
          aborts.delete(task.id);
          return;
        }
      }
    }
    onEvent({ type: 'error', message: '云端事件流中断（任务可能仍在节点上执行）' });
  } catch (e) { onEvent({ type: 'error', message: '云端事件流失败：' + e.message }); }
  aborts.delete(task.id);
}

module.exports.CLI_PRESETS = CLI_PRESETS;
module.exports.detectClis = detectClis;
