/* web/assets/app.js 流水线前端返工（R-5/R-6/R-8）—— 失败独立状态 / 打回精确清空 / 演示引擎并行
   渲染层脚本无法直接 require：按行提取源码里的纯函数助手真身求值，接线正确性用源码断言兜底 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'web', 'assets', 'app.js'), 'utf8');
const CSS = fs.readFileSync(path.join(__dirname, '..', 'web', 'assets', 'app.css'), 'utf8');
const grab = name => {
  const m = SRC.match(new RegExp('^const ' + name + ' = .+$', 'm'));
  if (!m) throw new Error('web/assets/app.js 缺少助手 ' + name + '（返工修复可能被误删）');
  return m[0];
};
const { pipeReworkIds } = new Function(grab('pipeReworkIds') + '\nreturn { pipeReworkIds };')();

/* 并行流水线样本：pm → (be ∥ ui) → fe(依赖 be、ui)；ui 为与目标 be 无关的兄弟分支 */
const stages = () => [
  { id: 's1', roleKey: 'pm', dependsOn: [] },
  { id: 's2', roleKey: 'be', dependsOn: ['s1'] },
  { id: 's3', roleKey: 'ui', dependsOn: ['s1'] },
  { id: 's4', roleKey: 'fe', dependsOn: ['s2', 's3'] },
];

async function run() {
  let n = 0;
  const ok = (c, m) => { n++; assert.ok(c, m); };

  /* 1. R-6 打回精确清空：目标 + 传递下游进重跑集合，无关兄弟分支保留 */
  {
    const ids = pipeReworkIds(stages(), ['be']);
    ok(ids.has('s2') && ids.has('s4'), '目标 be 与其下游 fe 进入重跑集合');
    ok(!ids.has('s3'), '兄弟分支 ui 产出保留（不再被误清）');
    ok(!ids.has('s1'), '上游 pm 保留');
  }
  /* 2. 串行链（链式依赖）：目标及其后全部重跑——与既有整段清空行为一致（向后兼容） */
  {
    const chain = ['s1', 's2', 's3', 's4'].map((id, i, a) => ({ id, roleKey: 'r' + i, dependsOn: i ? [a[i - 1]] : [] }));
    const ids = pipeReworkIds(chain, ['r1']);
    ok(['s2', 's3', 's4'].every(x => ids.has(x)) && !ids.has('s1'), '串行链目标后全部重跑（兼容）');
  }
  /* 3. 同角色多实例：角色级打回时一并纳入 */
  {
    const multi = [
      { id: 's1', roleKey: 'be', dependsOn: [] },
      { id: 's2', roleKey: 'ui', dependsOn: [] },
      { id: 's3', roleKey: 'be', dependsOn: ['s2'] },
    ];
    const ids = pipeReworkIds(multi, ['be']);
    ok(ids.has('s1') && ids.has('s3'), '同 roleKey 多实例一并重跑');
    ok(!ids.has('s2'), '无关角色保留');
  }
  /* 4. R-6 接线：pipelineGate 走 pipeReworkIds，不再按下标整段清空 */
  ok(SRC.includes('const reset = pipeReworkIds(p.stages, verdict.targets)'), '打回清空走 pipeReworkIds');
  ok(!/for \(let i = first; i < p\.stages\.length; i\+\+\)/.test(SRC), '不再按下标整段清空');

  /* 5. R-5 失败独立状态：error 路径 / 求助两轮暂停置 failed；断点续跑回 pending */
  ok(SRC.includes("if (st && ['running', 'rework'].includes(st.state)) st.state = 'failed';"), '阶段执行失败置 failed');
  ok(SRC.includes("p.status = 'paused'; t.status = 'todo'; st.state = 'failed';"), '两轮求助产出置 failed');
  ok(SRC.includes("if (s.state === 'failed') s.state = 'pending';"), '断点续跑失败阶段回待运行');
  ok(SRC.includes("state: 'pending'|'running'|'rework'|'done'|'failed'"), '状态机文档含 failed');
  /* 失败阻塞下游：依赖就绪判定仍只认 done（failed ≠ done，下游不派发） */
  ok(SRC.includes("return !d || d.state === 'done';"), 'pipeDepsDone 仍只认 done（failed 阻塞下游）');

  /* 6. R-5 渲染：阶段清单与甘特图失败图标 / 配色类 / 行内标注 / 构建产物样式 */
  ok(SRC.split("s.state === 'failed' ? ic('x')").length === 3, '阶段清单与甘特图均渲染失败图标（ic x）');
  ok(SRC.includes("s.state === 'failed' ? 'failed' :"), '阶段清单 failed 配色类');
  ok(SRC.includes(' · 失败（可从断点重试）'), '失败阶段行内标注');
  ok(CSS.includes('.pp-stage.failed') && CSS.includes('.pw-stage.failed'), 'app.css 含失败配色（已重构建）');

  /* 7. R-8 演示引擎并行：阶段实例独立成键（与 API 引擎同构），移除单发守卫 */
  ok(!SRC.includes('simDispatched'), '移除演示引擎单发守卫（可并行派发）');
  ok(SRC.split("taskId + '#' + st.id : taskId").length === 3, 'API 与演示引擎阶段实例同构独立成键');
  ok(SRC.includes('stageNo: st ? st.no : undefined'), '演示引擎实例携带 stageNo（完成事件可分流）');
  ok(SRC.includes('Number.isFinite(r.stageNo) ? t.pipeline.stages.find(s => s.no === r.stageNo)'), '演示引擎完成按 stageNo 定位阶段');
  /* 8. R-8 取消：真实实例仍走主进程全停，演示引擎实例（渲染层定时器）本地清停 */
  ok(SRC.includes("stageKeys.some(k => runs[k].mode === 'api')"), '真实引擎实例仍走主进程全停');
  ok(SRC.includes('clearTimeout(runs[k].timer)'), '取消时本地清停演示引擎定时器');

  return n;
}

module.exports = { run };
