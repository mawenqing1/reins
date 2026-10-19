/* 演示引擎流水线全链路集成自测（R-5/R-6/R-8 前端返工）—— vm 沙箱装载真实渲染层 app.js，
   桩 DOM/存储/定时器，手动驱动 sim 节拍：并行派发 / 打回精确清空 / 失败独立状态 / 取消与断点续跑 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function bootApp() {
  const timers = [];
  const store = {};
  const noop = () => { };
  const document = {
    addEventListener: noop,
    querySelector: () => null,
    querySelectorAll: () => [],
    getElementById: () => null,
    body: { classList: { add: noop, remove: noop, contains: () => false } },
  };
  const ctx = {
    document, navigator: {}, console,
    window: { addEventListener: noop, document },
    localStorage: {
      getItem: k => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: k => { delete store[k]; },
    },
    setTimeout: fn => { timers.push(fn); return timers.length; },   // sim 节拍由测试手动驱动
    clearTimeout: noop,
    setInterval: () => 0, clearInterval: noop,
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'web', 'assets', 'app.js'), 'utf8'), ctx, { filename: 'app.js' });
  /* 桩掉重渲染（DOM 表现不在本测范围，渲染接线由 pipeline-ui.test.js 源码断言覆盖） */
  vm.runInContext('refreshViews = () => {}; renderDrawer = () => {}; renderBell = () => {}; toast = () => {};', ctx);
  return {
    ctx, timers,
    ev: code => vm.runInContext(code, ctx),
    flush: async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); },   // 让 pipelineGate 微任务走完
    /* 单节拍推进：执行一个已排队定时器回调，直至条件成立 */
    stepUntil: async function (cond, maxBeats = 600) {
      for (let i = 0; i < maxBeats; i++) {
        if (this.ev(`!!(${cond})`)) return true;
        if (!this.timers.length) { await this.flush(); continue; }
        this.timers.shift()();
        await this.flush();
      }
      return this.ev(`!!(${cond})`);
    },
    /* 排空至无定时器且无新产出（含裁决微任务续排的节拍） */
    drain: async function (maxBeats = 800) { return this.stepUntil('false', maxBeats) || undefined; },
  };
}

/* 通用场景装配：sim Agent + 流水线角色 + 并行依赖图任务 pm → (be ∥ ui) → fe → qa */
function setup(app) {
  app.ev(`
    state = seed();
    O().agents.push({ id: 'ag-sim', name: '演示引擎', mode: 'sim', status: 'idle', provider: 'demo', model: 'sim-1',
      cliCommand: '', cliModel: '', runtime: 'local', scenePrompt: '', done: 0, tokens: 0, taskId: null });
    ensurePipelineRoles(['pmgr', 'pm', 'be', 'ui', 'fe', 'qa']);
    S().tasks.push({ id: 'tk1', key: 'T1', title: '并行流水线自测', type: 'feat', pri: 'P1', status: 'todo',
      assignee: null, pr: null, result: '', comments: [], history: [], createdAt: now(),
      pipeline: { on: true, status: 'idle', mode: 'std', serialChain: false, stages: null, waves: null,
        cur: 0, round: 1, maxRework: 5, stageNo: 0, gate: null, reworkCtx: null } });
    const p = byId('tk1').pipeline;
    p.stages = [
      { id: 's1', roleKey: 'pm', name: '产品文档', goal: '', state: 'pending', result: '', runs: 0, dependsOn: [] },
      { id: 's2', roleKey: 'be', name: '后端实现', goal: '', state: 'pending', result: '', runs: 0, dependsOn: ['s1'] },
      { id: 's3', roleKey: 'ui', name: 'UI 设计', goal: '', state: 'pending', result: '', runs: 0, dependsOn: ['s1'] },
      { id: 's4', roleKey: 'fe', name: '前端实现', goal: '', state: 'pending', result: '', runs: 0, dependsOn: ['s2', 's3'] },
      { id: 's5', roleKey: 'qa', name: '测试验证', goal: '', state: 'pending', result: '', runs: 0, dependsOn: ['s4'] },
    ];
    p.waves = [[0], [1, 2], [3], [4]];
    p.status = 'running'; byId('tk1').status = 'doing';
    save();
  `);
}

async function run() {
  let n = 0;
  const ok = (c, m) => { n++; assert.ok(c, m); };

  /* —— 场景 1：并行派发（R-8）→ 打回精确清空（R-6）→ 二轮交付 —— */
  {
    const app = bootApp();
    setup(app);
    app.ev(`pipeStep('tk1')`);
    ok(app.ev(`byId('tk1').pipeline.stages[0].state`) === 'running' && app.ev(`!!runs['tk1#s1']`), '首阶段派发（独立实例键 tk1#s1）');
    /* s1 完成后同波次 be/ui 必须同时派发——演示引擎不再被串行守卫压成单发 */
    ok(await app.stepUntil(`byId('tk1').pipeline.stages[1].state === 'running'`), '推进至第二波次');
    const par = app.ev(`({ s2: byId('tk1').pipeline.stages[1].state, s3: byId('tk1').pipeline.stages[2].state,
      r2: !!runs['tk1#s2'], r3: !!runs['tk1#s3'] })`);
    ok(par.s2 === 'running' && par.s3 === 'running' && par.r2 && par.r3, 'R-8：同波次 be/ui 并行执行（双独立实例同时在途）');
    /* 并行阶段的独立终端盒与甘特图并行展示 */
    const html = app.ev(`renderPipelinePanel(byId('tk1'))`);
    ok(html.includes('id="drawer-log-s2"') && html.includes('id="drawer-log-s3"'), '并行阶段各持独立运行终端盒');
    ok((html.match(/pw-stage running/g) || []).length === 2, '甘特图同波次两阶段并行展示');
    /* QA 完成后裁决打回 be：兄弟分支 ui 产出保留（R-6 核心） */
    app.ev(`pipeGateHeuristic = () => ({ action: 'rework', targets: ['be'], feedback: '修复后端', reason: '自测打回' });`);
    ok(await app.stepUntil(`byId('tk1').pipeline.gate && byId('tk1').pipeline.gate.action === 'rework'`), 'QA 完成并触发打回裁决');
    const st = app.ev(`byId('tk1').pipeline.stages.map(s => s.state + ':' + (s.result ? 'R' : '-') + ':' + (s.rework ? 1 : 0))`);
    ok(st[0] === 'done:R:0', '上游 pm 产出保留');
    ok(/^(pending|rework):-:1$/.test(st[1]), `目标 be 打回：产出清空 + 返工标记（采样时可能已再入执行，实际 ${st[1]}）`);
    ok(st[2] === 'done:R:0', 'R-6：兄弟分支 ui 产出保留（不再被整段误清）');
    ok(/^(pending|rework|running):-:0$/.test(st[3]) && /^(pending|rework|running):-:0$/.test(st[4]), `传递下游 fe/qa 连锁重跑（不带返工标记，实际 ${st[3]} / ${st[4]}）`);
    /* 二轮裁决通过 → 重跑链走完 → 交付总结 → 验收态 */
    app.ev(`pipeGateHeuristic = () => ({ action: 'pass', reason: '自测通过' });`);
    await app.drain();
    ok(app.ev(`byId('tk1').status`) === 'review' && !!app.ev(`byId('tk1').pr`), '打回重跑后全链路交付进入验收');
    ok(app.ev(`byId('tk1').pipeline.status`) === 'done', '流水线完成');
    ok(app.ev(`byId('tk1').pipeline.stages.length`) === 6 && app.ev(`byId('tk1').pipeline.stages.every(s => s.state === 'done')`), '含交付总结全部阶段完成');
  }

  /* —— 场景 2：阶段失败独立状态（R-5）+ 渲染 + 断点续跑原地重试 —— */
  {
    const app = bootApp();
    setup(app);
    app.ev(`pipeStep('tk1')`);
    const no = app.ev(`byId('tk1').pipeline.stages[0].no`);
    /* 主进程 error 事件按 stageNo 分流：失败阶段进入 failed（不再伪装成从未启动的 pending） */
    app.ev(`handleRunEvent({ type: 'error', taskId: 'tk1', stageNo: ${no}, message: 'HTTP 503 · 重试 3 次后耗尽' })`);
    const st = app.ev(`({ s1: byId('tk1').pipeline.stages[0].state, ps: byId('tk1').pipeline.status, ts: byId('tk1').status, run: !!runs['tk1#s1'] })`);
    ok(st.s1 === 'failed' && st.ps === 'paused' && st.ts === 'todo' && !st.run, 'R-5：失败阶段置 failed，流水线暂停、实例清理');
    const html = app.ev(`renderPipelinePanel(byId('tk1'))`);
    ok(html.includes('pp-stage failed') && html.includes('pw-stage failed'), '阶段清单与甘特图渲染 failed 配色类');
    ok(html.includes('✕') && html.includes('失败（可从断点重试）'), '失败图标与行内标注');
    /* 断点续跑：failed 回 pending 原地重试 */
    app.ev(`startPipeline('tk1')`);
    const rt = app.ev(`({ s1: byId('tk1').pipeline.stages[0].state, ps: byId('tk1').pipeline.status, run: !!runs['tk1#s1'] })`);
    ok(rt.s1 === 'running' && rt.ps === 'running' && rt.run, '断点续跑：失败阶段归位并重新派发');
  }

  /* —— 场景 3：并行在途取消（演示引擎本地定时器）→ 暂停 → 续跑 —— */
  {
    const app = bootApp();
    setup(app);
    app.ev(`pipeStep('tk1')`);
    ok(await app.stepUntil(`byId('tk1').pipeline.stages[1].state === 'running'`), '推进至并行波次');
    app.ev(`cancelRun('tk1')`);
    const cx = app.ev(`({ keys: Object.keys(runs).length, s2: byId('tk1').pipeline.stages[1].state,
      s3: byId('tk1').pipeline.stages[2].state, ps: byId('tk1').pipeline.status, ts: byId('tk1').status })`);
    ok(cx.keys === 0 && cx.s2 === 'pending' && cx.s3 === 'pending', '取消：并行实例本地清停、阶段归位待运行');
    ok(cx.ps === 'paused' && cx.ts === 'todo', '取消后流水线暂停（残留节拍回调空转不炸）');
    await app.drain();
    ok(app.ev(`byId('tk1').pipeline.stages[1].state`) === 'pending', '已取消实例的残留回调安全空转');
    app.ev(`startPipeline('tk1')`);
    ok(app.ev(`byId('tk1').pipeline.status`) === 'running' && app.ev(`byId('tk1').pipeline.stages.filter(s => s.state === 'running').length`) === 2, '续跑恢复并行派发');
  }

  return n;
}

module.exports = { run };
