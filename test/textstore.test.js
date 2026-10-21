/* services/textstore.js + main.js 正文外置 — 阈值 / 引用形态 / 路径安全 / 取回一致性
   外置的意义：state 每次保存全量序列化，流水线阶段正文与交付全文若留在里面
   （实测单个流水线任务 68K），任务一多就是几 MB 的整档读写。 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ts = require('../services/textstore');

async function run() {
  let n = 0;
  const ok = (c, m) => { n++; assert.ok(c, m); };

  /* ---------- 1. 阈值：小文本留在 state，大文本才外置 ---------- */
  {
    const writes = [];
    const store = (ref, text) => { writes.push({ ref, len: text.length }); };
    const small = 'x'.repeat(ts.THRESHOLD);
    ok(ts.toRef(small, 'REINS-1', 'result', store) === small, '刚好等于阈值不外置');
    ok(writes.length === 0, '未产生写盘');

    const big = 'y'.repeat(ts.THRESHOLD + 1);
    const ref = ts.toRef(big, 'REINS-1', 'result', store);
    ok(ts.isRef(ref), '超过阈值转成引用对象');
    ok(ref.ref === 'text/REINS-1/result.md', '引路径含任务号与槽位');
    ok(ref.bytes === ts.THRESHOLD + 1, '记录原始字节数');
    ok(ref.preview.length === ts.PREVIEW_CHARS, '预览截断到固定长度');
    ok(writes.length === 1 && writes[0].len === big.length, '写盘拿到全文');

    /* 中文按 UTF-8 字节算，不是字符数：1000 个汉字 = 3000 字节 */
    const cn = '汉'.repeat(1000);
    ok(ts.toRef(cn, 'K', 's', store) === cn, '中文按字节判定（1000 字 ≈ 3000 字节 < 8K）');
    ok(ts.isRef(ts.toRef('汉'.repeat(4000), 'K', 's', store)), '4000 汉字超阈值外置');
  }

  /* ---------- 2. 写盘失败必须保留原文（数据绝不丢） ---------- */
  {
    const big = 'z'.repeat(20000);
    const r = ts.toRef(big, 'K', 'result', () => { throw new Error('disk full'); });
    ok(r === big, '写盘抛错时保留原字符串');
    ok(!ts.isRef(ts.toRef(big, 'K', 'result', null)), '没有 store 时不外置');
  }

  /* ---------- 3. 预读取文本：引用给 preview，字符串截断 ---------- */
  {
    const big = 'A'.repeat(20000);
    const ref = ts.toRef(big, 'K', 'p', () => { });
    ok(ts.previewOf(ref) === 'A'.repeat(ts.PREVIEW_CHARS), '引用返回 preview');
    ok(ts.previewOf('short') === 'short', '短字符串原样');
    ok(ts.previewOf('abcdef', 3) === 'abc…', '指定长度时截断并加省略号');
    ok(ts.previewOf(null) === '' && ts.previewOf(undefined) === '', '空值返回空串');
    ok(ts.previewOf(12345) === '12345', '非字符串安全转字符串');

    ok(ts.bytesOf(ref) === 20000, '引用取记录字节数');
    ok(ts.bytesOf('abc') === 3, '字符串取实际字节数');
    ok(ts.bytesOf(null) === 0, '空值字节数为 0');
  }

  /* ---------- 4. 引用路径安全：拒绝穿越与绝对路径 ---------- */
  {
    ok(ts.safeRef('text/REINS-1/result.md') === 'text/REINS-1/result.md', '正常引用通过');
    ok(ts.safeRef('text/a/b/c.md') === 'text/a/b/c.md', '多级相对路径通过');

    ok(ts.safeRef('../../etc/passwd') === null, '拒绝 ../ 穿越');
    ok(ts.safeRef('text/../../etc/passwd') === null, '拒绝藏在合法前缀后的穿越');
    ok(ts.safeRef('text/./x.md') === null, '拒绝 . 段');
    ok(ts.safeRef('/etc/passwd') === null, '拒绝绝对路径');
    ok(ts.safeRef('C:\\Windows\\win.ini') === null, '拒绝 Windows 盘符路径');
    ok(ts.safeRef('settings.json') === null, '拒绝不在 text/ 前缀下的路径');
    ok(ts.safeRef('text/中文.md') === null, '拒绝非白名单字符（模型/任务名可能带中文）');
    ok(ts.safeRef('') === null && ts.safeRef(null) === null, '空引用拒绝');
    ok(ts.safeRef('text/' + 'a'.repeat(300) + '.md') === null, '超长引用拒绝');
  }

  /* ---------- 5. makeRef 清洗：非法字符转下划线，避免生成非法 ref ---------- */
  {
    ok(ts.makeRef('REINS-42', 'result') === 'text/REINS-42/result.md', '任务号直通');
    const r = ts.makeRef('my task/../x', 'stage 1');
    ok(/^text\/[\w.-]+\/[\w.-]+\.md$/.test(r), '清洗后仍是合法 ref');
    ok(!r.includes('..'), '清洗后不含穿越片段');
    ok(ts.safeRef(r) === r, '清洗结果通过安全校验');
    ok(ts.makeRef('', '') === 'text/x/x.md', '空值有兜底');
  }

  /* ---------- 6. resolveRef：解析到正文库内的绝对路径，越界返回 null ---------- */
  {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reins-text-'));
    try {
      const abs = ts.resolveRef(root, 'text/K/result.md');
      ok(abs === path.join(root, 'text', 'K', 'result.md'), '解析到正文库内路径');
      ok(ts.resolveRef(root, 'text/../../../etc/passwd') === null, '穿越被拒绝');
      ok(ts.resolveRef(root, '/etc/passwd') === null, '绝对路径被拒绝');
      ok(ts.resolveRef(root, 'text/K/../../../x.md') === null, '多级穿越被拒绝');

      /* 真实往返：写入 → 读回一致 */
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      const body = '正文' + '内容'.repeat(5000);
      fs.writeFileSync(abs, body, 'utf8');
      ok(fs.readFileSync(abs, 'utf8') === body, '写入后读回一致（UTF-8 无损坏）');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }

  /* ---------- 7. 序列化往返：引用是纯 JSON 对象，state 可正常存取 ---------- */
  {
    const ref = ts.toRef('Q'.repeat(10000), 'REINS-9', 'result', () => { });
    const round = JSON.parse(JSON.stringify({ a: ref }));
    ok(ts.isRef(round.a) && round.a.ref === ref.ref, 'JSON 往返后仍是合法引用');
    ok(ts.previewOf(round.a).length === ts.PREVIEW_CHARS, '往返后预览仍可读');
    ok(JSON.stringify(ref).length < 2000, '引用对象本身很小（不拖累 state）');
  }

  /* ---------- 7.5 导出/导入完整性（外置引入的回归防护） ----------
     外置后 state 只有引用，正文在 userData/deliveries/text/ 下；备份是单个 .json 文件，
     若不内联导出，换机导入就是"交付内容全丢、只剩 400 字摘要"。 */
  {
    const SRC = fs.readFileSync(path.join(__dirname, '..', 'web', 'assets', 'app.js'), 'utf8');
    const exp = SRC.match(/async function exportData\(\) \{[\s\S]*?\n\}/m);
    ok(!!exp, 'exportData 存在且为异步（要读正文）');
    ok(/await inlineAllText\(state\)/.test(exp ? exp[0] : ''), '导出前把引用内联成全文');
    ok(/function inlineAllText\(st\)/.test(SRC), 'inlineAllText 存在');
    const inline = SRC.match(/async function inlineAllText\(st\) \{[\s\S]*?\n\}/m);
    const body = inline ? inline[0] : '';
    ok(/clone\.orgs/.test(body), '遍历全部组织');
    ok(/walkStr\(t, 'result'\)/.test(body), '内联任务交付正文');
    ok(/p\.stages\.forEach/.test(body), '内联流水线阶段产出');
    ok(/thread/.test(body), '内联多轮对话');
    ok(/await Promise\.all\(jobs\)/.test(body), '并发取回后统一等待');
    ok(/data-export-btn/.test(SRC), '导出按钮有 busy 标记（大档打包时不重复点）');
    ok(/JSON\.stringify\(snapshot/.test(exp ? exp[0] : ''), '导出的是内联后的快照，不是原始 state');

    /* 导入侧兼容：裸 state（含引用）导入时降级为摘要，而不是留下指向不存在文件的引用 */
    ok(/function liftTextRefs\(st\)/.test(SRC), 'liftTextRefs 存在');
    ok(/const lifted = liftTextRefs\(n\)/.test(SRC), '导入时调用 liftTextRefs');
    const lift = SRC.match(/function liftTextRefs\(st\) \{[\s\S]*?\n\}/m);
    ok(/isTextRef\(v\)/.test(lift ? lift[0] : '') && /preview/.test(lift ? lift[0] : ''), '降级取 preview');
  }

  /* ---------- 7.6 交付文件清理（删除任务/孤儿回收） ---------- */
  {
    const MAIN = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
    ok(/reins:delivery:purge/.test(MAIN), '主进程提供删除交付文件接口');
    ok(/reins:delivery:gc/.test(MAIN), '主进程提供孤儿回收接口');
    const purge = MAIN.match(/ipcMain\.handle\('reins:delivery:purge'[\s\S]*?\n\}\);/m);
    ok(/startsWith\(path\.resolve\(root, 'deliveries'\)/.test(purge ? purge[0] : ''), '删除前校验目标在 deliveries 下（防越界删库）');
    ok(/text/.test(purge ? purge[0] : ''), '外置正文目录一并清理');

    const gc = MAIN.match(/ipcMain\.handle\('reins:delivery:gc'[\s\S]*?\n\}\);/m);
    ok(/keep/.test(gc ? gc[0] : '') && /rmSync/.test(gc ? gc[0] : ''), '孤儿回收按保留清单删除');
    ok(/dirSize/.test(gc ? gc[0] : ''), '回收时统计释放空间');
    /* 缺陷回归：初版 sweep 会把 deliveries/text 当成一个"任务目录"，
       它不在 keep 清单里 → 整个正文库被删（实测真的发生过，6 个正文文件全灭）。
       现在必须显式跳过容器目录，只对其子目录按 keep 判定 */
    ok(/TEXT_DIR/.test(gc ? gc[0] : ''), 'GC 显式处理正文库容器');
    ok(/sweepKeys\(base, new Set\(\[TEXT_DIR\]\)\)/.test(gc ? gc[0] : ''), '顶层扫描跳过 text/ 容器');
    ok(/sweepKeys\(path\.join\(base, TEXT_DIR\), null\)/.test(gc ? gc[0] : ''), '正文库内单独按 keep 扫描');
    ok(!/if \(isText && ent\.name === 'text'\)/.test(gc ? gc[0] : ''), '不再用 isText 参数误判容器');

    const SRC = fs.readFileSync(path.join(__dirname, '..', 'web', 'assets', 'app.js'), 'utf8');
    ok(/deliveryPurge\?\.\(t\.key\)/.test(SRC), '删除任务时调用 purge');
    ok(/function runDeliveryGC/.test(SRC), '设置页提供孤儿回收入口');
    ok(/\(state\.orgs \|\| \[\]\)\.flatMap/.test(SRC), '保留清单覆盖全部组织（切组织不会误删别家）');
    const PRELOAD = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8');
    ok(/deliveryPurge:/.test(PRELOAD) && /deliveryGC:/.test(PRELOAD), 'preload 暴露清理接口');
  }

  /* ---------- 7.7 正文回写与缺失降级 ---------- */
  {
    const MAIN = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
    ok(/reins:text:write/.test(MAIN), '主进程提供正文回写（恢复被误删/迁移丢失的正文库）');
    const w = MAIN.match(/ipcMain\.handle\('reins:text:write'[\s\S]*?\n\}\);/m);
    ok(/resolveRef\(textRoot\(\), p\.ref\)/.test(w ? w[0] : ''), '回写同样走路径安全校验');
    ok(/mkdirSync/.test(w ? w[0] : ''), '回写自动建目录');
    const PRELOAD = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8');
    ok(/textWrite:/.test(PRELOAD), 'preload 暴露 textWrite');

    /* 缺失降级：正文文件不在时 textFull 必须回落到 preview，而不是抛错或返回空 */
    const SRC = fs.readFileSync(path.join(__dirname, '..', 'web', 'assets', 'app.js'), 'utf8');
    const tf = SRC.match(/async function textFull\(v, onReady\) \{[\s\S]*?\n\}/m);
    ok(tf && /return String\(v\.preview \|\| ''\)/.test(tf[0]), '取全文失败时回落 preview');
    ok(tf && /catch \(e\) \{ textPending\.delete\(key\); return String\(v\.preview/.test(tf[0]), '异常也回落 preview（不抛给调用方）');

    /* 缓存失效（缺陷回归）：同一任务重跑时阶段 id 不变 → ref 不变，但正文已换。
       只用 ref 做缓存键会一直返回上一轮内容（实测复现）。键必须带 bytes */
    ok(/const textKeyOf = v => isTextRef\(v\) \? v\.ref \+ '::' \+ \(Number\(v\.bytes\) \|\| 0\)/.test(SRC), '缓存键 = ref + bytes');
    ok(tf && /const key = textKeyOf\(v\)/.test(tf[0]), 'textFull 用复合键查缓存');
    ok(tf && !/textCache\.has\(ref\)/.test(tf[0]), '不再用裸 ref 做缓存键');
    ok(tf && /textCache\.size > 50/.test(tf[0]), '缓存有上限（长会话不吃内存）');

    /* 下载必须给全文：用 textOf 只会导出 400 字摘要——"看起来正常、其实残缺"的文件比报错更糟 */
    const dl = SRC.match(/async function downloadDelivery\(id\) \{[\s\S]*?\n\}/m);
    ok(!!dl, 'downloadDelivery 改为异步（要读全文）');
    ok(/await textFull\(t\.result\)/.test(dl ? dl[0] : ''), '下载取全文');
    ok(!/Blob\(\[textOf\(t\.result\)\]/.test(SRC), '不再用摘要做下载内容');
    ok(/truncated/.test(dl ? dl[0] : ''), '正文缺失时降级并如实提示');
  }

  /* ---------- 8. 主进程接线：保存外置 + 读回接口 + 渲染层兼容 ---------- */
  {
    const MAIN = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
    ok(/const textstore = require\('\.\/services\/textstore'\)/.test(MAIN), 'main 引入 textstore');
    ok(/function externalizeState\(/.test(MAIN), 'main 具备外置逻辑');
    ok(/swap\(task, 'result', 'result'\)/.test(MAIN), '任务交付正文纳入外置');
    ok(/stage-/.test(MAIN) && /pipeline\.stages/.test(MAIN), '流水线阶段产出纳入外置');
    ok(/thread-/.test(MAIN), '多轮对话内容纳入外置');
    ok(/reins:text:read/.test(MAIN), '暴露正文取回 IPC');
    ok(/resolveRef\(textRoot\(\), ref\)/.test(MAIN), '取回走安全路径校验');
    ok(/try \{ externalizeState\(data\); \} catch/.test(MAIN), '外置失败不阻断保存');

    const SRC = fs.readFileSync(path.join(__dirname, '..', 'web', 'assets', 'app.js'), 'utf8');
    for (const fn of ['isTextRef', 'textOf', 'textFull', 'textRefNote']) {
      ok(new RegExp('const ' + fn + ' =|async function textFull|function ' + fn).test(SRC), '渲染层具备 ' + fn);
    }
    ok(!SRC.includes('mdToHtml(t.result)'), '交付正文渲染不再直接吃原始值（防 [object Object]）');
    ok(/textFull\(qa\.result\)/.test(SRC), '流水线裁决前取回 QA 全文');
    ok(/textOf\(t\.result, 2000\)/.test(SRC), 'PR 描述走 textOf');
    const PRELOAD = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8');
    ok(/textRead:/.test(PRELOAD), 'preload 暴露 textRead');
  }

  /* ---------- purgeRef（归档正文清理，v1.1） ---------- */
  {
    const ref = { __text: true, ref: 'text/REINS-9/stage-s1.md', bytes: 9000, preview: '前 400 字' };
    const p1 = ts.purgeRef(ref);
    ok(p1 && p1.purged === true && p1.ref === ref.ref && p1.preview === '前 400 字', '引用降级为 purged（保留摘要）');
    ok(ts.purgeRef(p1) === null, '已 purged 的引用不再重复处理');
    ok(ts.purgeRef('纯字符串') === null && ts.purgeRef(null) === null, '非引用返回 null');
    ok(ts.purgeRef({ __text: true, ref: 'x', preview: '' }).purged === true, '坏字段容错（preview 缺省空串）');
    ok(ts.previewOf(p1) === '前 400 字', 'purged 引用预览仍可读');
  }

  return n;
}

module.exports = { run };
