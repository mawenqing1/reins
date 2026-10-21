/* ============================================================
   Reins — 自动化调度引擎（主进程常驻，轻量时间轮）
   ------------------------------------------------------------
   - 三种频率：daily（每日 time）/ weekly（每周 weekday+time）/ cron（5 字段标准表达式）
   - setInterval 轮询（默认 30s）+ 每次触发即推进 nextRun，天然防同分钟重复触发
   - 休眠唤醒补执行：系统休眠时定时器暂停，唤醒后（powerMonitor resume / unlock-screen
     主动调 wake()）比对 now 与错过的 nextRun——落在补执行窗口（默认 5 分钟）内的照常触发，
     超窗的只记 lastSkip 不补（避免一觉醒来补跑十份报告）
   - 全部回调异步派发（fire-and-forget），绝不阻塞事件循环
   - 持久化由宿主注入（settings.json 的 schedules 字段），本模块不碰磁盘
   - cron 解析零依赖：支持 星号、步进(星号/n 与 a-b/n)、区间(a-b)、列表(a,b,c)；
     dom 与 dow 同时受限时按标准 cron 任一命中即可（OR 语义）
   ============================================================ */

const KIND_DEFAULTS = {
  standup: { name: '站报生成', freq: 'daily', time: '09:30' },
  weekly:  { name: '周报生成', freq: 'weekly', weekday: 5, time: '17:00' },
  /* 每日摘要：任务概况 + 失败/超时告警汇总，写看板并可推飞书（与站报/周报同一条时间轮） */
  digest:  { name: '每日摘要', freq: 'daily', time: '18:00' },
};

/* 推送去向：webhook（沿用「集成」页 Webhook 地址）/ feishu（飞书自建应用或群机器人）/
   both（两边都发）/ none（只写看板，不推送） */
const OUT_TARGETS = ['none', 'webhook', 'feishu', 'both'];
function normalizeOut(input) {
  if (OUT_TARGETS.includes(input)) return input;
  if (input && typeof input === 'object') {
    if (input.feishu && input.webhook) return 'both';
    if (input.feishu) return 'feishu';
    if (input.webhook) return 'webhook';
  }
  return 'none';
}

/* ---------- cron：解析与下次命中 ---------- */
function expandField(field, lo, hi) {
  const out = new Set();
  for (const piece of String(field).split(',')) {
    const m = piece.match(/^(\*|\d+-\d+|\d+)(?:\/(\d+))?$/);
    if (!m) return null;
    const step = m[2] ? parseInt(m[2], 10) : 1;
    if (!Number.isFinite(step) || step <= 0) return null;
    let a = lo, b = hi;
    if (m[1] !== '*') {
      if (m[1].includes('-')) {
        const pr = m[1].split('-');
        a = parseInt(pr[0], 10); b = parseInt(pr[1], 10);
      } else {
        a = parseInt(m[1], 10);
        // 标准 cron 语义：单值带步长（5/15）等价 5-上限/15
        b = m[2] ? hi : a;
      }
      if (!Number.isFinite(a) || !Number.isFinite(b) || a < lo || b > hi || a > b) return null;
    }
    for (let v = a; v <= b; v += step) out.add(v);
  }
  return out.size ? out : null;
}

function parseCron(expr) {
  const parts = String(expr || '').trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const min = expandField(parts[0], 0, 59);
  const hour = expandField(parts[1], 0, 23);
  const dom = expandField(parts[2], 1, 31);
  const month = expandField(parts[3], 1, 12);
  let dow = expandField(parts[4], 0, 7);
  if (!min || !hour || !dom || !month || !dow) return null;
  if (dow.has(7)) { dow.delete(7); dow.add(0); }   // cron 惯例：7 = 周日
  const full = (set, lo, hi) => { for (let v = lo; v <= hi; v++) if (!set.has(v)) return false; return true; };
  return {
    min, hour, dom, month, dow,
    domRestricted: !full(dom, 1, 31),
    dowRestricted: !full(dow, 0, 6),
  };
}

/* 下次命中时刻（epoch ms，严格晚于 from）；不命中/非法表达式返回 null。
   按天→时→分逐级跳过；天数守卫 4 年（覆盖 2·29 这类最稀疏命中），
   时/分跳过每天最多 ~84 次，总迭代 ~12 万，毫秒级 */
function cronNext(expr, from) {
  const c = parseCron(expr);
  if (!c) return null;
  const d = new Date(from);
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);
  let dayGuard = 0;
  while (dayGuard <= 366 * 4 + 2) {
    const monthOk = c.month.has(d.getMonth() + 1);
    const domOk = c.dom.has(d.getDate());
    const dowOk = c.dow.has(d.getDay());
    const dayOk = c.domRestricted && c.dowRestricted ? (domOk || dowOk) : (domOk && dowOk);
    if (!(monthOk && dayOk)) { d.setDate(d.getDate() + 1); d.setHours(0, 0, 0, 0); dayGuard++; continue; }
    if (!c.hour.has(d.getHours())) { d.setHours(d.getHours() + 1, 0, 0, 0); continue; }
    if (!c.min.has(d.getMinutes())) { d.setMinutes(d.getMinutes() + 1, 0, 0); continue; }
    return d.getTime();
  }
  return null;
}

/* ---------- 每日/每周下次触发 ---------- */
function parseHHMM(t) {
  const m = String(t || '').match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = parseInt(m[1], 10), mi = parseInt(m[2], 10);
  if (h > 23 || mi > 59) return null;
  return { h, mi };
}

function atTime(day, t) {
  const d = new Date(day);
  d.setHours(t.h, t.mi, 0, 0);
  return d;
}

function nextRunOf(sc, from) {
  const base = from instanceof Date ? from : new Date(from || Date.now());
  if (sc.freq === 'cron') return cronNext(sc.cron, base);
  const t = parseHHMM(sc.time);
  if (!t) return null;
  if (sc.freq === 'weekly') {
    const wd = Math.max(0, Math.min(6, Number(sc.weekday)));
    for (let i = 0; i < 8; i++) {
      const day = new Date(base);
      day.setDate(day.getDate() + i);
      if (day.getDay() !== wd) continue;
      const at = atTime(day, t);
      if (at.getTime() > base.getTime()) return at.getTime();
    }
    return null;
  }
  const today = atTime(base, t);
  return today.getTime() > base.getTime() ? today.getTime() : today.getTime() + 24 * 3600 * 1000;
}

/* ---------- 输入校验与归一化 ---------- */
function genId() {
  return 'sc' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function validateSchedule(input) {
  if (!input || typeof input !== 'object') return { ok: false, errors: ['调度对象为空'] };
  const errors = [];
  const dft = KIND_DEFAULTS[input.kind] || KIND_DEFAULTS.standup;
  const sc = {
    id: typeof input.id === 'string' && input.id ? input.id : genId(),
    kind: KIND_DEFAULTS[input.kind] ? input.kind : 'standup',
    name: typeof input.name === 'string' && input.name.trim() ? input.name.trim().slice(0, 40) : dft.name,
    freq: ['daily', 'weekly', 'cron'].includes(input.freq) ? input.freq : dft.freq,
    time: parseHHMM(input.time) ? String(input.time).padStart(5, '0') : dft.time,
    weekday: Number.isFinite(Number(input.weekday)) && Number(input.weekday) >= 0 && Number(input.weekday) <= 6 ? Number(input.weekday) : (dft.weekday != null ? dft.weekday : 1),
    cron: parseCron(input.cron) ? String(input.cron).trim() : (dft.cron || '0 9 * * 1-5'),
    enabled: input.enabled === undefined ? true : !!input.enabled,
    webhook: !!input.webhook,
    /* 推送去向（digest 等报告）：显式 out 优先，未给时沿用旧字段 webhook 的布尔语义 */
    out: normalizeOut(input.out !== undefined ? input.out : (input.webhook ? 'webhook' : 'none')),
  };
  if (input.kind && !KIND_DEFAULTS[input.kind]) errors.push('未知调度类型：' + input.kind);
  if (input.out !== undefined && !OUT_TARGETS.includes(input.out) && typeof input.out !== 'object') errors.push('推送去向非法：' + input.out);
  if (input.freq === 'cron' && !parseCron(input.cron)) errors.push('cron 表达式非法（需 5 字段：分 时 日 月 周）');
  if (input.time && !parseHHMM(input.time)) errors.push('时间格式应为 HH:MM');
  if (input.freq === 'weekly' && !(Number(input.weekday) >= 0 && Number(input.weekday) <= 6)) errors.push('星期取值 0-6（0=周日）');
  if (errors.length) return { ok: false, errors };
  const nr = nextRunOf(sc, new Date());
  if (nr === null) return { ok: false, errors: ['无法计算出下次执行时间（检查频率配置）'] };
  sc.nextRun = nr;
  // 保留运行痕迹字段（lastRun/lastSkip/lastResult 由引擎写入，编辑时不丢）
  for (const k of ['lastRun', 'lastSkip', 'lastResult']) if (Number.isFinite(Number(input[k]))) sc[k] = Number(input[k]);
  return { ok: true, schedule: sc };
}

/* ---------- 调度器实例 ---------- */
/* 依赖注入：load()/save() 读写持久化列表；onFire(schedule, info) 异步派发触发
   （info: {dueAt, missed, manual}）。intervalMs 轮询周期；catchupMs 补执行窗口 */
function createScheduler(dep) {
  const d = dep || {};
  const intervalMs = Number.isFinite(d.intervalMs) ? d.intervalMs : 30000;
  const catchupMs = Number.isFinite(d.catchupMs) ? d.catchupMs : 5 * 60 * 1000;
  let timer = null;
  let firing = false;   // tick 重入保护：持久化写完再进下一轮（触发本身仍是异步派发）

  const persist = list => { try { d.save && d.save(list); } catch (e) { console.error('[scheduler] 持久化失败:', e.message); } };
  const fire = (sc, info) => {
    // 异步派发、异常隔离：回调抛错只记日志，绝不能打断时间轮
    Promise.resolve().then(() => d.onFire && d.onFire(sc, info)).catch(e => console.error('[scheduler] 触发回调失败:', e.message));
  };

  function tick() {
    if (firing) return;
    firing = true;
    try {
      const list = (d.load && d.load() || []).filter(s => s && typeof s === 'object');
      let dirty = false;
      const now = Date.now();
      for (const sc of list) {
        if (!sc.enabled) continue;
        const nr = Number.isFinite(Number(sc.nextRun)) && sc.nextRun > 0 ? sc.nextRun : nextRunOf(sc, new Date(now));
        if (nr === null || nr === 0) continue;
        if (now < nr) { if (nr !== sc.nextRun) { sc.nextRun = nr; dirty = true; } continue; }
        const lateBy = now - nr;
        if (lateBy <= catchupMs) {
          // 到点触发（含休眠唤醒窗口内的补执行）；先推进 nextRun 再派发，防同分钟双触发
          sc.lastRun = now;
          sc.nextRun = nextRunOf(sc, new Date(now)) || now + intervalMs;
          sc.lastResult = 'dispatched';
          dirty = true;
          fire(sc, { dueAt: nr, missed: lateBy > 60000, manual: false });
        } else {
          // 错过补执行窗口：跳过并留痕，不静默消失
          sc.lastSkip = now;
          sc.nextRun = nextRunOf(sc, new Date(now)) || now + intervalMs;
          dirty = true;
          console.warn('[scheduler] 调度错过补执行窗口，已跳过：' + (sc.name || sc.id));
        }
      }
      if (dirty) persist(list);
    } catch (e) {
      console.error('[scheduler] tick 异常（不中断调度）:', e.message);
    } finally {
      firing = false;
    }
  }

  return {
    start() { if (timer) return; timer = setInterval(tick, intervalMs); tick(); return true; },
    stop() { if (timer) { clearInterval(timer); timer = null; } },
    /* 休眠唤醒 / 解锁：立即对账（间隔轮询在休眠期停摆，等下一个 tick 可能晚半分钟） */
    wake() { tick(); },
    list() {
      return (d.load && d.load() || []).map(sc => {
        if (sc.enabled && !Number.isFinite(Number(sc.nextRun))) sc.nextRun = nextRunOf(sc, new Date()) || 0;
        return sc;
      });
    },
    upsert(input) {
      const v = validateSchedule(input);
      if (!v.ok) return v;
      const list = (d.load && d.load() || []).filter(s => s && typeof s === 'object');
      const i = list.findIndex(s => s.id === v.schedule.id);
      /* 未显式给 enabled 时继承原启用态：编辑暂停中的调度不会出现「短暂 enabled」窗口
       （validateSchedule 默认 true 是新建场景的期望值，编辑场景由这里纠正） */
      if (input.enabled === undefined && i >= 0) v.schedule.enabled = list[i].enabled !== false;
      if (i >= 0) list[i] = Object.assign({}, list[i], v.schedule);
      else list.push(v.schedule);
      persist(list);
      return { ok: true, schedule: list[i >= 0 ? i : list.length - 1] };
    },
    remove(id) {
      const list = (d.load && d.load() || []).filter(s => s && typeof s === 'object');
      const next = list.filter(s => s.id !== id);
      if (next.length === list.length) return { ok: false, errors: ['调度不存在'] };
      persist(next);
      return { ok: true };
    },
    toggle(id, enabled) {
      const list = (d.load && d.load() || []).filter(s => s && typeof s === 'object');
      const sc = list.find(s => s.id === id);
      if (!sc) return { ok: false, errors: ['调度不存在'] };
      sc.enabled = enabled !== false;
      if (sc.enabled) sc.nextRun = nextRunOf(sc, new Date()) || 0;   // 重新启用从"现在"重算，不补旧账
      persist(list);
      return { ok: true, schedule: sc };
    },
    /* 手动立即触发（设置页「立即运行」/连通性验证）：走同一派发通道，格式与定时触发一致 */
    runNow(id) {
      const list = (d.load && d.load() || []).filter(s => s && typeof s === 'object');
      const sc = list.find(s => s.id === id);
      if (!sc) return { ok: false, errors: ['调度不存在'] };
      const now = Date.now();
      sc.lastRun = now;
      sc.nextRun = nextRunOf(sc, new Date(now)) || now + intervalMs;
      persist(list);
      fire(sc, { dueAt: now, missed: false, manual: true });
      return { ok: true, schedule: sc };
    },
  };
}

module.exports = { createScheduler, validateSchedule, nextRunOf, cronNext, parseCron, KIND_DEFAULTS, OUT_TARGETS, normalizeOut };
