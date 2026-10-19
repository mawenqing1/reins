/* services/runner.js 出站网络路径 — Jev 决策模型与云端执行的重试层接入（F-1 / F-2 返工）
   Node 16 无 global.fetch：与 runner-params.test.js 同款 http 模块 fetch 桩（晚绑定注入）；
   断流/取消用例注入 fetchImpl 假流（read 挂起、abort 时拒绝），不依赖真实流式语义 */
const assert = require('assert');
const http = require('http');
const { triageJev, testJev, runCloudTask, cancelTask } = require('../services/runner');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const abortErr = () => { const e = new Error('The operation was aborted'); e.name = 'AbortError'; return e; };
const enc = s => new TextEncoder().encode(s);

function nodeFetch(url, init = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: init.method || 'GET', headers: init.headers },
      r => {
        const chunks = [];
        r.on('data', c => chunks.push(c));
        r.on('end', () => {
          const buf = Buffer.concat(chunks);
          let read = false;
          resolve({
            status: r.statusCode, ok: r.statusCode >= 200 && r.statusCode < 300,
            headers: { get: k => r.headers[String(k).toLowerCase()] || null },
            text: async () => buf.toString('utf8'),
            json: async () => JSON.parse(buf.toString('utf8')),
            body: { getReader: () => ({ read: async () => read ? { done: true } : (read = true, { done: false, value: buf }) }) },
          });
        });
        r.on('error', reject);
      }
    );
    req.on('error', reject);
    if (init.signal) {
      if (init.signal.aborted) { req.destroy(); return reject(abortErr()); }
      init.signal.addEventListener('abort', () => { req.destroy(); reject(abortErr()); }, { once: true });
    }
    if (init.body) req.write(init.body);
    req.end();
  });
}

/* ---------- Jev 假服务：503 一次（Retry-After: 0）/ 恒 503 / 正常 answers ---------- */
function mkJevServer() {
  let hits = 0, mode = 'ok';
  const srv = http.createServer((req, res) => {
    req.on('data', () => { }); req.on('end', () => {
      hits++;
      if (mode === 'always503') { res.writeHead(503, { 'retry-after': '0' }); return res.end('down'); }
      if (mode === '503once' && hits === 1) { res.writeHead(503, { 'retry-after': '0' }); return res.end('rate limited'); }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        model: 'jev-test',
        answers: {
          type: { choice: 'bug', probabilities: { bug: 0.9 } },
          pri: { choice: 'P1', probabilities: { P1: 0.8 } },
          assignee: { choice: 'a1', probabilities: { a1: 0.7 } },
          ping: { noul: 0.42 },
        },
        usage: { input_tokens: 10, output_tokens: 5 },
      }));
    });
  });
  return {
    start: () => new Promise(r => srv.listen(0, '127.0.0.1', r)),
    url: () => 'http://127.0.0.1:' + srv.address().port,
    setMode: m => mode = m,
    hits: () => hits,
    close: () => new Promise(r => srv.close(r)),
  };
}

/* ---------- 云端节点假服务：POST /run（503 一次 / 恒 503 / 400 已存在 / 正常）+ SSE + cancel ---------- */
function mkCloudServer() {
  let runs = 0, cancels = 0, mode = 'ok';
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      if (req.method === 'POST' && u.pathname === '/run') {
        runs++;
        if (mode === 'always503') { res.writeHead(503, { 'retry-after': '0' }); return res.end('node down'); }
        if (mode === '503once' && runs === 1) { res.writeHead(503, { 'retry-after': '0' }); return res.end('busy'); }
        if (mode === 'existsOnce' && runs === 1) { res.writeHead(400, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: 'runId 已存在' })); }
        return res.writeHead(200, { 'content-type': 'application/json' }) && res.end(JSON.stringify({ ok: true }));
      }
      const mEv = u.pathname.match(/^\/run\/([^/]+)\/events$/);
      if (req.method === 'GET' && mEv) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('data: ' + JSON.stringify({ t: 'out', text: '云端输出' }) + '\n\n');
        res.write('data: ' + JSON.stringify({ t: 'done', code: 0, worktree: null }) + '\n\n');
        return res.end();
      }
      const mCancel = u.pathname.match(/^\/run\/([^/]+)\/cancel$/);
      if (req.method === 'POST' && mCancel) { cancels++; return res.writeHead(200) && res.end('{}'); }
      res.writeHead(404); res.end();
    });
  });
  return {
    start: () => new Promise(r => srv.listen(0, '127.0.0.1', r)),
    url: () => 'http://127.0.0.1:' + srv.address().port,
    setMode: m => mode = m,
    runs: () => runs, cancels: () => cancels,
    close: () => new Promise(r => srv.close(r)),
  };
}

/* 挂起流 fetch 桩：POST 派发立即成功；SSE 建连返回「永不产出数据、abort 才拒绝」的 reader */
function hangStreamFetch(dispatchOk) {
  return async (url, init = {}) => {
    if ((init.method || 'GET') === 'POST') return { status: dispatchOk === false ? 500 : 200, ok: dispatchOk !== false, headers: { get: () => null }, text: async () => '' };
    return {
      status: 200, ok: true, headers: { get: () => null }, text: async () => '',
      body: { getReader: () => ({ read: () => new Promise((_, rej) => {
        if (init.signal && init.signal.aborted) return rej(abortErr());
        init.signal && init.signal.addEventListener('abort', () => rej(abortErr()), { once: true });
      }) }) },
    };
  };
}

const mkTask = (id, extra) => Object.assign({ id, key: 'REINS-C', title: '云端任务', type: 'code', pri: 'P1', desc: '', thread: [] }, extra);
const AGENT = { name: '云 CLI', mode: 'cli', cliId: 'claude-code' };

async function run() {
  let n = 0;
  const ok = (c, m) => { n++; assert.ok(c, m); };
  global.fetch = nodeFetch;   // runner 的 pfetch 调用时解析 global.fetch，晚绑定注入

  /* 1. Jev：503 一次（Retry-After: 0）→ 重试成功（F-1：出站走共享重试层） */
  {
    const srv = mkJevServer();
    await srv.start();
    try {
      srv.setMode('503once');
      const r = await triageJev(mkTask('j1'), { agents: [{ id: '1', name: 'A', mode: 'api' }], roles: [], members: [] }, { jevUrl: srv.url(), jevKey: 'jk' }, { timeoutMs: 5000 });
      ok(r.ok === true, 'Jev 503 后重试成功');
      ok(srv.hits() === 2, '共发起 2 次请求（1 + 1 重试）');
      ok(r.suggestion.type === 'bug' && r.suggestion.pri === 'P1', '重试后解析建议');
      ok(r.suggestion.assignee && r.suggestion.assignee.kind === 'agent' && r.suggestion.assignee.id === '1', '经办人映射回候选');

      /* 2. Jev 恒 503 → 耗尽报错含状态码与重试次数 */
      srv.setMode('always503');
      const r2 = await triageJev(mkTask('j2'), { agents: [], roles: [], members: [] }, { jevUrl: srv.url(), jevKey: 'jk' }, { timeoutMs: 5000, retries: 2 });
      ok(r2.ok === false && /503/.test(r2.message) && /已重试 2 次/.test(r2.message), '重试耗尽报错带状态码与次数');

      /* 3. testJev 探活链路（同 callJev 通道） */
      srv.setMode('ok');
      const r3 = await testJev({ jevUrl: srv.url(), jevKey: 'jk' }, { timeoutMs: 5000 });
      ok(r3.ok === true && /连接成功/.test(r3.message), 'Jev 探活成功');
    } finally { await srv.close(); }
  }

  /* 4. 云端：派发 503 一次 → 重试成功 → SSE 正常收流 done（F-2） */
  {
    const srv = mkCloudServer();
    await srv.start();
    try {
      srv.setMode('503once');
      const events = [];
      await runCloudTask(mkTask('c1'), AGENT, '', e => events.push(e), { cloud: { url: srv.url(), token: 'ct' } });
      ok(srv.runs() === 2, '派发 POST 共 2 次（503 重试后成功）');
      ok(events.some(e => e.type === 'delta' && e.text === '云端输出'), 'SSE 输出事件上屏');
      ok(events.some(e => e.type === 'done' && e.result === '云端输出'), 'SSE done 事件完成执行');
      ok(!events.some(e => e.type === 'error' || e.type === 'cancelled'), '全程无错误/取消');

      /* 5. 派发恒 503 → 重试耗尽报错（含状态码与次数） */
      srv.setMode('always503');
      const ev2 = [];
      await runCloudTask(mkTask('c2'), AGENT, '', e => ev2.push(e), { cloud: { url: srv.url(), token: 'ct' } });
      const err = ev2.find(e => e.type === 'error');
      ok(!!err && /云端节点连接失败/.test(err.message) && /503/.test(err.message) && /已重试 2 次/.test(err.message), '派发耗尽报错带状态码与次数');

      /* 6. 派发撞 runId 已存在（首次响应丢失的重试）→ 按已派发续接事件流，不当错误 */
      srv.setMode('existsOnce');
      const ev3 = [];
      await runCloudTask(mkTask('c3'), AGENT, '', e => ev3.push(e), { cloud: { url: srv.url(), token: 'ct' } });
      ok(ev3.some(e => e.type === 'done'), 'runId 已存在按已派发续接事件流');
      ok(!ev3.some(e => e.type === 'error'), '幂等续接不报错');
    } finally { await srv.close(); }
  }

  /* 7. 云端：事件流断流看门狗 — 建连后长时间无字节 → 中止本地等待并如实报错 */
  {
    const ev = [];
    await runCloudTask(mkTask('c4'), AGENT, '', e => ev.push(e), {
      cloud: { url: 'http://reins.invalid', token: 'ct' },
      http: { stallMs: 120, timeoutMs: 5000, fetchImpl: hangStreamFetch(true) },
    });
    const err = ev.find(e => e.type === 'error');
    ok(!!err && /事件流超时/.test(err.message) && /无数据/.test(err.message), '断流看门狗超时报错');
    ok(!ev.some(e => e.type === 'cancelled'), '断流不是用户取消');
    ok(cancelTask('c4') === false, '结束后无在途句柄');
  }

  /* 8. 云端：用户取消 — 中止挂起的事件流并发送 cancel 到节点 */
  {
    let cancelHit = 0;
    const fetchImpl = async (url, init = {}) => {
      if (/\/cancel$/.test(String(url))) { cancelHit++; return { status: 200, ok: true, headers: { get: () => null }, text: async () => '' }; }
      return hangStreamFetch(true)(url, init);
    };
    const ev = [];
    const p = runCloudTask(mkTask('c5'), AGENT, '', e => ev.push(e), {
      cloud: { url: 'http://reins.invalid', token: 'ct' },
      http: { stallMs: 60000, timeoutMs: 5000, fetchImpl },
    });
    await sleep(150);   // 等 start 事件与 SSE 建连（aborts 已登记）
    ok(cancelTask('c5') === true, '取消命中在途任务');
    await p;
    ok(ev.some(e => e.type === 'cancelled'), '用户取消收到 cancelled 事件');
    ok(!ev.some(e => e.type === 'error'), '取消不报错误事件');
    ok(cancelHit === 1, '取消同时通知云端节点（cancel POST 一次）');
  }

  await sleep(1);
  return n;
}

module.exports = { run };
