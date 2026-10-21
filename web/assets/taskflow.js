/* ============================================================
   Reins — 任务状态迁移规则（taskflow，UMD 纯函数）
   ------------------------------------------------------------
   通过（approve）/ 打回（reject）/ 撤回（revoke）三条迁移的判定与字段变更计划。
   此前规则散在两处（客户端按钮 + 飞书群指令），已出现分叉：飞书侧漏记打回次数
   （首过率口径）、客户端侧无状态守卫。收敛到这一个模块，两边同源调用：
   - 渲染层：<script> 引入（window.TaskFlow）
   - 单测：require 引入
   - 主进程（后续）：require('../web/assets/taskflow')
   约定：本模块只做「判定 + 变更计划」，不碰 DOM / 不落盘 / 不推事件——
   调用方按 plan 应用并负责各自的留痕与通知。
   ============================================================ */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.TaskFlow = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {

  const STATUS_LABELS = { todo: '待处理', doing: '进行中', review: '待验收', done: '已完成' };
  const statusLabel = s => STATUS_LABELS[s] || String(s || '');

  /* 流水线打回重置的唯一口径（客户端 doReject 与飞书 reject 原本各写一份） */
  const PIPE_RESET = { status: 'idle', mode: '', stages: null, cur: 0, round: 1, stageNo: 0, gate: null, reworkCtx: null };
  function applyPipelineReset(p) {
    if (p && typeof p === 'object') Object.assign(p, PIPE_RESET);
    return p;
  }

  /* 验收通过：review → done。
     拦三种情况：已归档重复验收 / 非待验收状态 / 有未裁决的代码变更（拟议 diff 必须先应用或放弃） */
  function approve(task) {
    const t = task || {};
    if (t.status === 'done') return { ok: false, code: 'done', message: (t.key || '') + ' 已归档，无需重复验收' };
    if (t.status !== 'review') return { ok: false, code: 'not-review', message: (t.key || '') + ' 当前是「' + statusLabel(t.status) + '」，只有待验收的任务才能通过（Agent 执行完成后才是待验收）' };
    if (t.delivery && t.delivery.diff && t.delivery.diffState === 'pending') {
      return { ok: false, code: 'undecided-diff', message: (t.key || '') + ' 还有未裁决的代码变更，需先确认应用或放弃' };
    }
    return { ok: true, to: 'done', event: 'task.done', rejections: Number(t.rejections) || 0 };
  }

  /* 验收打回：非 done → todo；反馈写入多轮对话；流水线任务整链重置；
     打回计数（首过率口径：打回后的再次交付不算一次通过）。
     source（'飞书群' 等）只进反馈标注，不影响规则本身 */
  function reject(task, feedback, source) {
    const t = task || {};
    if (t.status === 'done') return { ok: false, code: 'done', message: (t.key || '') + ' 已归档，无法打回（可重新打开任务）' };
    const fb = String(feedback || '').trim() || '验收未通过，请按意见修改。';
    const src = source ? '（来自' + source + '）' : '';
    return {
      ok: true, to: 'todo', event: 'task.rejected',
      feedback: fb,
      threadText: '【验收反馈】' + fb + src,
      commentText: '验收打回：' + fb + src,
      resetPipeline: !!(t.pipeline && t.pipeline.on),
      pipelineTimeline: '流水线已重置：将带着验收意见重新拆解执行',
      rejections: (Number(t.rejections) || 0) + 1,
    };
  }

  /* 撤回验收：review → doing（误点通过后反悔 / 重新指派）。
     已归档的任务不可撤回——归档可能已触发下游（Git 推送 / Webhook），要走打回重做 */
  function revoke(task) {
    const t = task || {};
    if (t.status === 'done') return { ok: false, code: 'done', message: (t.key || '') + ' 已归档；如需重做请打回并附原因' };
    if (t.status !== 'review') return { ok: false, code: 'not-review', message: (t.key || '') + ' 当前是「' + statusLabel(t.status) + '」，无需撤回（只有待验收可撤回）' };
    return { ok: true, to: 'doing' };
  }

  /* 打回的应用层：把 reject() 的计划落到任务上（thread / 状态 / pr / 打回计数 / 流水线重置）。
     客户端按钮与飞书指令共用这一份应用逻辑；调用方只保留各自的留痕文案与通知 */
  function applyReject(task, plan) {
    if (!task || !plan || !plan.ok) return false;
    task.thread = task.thread || [];
    task.thread.push({ role: 'user', content: plan.threadText });
    task.status = plan.to;
    task.pr = null;
    task.rejections = plan.rejections;
    if (plan.resetPipeline && task.pipeline) applyPipelineReset(task.pipeline);
    return true;
  }

  return { approve, reject, revoke, applyReject, applyPipelineReset, PIPE_RESET, statusLabel };
});
