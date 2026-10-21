/* web/assets/taskflow.js — 任务状态迁移共享规则（require 真身 + app.js/app.html 接线断言）
   通过 / 打回 / 撤回三条迁移此前散在客户端按钮与飞书群指令两处，本模块收敛为单一判定源 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const TaskFlow = require('../web/assets/taskflow.js');
const SRC = fs.readFileSync(path.join(__dirname, '..', 'web', 'assets', 'app.js'), 'utf8');
const HTML = fs.readFileSync(path.join(__dirname, '..', 'web', 'app.html'), 'utf8');

async function run() {
  let n = 0;
  const ok = (c, m) => { n++; assert.ok(c, m); };
  const eq = (a, b, m) => { n++; assert.strictEqual(a, b, m); };

  /* ---------- 1. UMD 双端可用 ---------- */
  ok(typeof TaskFlow.approve === 'function' && typeof TaskFlow.reject === 'function' && typeof TaskFlow.revoke === 'function', '三条迁移函数齐备');
  ok(globalThis.TaskFlow === TaskFlow, '浏览器全局注入');

  /* ---------- 2. approve：三重守卫 ---------- */
  {
    const mk = () => ({ key: 'REINS-1', status: 'review', delivery: null, pipeline: null, rejections: 0 });
    ok(TaskFlow.approve(mk()).ok === true, '待验收可归档');
    const d = mk(); d.status = 'done';
    ok(TaskFlow.approve(d).code === 'done', '已归档拒绝重复验收');
    const t2 = mk(); t2.status = 'doing';
    ok(TaskFlow.approve(t2).code === 'not-review' && /只有待验收/.test(TaskFlow.approve(t2).message), '非待验收给出可解释拒绝');
    const pend = mk(); pend.delivery = { diff: { files: [] }, diffState: 'pending' };
    ok(TaskFlow.approve(pend).code === 'undecided-diff', '未裁决代码变更拦截');
    const applied = mk(); applied.delivery = { diff: { files: [] }, diffState: 'applied' };
    ok(TaskFlow.approve(applied).ok === true, '已裁决（applied）放行');
    eq(TaskFlow.approve(mk()).to, 'done', '目标状态 done');
    eq(TaskFlow.approve(mk()).event, 'task.done', '事件名统一');
  }

  /* ---------- 3. reject：变更计划与打回计数 ---------- */
  {
    const mk = () => ({ key: 'REINS-2', status: 'review', thread: [], pipeline: null, rejections: 0 });
    let r = TaskFlow.reject(mk(), '第二部分缺来源');
    ok(r.ok && r.to === 'todo' && r.event === 'task.rejected', '待验收可打回');
    ok(/第二部分缺来源/.test(r.threadText) && /【验收反馈】/.test(r.threadText), '反馈进多轮对话');
    ok(/验收未通过，请按意见修改/.test(TaskFlow.reject(mk(), '').feedback), '空反馈给默认话术');
    ok(/（来自飞书群）/.test(TaskFlow.reject(mk(), 'x', '飞书群').threadText), '来源标注');
    ok(TaskFlow.reject(mk(), 'x', '飞书群').commentText.startsWith('验收打回：'), '评论文案');

    const done = mk(); done.status = 'done';
    ok(TaskFlow.reject(done, 'x').code === 'done', '已归档不可打回');

    /* 打回计数：首过率口径的同一来源 */
    eq(TaskFlow.reject(mk(), 'x').rejections, 1, '无历史打回 → 1');
    const twice = mk(); twice.rejections = 1;
    eq(TaskFlow.reject(twice, 'x').rejections, 2, '累加历史打回');

    /* 流水线重置判定与重置口径 */
    const pipe = mk(); pipe.pipeline = { on: true, status: 'running', stages: [{ id: 's1' }], gate: { round: 2 }, reworkCtx: { feedback: 'x' }, cur: 3, mode: 'm', round: 2, stageNo: 7 };
    const rp = TaskFlow.reject(pipe, 'x');
    ok(rp.resetPipeline === true, '流水线任务标记重置');
    TaskFlow.applyPipelineReset(pipe.pipeline);
    ok(pipe.pipeline.status === 'idle' && pipe.pipeline.stages === null && pipe.pipeline.gate === null
      && pipe.pipeline.reworkCtx === null && pipe.pipeline.cur === 0 && pipe.pipeline.round === 1
      && pipe.pipeline.stageNo === 0 && pipe.pipeline.mode === '', '重置后字段与 PIPE_RESET 完全一致');
    ok(TaskFlow.reject(mk(), 'x').resetPipeline === false, '非流水线不标记重置');
    const off = mk(); off.pipeline = { on: false, status: 'idle' };
    ok(TaskFlow.reject(off, 'x').resetPipeline === false, 'pipeline.on=false 不重置');
  }

  /* ---------- 4. revoke：撤回验收 ---------- */
  {
    const mk = () => ({ key: 'REINS-3', status: 'review' });
    ok(TaskFlow.revoke(mk()).ok === true && TaskFlow.revoke(mk()).to === 'doing', '待验收可撤回到进行中');
    const done = mk(); done.status = 'done';
    ok(TaskFlow.revoke(done).code === 'done' && /打回/.test(TaskFlow.revoke(done).message), '已归档引导走打回');
    const todo = mk(); todo.status = 'todo';
    ok(TaskFlow.revoke(todo).code === 'not-review', '非待验收无需撤回');
  }

  /* ---------- 5. 接线断言：三条迁移的两个入口都走 TaskFlow（防回退到各写一份） ---------- */
  {
    ok(/<script src="assets\/taskflow.js"><\/script>/.test(HTML), 'app.html 引入 taskflow.js');
    ok(/const r = TaskFlow\.approve\(t\);/.test(SRC) && /const v = TaskFlow\.approve\(t\);/.test(SRC), '客户端归档与飞书 approve 都走共享判定');
    ok(/const r = TaskFlow\.reject\(t, \$\('#rj-text'\)\.value\.trim\(\)\);/.test(SRC), '客户端打回走共享变更计划');
    ok(/TaskFlow\.reject\(t, reason, '飞书群'\)/.test(SRC), '飞书 reject 走共享变更计划');
    ok(/TaskFlow\.revoke\(t\)/.test(SRC), '飞书 revoke 走共享判定');
    /* 流水线重置口径已内聚进 applyReject（应用层），入口不再直呼 applyPipelineReset */
    /* 飞书侧打回计数经 applyReject 同源（此前漏记导致首过率分叉），§6 已断言两入口接线 */
    /* 旧的内联重置代码不应再残留于这两个入口 */
    const mergeD = SRC.slice(SRC.indexOf('function doReject'), SRC.indexOf('function doReject') + 900);
    ok(!/pipeline\.status = 'idle'/.test(mergeD), 'doReject 内联流水线重置已移除');
  }

  /* ---------- 6. applyReject：应用层同源（thread/状态/计数/流水线重置一次落位） ---------- */
  {
    const mk = () => ({ key: 'REINS-4', status: 'review', thread: [], pr: '交付 #9', rejections: 0, pipeline: { on: true, status: 'running', stages: [{ id: 's' }], gate: { round: 2 }, reworkCtx: { qaReport: 'x' }, cur: 2, mode: 'm', round: 2, stageNo: 5 } });
    const t = mk();
    const plan = TaskFlow.reject(t, '改语气', '飞书群');
    ok(TaskFlow.applyReject(t, plan) === true, '应用成功');
    ok(t.status === 'todo' && t.pr === null && t.rejections === 1, '状态/pr/打回计数落位');
    ok(t.thread.length === 1 && /【验收反馈】改语气（来自飞书群）/.test(t.thread[0].content), '反馈写入 thread');
    ok(t.pipeline.status === 'idle' && t.pipeline.stages === null && t.pipeline.gate === null, '流水线重置落位');
    ok(TaskFlow.applyReject(t, null) === false && TaskFlow.applyReject(null, plan) === false, '坏计划/坏任务安全拒绝');
    const t2 = mk(); t2.pipeline = null;
    TaskFlow.applyReject(t2, TaskFlow.reject(t2, 'x'));
    ok(t2.status === 'todo', '无流水线任务照常应用');
  }
  /* 接线：两个入口都走 applyReject */
  {
    ok(SRC.includes('TaskFlow.applyReject(t, r);') && SRC.includes('TaskFlow.applyReject(t, v);'), '客户端与飞书打回都走 applyReject');
    ok(!/t\.thread\.push\(\{ role: 'user', content: r\.threadText \}\)/.test(SRC), '客户端打回的内联应用已移除');
  }

  return n;
}

module.exports = { run };
