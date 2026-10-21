/* services/integrity.js — 数据自检：引用盘点 / 缺失检测 / 孤儿目录 / 报告组装
   纯函数，文件存在性由注入的 exists 决定，不碰磁盘。 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const integrity = require('../services/integrity');

const ref = (r, bytes) => ({ __text: true, ref: r, bytes: bytes || 100, preview: 'p'.repeat(400) });

/* 造一份最小的 v3 state：一个组织、一个空间、若干任务 */
function mkState(tasks) {
  return { version: 3, orgs: [{ id: 'o1', spaces: [{ id: 's1', tasks: tasks || [] }] }] };
}

async function run() {
  let n = 0;
  const ok = (c, m) => { n++; assert.ok(c, m); };

  /* ---------- 1. collectRefs：四类外置位置都能被找到，且带可读的位置描述 ---------- */
  {
    const state = mkState([{
      key: 'REINS-1', title: 'T', result: ref('text/REINS-1/result.md', 9000),
      thread: [{ role: 'assistant', content: ref('text/REINS-1/thread-0.md') }],
      pipeline: {
        stages: [{ name: 'UI 设计', result: ref('text/REINS-1/stage-2.md', 30000) }],
        reworkCtx: { qaReport: ref('text/REINS-1/qa-report.md'), feedback: '普通字符串' },
        gate: { evidence: ref('text/REINS-1/gate-evidence.md') },
      },
    }]);
    const refs = integrity.collectRefs(state);
    ok(refs.length === 5, '收集到 5 处引用（result / thread / stage / qaReport / evidence）');
    const where = refs.map(r => r.where).join('|');
    ok(/REINS-1 · 交付正文/.test(where), '交付正文位置含任务号');
    ok(/REINS-1 · UI 设计/.test(where), '阶段位置用阶段名而非裸 id');
    ok(/测试报告/.test(where) && /裁决依据/.test(where), 'qaReport / evidence 都有可读位置');
    ok(refs.every(r => r.taskKey === 'REINS-1'), '每条引用都带 taskKey（界面按任务分组用）');
    ok(refs.find(r => r.ref === 'text/REINS-1/stage-2.md').bytes === 30000, '保留字节数');
  }

  /* ---------- 2. 非引用值不许误判：字符串 / 空 / 坏对象都不算 ---------- */
  {
    const state = mkState([{
      key: 'K', result: '普通字符串正文',
      thread: [{ content: null }, { content: { __text: true, ref: 123 } }],   // ref 不是字符串
      pipeline: { stages: [{ result: { __text: false, ref: 'x' } }] },        // __text 不是 true
    }]);
    const refs = integrity.collectRefs(state);
    ok(refs.length === 0, '普通字符串与畸形对象都不算引用');

    ok(integrity.collectRefs(null).length === 0, '空 state 不抛错');
    ok(integrity.collectRefs({}).length === 0, '无 orgs 不抛错');
    ok(integrity.collectRefs({ orgs: [{ spaces: null }] }).length === 0, 'spaces 为 null 不抛错');
    ok(integrity.collectRefs({ orgs: [{ spaces: [{ tasks: [null, undefined] }] }] }).length === 0, '坏任务项不抛错');
  }

  /* ---------- 3. verifyRefs：逐个校验存在性，统计缺失与总体积 ---------- */
  {
    const refs = [
      { ref: 'text/A/1.md', bytes: 100 },
      { ref: 'text/A/2.md', bytes: 200 },
      { ref: 'text/B/3.md', bytes: 300 },
    ];
    const exists = r => r !== 'text/A/2.md';
    const v = integrity.verifyRefs(refs, exists);
    ok(v.total === 3, '总数正确');
    ok(v.missing.length === 1 && v.missing[0].ref === 'text/A/2.md', '准确找出缺失项');
    ok(v.bytes === 600, '体积按引用记录累加（含缺失项，便于估损）');

    const all = integrity.verifyRefs(refs, () => true);
    ok(all.missing.length === 0, '全部存在时无缺失');
    ok(integrity.verifyRefs([], () => true).missing.length === 0, '空列表安全');
    /* exists 抛错不能把整个体检带崩：按缺失处理 */
    const boom = integrity.verifyRefs(refs, () => { throw new Error('EACCES'); });
    ok(boom.missing.length === 3, 'exists 抛错时按缺失计（不中断体检）');
    ok(integrity.verifyRefs(null).total === 0, 'null 输入安全');
  }

  /* ---------- 4. findOrphans：text 容器永不算孤儿 ---------- */
  {
    const dirs = ['REINS-1', 'REINS-2', 'text', 'REINS-OLD', '.DS_Store'];
    const orph = integrity.findOrphans(dirs, ['REINS-1', 'REINS-2']);
    ok(orph.join(',') === 'REINS-OLD', '只报真正没主的目录');
    ok(!orph.includes('text'), 'text 是正文库容器，绝不判为孤儿（误删会丢掉整个正文库）');
    ok(!orph.includes('.DS_Store'), 'macOS 杂项文件不算孤儿');
    ok(integrity.findOrphans(['A'], ['A']).length === 0, '全在 keep 清单里时无孤儿');
    ok(integrity.findOrphans(null, ['A']).length === 0, 'null 输入安全');
    ok(integrity.findOrphans(['A'], null).join() === 'A', 'keep 缺省时全部视为孤儿');
  }

  /* ---------- 5. buildReport：健康/缺失/孤儿/体积四类结论 ---------- */
  {
    const refs = [
      { ref: 'text/A/1.md', bytes: 1000, where: 'A · 交付正文' },
      { ref: 'text/A/2.md', bytes: 2000, where: 'A · 阶段 1' },
    ];

    const healthy = integrity.buildReport({ refs, exists: () => true, dirNames: ['A'], keepKeys: ['A'] });
    ok(healthy.healthy === true, '全存在时 healthy=true');
    ok(healthy.warnings.length === 0, '健康时无告警');
    ok(healthy.refs.total === 2 && healthy.refs.bytes === 3000, '报告含统计');
    ok(healthy.orphans.dirs.length === 0, '无孤儿');

    const missing = integrity.buildReport({ refs, exists: r => r.endsWith('1.md'), dirNames: ['A'], keepKeys: ['A'] });
    ok(missing.healthy === false, '有缺失时 healthy=false');
    const w = missing.warnings.find(x => x.kind === 'missing');
    ok(w && w.level === 'error' && /1 处正文文件缺失/.test(w.title), '缺失告警为 error 级');
    ok(/只有摘要|前 400 字/.test(w.detail), '说明后果（只剩摘要）');
    ok(w.items.length === 1 && w.items[0].where === 'A · 阶段 1', '告警带具体位置');

    const orphan = integrity.buildReport({ refs, exists: () => true, dirNames: ['A', 'OLD1', 'OLD2'], keepKeys: ['A'], orphanBytes: 5 * 1024 * 1024 });
    const ow = orphan.warnings.find(x => x.kind === 'orphans');
    ok(ow && /2 个孤儿交付目录/.test(ow.title), '孤儿告警');
    ok(/5\.0MB/.test(ow.detail), '孤儿体积进描述');
    ok(orphan.healthy === true, '孤儿不算"不健康"（正文完好）');

    const big = integrity.buildReport({ refs, exists: () => true, dirNames: ['A'], keepKeys: ['A'], orphanBytes: 400 * 1024 * 1024 });
    const sw = big.warnings.find(x => x.kind === 'size');
    ok(sw && sw.level === 'warn', '超阈值体积告警');
    ok(/GB|MB/.test(sw.title), '体积告警带可读单位');

    /* 阈值可覆盖（单测与低配环境用） */
    const custom = integrity.buildReport({ refs, exists: () => true, dirNames: [], keepKeys: [], warnBytes: 1000 });
    ok(custom.warnings.some(x => x.kind === 'size'), 'warnBytes 可被覆盖');
    ok(integrity.findOrphans([], []).length === 0, '空目录列表安全');
  }

  /* ---------- 6. summaryOf：一行结论 ---------- */
  {
    ok(/自检通过/.test(integrity.summaryOf({ refs: { total: 6 }, orphans: { dirs: [] }, totalBytes: 1024 * 1024 })), '健康时给通过文案');
    const bad = integrity.summaryOf({ refs: { total: 6, missing: [{}, {}] }, orphans: { dirs: ['X'] }, totalBytes: 0 });
    ok(/2 处正文缺失/.test(bad) && /1 个孤儿目录/.test(bad), '有问题时列出两类问题');
    ok(/数据自检通过/.test(integrity.summaryOf({})), '空报告不抛错');
  }

  /* ---------- 7. 主进程接线与渲染层接线 ---------- */
  {
    const MAIN = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
    ok(/const integrity = require\('\.\/services\/integrity'\)/.test(MAIN), 'main 引入 integrity');
    ok(/reins:integrity:check/.test(MAIN), '暴露自检 IPC');
    const h = MAIN.match(/ipcMain\.handle\('reins:integrity:check'[\s\S]*?\n\}\);/m);
    const body = h ? h[0] : '';
    ok(/integrity\.collectRefs\(state\)/.test(body), '从 state 收集引用');
    ok(/textstore\.resolveRef\(textRoot\(\), ref\)/.test(body), '校验走路径安全解析（非法 ref 视为缺失）');
    ok(/findOrphans\(dirNames, keepKeys\)/.test(body), '孤儿检测走纯函数');
    ok(/Date\.now\(\) - integrityCache\.at < 30000/.test(body), '结果缓存 30s，避免反复扫盘');
    ok(/force/.test(body), '支持强制重扫');
    ok(/invalidateIntegrity\(\)/.test(MAIN), '写盘/删除后让缓存失效');

    const PRELOAD = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8');
    ok(/integrityCheck:/.test(PRELOAD), 'preload 暴露 integrityCheck');

    const SRC = fs.readFileSync(path.join(__dirname, '..', 'web', 'assets', 'app.js'), 'utf8');
    ok(/boot\('integrity'/.test(SRC), '启动时跑一次自检');
    ok(/silent: true/.test(SRC), '启动自检静默模式（正常不打扰）');
    ok(/async function runIntegrityCheck/.test(SRC), '渲染层自检函数存在');
    ok(/function renderIntegrityPanel/.test(SRC), '设置页面板渲染');
    ok(/integrity-box/.test(SRC), '设置页有自检容器');
    ok(/正文缺失/.test(SRC) && /只剩前 400 字/.test(SRC), '缺失时说明后果');
    ok(/runDeliveryGC\(\)/.test(SRC), '面板内可直接回收孤儿');
  }

  /* ---------- purged 引用豁免（归档正文清理后的形态不判缺失） ---------- */
  {
    const st = { orgs: [{ spaces: [{ tasks: [
      { key: 'REINS-P1', status: 'done', result: { __text: true, ref: 'text/REINS-P1/result.md', bytes: 9000, preview: 'x', purged: true } },
      { key: 'REINS-P2', status: 'done', result: { __text: true, ref: 'text/REINS-P2/result.md', bytes: 8000, preview: 'x' } },
    ] }] }] };
    const refs = integrity.collectRefs(st);
    ok(refs.length === 2 && refs[0].purged === true && refs[1].purged === undefined, 'collectRefs 标记 purged');
    ok(refs[0].bytes === 0, 'purged 引用不计占用');
    const v = integrity.verifyRefs(refs, () => false);   // 文件全不存在
    ok(v.missing.length === 1 && v.missing[0].ref === 'text/REINS-P2/result.md', 'purged 不判缺失，普通引用照常判');
    ok(v.bytes === 8000, '占用只计未清理的引用');
    const rep = integrity.buildReport({ refs, exists: () => false });
    ok(rep.healthy === false && rep.refs.missing.length === 1, '报告组装同口径');
  }

  return n;
}

module.exports = { run };
