/* services/scheduler.js — cron 解析 / 下次命中 / 校验 / 时间轮触发 / 补执行窗口 / CRUD */
import assert = require('assert');
import scheduler = require('../services/scheduler');
const { createScheduler, validateSchedule, nextRunOf, cronNext, parseCron } = scheduler;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const at = (s) => new Date(s);

async function run() {
  let n = 0;
  const ok = (c, m) => { n++; assert.ok(c, m); };

  /* 1. cron 解析 */
  ok(parseCron('*/15 * * * *').min.has(15) && parseCron('*/15 * * * *').min.has(45), '步进分钟展开');
  ok(parseCron('0 9 * * 1-5').dowRestricted, '工作日区间视为受限');
  ok(parseCron('0 9 * * 7').dow.has(0), '7 归一为周日 0');
  ok(parseCron('* * * * *') && !parseCron('* * * * *').domRestricted, '全星号不限 dom');
  ok(parseCron('1,15,30 * * * *').min.size === 3, '列表展开');
  ok(!parseCron('61 * * * *') && !parseCron('* * * *') && !parseCron('a b c d e') && !parseCron(''), '非法表达式返回 null');
  ok(!parseCron('5-1 * * * *'), '倒序区间非法');

  /* 2. cronNext 下次命中 */
  {
    const t = cronNext('* * * * *', at('2026-10-19T08:00:30'));
    ok(t === at('2026-10-19T08:01:00').getTime(), '每分钟命中严格晚于起点');
  }
  {
    const a = cronNext('30 9 * * *', at('2026-10-19T08:00:00'));
    const b = cronNext('30 9 * * *', at('2026-10-19T10:00:00'));
    ok(a === at('2026-10-19T09:30:00').getTime(), '当日未到取当日');
    ok(b === at('2026-10-20T09:30:00').getTime(), '已过取次日');
  }
  {   // 每周五 17:00：起点 2026-10-19（周一）→ 下个周五 10-23
    const t = cronNext('0 17 * * 5', at('2026-10-19T10:00:00'));
    const d = new Date(t);
    ok(d.getDay() === 5 && d.getHours() === 17 && d.getMinutes() === 0 && d.getDate() === 23, '周命中落在正确的工作日');
  }
  {   // 最稀疏命中：2 月 29 日（4 年守卫内可解）
    const t = cronNext('0 0 29 2 *', at('2026-03-01T00:00:00'));
    const d = new Date(t);
    ok(d.getFullYear() === 2028 && d.getMonth() === 1 && d.getDate() === 29, '稀疏日期命中 2028-02-29');
  }

  /* 3. daily / weekly nextRunOf */
  {
    const sc = { freq: 'daily', time: '09:30' };
    ok(nextRunOf(sc, at('2026-10-19T08:00:00')) === at('2026-10-19T09:30:00').getTime(), 'daily 当日未到');
    ok(nextRunOf(sc, at('2026-10-19T10:00:00')) === at('2026-10-20T09:30:00').getTime(), 'daily 已过取次日');
    const wk = { freq: 'weekly', weekday: 5, time: '17:00' };
    const w = new Date(nextRunOf(wk, at('2026-10-17T18:00:00')));   // 周六晚 → 下周五
    ok(w.getDay() === 5 && w.getDate() === 23, 'weekly 跨周取下周匹配日');
    ok(nextRunOf({ freq: 'daily', time: '25:00' }, new Date()) === null, '非法时间算不出下次');
  }

  /* 4. validateSchedule 校验与默认值 */
  {
    const v = validateSchedule({ kind: 'standup', freq: 'daily', time: '09:30' });
    ok(v.ok && v.schedule.enabled === true && Number.isFinite(v.schedule.nextRun), '合法输入通过并算出 nextRun');
    const v2 = validateSchedule({ kind: 'weekly', freq: 'cron', cron: 'bad expr' });
    ok(!v2.ok && v2.errors.some(e => /cron/.test(e)), '非法 cron 报错');
    const v3 = validateSchedule({ time: '25:61' });
    ok(!v3.ok, '非法时间报错');
    const v4 = validateSchedule({ freq: 'weekly', weekday: 9 });
    ok(!v4.ok, 'weekday 越界报错');
    const v5 = validateSchedule({ id: 'sc1', freq: 'daily', time: '09:30', lastRun: 123 });
    ok(v5.ok && v5.schedule.lastRun === 123, '运行痕迹字段编辑时保留');
  }

  /* 5. 时间轮：到点触发 / 补执行窗口 / 超窗跳过 / 禁用不触发 */
  {
    const fired = [];
    const db = { list: [] };
    const saved = [];
    const s = createScheduler({
      intervalMs: 20,
      load: () => db.list,
      save: l => { db.list = l; saved.push(1); },
      onFire: (sc, info) => fired.push({ sc, info }),
    });
    db.list = [{ id: 'a', kind: 'standup', name: '站报', freq: 'daily', time: '09:30', enabled: true, nextRun: Date.now() - 10 * 1000 }];
    s.start();
    await sleep(60);
    ok(fired.length === 1 && fired[0].info.missed === false, '准点触发（10s 误差不算 missed）');
    ok(fired[0].sc.lastRun > 0 && fired[0].sc.nextRun > Date.now(), '触发后推进 nextRun');
    ok(saved.length >= 1, '触发后持久化');
    ok(db.list[0].lastResult === 'dispatched', '触发留痕 lastResult');

    // 超窗：错过的 nextRun 在补执行窗口（5 分钟）之外 → 跳过留痕，不触发
    fired.length = 0;
    db.list = [{ id: 'b', kind: 'standup', name: '站报', freq: 'daily', time: '09:30', enabled: true, nextRun: Date.now() - 10 * 60 * 1000 }];
    s.wake();
    await sleep(40);
    ok(fired.length === 0, '超过 5 分钟窗口不补执行');
    ok(db.list[0].lastSkip > 0 && db.list[0].nextRun > Date.now(), '跳过留痕并推进 nextRun');

    // 窗口内补执行：晚 2 分钟 → 触发且 missed=true（休眠唤醒场景）
    fired.length = 0;
    db.list = [{ id: 'c', kind: 'standup', name: '站报', freq: 'daily', time: '09:30', enabled: true, nextRun: Date.now() - 2 * 60 * 1000 }];
    s.wake();
    await sleep(40);
    ok(fired.length === 1 && fired[0].info.missed === true, '窗口内补执行且标记 missed');

    // 禁用的调度：nextRun 已过也不触发
    fired.length = 0;
    db.list = [{ id: 'd', kind: 'standup', name: '站报', freq: 'daily', time: '09:30', enabled: false, nextRun: Date.now() - 1000 }];
    s.wake();
    await sleep(40);
    ok(fired.length === 0, '禁用调度不触发');
    s.stop();

    // 同一分钟内不重复触发：nextRun 推进后多次 tick 只触发一次（上面 60ms 内已含 3 次 tick 仍 1 次，这里显式再验）
    fired.length = 0;
    db.list = [{ id: 'e', kind: 'standup', name: '站报', freq: 'daily', time: '23:59', enabled: true, nextRun: Date.now() - 1000 }];
    const s2 = createScheduler({ intervalMs: 15, load: () => db.list, save: () => { }, onFire: (sc, info) => fired.push(info) });
    s2.start();
    await sleep(80);
    ok(fired.length === 1, '多次 tick 不重复触发同一调度');
    s2.stop();
  }

  /* 6. CRUD：upsert / toggle / remove / runNow */
  {
    const fired = [];
    const db = { list: [] };
    const s = createScheduler({ intervalMs: 60000, load: () => db.list, save: l => { db.list = l.slice(); }, onFire: (sc, info) => fired.push({ sc, info }) });

    const add = s.upsert({ name: '每日站报', freq: 'daily', time: '09:30' });
    ok(add.ok && db.list.length === 1, 'upsert 新增');
    const bad = s.upsert({ freq: 'cron', cron: 'nope' });
    ok(!bad.ok && Array.isArray(bad.errors), '非法 upsert 返回错误列表');

    const edit = s.upsert({ id: add.schedule.id, freq: 'daily', time: '10:00' });
    ok(edit.ok && db.list[0].time === '10:00' && db.list[0].nextRun > Date.now(), '编辑重算 nextRun');

    const t1 = s.toggle(add.schedule.id, false);
    ok(t1.ok && db.list[0].enabled === false, '暂停');

    /* 编辑未显式给 enabled → 继承原启用态（暂停中的调度编辑后仍是暂停，消除短暂 enabled 窗口） */
    const editPaused = s.upsert({ id: add.schedule.id, freq: 'daily', time: '11:00' });
    ok(editPaused.ok && db.list[0].enabled === false && db.list[0].time === '11:00', '编辑继承原启用态（暂停保持暂停）');

    const t2 = s.toggle(add.schedule.id, true);
    ok(t2.ok && db.list[0].enabled === true && db.list[0].nextRun > Date.now(), '恢复启用从现在重算');

    s.runNow(add.schedule.id);
    await sleep(30);
    ok(fired.length === 1 && fired[0].info.manual === true, '手动立即触发走同一派发通道');
    ok(db.list[0].lastRun > 0, '手动触发留痕');

    ok(s.remove(add.schedule.id).ok && db.list.length === 0, '删除');
    ok(!s.remove('nonexistent').ok, '删除不存在的报错');
    ok(!s.toggle('nonexistent', true).ok, '切换不存在的报错');
    ok(s.list().length === 0, 'list 读取');
  }

  /* ---------- 空间定向（v1.1）：orgId/spaceId 透传与归一 ---------- */
  {
    const db = { list: [] };
    const s = createScheduler({ load: () => db.list, save: l => { db.list = l; }, onFire: () => { } });
    const v = validateSchedule({ kind: 'digest', freq: 'daily', time: '18:00', orgId: 'o1', spaceId: 'sp9' });
    ok(v.ok && v.schedule.orgId === 'o1' && v.schedule.spaceId === 'sp9', '定向字段透传');
    ok(validateSchedule({ kind: 'digest', freq: 'daily', time: '18:00' }).schedule.orgId === '', '缺省归空（跟随当前空间）');
    ok(validateSchedule({ kind: 'digest', freq: 'daily', time: '18:00', orgId: 42, spaceId: { x: 1 } }).schedule.spaceId === '', '坏类型归空不炸');
    ok(validateSchedule({ kind: 'digest', freq: 'daily', time: '18:00', orgId: 'x'.repeat(80) }).schedule.orgId.length === 40, '超长截断');
    s.upsert({ kind: 'digest', freq: 'daily', time: '18:00', orgId: 'o1', spaceId: 'sp9' });
    ok(db.list[0].orgId === 'o1' && db.list[0].spaceId === 'sp9', 'upsert 持久化定向');
    s.upsert({ id: db.list[0].id, freq: 'daily', time: '19:00', orgId: '', spaceId: '' });
    ok(db.list[0].orgId === '' && db.list[0].time === '19:00', '编辑可清空定向（改回跟随当前空间）');
  }

  /* ---------- 渲染层接线（源码断言，防回退） ---------- */
  {
    const fs = require('fs');
    const path = require('path');
    const SRC = fs.readFileSync(path.join(__dirname, '..', '..', 'web', 'assets', 'app.ts'), 'utf8');
    ok(/function schedResolveSpace\(sc\)/.test(SRC), 'schedResolveSpace 存在');
    ok(/fallback: true/.test(SRC) && /原定向空间已不存在/.test(SRC), '定向失效回落当前空间并如实提示');
    ok(/buildDigest\(sp, org\)/.test(SRC) && /buildWeekly\(sp, org\)/.test(SRC) && /buildStandup\(sp\)/.test(SRC), '三个报告生成器参数化（按定向空间聚合）');
    ok(/const tgt = schedResolveSpace\(sc\);/.test(SRC) && /sp\.tasks\.unshift\(t\)/.test(SRC), '触发写入定向空间而非当前空间');
    ok(/id="sc-space"|ds\('sc-space'/.test(SRC), '调度表单带空间选择');
    ok(/orgId: po \|\| ''/.test(SRC), '保存携带定向字段');
  }

  await sleep(1);
  return n;
}

module.exports = { run };
