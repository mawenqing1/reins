/* ============================================================
   Reins — Git 远程操作：任务分支推送 + Pull Request 创建
   ------------------------------------------------------------
   交付闭环补齐：Agent 在隔离 worktree（reins/<KEY> 分支）完成拟议变更并
   应用回宿主仓库后，可直接推送到远程并开 PR，无需用户切终端手工操作。
   - 远程识别：origin 的 https / git@ / ssh:// 三种写法，解析出托管平台与仓库坐标
   - 推送：git push --set-upstream；认证/网络/非快进等常见失败给出可操作中文指引
   - PR：GitHub（REST /pulls）与 Gitee（API v5 /pulls）两种托管；
     令牌从设置 gitTokens[provider] 取，请求复用共享 HTTP 层（超时+重试）
   - 重复开 PR（422 已存在）自动找回既有 PR 链接返回，不当错误报
   ============================================================ */
const { spawnSync } = require('child_process');
const { fetchWithRetry } = require('./http');

/* ---------- 远程仓库识别 ---------- */
/* https://github.com/o/r(.git) / git@github.com:o/r.git / ssh://git@github.com/o/r(.git) / ssh://gitee.com/o/r(.git) */
function parseRemoteUrl(url) {
  const s = String(url || '').trim();
  if (!s) return null;
  let host = '', slug = '';
  let m = s.match(/^(?:https?:\/\/|git\+ssh:\/\/|ssh:\/\/)?([^\/@]+)@([^:\/]+)[:\/](.+?)(?:\.git)?\/?$/);
  if (m) { host = m[2]; slug = m[3]; }
  else {
    m = s.match(/^(?:https?:\/\/|git\+https:\/\/|ssh:\/\/)([^\/]+)\/(.+?)(?:\.git)?\/?$/);
    if (m) { host = m[1]; slug = m[2]; }
  }
  if (!host || !slug || !/^[^\/]+\/[^\/]+$/.test(slug)) return null;
  const h = host.toLowerCase();
  const provider = /github/.test(h) ? 'github' : /gitee/.test(h) ? 'gitee' : 'other';
  return { host, slug, provider, url: s };
}

const gitAt = (cwd, ...args) => spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: 120000 });

function remoteInfo(cwd) {
  if (!cwd || typeof cwd !== 'string') return { ok: false, message: '缺少工作目录' };
  const r = gitAt(cwd, 'remote', 'get-url', 'origin');
  if (r.status !== 0) {
    return { ok: false, message: '未配置 origin 远程（git remote get-url origin 失败）：' + String(r.stderr || '').trim().slice(0, 160) };
  }
  const parsed = parseRemoteUrl(r.stdout);
  /* detached HEAD（游离头指针）时 abbrev-ref 输出字面量 'HEAD'，直接当分支名推送会得到
     不可读的 git 报错——标记 detached 并清空分支，由调用方/推送入口给出明确指引 */
  const br = gitAt(cwd, 'rev-parse', '--abbrev-ref', 'HEAD');
  const brName = br.status === 0 ? String(br.stdout || '').trim() : '';
  /* 远程默认分支：origin/HEAD 符号引用（克隆时 git 自动登记）；取不到回退 main */
  let defaultBranch = 'main';
  const sym = gitAt(cwd, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD');
  if (sym.status === 0 && String(sym.stdout || '').trim()) defaultBranch = String(sym.stdout).trim().replace(/^origin\//, '');
  return {
    ok: true,
    origin: parsed,
    branch: brName === 'HEAD' ? '' : brName,
    detached: brName === 'HEAD',
    defaultBranch,
    supported: parsed ? parsed.provider !== 'other' : false,
  };
}

/* ---------- 推送 ---------- */
/* 常见失败分类：给出下一步动作，而不是裸 stderr */
function classifyPushError(stderr, stdout) {
  const s = String(stderr || '') + '\n' + String(stdout || '');
  if (/Authentication failed|could not read [Cc]redentials|Permission denied \(publickey|403|terminal prompts disabled/i.test(s)) {
    return { kind: 'auth', hint: '远程认证失败：HTTPS 方式请在 git 凭据助手登录，或改用 SSH 远程（git@github.com:o/r.git）' };
  }
  if (/Could not resolve host|Connection (timed out|refused)|network|Step timed out|Failed to connect/i.test(s)) {
    return { kind: 'network', hint: '网络不通：检查代理/VPN，或远程地址拼写' };
  }
  if (/No configured push destinations|does not appear to be a git repository|No such remote/i.test(s)) {
    return { kind: 'noremote', hint: '该仓库没有可推送的 origin 远程：git remote add origin <地址> 后重试' };
  }
  if (/non-fast-forward|fetch first|behind the remote/i.test(s)) {
    return { kind: 'rejected', hint: '远程已有更新的提交（非快进）：先 git pull --rebase 再推送' };
  }
  if (/has no upstream|set-upstream/i.test(s)) return { kind: 'upstream', hint: '' };
  return { kind: 'unknown', hint: '' };
}

function pushBranch(cwd, opts) {
  const o = opts || {};
  if (!cwd) return { ok: false, message: '缺少工作目录' };
  const branch = String(o.branch || '').trim();
  if (branch === 'HEAD') return { ok: false, kind: 'detached', message: '推送失败：工作区处于 detached HEAD（游离头指针）状态，不在任何分支上。请先创建分支（git switch -c <分支名>）再推送' };
  if (!branch) return { ok: false, message: '缺少要推送的分支名' };
  const remote = String(o.remote || 'origin').trim();
  const r = spawnSync('git', ['-C', cwd, 'push', '--set-upstream', remote, branch], { encoding: 'utf8', timeout: 10 * 60 * 1000 });
  if (r.status === 0) {
    const info = remoteInfo(cwd);
    return { ok: true, branch, remote, origin: info.origin, message: '已推送 ' + branch + ' → ' + remote };
  }
  const cls = classifyPushError(r.stderr, r.stdout);
  return { ok: false, kind: cls.kind, message: '推送失败：' + (cls.hint || String(r.stderr || '').trim().slice(0, 240) || 'git 退出码 ' + r.status) };
}

/* ---------- PR 创建 ---------- */
/* 纯函数：按托管平台构造 PR 请求（单测不发出网络请求） */
function buildPRRequest(info, pr) {
  const origin = info.origin;
  const title = String(pr.title || '').slice(0, 300);
  const body = String(pr.body || '');
  const head = String(pr.head || '');
  const base = String(pr.base || info.defaultBranch || 'main');
  if (!origin || origin.provider === 'other') return { ok: false, message: '仅支持 GitHub / Gitee 托管的远程仓库' };
  if (!head) return { ok: false, message: '缺少 PR 来源分支（head）' };
  if (origin.provider === 'github') {
    return {
      ok: true, provider: 'github', slug: origin.slug, head, base, title, body,
      create: {
        url: 'https://api.github.com/repos/' + origin.slug + '/pulls',
        init: {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Accept': 'application/vnd.github+json', 'Authorization': 'Bearer ' + pr.token, 'User-Agent': 'Reins-PR/1.0' },
          body: JSON.stringify({ title, body, head, base }),
        },
      },
      existingUrl: 'https://api.github.com/repos/' + origin.slug + '/pulls?head=' + encodeURIComponent(origin.slug.split('/')[0] + ':' + head) + '&state=open',
    };
  }
  // Gitee API v5：令牌走 body 的 access_token（官方约定），字段名与 GitHub 略异
  return {
    ok: true, provider: 'gitee', slug: origin.slug, head, base, title, body,
    create: {
      url: 'https://gitee.com/api/v5/repos/' + origin.slug + '/pulls',
      init: {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': 'Reins-PR/1.0' },
        body: JSON.stringify({ access_token: pr.token, title, body, head, base }),
      },
    },
    existingUrl: 'https://gitee.com/api/v5/repos/' + origin.slug + '/pulls?head=' + encodeURIComponent(head) + '&state=open',
  };
}

async function createPR(input) {
  const pr = input || {};
  if (!pr.cwd) return { ok: false, message: '缺少工作目录' };
  const info = remoteInfo(pr.cwd);
  if (!info.ok) return { ok: false, message: info.message };
  const req = buildPRRequest(info, pr);
  if (!req.ok) return req;
  const token = pr.token || (pr.tokens && pr.tokens[req.provider]) || '';
  if (!token) {
    return { ok: false, message: '未配置 ' + (req.provider === 'github' ? 'GitHub' : 'Gitee') + ' 访问令牌：设置 → Git 远程 → 填入 PAT（需 repo 读写权限）' };
  }
  const resp = await fetchWithRetry(req.create.url, req.create.init, {
    timeoutMs: 30000, retries: 1,
    fetchImpl: pr.fetchImpl,
  }).catch(e => ({ __error: e }));
  if (resp && resp.__error) return { ok: false, message: 'PR 接口请求失败：' + resp.__error.message };
  if (resp.status === 201 || resp.status === 200) {
    const data = await resp.json().catch(() => null);
    const url = (data && (data.html_url || data.url)) || '';
    return { ok: true, number: data && data.number, url, provider: req.provider, exists: false };
  }
  const text = await resp.text().catch(() => '');
  /* 重复开 PR：GitHub 422 / Gitee 400 报 already exists → 找回既有 PR 链接按成功返回 */
  if ((resp.status === 422 || resp.status === 400) && /already exists/i.test(text)) {
    try {
      /* Gitee v5 私有仓库读取同样要求鉴权：查找请求须与创建用同一令牌（access_token 查询参数） */
      const exUrl = req.provider === 'gitee'
        ? req.existingUrl + '&access_token=' + encodeURIComponent(token)
        : req.existingUrl;
      const ex = await fetchWithRetry(exUrl, {
        headers: req.provider === 'github' ? { 'Authorization': 'Bearer ' + token, 'Accept': 'application/vnd.github+json', 'User-Agent': 'Reins-PR/1.0' } : { 'User-Agent': 'Reins-PR/1.0' },
      }, { timeoutMs: 30000, retries: 1, fetchImpl: pr.fetchImpl });
      if (ex.ok) {
        const list = await ex.json().catch(() => []);
        const hit = Array.isArray(list) && list[0];
        if (hit && hit.html_url) return { ok: true, number: hit.number, url: hit.html_url, provider: req.provider, exists: true };
      }
    } catch (e) { }
    return { ok: true, url: '', provider: req.provider, exists: true, message: '该分支已存在打开的 PR' };
  }
  if (resp.status === 401 || resp.status === 403) return { ok: false, message: '令牌无效或权限不足（HTTP ' + resp.status + '）：检查 PAT 是否有 repo 读写权限' };
  return { ok: false, message: 'PR 创建失败：HTTP ' + resp.status + ' ' + text.slice(0, 200) };
}

module.exports = { parseRemoteUrl, remoteInfo, pushBranch, classifyPushError, buildPRRequest, createPR };
