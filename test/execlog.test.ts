/* 执行流水表 + 首次成功率 —— web/assets/execlog.js 纯函数（require 真身）
   + app.js/app.html 接线源码断言（防回退） */
import assert = require('assert');
import fs = require('fs');
import path = require('path');

/* execlog/taskflow 是手写 UMD 脚本形态（无顶层 export），import = require 会报 TS2306，用 require 全局 */
const ExecLog = require('../../web/assets/execlog');
const SRC = fs.readFileSync(path.join(__dirname, '..', '..', 'web', 'assets', 'app.ts'), 'utf8');
const HTML = fs.readFileSync(path.join(__dirname, '..', '..', 'web', 'app.html'), 'utf8');

async function run() {
  let n = 0;
  const ok = (c, m) => { n++; assert.ok(c, m); };
  const eq = (a, b, m?: any) => { n++; assert.strictEqual(a, b, m); };

  /* ---------- 1. UMD：require 与全局双端可用 ---------- */
  ok(ExecLog && typeof ExecLog.makeEntry === 'function', 'require 路径可用');
  ok(typeof globalThis.ExecLog === 'object' || typeof globalThis.ExecLog === 'function', '浏览器全局 ExecLog 注入');

  /* ---------- 2. dayOf：本地日历日 ---------- */
  {
    const d = new Date(2026, 9, 21, 23, 59, 59);   // 10 月 21 日 23:59 本地
    eq(ExecLog.dayOf(d.getTime()), '2026-10-21', '本地日期 YYYY-MM-DD');
    const d2 = new Date(2026, 0, 3, 0, 0, 1);
    eq(ExecLog.dayOf(d2.getTime()), '2026-01-03', '月份补零');
    eq(ExecLog.dayOf(NaN), ExecLog.dayOf(0), '坏值回落纪元日，不抛');
  }

  /* ---------- 3. splitUsage：各家字段名兼容 ---------- */
  {
    const a = ExecLog.splitUsage({ prompt_tokens: 100, completion_tokens: 40, total_tokens: 140 });
    eq(a.in, 100); eq(a.out, 40); eq(a.total, 140);
    const b = ExecLog.splitUsage({ input_tokens: 10, output_tokens: 5 });
    eq(b.total, 15, 'input/output 命名且缺 total → 求和');
    const c = ExecLog.splitUsage(null);
    eq(c.total, 0, '空 usage → 0');
  }

  /* ---------- 4. makeEntry：归一与安全截断 ---------- */
  {
    const e = ExecLog.makeEntry({
      at: new Date(2026, 9, 21, 10, 0, 0).getTime(), taskId: 't1', taskKey: 'REINS-42', taskTitle: 'x'.repeat(200),
      agentId: 'a1', agentName: 'GLM', model: 'm'.repeat(100), provider: 'zhipu', stage: 'UI 设计',
      ok: true, firstPass: true, ms: 1234.6, usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
    });
    eq(e.day, '2026-10-21', 'day 与 at 同步');
    eq(e.taskTitle.length, 60, '标题截断 60');
    eq(e.model.length, 60, '模型名截断 60');
    eq(e.ms, 1235, '耗时取整');
    eq(e.tokens, 15, 'tokens 拆分');
    eq(e.firstPass, true, '成功交付的 firstPass 保留');
    eq(e.cost, null, 'cost 待计价回包');
    eq(e.priced, null, 'priced 待计价回包');

    const f = ExecLog.makeEntry({ ok: false, firstPass: true });   // 失败行强行传 firstPass
    eq(f.firstPass, false, '失败行 firstPass 强制为 false');
    eq(f.tokens, 0, '无 usage → 0 tokens');
    eq(f.stage, null, '无阶段 → null');

    const g = ExecLog.makeEntry({ ok: true, firstPass: null });    // 阶段执行（非交付级）
    eq(g.firstPass, false, '非交付级完成 firstPass=false（占位，不参与首过分母）');
  }

  /* ---------- 5. push：封顶丢最旧 ---------- */
  {
    const log = [];
    for (let i = 0; i < ExecLog.CAP + 30; i++) ExecLog.push(log, { at: i, day: 'd' });
    eq(log.length, ExecLog.CAP, '封顶 500');
    eq(log[0].at, 30, '丢最旧');
    const ref = [];
    eq(ExecLog.push(ref, { x: 1 }), ref, '返回同一引用（state 原地更新语义）');
    eq(ExecLog.push(null, {}), null, '坏档不炸');
  }

  /* ---------- 6. sumDay：按日汇总与计价三态 ---------- */
  {
    const day = ExecLog.dayOf(Date.now());
    const log = [
      { day, ok: true, tokens: 100, priced: true, cost: 0.5 },
      { day, ok: false, tokens: 50, priced: true, cost: 0.1 },
      { day, ok: true, tokens: 30, priced: false },
      { day, ok: true, tokens: 20, priced: null },
      { day: '2000-01-01', ok: true, tokens: 999, priced: true, cost: 9 }
    ];
    const s = ExecLog.sumDay(log, day);
    eq(s.runs, 4, '只计当日 4 条');
    eq(s.fails, 1, '失败 1');
    eq(s.tokens, 200, 'tokens 当日合计');
    ok(Math.abs(s.cost - 0.6) < 1e-9, '花费只计已定价回包条目');
    eq(s.unpriced, 1, '未定价 1');
    eq(s.pending, 1, '计价中 1');
    eq(ExecLog.sumDay(null, day).runs, 0, '空档安全');
  }

  /* ---------- 7. recent：倒序 + firstPassRate ---------- */
  {
    const log = [{ at: 1 }, { at: 2 }, { at: 3 }];
    eq(ExecLog.recent(log, 2)[0].at, 3, '新的在前');
    eq(ExecLog.recent(log).length, 3, '默认 12 条上限内全回');
    eq(ExecLog.firstPassRate(3, 4), 75, '3/4 → 75%');
    eq(ExecLog.firstPassRate(0, 5), 0, '0/5 → 0%（有样本时如实为 0）');
    eq(ExecLog.firstPassRate(2, 0), null, '0 交付 → null（不显示 0%）');
    eq(ExecLog.firstPassRate(undefined, undefined), null, '坏输入 → null');
  }

  /* ---------- 8. 接线源码断言：记账路径不回退 ---------- */
  {
    ok(/org\.execLog = Array\.isArray\(org\.execLog\) \? org\.execLog : \[\]/.test(SRC), 'normalizeState 补齐 org.execLog');
    ok(/ExecLog\.makeEntry\(/.test(SRC) && /ExecLog\.push\(org\.execLog, row\)/.test(SRC), 'accountRun 落流水');
    ok(/agentId: agent\.id, agentName: agent\.name, provider: agent\.provider/.test(SRC), 'run 实例携带 agentId（并行阶段归属）');
    ok(/agentById\(r\.agentId\) \|\| effAgentOf\(t0\)/.test(SRC), '流水线阶段完成按 run.agentId 记账');
    ok(/TaskFlow\.applyReject\(t, [rv]\);/.test(SRC), '打回计数经 taskflow.applyReject 应用（首过率口径同源）');
    ok(/firstPass: !\(t2\.rejections > 0\)/.test(SRC), '单任务交付带 firstPass');
    ok(/delivery: true, firstPass: !\(t\.rejections > 0\)/.test(SRC), '演示引擎交付入流水');
    ok(/st\.deliveries = \(st\.deliveries \|\| 0\) \+ 1;/.test(SRC), '交付级完成计 deliveries 样本');
    ok(/首过率 <b>\$\{fp\}%<\/b>/.test(SRC), 'Agent 卡片展示首过率');
    ok(/ExecLog\.sumDay\(O\(\)\.execLog, ExecLog\.dayOf\(Date\.now\(\)\)\)/.test(SRC), '概览今日成本走流水表');
    ok(/function dashExecList\(\)/.test(SRC), '概览最近执行明细');
    ok(/if \(usedTokens\) a\.tokens = \(a\.tokens \|\| 0\) \+ usedTokens;/.test(SRC) === false, '流水线 tokens 旧记账路径已移除（防双计）');
    ok(/<script src="assets\/execlog.js"><\/script>/.test(HTML), 'app.html 引入 execlog.js');
  }

  /* ---------- 9. daysBuckets：近 N 日逐日汇总（图表用） ---------- */
  {
    const nowMs = new Date(2026, 9, 21, 20, 0, 0).getTime();   // 10-21 晚
    const d21 = '2026-10-21', d20 = '2026-10-20', d15 = '2026-10-15';
    const log = [
      { day: d21, ok: true, tokens: 100, priced: true, cost: 0.5 },
      { day: d21, ok: false, tokens: 10, priced: true, cost: 0.1 },
      { day: d20, ok: true, tokens: 50, priced: true, cost: 0.2 },
      { day: d15, ok: true, tokens: 5, priced: true, cost: 9 },   // 超出 7 日窗口
      { day: '2000-01-01', ok: true, tokens: 0, priced: true, cost: 99 },
    ];
    const b = ExecLog.daysBuckets(log, 7, nowMs);
    eq(b.length, 7, '恰好 7 个桶');
    eq(b[0].day, '2026-10-15', '最旧在前（含 7 日窗口边界当天）');
    eq(b[6].day, d21, '最新在后（今天）');
    ok(Math.abs(b[6].cost - 0.6) < 1e-9 && b[6].runs === 2, '今天两笔合计');
    ok(Math.abs(b[5].cost - 0.2) < 1e-9, '昨天命中');
    eq(b[0].cost, 9, '窗口首日（15 号）命中；14 号及更早不计');
    ok(b.slice(1, 5).every(x => x.cost === 0 && x.runs === 0), '无执行日为 0 桶');
    /* 跨月边界 */
    const b2 = ExecLog.daysBuckets([], 7, new Date(2026, 10, 2).getTime());
    eq(b2[0].day, '2026-10-27', '跨月：11-02 往前 7 天首日落在 10 月');
    eq(b2[6].day, '2026-11-02', '跨月：末日正确');
    ok(ExecLog.daysBuckets(null, 7, nowMs).length === 7, '空档安全');
  }

  return n;
}

module.exports = { run };
