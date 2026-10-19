/* services/http.js — 重试 / 退避 / Retry-After / 超时 / 取消语义 */
const assert = require('assert');
const { fetchWithRetry, HttpRetryError, retryAfterMs, isRetryableStatus } = require('../services/http');

/* 假 Response（Node 16 无全局 Response）：helper 只用 status/headers.get/text */
const res = (status, opts) => ({
  status,
  ok: status >= 200 && status < 300,
  headers: { get: k => (opts && opts.headers && opts.headers[k]) || null },
  text: async () => (opts && opts.body) || '',
});

const sleep = ms => new Promise(r => setTimeout(r, ms));
const FAST = [5, 5, 5];   // 测试用退避表：5ms，不真等 1s

/* 假"永不落定"fetch：必须像真实 fetch 一样响应 signal 中止（reject AbortError），
   否则超时用例的 await 永远挂起、整条测试链静默死等 */
const hangFetch = init => new Promise((_, rej) => init.signal.addEventListener('abort', () => {
  const e = new Error('The operation was aborted');
  e.name = 'AbortError';
  rej(e);
}));

async function run() {
  let n = 0;
  const ok = (c, m) => { n++; assert.ok(c, m); };

  /* 1. 429 → 按 Retry-After(0) 立即重试 → 成功 */
  {
    const calls = [];
    const retriesInfo = [];
    const resp = await fetchWithRetry('http://x/api', {}, {
      fetchImpl: async () => { calls.push(1); return calls.length === 1 ? res(429, { headers: { 'retry-after': '0' } }) : res(200); },
      backoff: FAST, retries: 3, onRetry: i => retriesInfo.push(i),
    });
    ok(resp.status === 200, '429 后重试拿到 200');
    ok(calls.length === 2, '只发了 2 次请求');
    ok(retriesInfo.length === 1 && retriesInfo[0].retryNo === 1 && retriesInfo[0].delayMs === 0, 'onRetry 报告第 1 次重试且 delayMs 取 Retry-After=0');
    ok(/429/.test(retriesInfo[0].reason), '重试原因含状态码 429');
  }

  /* 2. 529/5xx 连续失败 4 次（首次+3 重试）→ HttpRetryError 带状态码与重试次数 */
  {
    let calls = 0;
    await assert.rejects(
      () => fetchWithRetry('http://x/api', {}, { fetchImpl: async () => { calls++; return res(503, { body: 'upstream boom' }); }, backoff: FAST, retries: 3 }),
      e => {
        ok(e instanceof HttpRetryError, '抛 HttpRetryError');
        ok(e.status === 503, '错误带原始状态码 503');
        ok(e.attempts === 4, '总尝试 4 次');
        ok(/503/.test(e.message) && /已重试 3 次/.test(e.message), '错误信息含状态码与重试次数');
        return true;
      }
    );
    ok(calls === 4, '共发起 4 次请求（1+3）');
    n++;
  }

  /* 3. 400 不可重试 → 立即返回响应 */
  {
    let calls = 0;
    const resp = await fetchWithRetry('http://x/api', {}, { fetchImpl: async () => { calls++; return res(400, { body: 'bad' }); }, backoff: FAST });
    ok(resp.status === 400 && calls === 1, '400 不重试直接返回');
  }

  /* 4. 网络错误（fetch 抛 TypeError）→ 重试 → 成功 */
  {
    let calls = 0;
    const resp = await fetchWithRetry('http://x/api', {}, {
      fetchImpl: async () => { calls++; if (calls === 1) { const e = new TypeError('fetch failed'); e.cause = { code: 'ECONNRESET' }; throw e; } return res(200); },
      backoff: FAST,
    });
    ok(resp.status === 200 && calls === 2, '网络错误后重试成功');
  }

  /* 5. 用户取消：外部 signal 已中止 → 不发请求直接抛 AbortError */
  {
    const ac = new AbortController();
    ac.abort();
    let calls = 0;
    await assert.rejects(
      () => fetchWithRetry('http://x/api', {}, { fetchImpl: async () => { calls++; return res(200); }, signal: ac.signal, backoff: FAST }),
      e => { ok(e.name === 'AbortError', '用户取消抛 AbortError'); ok(calls === 0, '取消后零请求'); return true; }
    );
    n++;
  }

  /* 6. 退避等待期间用户取消 → 不再发起下一次尝试 */
  {
    const ac = new AbortController();
    let calls = 0;
    const p = fetchWithRetry('http://x/api', {}, {
      fetchImpl: async () => { calls++; return res(500); },
      backoff: [80, 80, 80], signal: ac.signal,
      onRetry: () => setTimeout(() => ac.abort(), 5),
    }).then(() => 'resolved', e => e);
    const r = await p;
    ok(r instanceof Error && r.name === 'AbortError', '退避期取消抛 AbortError');
    ok(calls === 1, '退避期取消后没有第 2 次请求');
  }

  /* 7. 无响应超时：fetch 永不落定 → 超时作废本次尝试（可重试）；retries=0 → 耗尽报错 */
  {
    const t0 = Date.now();
    await assert.rejects(
      () => fetchWithRetry('http://x/api', {}, { fetchImpl: (url, init) => hangFetch(init), timeoutMs: 1000, retries: 0 }),
      e => {
        ok(e instanceof HttpRetryError, '超时耗尽抛 HttpRetryError');
        ok(/超时/.test(e.message) && /已重试 0 次/.test(e.message), '超时错误信息带原因与重试次数');
        ok(Date.now() - t0 >= 950, '确实等满了超时时长');
        return true;
      }
    );
    n++;
  }

  /* 8. 超时属于瞬态错误：首次超时 → 重试成功 */
  {
    let calls = 0;
    const resp = await fetchWithRetry('http://x/api', {}, {
      fetchImpl: (url, init) => { calls++; return calls === 1 ? hangFetch(init) : Promise.resolve(res(200)); },
      timeoutMs: 1000, retries: 1, backoff: FAST,
    });
    ok(resp.status === 200 && calls === 2, '无响应超时后重试成功');
  }

  /* 9. Retry-After 解析：秒数 / HTTP 日期 / 上限封顶 */
  ok(retryAfterMs(res(429, { headers: { 'retry-after': '3' } })) === 3000, '秒数 Retry-After');
  ok(retryAfterMs(res(429, { headers: { 'retry-after': new Date(Date.now() + 4000).toUTCString() } })) >= 3000, 'HTTP 日期 Retry-After');
  ok(retryAfterMs(res(429, { headers: { 'retry-after': '9999' } })) === 60000, '离谱 Retry-After 封顶 60s');
  ok(retryAfterMs(res(429)) === null, '无头返回 null');

  /* 10. 状态码分类 */
  ok(isRetryableStatus(429) && isRetryableStatus(500) && isRetryableStatus(503), '429/5xx 可重试');
  ok(!isRetryableStatus(400) && !isRetryableStatus(401) && !isRetryableStatus(404), '4xx 不可重试');

  /* 11. 终止响应保留 outer→attempt 取消传播：调用方在流式消费期间 abort 外部信号，
        响应体绑定的本次尝试 signal 必须跟着中止（流内看门狗依赖此行为）。
        Node 16 AbortSignal 无 listenerCount：包一层 add/remove 计数（仅统计 http.js 的挂载） */
  {
    const ac = new AbortController();
    const probe = { added: 0, removed: 0 };
    const origAdd = ac.signal.addEventListener.bind(ac.signal);
    const origRemove = ac.signal.removeEventListener.bind(ac.signal);
    ac.signal.addEventListener = (t, fn, o) => { if (t === 'abort') probe.added++; return origAdd(t, fn, o); };
    ac.signal.removeEventListener = (t, fn, o) => { if (t === 'abort') probe.removed++; return origRemove(t, fn, o); };
    let attemptSignal = null;
    const resp = await fetchWithRetry('http://x/api', {}, {
      fetchImpl: (url, init) => { attemptSignal = init.signal; return Promise.resolve(res(200)); },
      signal: ac.signal, backoff: FAST,
    });
    ok(resp.status === 200, '拿到终止响应');
    ok(probe.added - probe.removed === 1, '恰保留一个 outer→attempt 监听器');
    const read = new Promise((_, rej) => origAdd.call(attemptSignal, 'abort', () => {
      const e = new Error('The operation was aborted'); e.name = 'AbortError'; rej(e);
    }, { once: true }));
    ac.abort();
    await assert.rejects(read, e => { ok(e.name === 'AbortError', 'abort 外部信号掐断在途流'); return true; });
    n++;
    ok(attemptSignal.aborted === true, '本次尝试 signal 已随外部取消中止');
  }

  /* 12. 作废尝试（重试/耗尽）解除传播，不随调用累积 */
  {
    const ac = new AbortController();
    const probe = { added: 0, removed: 0 };
    const origAdd = ac.signal.addEventListener.bind(ac.signal);
    const origRemove = ac.signal.removeEventListener.bind(ac.signal);
    ac.signal.addEventListener = (t, fn, o) => { if (t === 'abort') probe.added++; return origAdd(t, fn, o); };
    ac.signal.removeEventListener = (t, fn, o) => { if (t === 'abort') probe.removed++; return origRemove(t, fn, o); };
    let calls = 0;
    await fetchWithRetry('http://x/api', {}, {
      fetchImpl: async () => { calls++; return calls === 1 ? res(429, { headers: { 'retry-after': '0' } }) : res(200); },
      signal: ac.signal, backoff: FAST,
    });
    ok(probe.added - probe.removed === 1, '重试后只留终止尝试的监听器（作废尝试已解除）');
    let fails = 0;
    await fetchWithRetry('http://x/api', {}, {
      fetchImpl: async () => { fails++; return res(503); },
      signal: ac.signal, backoff: FAST, retries: 1,
    }).catch(() => { });
    ok(probe.added - probe.removed === 1, '耗尽路径零残留监听器');
  }

  await sleep(1);
  return n;
}

module.exports = { run };
