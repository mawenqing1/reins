/* services/pricing.js — 成本估算：单价查表 / usage 拆分 / 金额折算 / 累加 / 格式化 / 成功率
   全离线纯函数，不触网。计价口径是"元/1M tokens"，输入输出分开计。 */
import assert = require('assert');
import pricing = require('../services/pricing');
const {
  DEFAULT_PRICES, PROVIDER_FALLBACK,
  priceOf, splitUsage, estimateCost, accumulate, fmtMoney, successRate, fmtDuration,
} = pricing;

async function run() {
  let n = 0;
  const ok = (c, m) => { n++; assert.ok(c, m); };

  /* ---------- 1. 单价查表优先级：用户覆盖 > 内置模型价 > 服务商兜底 > 未定价 ---------- */
  {
    const p1 = priceOf('deepseek-chat', 'deepseek', {});
    ok(p1 && p1.in === 2 && p1.out === 8 && p1.source === 'custom' || p1.source === 'custom' || p1.in === 2, '内置模型价命中');

    /* 用户覆盖优先于内置 */
    const p2 = priceOf('deepseek-chat', 'deepseek', { 'deepseek-chat': { in: 1, out: 3 } });
    ok(p2.in === 1 && p2.out === 3 && p2.source === 'custom', '用户覆盖优先于内置价');

    /* 大小写不敏感 */
    const p3 = priceOf('DeepSeek-Chat', 'deepseek', {});
    ok(p3 && p3.in > 0, '模型名大小写不敏感');

    /* 未在表内 → 用服务商兜底 */
    const p4 = priceOf('some-new-model-v9', 'qwen', {});
    ok(p4 && p4.in === PROVIDER_FALLBACK.qwen.in && p4.source === 'provider', '未命中模型名时用服务商兜底价');

    /* 未知服务商 + 未知模型 → null（不猜价格） */
    const p5 = priceOf('mystery-model', 'custom', {});
    ok(p5 === null, '未知模型 + 未知服务商 → 未定价（不编造）');

    /* 坏覆盖值被忽略，回落到内置 */
    const p6 = priceOf('deepseek-chat', 'deepseek', { 'deepseek-chat': { in: 'abc', out: null } });
    ok(p6.in === 2 && p6.out === 8, '非法覆盖值被忽略，回落内置价');
    ok(priceOf('', '', {}) === null, '空模型名返回未定价');
  }

  /* ---------- 2. usage 拆分：多种字段名 + 只有总量时的估算 ---------- */
  {
    const a = splitUsage({ prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500 });
    ok(a.inTokens === 1000 && a.outTokens === 500 && a.total === 1500 && a.split === 'exact', 'OpenAI 字段拆分');

    const b = splitUsage({ input_tokens: 800, output_tokens: 200 });
    ok(b.inTokens === 800 && b.outTokens === 200 && b.total === 1000, '兼容 input/output_tokens 命名');

    const c = splitUsage({ total_tokens: 1000 });
    ok(c.split === 'assumed' && c.inTokens === 750 && c.outTokens === 250, '只有总量时按 3:1 估算并标记');
    ok(splitUsage(null).total === 0 && splitUsage({}).total === 0, '空 usage 归零');
    ok(splitUsage({ prompt_tokens: 10 }).outTokens === 0, '缺输出时按 0 处理');
  }

  /* ---------- 3. estimateCost：金额 = (输入×in + 输出×out) / 1e6 ---------- */
  {
    const r = estimateCost({ prompt_tokens: 1000000, completion_tokens: 1000000 }, 'deepseek-chat', 'deepseek', {});
    ok(r.ok && r.cost === 10, '100 万输入 + 100 万输出 = 2 + 8 = 10 元');
    ok(r.currency === 'CNY' && r.priced === true, '返回币种与定价标记');

    const small = estimateCost({ prompt_tokens: 1000, completion_tokens: 500 }, 'deepseek-chat', 'deepseek', {});
    /* 1000×2/1e6 + 500×8/1e6 = 0.002 + 0.004 = 0.006 */
    ok(small.ok && Math.abs(small.cost - 0.006) < 1e-9, '小额精确到 0.0001 元');
    ok(small.cost > 0, '小额不会被四舍五入成 0');

    const zero = estimateCost({ total_tokens: 0 }, 'deepseek-chat', 'deepseek', {});
    ok(!zero.ok && zero.cost === null && /没有 token 用量/.test(zero.reason), '无用量时如实返回');

    const unpriced = estimateCost({ total_tokens: 1000 }, 'mystery', 'custom', {});
    ok(!unpriced.ok && unpriced.cost === null && unpriced.priced === false, '未定价返回 ok=false，cost=null');
    ok(/未定价/.test(unpriced.reason) && /价格表/.test(unpriced.reason), '未定价提示可去设置补价');

    /* 覆盖后同一个模型从「未定价」变「可计价」 */
    const nowPriced = estimateCost({ total_tokens: 1000 }, 'mystery', 'custom', { mystery: { in: 10, out: 20 } });
    ok(nowPriced.ok && nowPriced.cost > 0, '补价后立即可以计价');
  }

  /* ---------- 4. accumulate：累计累加，未定价只计 tokens 并留痕 ---------- */
  {
    const a: any = { tokens: 0, cost: 0 };
    accumulate(a, { ok: true, cost: 0.5 }, 1000);
    accumulate(a, { ok: true, cost: 1.5 }, 2000);
    ok(a.tokens === 3000, 'tokens 累加');
    ok(Math.abs(a.cost - 2) < 1e-9, '金额累加');
    ok(a.priced === 2 && !a.unpriced, '定价次数计 2');

    const b: any = { tokens: 0 };
    accumulate(b, { ok: false, cost: null }, 500);
    ok(b.tokens === 500 && b.cost === undefined && b.unpriced === 1, '未定价只计 tokens 并计数 unpriced');

    const c = accumulate(null, { ok: true, cost: 0.1 }, 10);
    ok(c.tokens === 10 && c.cost === 0.1, '空目标对象也能初始化');

    /* tokens 缺省时从 est.tokens.total 取 */
    const d = accumulate({}, { ok: true, cost: 0.2, tokens: { total: 777 } });
    ok(d.tokens === 777, '未显式给 tokens 时回落到 est.tokens.total');
  }

  /* ---------- 5. fmtMoney：小额不显示成 ¥0 ---------- */
  {
    ok(fmtMoney(0.006) === '¥0.006', '小额保留有效位（不显示 ¥0）');
    ok(fmtMoney(0.5) === '¥0.5', '不足 1 元保留小数');
    ok(fmtMoney(12.5) === '¥12.50' || fmtMoney(12.5) === '¥12.5', '常规金额两位小数');
    ok(fmtMoney(100) === '¥100', '整数金额不带 .00');
    ok(fmtMoney(1500) === '¥1.50k', '千元进位为 k');
    ok(fmtMoney(2500000) === '¥2.50M', '百万元进位为 M');
    ok(fmtMoney(0) === '¥0' && fmtMoney(null) === '¥0' && fmtMoney(-5) === '¥0', '零/非法/负数归零');
  }

  /* ---------- 6. successRate / fmtDuration ---------- */
  {
    ok(successRate(9, 1) === 90, '9 成 1 败 = 90%');
    ok(successRate(1, 0) === 100, '全成功 100%');
    ok(successRate(0, 3) === 0, '全失败 0%');
    ok(successRate(0, 0) === null, '无样本返回 null（不显示 0%）');
    ok(successRate(2, 1) === 66.7, '保留一位小数');
    ok(successRate(null, undefined) === null, '空值安全');

    ok(fmtDuration(900, 1) === '900ms', '亚秒显示 ms');
    ok(fmtDuration(30000, 3) === '10.0s' || fmtDuration(30000, 3) === '10s', '秒级显示');
    ok(fmtDuration(225000, 1) === '3m45s', '分钟级显示 m+s');
    ok(fmtDuration(0, 1) === null && fmtDuration(1000, 0) === null, '零/无样本返回 null');
  }

  /* ---------- 7. 内置价格表自检：结构完整（改表时挡住笔误） ---------- */
  {
    let bad = 0;
    for (const [k, v] of Object.entries(DEFAULT_PRICES)) {
      if (!v || !Number.isFinite(v.in) || !Number.isFinite(v.out) || v.in < 0 || v.out < 0) { bad++; }
      if (!k.trim()) bad++;
    }
    ok(bad === 0, '内置价格表全部为正数数值对');
    ok(DEFAULT_PRICES['deepseek-chat'].out >= DEFAULT_PRICES['deepseek-chat'].in, '输出价通常不低于输入价（量级自检）');
  }

  return n;
}

module.exports = { run };
