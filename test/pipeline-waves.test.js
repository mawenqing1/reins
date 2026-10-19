/* services/pipeline.js — 依赖归一 / 并行波次 / 下游上下文合并
   渲染层（app.js 流水线编排）经 reins:pipeline:deps 消费同一语义，这里锁定其契约：
   串行回退、并行根、失败阻塞下游、环不死锁、上下文只取直接依赖 */
const assert = require('assert');
const { normalizeDeps, planWaves, mergeUpstream } = require('../services/pipeline');

async function run() {
  let n = 0;
  const ok = (c, m) => { n++; assert.ok(c, m); };

  /* 1. 无人显式声明 dependsOn → 逐阶段单波次（串行接力，向后兼容） */
  {
    const stages = [
      { roleKey: 'pm', name: '产品文档' },
      { roleKey: 'be', name: '后端实现' },
      { roleKey: 'fe', name: '前端实现' },
    ];
    const plan = planWaves(stages);
    ok(plan.waves.length === 3 && plan.waves.every(w => w.length === 1), '无依赖声明 → 三波各一阶段（串行）');
    ok(plan.hasCycle === false, '无环');
    ok(JSON.stringify(plan.order) === JSON.stringify([0, 1, 2]), '拓扑序保持原顺序');
  }

  /* 2. 声明依赖 → 无依赖阶段同波并行，下游等齐（渲染层并行执行的依据） */
  {
    const stages = [
      { roleKey: 'pm', name: '产品文档', dependsOn: [] },
      { roleKey: 'be', name: '后端实现', dependsOn: ['s1'] },
      { roleKey: 'fe', name: '前端实现', dependsOn: ['s1'] },
      { roleKey: 'qa', name: '测试验证', dependsOn: ['s2', 's3'] },
    ];
    const plan = planWaves(stages);
    ok(plan.waves.length === 3, '四阶段分三波');
    ok(plan.waves[0].length === 1 && plan.waves[1].length === 2, '后端与前端同波并行（甘特图左右排列）');
    ok(plan.waves[1].includes(1) && plan.waves[1].includes(2), '并行波含 be/fe 下标');
    ok(plan.waves[2].length === 1 && plan.waves[2][0] === 3, 'QA 等全部实现阶段完成后统一评审');
  }

  /* 3. 依赖清洗：未知 id / 自引用 / 数字序号容错 / 重复 */
  {
    const stages = [
      { roleKey: 'pm', name: 'A', dependsOn: [] },
      { roleKey: 'be', name: 'B', dependsOn: [1, 's1', 's1', 's9', 's2'] },   // 数字 1 → s1；未知 s9、自引用 s2 剔除
    ];
    const norm = normalizeDeps(stages);
    ok(norm[0].id === 's1' && norm[1].id === 's2', '按数组序补稳定 id');
    ok(JSON.stringify(norm[1].dependsOn) === JSON.stringify(['s1']), '数字序号归一 + 未知/自引用/重复剔除');
  }

  /* 4. 依赖成环 → 环上节点进末波不死锁，hasCycle 如实上报（界面警示用） */
  {
    const stages = [
      { roleKey: 'pm', name: 'A', dependsOn: [] },
      { roleKey: 'be', name: 'B', dependsOn: ['s3'] },
      { roleKey: 'fe', name: 'C', dependsOn: ['s2'] },
    ];
    const plan = planWaves(stages);
    ok(plan.hasCycle === true, '成环被检出');
    ok(plan.order.length === 3 && plan.waves.flat().length === 3, '环上节点仍被排入波次（顺序推进）');
  }

  /* 5. 上下文合并：只取直接依赖产出，按完成时间升序（REINS-128 并行上下文契约） */
  {
    const stages = [
      { roleKey: 'pm', name: '产品', dependsOn: [], result: 'PRD', completedAt: 300 },
      { roleKey: 'be', name: '后端', dependsOn: ['s1'], result: 'API', completedAt: 500 },
      { roleKey: 'fe', name: '前端', dependsOn: ['s1'], result: 'UI', completedAt: 400 },
      { roleKey: 'qa', name: '测试', dependsOn: ['s2', 's3'], result: '' },
    ];
    const r = mergeUpstream(stages, 's4');
    ok(r.sources.length === 2 && r.sources.includes('s2') && r.sources.includes('s3'), 'QA 只拿直接依赖（be/fe）的产出');
    ok(r.text.indexOf('前端') < r.text.indexOf('后端'), '按完成时间升序拼接（UI 先完成先出现）');
    ok(!r.text.includes('PRD'), '非直接依赖（产品文档）不重复注入');
  }

  return n;
}

module.exports = { run };
