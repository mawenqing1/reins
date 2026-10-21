/* ============================================================
   Reins — 数据自检（一致性体检）
   ------------------------------------------------------------
   为什么需要：大文本外置把「正文」从 state 挪到了磁盘文件，于是出现了一类
   新的失败模式——**state 还在、文件没了**。它不会报错，只会静默降级成 400 字摘要，
   用户往往在导出/换机/重跑之后才发现内容缺了。

   本模块只做「盘点与判定」，不碰磁盘也不碰网络（文件存在性由宿主注入 exists 函数），
   因此可以在裸 Node 里全量单测。产出是一份结构化报告，供界面展示与一键处置：

     { seq, healthy, refs:{total, missing[], bytes}, orphans:{dirs[], bytes}, warnings[] }

   判定口径：
   - 缺失引用：state 里有 __text 引用，但目标文件不存在 → 内容已丢（不可自动恢复，需提示）
   - 孤儿目录：deliveries 下存在、但 state 里没有对应任务号的目录 → 可安全回收
   - 体积告警：正文库/交付目录超过阈值时提醒（长期只增不减）
   ============================================================ */

const MODULE_PREFIX = 'text/';
const isRef = (v: any): boolean => !!(v && typeof v === 'object' && v.__text === true && typeof v.ref === 'string');

/* 从 state 里收集全部正文引用，附带「位置」便于界面直接告诉用户是哪条任务的哪一段 */
function collectRefs(state: any): any[] {
  const out = [];
  const visit = (holder, field, where) => {
    const v = holder && holder[field];
    if (!isRef(v)) return;
    /* purged 引用（归档正文显式清理后的降级形态）：体检不再要求文件存在，也不计占用 */
    if (v.purged === true) {
      out.push({ ref: v.ref, bytes: 0, previewLen: String(v.preview || '').length, where, taskKey: where.split(' · ')[0] || '', purged: true });
      return;
    }
    out.push({
      ref: v.ref,
      bytes: Number(v.bytes) || 0,
      previewLen: String(v.preview || '').length,
      where,
      taskKey: where.split(' · ')[0] || '',
    });
  };
  for (const org of (state && state.orgs) || []) {
    for (const sp of ((org && org.spaces) || [])) {
      for (const t of ((sp && sp.tasks) || [])) {
        /* state 可能被手工改坏（null / 非对象任务项）：体检本身绝不能因此崩掉 */
        if (!t || typeof t !== 'object') continue;
        const key = String(t.key || t.id || '未命名任务');
        visit(t, 'result', key + ' · 交付正文');
        if (Array.isArray(t.thread)) t.thread.forEach((m, i) => visit(m, 'content', key + ' · 对话第 ' + (i + 1) + ' 轮'));
        const p = t.pipeline;
        if (p && Array.isArray(p.stages)) {
          p.stages.forEach((s, i) => visit(s, 'result', key + ' · ' + ((s && s.name) || ('阶段 ' + (i + 1)))));
        }
        if (p && p.reworkCtx) {
          visit(p.reworkCtx, 'qaReport', key + ' · 测试报告');
          visit(p.reworkCtx, 'feedback', key + ' · 返工意见');
        }
        if (p && p.gate) visit(p.gate, 'evidence', key + ' · 裁决依据');
      }
    }
  }
  return out;
}

/* 校验引用：exists(ref) → boolean 由宿主注入（真实环境做路径安全校验 + fs.existsSync）。
   purged 引用（用户显式清理过的归档正文）不算缺失——那是有意的降级，不是数据丢失 */
function verifyRefs(refs: any, exists?: (ref: string) => boolean): { total: number; missing: any[]; bytes: number } {
  const list = Array.isArray(refs) ? refs : [];
  const missing = [];
  let bytes = 0;
  for (const r of list) {
    if (r && r.purged === true) continue;
    bytes += Number(r.bytes) || 0;
    let ok = false;
    try { ok = !!exists(r.ref); } catch (e) { ok = false; }
    if (!ok) missing.push(r);
  }
  return { total: list.length, missing, bytes };
}

/* 孤儿目录：顶层 deliveries 下的目录名不在 keepKeys 里（text/ 是容器，永远不算孤儿） */
function findOrphans(dirNames: any, keepKeys: any): string[] {
  const keep = new Set((Array.isArray(keepKeys) ? keepKeys : []).map(String));
  return (Array.isArray(dirNames) ? dirNames : [])
    .filter(n => n && n !== 'text' && n !== '.DS_Store')
    .filter(n => !keep.has(n));
}

/* 体检报告组装（纯函数，宿主把扫盘结果喂进来）。
   opts: { refs, exists, dirNames, keepKeys, orphanBytes, warnBytes } */
function buildReport(opts: any): any {
  const o = opts || {};
  const refs = verifyRefs(o.refs || [], o.exists || (() => true));
  const orphanDirs = findOrphans(o.dirNames || [], o.keepKeys || []);
  const orphanBytes = Number(o.orphanBytes) || 0;
  const warnBytes = Number(o.warnBytes) > 0 ? Number(o.warnBytes) : 300 * 1024 * 1024;
  const warnings = [];
  if (refs.missing.length) {
    warnings.push({
      kind: 'missing',
      level: 'error',
      title: '有 ' + refs.missing.length + ' 处正文文件缺失',
      detail: '这些内容只剩摘要（前 400 字），导出/下载会拿到不完整内容。常见原因：手工删过 deliveries、从别处拷了 reins-data.json 但没带正文库。',
      items: refs.missing.slice(0, 20),
    });
  }
  if (orphanDirs.length) {
    warnings.push({
      kind: 'orphans',
      level: 'info',
      title: '有 ' + orphanDirs.length + ' 个孤儿交付目录',
      detail: '任务已删除或来自旧存档，占用 ' + (orphanBytes / 1024 / 1024).toFixed(1) + 'MB，可安全回收。',
      items: orphanDirs.slice(0, 20).map(n => ({ dir: n })),
    });
  }
  const totalBytes = refs.bytes + orphanBytes;
  if (totalBytes > warnBytes) {
    warnings.push({
      kind: 'size',
      level: 'warn',
      title: '交付与正文占用 ' + (totalBytes / 1024 / 1024 / 1024).toFixed(2) + 'GB',
      detail: '正文库只增不减。可清理已归档任务的交付目录，或先导出备份再回收。',
      items: [],
    });
  }
  return {
    at: Date.now(),
    healthy: refs.missing.length === 0,
    refs: { total: refs.total, missing: refs.missing, bytes: refs.bytes },
    orphans: { dirs: orphanDirs, bytes: orphanBytes },
    totalBytes,
    warnings,
  };
}

/* 一行摘要（日志/飞书/自检横幅用） */
function summaryOf(report: any): string {
  const r = report || {};
  const miss = (r.refs && r.refs.missing && r.refs.missing.length) || 0;
  const orph = (r.orphans && r.orphans.dirs && r.orphans.dirs.length) || 0;
  const mb = ((Number(r.totalBytes) || 0) / 1024 / 1024).toFixed(1);
  if (!miss && !orph) return '数据自检通过：' + ((r.refs && r.refs.total) || 0) + ' 处正文完好，占用 ' + mb + 'MB';
  const parts = [];
  if (miss) parts.push(miss + ' 处正文缺失');
  if (orph) parts.push(orph + ' 个孤儿目录');
  return '数据自检发现 ' + parts.join('、') + '（占用 ' + mb + 'MB）';
}

export = { MODULE_PREFIX, isRef, collectRefs, verifyRefs, findOrphans, buildReport, summaryOf };
