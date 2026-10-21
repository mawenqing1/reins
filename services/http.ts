/* ============================================================
   Reins — 共享 HTTP 客户端：无响应超时 + 瞬态错误自动重试
   ------------------------------------------------------------
   供 API 执行引擎 / Jev / Git PR 创建等主进程出站调用共用：
   - 指数退避：默认重试 3 次依次等待 1s→2s→4s（表尾 8s 档仅在 retries 调大时
     经 backoffAt 钳制生效，默认配置不会用到）
   - 仅重试三类瞬态错误：HTTP 429（优先读 Retry-After，秒数或 HTTP 日期）、
     HTTP 5xx、网络层失败（连接被拒/重置/DNS、无响应超时）
   - 每次尝试挂独立超时 AbortController（默认 120s 无响应）；外部 signal
     （用户手动取消）与超时共用同一 abort 通道：用户取消立即终止且绝不重试
   - 只在「响应体尚未开始消费」前重试（拿到状态码即做出站判断）；
     流式 body 开始消费后的断流由调用方看门狗处理，不在此重放
   - fetch/退避表均可注入，零依赖，可在裸 Node 单测
   ============================================================ */

const DEFAULT_BACKOFF = [1000, 2000, 4000, 8000];
const DEFAULT_TIMEOUT_MS = 120000;
const DEFAULT_RETRIES = 3;

/* 网络栈选择与 runner.pfetch 同策略：Electron 主进程优先 net.fetch（Chromium 网络栈，
   绕过部分服务 WAF 的 TLS 指纹丢弃），纯 Node 环境回退原生 fetch */
let _netFetch: any = null;
function defaultFetch() {
  if (_netFetch === null) {
    _netFetch = undefined;
    try { _netFetch = require('electron').net.fetch; } catch (e) { }
  }
  return _netFetch || (typeof global.fetch === 'function' ? global.fetch : null);
}

const isRetryableStatus = (s: number): boolean => s === 429 || (s >= 500 && s <= 599);

/* 429 优先读 Retry-After：支持秒数与 HTTP 日期两种格式；
   上限 60s——服务端给离谱值也不能把调用方永久挂死 */
function retryAfterMs(resp: any, capMs?: number): number | null {
  const cap = Number.isFinite(capMs) ? capMs : 60000;
  try {
    const ra = resp && resp.headers && resp.headers.get && resp.headers.get('retry-after');
    if (!ra) return null;
    const s = Number(ra);
    if (Number.isFinite(s) && s >= 0) return Math.min(s * 1000, cap);
    const d = Date.parse(ra);
    if (!Number.isNaN(d)) return Math.min(Math.max(d - Date.now(), 0), cap);
  } catch (e) { }
  return null;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/* 重试耗尽后的终止错误：status=0 表示网络层失败（连不上/超时），否则最后一次 HTTP 状态码；
   attempts 为总尝试次数（含首次）。验收要求错误信息包含原始状态码与重试次数 */
class HttpRetryError extends Error {
  status: number;
  attempts: number;
  lastError: any;
  constructor(message: string, info: any) {
    super(message);
    this.name = 'HttpRetryError';
    this.status = (info && info.status) || 0;
    this.attempts = (info && info.attempts) || 0;
    this.lastError = (info && info.lastError) || null;
  }
}

function reasonText(err, timedOut, status, timeoutMs) {
  if (timedOut) return '请求超时（' + Math.round(timeoutMs / 1000) + 's 无响应）';
  if (status === 429) return 'HTTP 429（被限流）';
  if (status) return 'HTTP ' + status + '（服务端错误）';
  return '网络错误（' + String(err && err.message || err) + '）';
}

function finalMessage(err, timedOut, status, attempts, timeoutMs, snippet) {
  const base = reasonText(err, timedOut, status, timeoutMs);
  const tail = status && snippet ? ' ' + String(snippet).slice(0, 200) : '';
  return base + tail + '（已重试 ' + (attempts - 1) + ' 次仍失败）';
}

const backoffAt = (table, i) => (table && table.length ? table[Math.min(Math.max(i, 0), table.length - 1)] : 1000);

/* 核心入口。opts：
   fetchImpl  注入的 fetch（默认 net.fetch / global.fetch）
   retries    最大重试次数（默认 3；0 = 不重试）
   timeoutMs  每次尝试的无响应超时（默认 120000）
   backoff    退避表 ms（默认 [1000,2000,4000,8000]）
   signal     外部取消信号（用户手动取消）：触发后立即抛 AbortError，绝不重试
   onRetry    每次决定重试时回调 {retryNo, retries, delayMs, status, reason, snippet}（异步派发前的同步通知）
   返回：终止响应（2xx，或不可重试的 4xx——由调用方按 resp.ok 判定并组织错误文案）
   抛出：AbortError（用户取消）/ 原始网络异常（不可重试类）/ HttpRetryError（重试耗尽） */
async function fetchWithRetry(url: string, init?: any, opts?: any): Promise<any> {
  const o = opts || {};
  const fetchImpl = o.fetchImpl || defaultFetch();
  if (!fetchImpl) throw new Error('当前环境无可用 fetch（net.fetch / global.fetch 均缺失）');
  const retries = Math.max(0, Number.isFinite(o.retries) ? o.retries : DEFAULT_RETRIES);
  const timeoutMs = Math.min(Math.max(Number.isFinite(o.timeoutMs) ? o.timeoutMs : DEFAULT_TIMEOUT_MS, 1000), 30 * 60 * 1000);
  const backoff = Array.isArray(o.backoff) && o.backoff.length ? o.backoff : DEFAULT_BACKOFF;
  const maxAttempts = retries + 1;
  const outer = o.signal || null;

  let lastErr: any = null;      // 最近一次可重试失败（网络异常或带 status 的伪 Error）
  let lastTimedOut = false;
  let lastSnippet = '';

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (outer && outer.aborted) { const e = new Error('已取消'); e.name = 'AbortError'; throw e; }

    /* 每次尝试独立控制器：超时只作废本次尝试；外部取消透传到本次尝试 */
    const ac = new AbortController();
    let timedOut = false;
    const onOuterAbort = () => ac.abort();
    if (outer) outer.addEventListener('abort', onOuterAbort, { once: true });
    const timer = setTimeout(() => { timedOut = true; ac.abort(); }, timeoutMs);
    const dropLink = () => { clearTimeout(timer); if (outer) outer.removeEventListener('abort', onOuterAbort); };

    let resp: any = null;
    let err: any = null;
    try {
      resp = await fetchImpl(url, Object.assign({}, init, { signal: ac.signal }));
    } catch (e) { err = e; }

    /* 用户取消：与超时共用 abort 通道，靠「外部 signal 是否已中止」区分，绝不重试 */
    if (outer && outer.aborted) {
      dropLink();
      const e = new Error('已取消'); e.name = 'AbortError'; throw e;
    }

    const status = resp ? resp.status : 0;
    /* 网络异常分类：本次超时（timedOut）或非 Abort 网络失败（fetch 网络层抛 TypeError 等）才可重试 */
    const retryable = !err ? isRetryableStatus(status) : (timedOut || err.name !== 'AbortError');

    if (!retryable) {
      if (err) { dropLink(); throw err; }   // 不可重试的异常（请求构造错误等）原样上抛
      /* 终止响应（2xx / 不可重试 4xx）交还调用方。注意：不清除超时定时器以外的
         outer→attempt 取消传播——响应体绑定的是本次尝试的 signal，保留传播才能让
         调用方在流式消费期间 abort 外部信号时真正掐断在途流（流内看门狗依赖此行为）；
         监听器 once 且随外部信号生命周期回收，不随调用累积 */
      clearTimeout(timer);
      return resp;
    }
    dropLink();   // 本次尝试作废（重试/耗尽）：解除传播后再进退避

    lastErr = err || Object.assign(new Error('HTTP ' + status), { status });
    lastTimedOut = timedOut;

    if (attempt >= maxAttempts) break;

    let delayMs: any = null;
    if (resp) {
      delayMs = retryAfterMs(resp);
      if (delayMs === null) delayMs = backoffAt(backoff, attempt - 1);
      try { lastSnippet = String(await resp.text()).slice(0, 300); } catch (e) { }   // 释放连接，留错误片段
    } else {
      delayMs = backoffAt(backoff, attempt - 1);
    }

    if (typeof o.onRetry === 'function') {
      try {
        o.onRetry({ retryNo: attempt, retries, delayMs, status, reason: reasonText(err, timedOut, status, timeoutMs), snippet: lastSnippet });
      } catch (e) { }
    }
    await sleep(delayMs);
  }

  const status = lastErr && lastErr.status ? lastErr.status : 0;
  throw new HttpRetryError(
    finalMessage(lastErr, lastTimedOut, status, maxAttempts, timeoutMs, lastSnippet),
    { status, attempts: maxAttempts, lastError: lastErr }
  );
}

export = { fetchWithRetry, HttpRetryError, isRetryableStatus, retryAfterMs, DEFAULT_BACKOFF, DEFAULT_TIMEOUT_MS, DEFAULT_RETRIES };
