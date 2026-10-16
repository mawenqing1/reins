#!/usr/bin/env node
/* ============================================================
   Reins — 云端执行节点（runtime server）
   零依赖单文件：Node 18+ 直接运行。部署：
     node server.js --port 8787 --token <密钥> [--workspace ./workspace] [--repo-root /path/to/repo] [--name 节点名]
   客户端在「设置 → 云端节点」填 http://<服务器>:<端口> 与同一 token 即可派发任务。
   安全模型：Bearer token 鉴权；只执行客户端下发的 argv 数组（不经 shell 解析）；
   每个任务在独立目录中执行，配置 --repo-root 后自动创建 git worktree（分支 reins/<任务号>）。
   ============================================================ */
const http = require('http');
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

/* ---------- 参数 ---------- */
const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf('--' + name);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const PORT = parseInt(opt('port', process.env.REINS_PORT || '8787'), 10);
const TOKEN = opt('token', process.env.REINS_TOKEN || crypto.randomBytes(18).toString('hex'));
const WORKSPACE = path.resolve(opt('workspace', process.env.REINS_WORKSPACE || path.join(__dirname, 'workspace')));
const REPO_ROOT = path.resolve(opt('repo-root', process.env.REINS_REPO_ROOT || ''));
const NAME = opt('name', os.hostname());
const MAX_RUNS = parseInt(opt('max-runs', '8'), 10);
const DEFAULT_TIMEOUT = parseInt(opt('timeout', String(20 * 60 * 1000)), 10);

fs.mkdirSync(WORKSPACE, { recursive: true });

/* ---------- 运行注册表 ---------- */
const runs = new Map(); // runId -> { child, buffer[], resolvers[], done, worktree, timer }

function authOK(req) {
  const h = req.headers['authorization'] || '';
  const a = Buffer.from(String(TOKEN));
  const b = Buffer.from(String(h.replace(/^Bearer\s+/i, '')));
  return h.startsWith('Bearer ') && a.length === b.length && crypto.timingSafeEqual(a, b);
}

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function readBody(req, limit = 1024 * 512) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > limit) { reject(new Error('body too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString() || '{}')); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

const safeKey = k => String(k || '').replace(/[^a-zA-Z0-9_\-]/g, '').slice(0, 40) || 'task';

/* ---------- worktree（与客户端 runner 同策略） ---------- */
function prepareWorktree(repoRoot, key, note) {
  try {
    const git = (...a) => spawnSync('git', ['-C', repoRoot, ...a], { encoding: 'utf8', timeout: 20000 });
    const chk = git('rev-parse', '--is-inside-work-tree');
    if (!chk || chk.status !== 0 || String(chk.stdout || '').trim() !== 'true') { note('⚠ ' + repoRoot + ' 不是 git 仓库，在任务目录直接执行'); return null; }
    const wtRoot = path.join(repoRoot, '..', '.reins-wt');
    const wt = path.join(wtRoot, key);
    if (fs.existsSync(wt)) { note('↻ 复用隔离工作区 .reins-wt/' + key); return wt; }
    fs.mkdirSync(wtRoot, { recursive: true });
    let r = git('worktree', 'add', '-b', 'reins/' + key, wt);
    if (r.status !== 0) {
      r = git('worktree', 'add', wt, 'reins/' + key);
      if (r.status !== 0) { note('⚠ 无法创建 worktree：' + String(r.stderr || '').trim().slice(0, 140)); return null; }
      note('✓ 挂载既有分支 reins/' + key);
    } else note('✓ 已创建隔离工作区 .reins-wt/' + key + '（分支 reins/' + key + '）');
    const nm = path.join(repoRoot, 'node_modules');
    if (fs.existsSync(nm) && !fs.existsSync(path.join(wt, 'node_modules'))) {
      try { fs.symlinkSync(nm, path.join(wt, 'node_modules'), 'dir'); note('✓ 已链接 node_modules'); } catch (e) { }
    }
    return wt;
  } catch (e) { note('⚠ worktree 异常：' + e.message); return null; }
}

/* ---------- 检测本机可用 CLI（供客户端展示） ---------- */
function detectClis() {
  const cmds = ['claude', 'codex', 'codebuddy', 'workbuddy', 'opencode', 'gemini', 'cursor-agent', 'qwen', 'copilot', 'droid', 'amp', 'openclaw', 'hermes', 'pi'];
  const found = [];
  for (const c of cmds) {
    try { const r = spawnSync('/bin/sh', ['-c', 'command -v ' + c], { encoding: 'utf8', timeout: 3000 }); if (r.status === 0 && r.stdout && r.stdout.trim()) found.push(c); } catch (e) { }
  }
  return found;
}

/* ---------- 执行 ---------- */
function startRun(runId, body) {
  const { cmd, args = [], taskKey, repoRoot, timeoutMs } = body;
  if (!cmd || typeof cmd !== 'string') return { error: '缺少 cmd' };
  if (!Array.isArray(args) || args.some(a => typeof a !== 'string')) return { error: 'args 必须是字符串数组' };
  if (runs.has(runId)) return { error: 'runId 已存在' };
  if (runs.size >= MAX_RUNS) return { error: '节点繁忙（并发上限 ' + MAX_RUNS + '）' };

  const key = safeKey(taskKey || runId);
  const rec = { child: null, buffer: [], resolvers: [], done: false, worktree: null };
  runs.set(runId, rec);
  const emit = ev => {
    if (rec.buffer.length < 4000) rec.buffer.push(ev);
    for (const res of rec.resolvers.splice(0)) res(ev);
  };

  const note = text => emit({ t: 'note', text });
  const useRepo = repoRoot && typeof repoRoot === 'string' ? repoRoot : REPO_ROOT;
  const cwd = useRepo ? (prepareWorktree(path.resolve(useRepo), key, note) || path.join(WORKSPACE, key)) : path.join(WORKSPACE, key);
  rec.worktree = cwd.startsWith('.reins-wt') ? cwd : (useRepo && cwd.includes('.reins-wt') ? cwd : null);
  fs.mkdirSync(cwd, { recursive: true });

  const t0 = Date.now();
  try {
    rec.child = spawn(cmd, args, { cwd, env: { ...process.env, REINS_TASK: key } });
  } catch (e) {
    emit({ t: 'done', code: -1, error: e.message });
    rec.done = true;
    return { ok: true, runId, cwd };
  }
  emit({ t: 'start', pid: rec.child.pid, cwd, node: NAME });
  rec.child.stdout.on('data', d => emit({ t: 'out', text: d.toString() }));
  rec.child.stderr.on('data', d => emit({ t: 'err', text: d.toString() }));
  const finish = (ev) => { rec.done = true; clearTimeout(rec.timer); emit(ev); setTimeout(() => runs.delete(runId), 120000); };
  rec.child.on('error', e => finish({ t: 'done', code: -1, error: e.message }));
  rec.child.on('close', code => finish({ t: 'done', code: code === null ? -1 : code, durationMs: Date.now() - t0, worktree: rec.worktree }));
  rec.timer = setTimeout(() => {
    try { rec.child.kill('SIGKILL'); } catch (e) { }
    finish({ t: 'killed', reason: 'timeout' });
  }, Math.min(Math.max(parseInt(timeoutMs, 10) || DEFAULT_TIMEOUT, 5000), 60 * 60 * 1000));
  return { ok: true, runId, cwd };
}

function cancelRun(runId) {
  const rec = runs.get(runId);
  if (!rec || rec.done) return false;
  try { rec.child.kill('SIGTERM'); } catch (e) { }
  return true;
}

/* ---------- SSE：先回放缓冲，再实时推送 ---------- */
function sseEvents(req, res, runId) {
  const rec = runs.get(runId);
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(': connected\n\n');
  if (!rec) { res.write('data: ' + JSON.stringify({ t: 'gone' }) + '\n\n'); res.end(); return; }
  for (const ev of rec.buffer) res.write('data: ' + JSON.stringify(ev) + '\n\n');
  if (rec.done) { res.end(); return; }
  const onEv = ev => {
    res.write('data: ' + JSON.stringify(ev) + '\n\n');
    if (ev.t === 'done' || ev.t === 'killed') res.end();
  };
  rec.resolvers.push(onEv);
  req.on('close', () => { const i = rec.resolvers.indexOf(onEv); if (i >= 0) rec.resolvers.splice(i, 1); });
}

/* ---------- HTTP ---------- */
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  if (!authOK(req)) return json(res, 401, { ok: false, error: 'unauthorized' });
  if (req.method === 'GET' && u.pathname === '/health') {
    return json(res, 200, { ok: true, name: NAME, version: '1.0.0', uptime: Math.round(process.uptime()), workspace: WORKSPACE, repoRoot: REPO_ROOT || null, agents: detectClis() });
  }
  const mRun = u.pathname.match(/^\/run\/([^/]+)\/events$/);
  if (req.method === 'GET' && mRun) return sseEvents(req, res, decodeURIComponent(mRun[1]));
  const mCancel = u.pathname.match(/^\/run\/([^/]+)\/cancel$/);
  if (req.method === 'POST' && mCancel) return json(res, 200, { ok: cancelRun(decodeURIComponent(mCancel[1])) });
  if (req.method === 'POST' && u.pathname === '/run') {
    try {
      const body = await readBody(req);
      const r = startRun(String(body.runId || crypto.randomBytes(8).toString('hex')), body);
      return json(res, r.error ? 400 : 200, r);
    } catch (e) { return json(res, 400, { ok: false, error: e.message }); }
  }
  json(res, 404, { ok: false, error: 'not found' });
});
server.listen(PORT, '0.0.0.0', () => {
  console.log('Reins 云端节点已启动');
  console.log('  名称   :', NAME);
  console.log('  地址   : http://0.0.0.0:' + PORT);
  console.log('  Token  :', TOKEN === opt('token', process.env.REINS_TOKEN || '') ? TOKEN : '(随机生成，建议用 --token 指定固定值)');
  console.log('  工作区 :', WORKSPACE);
  console.log('  仓库   :', REPO_ROOT || '（未配置，任务在独立目录执行）');
});
