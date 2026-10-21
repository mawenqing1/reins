/* ============================================================
   Reins — Token 成本估算（纯函数，零依赖）
   ------------------------------------------------------------
   背景：Agent 卡片一直只显示「tokens 消耗」，但 token 数与钱不是线性关系——
   不同模型单价差 20 倍以上，用户无法据此判断「这个 Agent 跑一天要多少钱」。
   本模块把 tokens × 单价折算成金额，作为概览与 Agent 卡片的第二指标。

   设计取舍：
   - 价格是**用户可覆盖的配置**（settings.modelPrices），内置表只作默认值与起点：
     各家价格随促销/版本变动频繁，硬编码「真相」必然会错，宁可让用户改。
   - 计价单位统一为「元 / 百万 tokens」：国内厂商都按这个口径报价，避免 1K 换算歧义。
   - 输入/输出分开计价（输出通常是输入的 3–4 倍），按 usage 的 prompt/completion 分算；
     拿不到明细时按总量 × 输入价保守估算，并在结果里标记 priced=false 的近似来源。
   - 未知模型不编造价格：返回 null，界面显示「未定价」而不是给个看起来很像真的数字。
   ============================================================ */

/* 内置参考价（元 / 1M tokens，输入 / 输出）。仅作默认起点，用户可在设置里覆盖。
   数值为公开报价的量级参考，不保证实时准确——真金白银的核算请以账单为准 */
const DEFAULT_PRICES = {
  'glm-4.7': { in: 4, out: 16 },
  'glm-4-plus': { in: 5, out: 15 },
  'glm-4-flash': { in: 0.1, out: 0.1 },
  'deepseek-chat': { in: 2, out: 8 },
  'deepseek-reasoner': { in: 4, out: 16 },
  'moonshot-v1-32k': { in: 24, out: 24 },
  'qwen-plus': { in: 0.8, out: 2 },
  'qwen-max': { in: 20, out: 60 },
  'gpt-4o-mini': { in: 1, out: 4 },
  'gpt-4o': { in: 18, out: 72 },
  'Qwen/Qwen2.5-72B-Instruct': { in: 4, out: 4 },
};

/* 按服务商兜底价：模型名没命中时用，仍比"未定价"更有参考价值；
   自定义/未知服务商返回 null（不猜） */
const PROVIDER_FALLBACK = {
  glm: { in: 4, out: 16 },
  deepseek: { in: 2, out: 8 },
  kimi: { in: 24, out: 24 },
  qwen: { in: 0.8, out: 2 },
  openai: { in: 1, out: 4 },
  siliconflow: { in: 4, out: 4 },
};

const isNum = (v: any): boolean => typeof v === 'number' && Number.isFinite(v) && v >= 0;

/* 取单价：用户覆盖 > 内置模型价 > 服务商兜底 > null */
function priceOf(model: any, provider: any, overrides: any): { in: number; out: number; source: string } | null {
  const m = String(model || '').trim();
  const p = String(provider || '').trim();
  const ov = overrides && typeof overrides === 'object' ? overrides : {};
  const pick = src => {
    if (!src || typeof src !== 'object') return null;
    const v = src[m] || src[m.toLowerCase()];
    if (v && isNum(Number(v.in)) && isNum(Number(v.out))) return { in: Number(v.in), out: Number(v.out), source: 'custom' };
    return null;
  };
  return pick(ov) || pick(DEFAULT_PRICES) || (PROVIDER_FALLBACK[p] ? { ...PROVIDER_FALLBACK[p], source: 'provider' } : null);
}

/* 从 usage 里取输入/输出 tokens（兼容 OpenAI 与各家兼容协议的多种字段名） */
function splitUsage(usage: any): { inTokens: number; outTokens: number; total: number; split: string } {
  const u = usage && typeof usage === 'object' ? usage : {};
  const n = v => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const inTok = n(u.prompt_tokens) || n(u.input_tokens) || n(u.promptTokens);
  const outTok = n(u.completion_tokens) || n(u.output_tokens) || n(u.completionTokens);
  const total = n(u.total_tokens) || n(u.totalTokens) || (inTok + outTok);
  /* 只有总量、没有明细：按 3:1 拆（多数任务的典型输入输出比），并在结果里标记估算 */
  if (!inTok && !outTok && total) return { inTokens: Math.round(total * 0.75), outTokens: Math.round(total * 0.25), total, split: 'assumed' };
  return { inTokens: inTok, outTokens: outTok, total: total || inTok + outTok, split: 'exact' };
}

/* 主入口：返回 { ok, cost, currency, priced, source, tokens:{...} }
   cost 单位为元（保留到 0.0001，避免小额被四舍五入成 0）；未定价时 ok=false 且 cost=null */
function estimateCost(usage: any, model: any, provider: any, overrides: any): any {
  const t = splitUsage(usage);
  if (!t.total) return { ok: false, cost: null, reason: '没有 token 用量', tokens: t };
  const price = priceOf(model, provider, overrides);
  if (!price) {
    return {
      ok: false, cost: null, reason: '该模型未定价（设置 → 模型与密钥 → 价格表可补充）',
      priced: false, tokens: t, model: String(model || ''), currency: 'CNY',
    };
  }
  /* 元/1M tokens × tokens / 1e6 */
  const raw = (t.inTokens * price.in + t.outTokens * price.out) / 1e6;
  return {
    ok: true, cost: Math.round(raw * 10000) / 10000, currency: 'CNY',
    priced: true, source: price.source, price: { in: price.in, out: price.out },
    tokens: t, model: String(model || ''),
  };
}

/* 余额式累加：把一次执行折进 Agent 的累计值。price 未知时只加 tokens、不动 cost，
   并用 unpriced 计数让界面能说明「有 N 次执行未计入金额」 */
function accumulate(target: any, est: any, tokensTotal?: any): any {
  const t = target && typeof target === 'object' ? target : {};
  const tok = Number.isFinite(Number(tokensTotal)) ? Number(tokensTotal) : (est && est.tokens && est.tokens.total) || 0;
  t.tokens = (Number(t.tokens) || 0) + tok;
  if (est && est.ok && Number.isFinite(est.cost)) {
    t.cost = Math.round(((Number(t.cost) || 0) + est.cost) * 10000) / 10000;
    t.priced = (Number(t.priced) || 0) + 1;
  } else if (tok) {
    t.unpriced = (Number(t.unpriced) || 0) + 1;
  }
  return t;
}

/* 金额展示：小额保留到分厘，大额进位到元/千元，避免「¥0.00」这种信息量为零的展示 */
function fmtMoney(v: any): string {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return '¥0';
  if (n < 0.01) return '¥' + n.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
  if (n < 1) return '¥' + n.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
  if (n < 1000) return '¥' + n.toFixed(2).replace(/\.00$/, '');
  if (n < 1e6) return '¥' + (n / 1000).toFixed(2).replace(/\.00$/, '') + 'k';
  return '¥' + (n / 1e6).toFixed(2) + 'M';
}

/* 成功率：失败数按「失败次数」计，与 done 分开；无任何执行时返回 null（不显示 0%） */
function successRate(done: any, fail: any): number | null {
  const d = Number(done) || 0, f = Number(fail) || 0;
  const total = d + f;
  if (!total) return null;
  return Math.round((d / total) * 1000) / 10;
}

/* 平均耗时（毫秒 → 自适应文案）；样本 0 返回 null。
   样本数为 0 时不能拿 ms 硬除：Math.max(1,0) 会把「没有样本」伪装成一个有意义的数字 */
function fmtDuration(ms: any, samples: any): string | null {
  const s = Number(samples);
  if (!Number.isFinite(s) || s <= 0) return null;
  const n = Number(ms) / s;
  if (!Number.isFinite(n) || n <= 0) return null;
  if (n < 1000) return Math.round(n) + 'ms';
  if (n < 60000) return (n / 1000).toFixed(n < 10000 ? 1 : 0) + 's';
  const m = Math.floor(n / 60000), sec = Math.round((n % 60000) / 1000);
  return m + 'm' + (sec ? sec + 's' : '');
}

export = {
  DEFAULT_PRICES, PROVIDER_FALLBACK,
  priceOf, splitUsage, estimateCost, accumulate, fmtMoney, successRate, fmtDuration,
};
