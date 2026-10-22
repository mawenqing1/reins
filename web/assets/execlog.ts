/* ============================================================
   Reins — 执行流水表（纯函数，UMD）
   ------------------------------------------------------------
   逐次执行明细的构造 / 封顶 / 按日汇总 / 首次成功率。
   app.js 经 <script> 引入（window.ExecLog），单测经 require 引入。
   约定：
   - 流水表挂在组织上（org.execLog），与 agents 同维度（公司/个人互不可见）
   - cost 为 null 表示「计价在途或未定价」：priced=false 明确未定价，
     priced=null 表示主进程计价回包还没到（渲染时按「计价中」处理）
   注意：本文件保留手写 UMD 壳 —— TS 的 module:umd 原生 emit 只有
   CommonJS/AMD 两个分支（factory 在浏览器里根本不会被调用，模块体不执行，
   window.ExecLog 不会被赋值），且 `export as namespace` 只允许出现在 .d.ts
   （TS1315）。要同时满足浏览器全局挂载 + Node require + 单测对
   globalThis.ExecLog 的断言，手写壳是当前唯一等价写法。
   ============================================================ */
(function (root: any, factory: () => any) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.ExecLog = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {

  const CAP = 500;   // 流水封顶：超出丢最旧（按次滚动的明细，不是账本全集）

  /* 本地时区 YYYY-MM-DD（"今天花了多少"按用户本地日历日算，不按 UTC） */
  function dayOf(ms: number): string {
    const d = new Date(Number(ms) || 0);
    const p = (n: number): string => (n < 10 ? '0' + n : '' + n);
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }

  /* usage 字段名各家兼容（prompt/completion_tokens、input/output_tokens）；
     与 services/pricing.js 的 splitUsage 同口径的轻量版（只拆不加总假设） */
  interface SplitUsage { in: number | null; out: number | null; total: number; }
  function splitUsage(u: any): SplitUsage {
    const inn = u?.prompt_tokens ?? u?.input_tokens;
    const out = u?.completion_tokens ?? u?.output_tokens;
    return {
      in: Number.isFinite(+inn) ? +inn : null,
      out: Number.isFinite(+out) ? +out : null,
      total: Number.isFinite(+u?.total_tokens) ? +u.total_tokens : ((inn != null || out != null) ? ((+inn || 0) + (+out || 0)) : 0)
    };
  }

  /* makeEntry 的入参（info）：坏值容忍是刻意的（+undefined → NaN → 走回退），
     会进 +Number 强转的字段按宽松口径声明 */
  interface EntryInfo {
    at?: any;
    taskId?: string;
    taskKey?: any;
    taskTitle?: any;
    agentId?: string;
    agentName?: any;
    model?: any;
    provider?: any;
    stage?: any;
    ok?: boolean;
    firstPass?: boolean | null;
    ms?: any;
    usage?: any;
    credits?: any;
  }

  /* 一条流水：cost/priced 构造时为 null，由记账方（计价回包后）回填 */
  interface Entry {
    at: number;
    day: string;
    taskId: string;
    taskKey: string;
    taskTitle: string;
    agentId: string;
    agentName: string;
    model: string;
    provider: string;
    stage: string | null;
    ok: boolean;
    firstPass: boolean;
    ms: number;
    tokIn: number | null;
    tokOut: number | null;
    tokens: number;
    credits: number;
    cost: number | null;
    priced: boolean | null;
  }

  /* 构造一条流水。info：{ at, taskId, taskKey, taskTitle, agentId, agentName, model, provider,
     stage, ok, firstPass, ms, usage }
     - firstPass 仅在 ok 且为「交付级完成」时有意义，其余传 null
     - 坏值全部归一到安全形态（流水表要先于 UI 存在，不能因字段脏而渲染崩） */
  function makeEntry(info?: EntryInfo | null): Entry {
    const i: EntryInfo = info || {};
    const at = Number.isFinite(+i.at) ? +i.at : Date.now();
    const tk = splitUsage(i.usage);
    return {
      at, day: dayOf(at),
      taskId: typeof i.taskId === 'string' ? i.taskId : '',
      taskKey: String(i.taskKey || '').slice(0, 24),
      taskTitle: String(i.taskTitle || '').slice(0, 60),
      agentId: typeof i.agentId === 'string' ? i.agentId : '',
      agentName: String(i.agentName || '').slice(0, 40),
      model: String(i.model || '').slice(0, 60),
      provider: String(i.provider || '').slice(0, 24),
      stage: i.stage ? String(i.stage).slice(0, 40) : null,
      ok: i.ok !== false,
      firstPass: i.ok !== false && i.firstPass === true,
      ms: Math.max(0, Math.round(+i.ms || 0)),
      tokIn: tk.in, tokOut: tk.out,
      tokens: tk.total || 0,
      credits: Math.max(0, +i.credits || 0),   // 积分消耗（qoder 家族），与 tokens 并列如实记，不折算金额
      cost: null, priced: null   // 计价回包后由记账方回填
    };
  }

  /* 追加 + 封顶（丢最旧）。原地修改并返回同一数组引用（渲染层 save() 存的是 state 本身） */
  function push<T>(log: T[] | null, entry: T, cap?: any): T[] | null {
    if (!Array.isArray(log)) return log;
    log.push(entry);
    const c = Number.isFinite(+cap) && +cap > 0 ? +cap : CAP;
    if (log.length > c) log.splice(0, log.length - c);
    return log;
  }

  /* 按日汇总：次数 / 失败 / tokens / 花费 / 未定价（花费只计已回包的已定价条目） */
  interface DaySum { runs: number; fails: number; tokens: number; cost: number; unpriced: number; pending: number; }
  function sumDay(log: any[] | null | undefined, day: string): DaySum {
    const r: DaySum = { runs: 0, fails: 0, tokens: 0, cost: 0, unpriced: 0, pending: 0 };
    if (!Array.isArray(log)) return r;
    for (const e of log) {
      if (!e || e.day !== day) continue;
      r.runs++; if (e.ok === false) r.fails++;
      r.tokens += Number(e.tokens) || 0;
      if (e.priced === true && Number.isFinite(+e.cost)) r.cost += +e.cost;
      else if (e.priced === false) r.unpriced++;
      else r.pending++;
    }
    r.cost = Math.round(r.cost * 10000) / 10000;
    return r;
  }

  /* 最近 N 条（新的在前，展示用；流水本身按时间追加） */
  function recent(log: Entry[] | null | undefined, n?: any): Entry[] {
    if (!Array.isArray(log)) return [];
    const c = Number.isFinite(+n) && +n > 0 ? +n : 12;
    return log.slice(-c).reverse();
  }

  /* 首次成功率：一次通过的交付 / 全部交付。0 交付返回 null（同 successRate 语义：
     不显示 0%，免得被读成「全靠返工」） */
  function firstPassRate(firstPass?: any, deliveries?: any): number | null {
    const f = Number(firstPass) || 0, d = Number(deliveries) || 0;
    if (!d) return null;
    return Math.round(f / d * 100);
  }

  /* 近 N 日逐日汇总（旧 → 新），图表用；nowMs 可注入便于单测跨日边界 */
  interface DayBucket extends DaySum { day: string; }
  function daysBuckets(log: Entry[] | null | undefined, n?: any, nowMs?: any): DayBucket[] {
    const days = Number.isFinite(+n) && +n > 0 ? Math.floor(+n) : 7;
    const base = new Date(Number.isFinite(+nowMs) ? +nowMs : Date.now());
    const out: DayBucket[] = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(base.getTime());
      d.setDate(d.getDate() - i);
      const key = dayOf(d.getTime());
      out.push(Object.assign({ day: key }, sumDay(log, key)));
    }
    return out;
  }

  return { CAP, dayOf, splitUsage, makeEntry, push, sumDay, recent, firstPassRate, daysBuckets };
});
