/* services/runner.js — 模型参数五层优先级 / 并行阶段取消键 / 本地服务器上的重试事件与参数透传集成
   Node 16 无 global.fetch：测试自带 fetch 桩（http 模块 + Response shim，支持 AbortError 中止） */
const assert = require('assert');
const http = require('http');
const { resolveModelParams, stageKeyOf, runTask, cancelTask } = require('../services/runner');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const enc = s => new TextEncoder().encode(s);
const abortErr = () => { const e = new Error('The operation was aborted'); e.name = 'AbortError'; return e; };

/* ---------- fetch 桩：整包读回后以单 chunk 供 getReader（runner 按行解析，单块等价） ---------- */
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

/* ---------- 本地 SSE 服务器：mode 可切（429 一次后成功 / 正常流 / 挂起不响应） ---------- */
function mkServer() {
  const bodies = [];
  let mode = 'sse';
  const srv = http.createServer((req, res) => {
    let buf = '';
    req.on('data', c => buf += c);
    req.on('end', () => {
      bodies.push(buf);
      if (mode === 'hang') return;                       // 收下请求但永不响应（取消/出站超时场景）
      if (mode === '429once') {
        mode = 'sse';
        res.writeHead(429, { 'retry-after': '0' });
        return res.end('rate limited');
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end([
        'data: ' + JSON.stringify({ choices: [{ delta: { content: '交付内容' } }] }),
        '',
        'data: ' + JSON.stringify({ choices: [{ delta: {} }], usage: { total_tokens: 42 } }),
        '',
        'data: [DONE]',
        '',
      ].join('\n'));
    });
  });
  return {
    start: () => new Promise(r => srv.listen(0, '127.0.0.1', r)),
    url: () => 'http://127.0.0.1:' + srv.address().port,
    setMode: m => mode = m,
    bodies,
    close: () => new Promise(r => srv.close(r)),
  };
}

const mkTask = (id, extra) => Object.assign({ id, key: 'REINS-T', title: '测试任务', type: 'code', pri: 'P1', desc: '', thread: [] }, extra);

async function run() {
  let n = 0;
  const ok = (c, m) => { n++; assert.ok(c, m); };

  /* 1. resolveModelParams：五层优先级 覆盖 > 任务 > Agent > 全局默认 > 内置 */
  {
    const r0 = resolveModelParams(null, null, null, null);
    ok(r0.temperature === 0.6 && r0.maxTokens === 4096 && r0.topP === 1, '内置默认值');
    const r1 = resolveModelParams({ modelParams: { temperature: 0.2, maxTokens: 1024 } }, null, null, null);
    ok(r1.temperature === 0.2 && r1.maxTokens === 1024, 'Agent 层生效');
    const r2 = resolveModelParams({ modelParams: { temperature: 0.2 } }, { modelParams: { temperature: 0.8 } }, null, null);
    ok(r2.temperature === 0.8, '任务层覆盖 Agent 层');
    const r3 = resolveModelParams({ modelParams: { temperature: 0.2 } }, null, { temperature: 0.9 }, null);
    ok(r3.temperature === 0.9, '高级选项覆盖一切');
    const r4 = resolveModelParams(null, null, null, { topP: 0.5 });
    ok(r4.topP === 0.5 && r4.temperature === 0.6, '全局默认层生效');
    const r5 = resolveModelParams({ modelParams: { temperature: 0.2 } }, { modelParams: { temperature: '非法', max_tokens: 2048 } }, null, null);
    ok(r5.temperature === 0.2 && r5.maxTokens === 2048, '非法值逐字段回退 + snake_case 字段名兼容');
    const r6 = resolveModelParams({ modelParams: { temperature: 99, topP: 0 } }, null, null, null);
    ok(r6.temperature === 2 && r6.topP === 0.01, '越界值夹取到合法区间');
  }

  /* 2. stageKeyOf：并行阶段隔离键 */
  ok(stageKeyOf(mkTask('t1'), { key: 's2' }) === 't1#s2', '阶段键 = taskId#stageKey');
  ok(stageKeyOf(mkTask('t1'), null) === 't1', '无阶段回退 taskId');

  /* 3. 集成：429 + Retry-After=0 自动重试（retry 事件）→ 流式成功（done 带 usage）；
        请求体模型参数按 覆盖 > Agent > 全局默认 解析 */
  {
    global.fetch = nodeFetch;   // runner 的 pfetch 在调用时解析 global.fetch，晚绑定可注入
    const srv = mkServer();
    await srv.start();
    try {
      srv.setMode('429once');
      const events = [];
      const task = mkTask('it1', { modelParams: { temperature: 0.3 } });
      const agent = { provider: 'custom', baseURL: srv.url(), apiKey: 'sk-test', model: 'test-model', modelParams: { maxTokens: 777 } };
      await runTask(task, agent, '', e => events.push(e), {
        params: { temperature: 0.9 },
        modelDefaults: { topP: 0.5, maxTokens: 111 },
        http: { retries: 3 },
      });
      const retry = events.find(e => e.type === 'retry');
      ok(!!retry && retry.status === 429 && retry.retryNo === 1, '429 后发出 retry 事件（第 1 次）');
      ok(/429/.test(retry.reason) && retry.delayMs === 0, 'retry 事件带原因与 Retry-After=0 延时');
      const done = events.find(e => e.type === 'done');
      ok(!!done && done.result === '交付内容' && done.usage && done.usage.total_tokens === 42, '重试后流式完成并带 usage');
      ok(!events.some(e => e.type === 'error' || e.type === 'cancelled'), '全程无错误/取消');
      const sent = JSON.parse(srv.bodies[0]);
      ok(sent.temperature === 0.9 && sent.max_tokens === 777 && sent.top_p === 0.5, '请求体参数：覆盖>任务>Agent>默认逐层解析');
      ok(sent.stream === true && Array.isArray(sent.messages) && sent.messages[0].role === 'system', '消息结构与流式开关');

      /* 4. 集成：并行阶段取消 —— 同任务两个阶段在途，cancelTask 一次全停 */
      srv.setMode('hang');
      const t2 = mkTask('it2');
      const ev1 = [], ev2 = [];
      const p1 = runTask(t2, agent, '', e => ev1.push(e), { stage: { key: 's1', no: 1 } });
      const p2 = runTask(t2, agent, '', e => ev2.push(e), { stage: { key: 's2', no: 2 } });
      await sleep(150);   // 等 start 事件（aborts 表已登记两个阶段键）
      ok(ev1.some(e => e.type === 'start') && ev2.some(e => e.type === 'start'), '两个并行阶段均已启动');
      ok(cancelTask('it2') === true, '取消命中在途任务');
      await Promise.all([p1, p2]);
      ok(ev1.some(e => e.type === 'cancelled') && ev2.some(e => e.type === 'cancelled'), '两个阶段均收到 cancelled（前缀全停）');
      ok(!ev1.some(e => e.type === 'error') && !ev2.some(e => e.type === 'error'), '用户取消不报错误事件');
      ok(cancelTask('it2') === false, '取消后无在途句柄');
    } finally { await srv.close(); }
  }

  return n;
}

module.exports = { run };
