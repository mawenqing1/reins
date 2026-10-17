/* ============================================================
   REINS-126 漫剧渲染层 · 冒烟测试（纯 Node，零依赖）
   用 DOM 桩让 web/assets/app.js 以「浏览器预览模式」完整 boot，
   驱动漫剧库 / 详情页 / 各模态的真实渲染函数，断言生成的 HTML 结构：
     1) 库空态与卡片（含失败态胶囊/进度条）
     2) 详情页：吸附头 / 七节点阶段轨 / 设定卡 / 剧集折叠展开 / 镜头网格
     3) 阶段轨完成度推导（cmStageStats 与引擎 _predicates 同口径）
     4) comic/shot 补丁事件增量应用
     5) 新建 / 镜头预览 / 合成包 / 重命名 / 删除确认模态构造
     6) 设置页渲染引擎区块（浏览器模式引导）
   运行：node tools/test-comic-ui.js
   ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.join(__dirname, '..');

/* —— DOM 桩：按 id 记录元素，供断言读取 innerHTML —— */
const stubEl = () => ({
  innerHTML: '', textContent: '', value: '', style: {}, dataset: {},
  classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
  addEventListener() {}, removeEventListener() {}, appendChild() {}, remove() {},
  insertAdjacentHTML() {}, replaceWith() {}, getAttribute: () => null, setAttribute() {},
  querySelector: () => null, querySelectorAll: () => [], focus() {}, select() {},
  getBoundingClientRect: () => ({ top: 0, left: 0, right: 100, bottom: 40, width: 100, height: 40 }),
  offsetWidth: 100, offsetHeight: 30, scrollTop: 0, scrollHeight: 0, hidden: false, closest: () => null,
});
const els = {};
const doc = {
  getElementById: id => (els[id] = els[id] || stubEl()),
  createElement: () => stubEl(),
  querySelector: sel => (sel && sel.startsWith('#') ? doc.getElementById(sel.slice(1)) : null),
  querySelectorAll: () => [],
  addEventListener() {}, removeEventListener() {},
  body: stubEl(), documentElement: stubEl(), activeElement: null,
};
const sandbox = {
  console, setTimeout, setInterval, clearInterval, clearTimeout,
  requestAnimationFrame: fn => 0, cancelAnimationFrame: () => {},
  Date, Math, JSON, Object, Array, String, Number, Boolean, RegExp, Error, Promise,
  TextEncoder, TextDecoder, URL, Blob: class {},
  navigator: { clipboard: { writeText: () => Promise.resolve() } },
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  CSS: { escape: s => String(s) },
  document: doc, location: { href: 'http://localhost/' },
  addEventListener() {}, removeEventListener() {}, dispatchEvent() {},
  matchMedia: () => ({ matches: false, addEventListener() {} }),
  innerWidth: 1440, innerHeight: 900, open() {},
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'web/assets/icons.js'), 'utf8'), sandbox, { filename: 'icons.js' });
vm.runInContext(fs.readFileSync(path.join(ROOT, 'web/assets/app.js'), 'utf8'), sandbox, { filename: 'app.js' });
vm.runInContext('init()', sandbox);   // 桩环境无 DOMContentLoaded，手动驱动

const run = c => vm.runInContext(c, sandbox);
let passed = 0, failed = 0;
function ok(cond, name) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.error('  ✕ ' + name); }
}
const contentHTML = () => els['content'] ? els['content'].innerHTML : '';

const MOCK_COMIC = {
  id: 'cpTest01', title: '时间快递', theme: '都市奇幻', style: '国漫', aspect: '9:16', shotsPer: 3,
  status: 'failed', progress: { stage: 'video', pct: 62, note: '2 个镜头待重跑' },
  writerAgentId: '', renderAgentId: '', createdAt: 1, updatedAt: Date.now(),
  bible: {
    logline: '外卖骑手获得时间回溯能力', style: '国漫风,高饱和,夜城市',
    characters: [
      { name: '林小满', role: '主角', look: '红色冲锋衣,马尾', voice: '清亮女声' },
      { name: '墨先生', role: '反派', look: '黑色长袍', voice: '' },
    ],
    scenes: [{ name: '霓虹街头', look: '雨夜霓虹' }],
  },
  episodes: [{
    id: 'ep1', n: 1, title: '第一单', synopsis: '林小满第一次触发回溯。', script: '', status: 'failed',
    err: '1 个镜头失败，可单镜头重跑',
    package: {
      srt: '1\n00:00:00,000 --> 00:00:05,000\n今晚最后一单！\n',
      ffmpegSh: '#!/bin/sh\nffmpeg ...\n',
      shotlistMd: '| # | 台词 |\n|---|---|\n| 1 | 今晚最后一单 |',
      durationSec: 15, missing: 1, at: 2,
    },
    shots: [
      { id: 's1', index: 1, imagePrompt: 'p1', desc: '雨夜骑车穿行', dialogue: '今晚最后一单！', camera: '中景/跟拍', duration: 5, motionPrompt: 'm1', imageUrl: 'http://x/1.png', videoUrl: 'http://x/1.mp4', coverUrl: '', audioUrl: '/tmp/a1.mp3', err: '', updatedAt: 1 },
      { id: 's2', index: 2, imagePrompt: 'p2', desc: '差点撞上货车，时间凝固', dialogue: '', camera: '特写/推镜头', duration: 5, motionPrompt: 'm2', imageUrl: 'http://x/2.png', videoUrl: '', coverUrl: '', audioUrl: '', err: '视频生成失败（内容审核未通过）', updatedAt: 2 },
      { id: 's3', index: 3, imagePrompt: 'p3', desc: '时间倒回三秒', dialogue: '刚才……发生了什么？', camera: '近景', duration: 5, motionPrompt: 'm3', imageUrl: 'http://x/3.png', videoUrl: 'http://x/3.mp4', coverUrl: '', audioUrl: '', err: '', updatedAt: 3 },
    ],
  }],
};

setTimeout(async () => {
  /* ============ 1. 漫剧库：空态 ============ */
  console.log('\n[1] 漫剧库 · 空态');
  run("switchView('comics')");
  let html = contentHTML();
  ok(html.includes('还没有漫剧项目') && html.includes('新建漫剧'), '空态文案与入口按钮');
  ok(html.includes('view-head'), '库头渲染');

  /* ============ 2. 漫剧库：卡片 ============ */
  console.log('\n[2] 漫剧库 · 项目卡');
  run(`S().comics = [${JSON.stringify(MOCK_COMIC)}]`);
  run("switchView('comics')");
  html = contentHTML();
  ok(html.includes('cm-grid') && html.includes('cm-card'), '卡片网格容器');
  ok(html.includes('时间快递') && html.includes('9:16'), '卡面标题与画幅');
  ok(html.includes('s-failed') && html.includes('prog fail'), '失败态胶囊 + 失败进度条');

  /* ============ 3. 详情页 ============ */
  console.log('\n[3] 漫剧详情');
  run('openComicDetail("cpTest01")');
  html = contentHTML();
  ok(html.includes('cm-head') && html.includes('继续生成'), '吸附头（failed → 继续生成）');
  ok(html.includes('cm-stagebar') && (html.match(/class="cm-stage /g) || []).length === 7, '阶段轨 7 节点');
  ok(html.includes('cm-bible') && html.includes('世界观设定') && html.includes('林小满'), '设定卡与角色');
  ok(html.includes('cm-ep-row') && html.includes('第一单'), '剧集行');
  ok(/class="cm-ep-body" hidden/.test(html) && html.includes('cm-shotgrid'), '剧集折叠（body 带 hidden）');
  run('cmToggleEp("ep1"); render()');
  html = contentHTML();
  ok((html.match(/class="cm-shot[ "]/g) || []).length === 3, '展开后 3 张镜头卡');
  ok(html.includes('重跑此镜头'), '失败镜头重跑按钮');
  ok(html.includes('vico'), '已出视频角标');

  /* ============ 4. 阶段轨完成度推导 ============ */
  console.log('\n[4] 阶段完成度（cmStageStats 与引擎谓词同口径）');
  const want = { bible: [1, 1, 'done'], script: [1, 1, 'done'], storyboard: [1, 1, 'done'], image: [3, 3, 'done'], video: [2, 3, 'doing'], voice: [1, 2, 'todo'], assemble: [1, 1, 'done'] };
  run("S().comics[0].status = 'running'; S().comics[0].progress = { stage: 'video', pct: 62, note: '' }");
  const stats = JSON.parse(run('JSON.stringify(cmStageStats(comicById("cpTest01")).map(s => [s.id, s.done, s.total, s.state]))'));
  for (const [id, d, t, st] of stats) {
    const w = want[id];
    ok(d === w[0] && t === w[1] && st === w[2], id + ' ' + d + '/' + t + ' · ' + st);
  }

/* ============ 5. 事件增量应用 ============ */
console.log('\n[5] 补丁事件应用（单事件 + 批量帧）');
let threw = null;
try {
  run(`handleComicEvent({ comicId: 'cpTest01', seq: 1, type: 'shot', episodeId: 'ep1', shotId: 's2', patch: { videoUrl: 'http://x/2.mp4', err: '' }, at: ${Date.now()} })`);
  run(`handleComicEvent({ comicId: 'cpTest01', seq: 2, type: 'comic', patch: { status: 'done', progress: { stage: '', pct: 100, note: '全部完成' } }, at: ${Date.now()} })`);
} catch (e) { threw = e; }
ok(!threw, 'shot/comic 补丁不抛错');
ok(run('comicById("cpTest01").episodes[0].shots[1].videoUrl') === 'http://x/2.mp4', 'shot 补丁写入状态');
/* 主进程批量帧 {type:'batch', events:[...]}（REINS-126 返工）：一次 IPC 一批事件 */
threw = null;
try {
  run(`handleComicEvent({ type: 'batch', events: [
    { comicId: 'cpTest01', seq: 3, type: 'shot', episodeId: 'ep1', shotId: 's2', patch: { videoUrl: 'http://x/2b.mp4', err: '' }, at: ${Date.now()} },
    { comicId: 'cpTest01', seq: 4, type: 'comic', patch: { status: 'failed', progress: { stage: 'video', pct: 66, note: 'x' } }, at: ${Date.now()} },
  ] })`);
} catch (e) { threw = e; }
ok(!threw, '批量帧不抛错');
ok(run('comicById("cpTest01").episodes[0].shots[1].videoUrl') === 'http://x/2b.mp4', '批量帧内 shot 补丁写入');
ok(run('comicById("cpTest01").status') === 'failed' && run('comicById("cpTest01").progress.pct') === 66, '批量帧内 comic 补丁写入');
  /* 乱序 seq 丢弃（批量帧内同样生效） */
  run(`handleComicEvent({ type: 'batch', events: [
    { comicId: 'cpTest01', seq: 4, type: 'comic', patch: { status: 'done' }, at: ${Date.now()} },
  ] })`);
  ok(run('comicById("cpTest01").status') === 'failed', '乱序/过期 seq 事件被丢弃');

  /* ============ 5b. 快速连续事件 DOM 稳定层（REINS-126 返工②） ============ */
  console.log('\n[5b] 快速连续事件 DOM 稳定层（签名 + 合帧 + 批量日志）');
  {
    /* 5b.1 头部签名：内容未变 → 签名不变（零 DOM 依据）；进度变化 → 必刷新 */
    const sig0 = run('cmHeadSig(comicById("cpTest01"))');
    ok(typeof sig0 === 'string' && sig0.length > 0 && sig0 === run('cmHeadSig(comicById("cpTest01"))'), '头部签名可计算且稳定');
    run('comicById("cpTest01").progress.pct = 67');
    ok(run('cmHeadSig(comicById("cpTest01"))') !== sig0, '进度变化 → 头部签名变化');

    /* 5b.2 镜头 media 签名：err / 提示词变化不动封面；产物地址变化才重建 <img> */
    const msig0 = run('cmShotMediaSig(comicById("cpTest01"), comicById("cpTest01").episodes[0].shots[0])');
    run('comicById("cpTest01").episodes[0].shots[0].err = "临时失败"');
    run('comicById("cpTest01").episodes[0].shots[0].imagePrompt = "换提示词"');
    ok(run('cmShotMediaSig(comicById("cpTest01"), comicById("cpTest01").episodes[0].shots[0])') === msig0,
      'err/提示词变化不重建封面节点（消除闪烁）');
    run('comicById("cpTest01").episodes[0].shots[0].imageUrl = "http://x/9.png"');
    ok(run('cmShotMediaSig(comicById("cpTest01"), comicById("cpTest01").episodes[0].shots[0])') !== msig0,
      '首帧地址变化才重建 <img>');
    ok(contentHTML().includes('data-sig='), '镜头 media 节点带签名属性（整页渲染路径同样携带）');

    /* 5b.3 剧集镜头签名：同数量换 ID（重跑剧本生成全新镜头 ID）必须触发重建——
       此前按数量比对看不出变化，网格停留在过期镜头上 */
    const esig0 = run('cmEpShotSig(comicById("cpTest01").episodes[0])');
    run(`handleComicEvent({ type: 'batch', events: [{ comicId: 'cpTest01', seq: 800, type: 'episode', episodeId: 'ep1',
      patch: { shots: [{ id: 'sn1', index: 1, duration: 5, desc: '新A' }, { id: 'sn2', index: 2, duration: 5, desc: '新B' }, { id: 'sn3', index: 3, duration: 5, desc: '新C' }] }, at: ${Date.now()} }] })`);
    ok(run('comicById("cpTest01").episodes[0].shots.length') === 3
      && run('comicById("cpTest01").episodes[0].shots[0].desc') === '新A', '重跑剧本：同数量全新镜头写入');
    ok(run('cmEpShotSig(comicById("cpTest01").episodes[0])') !== esig0, 'ID 序列变化 → 签名变化（触发网格重建）');

    /* 5b.4 快速连续 3 批背靠背事件：不抛错、数据按序收敛（DOM 收尾合帧不改变数据语义） */
    threw = null;
    try {
      run(`handleComicEvent({ type:'batch', events:[{ comicId:'cpTest01', seq:801, type:'shot', episodeId:'ep1', shotId:'sn1', patch:{ imageUrl:'http://x/1.png' }, at: ${Date.now()} }]})`);
      run(`handleComicEvent({ type:'batch', events:[{ comicId:'cpTest01', seq:802, type:'shot', episodeId:'ep1', shotId:'sn1', patch:{ videoUrl:'http://x/1.mp4' }, at: ${Date.now()} }]})`);
      run(`handleComicEvent({ type:'batch', events:[{ comicId:'cpTest01', seq:803, type:'comic', patch:{ progress:{ stage:'', pct:100, note:'收敛' } }, at: ${Date.now()} }]})`);
    } catch (e) { threw = e; }
    ok(!threw, '背靠背 3 批事件不抛错（DOM 收尾已合帧）');
    ok(run('comicById("cpTest01").episodes[0].shots[0].videoUrl') === 'http://x/1.mp4'
      && run('comicById("cpTest01").progress.pct') === 100, '数据按序收敛到最后一批');

    /* 5b.5 批量日志：同 key 流式增量并进同一行（一批一次插入的合并语义） */
    run(`cmLogAppendMany([['', 'ab', 'script:ep1'], ['', 'cd', 'script:ep1'], ['dim', '[剧本] 完成', null]])`);
    ok(run('cmLogBuf[cmLogBuf.length-2][1]') === 'abcd', '同 key 增量合并为一行');
    ok(run('cmLogBuf[cmLogBuf.length-1][1]') === '[剧本] 完成', '不同 key 另起一行');
  }


  /* ============ 6. 模态构造 ============ */
  console.log('\n[6] 模态');
  threw = null;
  try { run('openNewComicModal()'); } catch (e) { threw = e; }
  ok(!threw && els['modal'] && els['modal'].innerHTML.includes('cm-seg') && els['modal'].innerHTML.includes('cm-step'), '新建漫剧模态（分段器/步进器）');
  threw = null;
  try { run('cmExpand["ep1"]=true; render(); openComicShot("cpTest01","ep1","sn1")'); } catch (e) { threw = e; }   // sn1 = §5b 重跑后的镜头（含首帧+视频）
  ok(!threw && els['modal'].innerHTML.includes('cm-shot-media'), '镜头预览模态');
  threw = null;
  try { run('openComicPackage("cpTest01","ep1")'); } catch (e) { threw = e; }
  ok(!threw && els['modal'].innerHTML.includes('cm-pkg-pre'), '合成包模态三段');
  threw = null;
  try { run('openComicRename("cpTest01")'); run('confirmDeleteComic("cpTest01")'); } catch (e) { threw = e; }
  ok(!threw, '重命名 / 删除确认模态');

  /* ============ 7. 设置页渲染引擎区块 ============ */
  console.log('\n[7] 设置页');
  threw = null;
  try { run('switchView("settings")'); } catch (e) { threw = e; }
  ok(!threw, '设置页渲染');
  await new Promise(r => setTimeout(r, 30));
  ok(els['re-cfg'] && els['re-cfg'].innerHTML.includes('渲染引擎'), '渲染引擎区块（浏览器模式引导）');

  /* ============ 7b. 返工回归：settings 契约收口 + 渲染引擎缺口口径（返工①③） ============ */
  console.log('\n[7b] 返工回归 · settings 契约 / 渲染引擎缺口');
  {
    /* settingsApplied：新契约成功取 settings、旧形状直通、写失败返回 null 且不抛错 */
    ok(run('settingsApplied({ ok: true, settings: { webhookUrl: "https://a" } }).webhookUrl') === 'https://a', 'settingsApplied · 新契约成功取 settings');
    ok(run('settingsApplied({ launchAtLogin: true }).launchAtLogin') === true, 'settingsApplied · 旧形状直通（兼容）');
    ok(run('settingsApplied({ ok: false, error: "设置写入失败：EACCES" })') === null, 'settingsApplied · 写失败返回 null（不假装成功）');

    /* cmRenderGapLabel 与主进程 renderConfigError 同口径：逐字段点名，配音可选不计 */
    ok(run('cmRenderGapLabel(null)') === '渲染引擎未配置', '缺口口径 · 未配置');
    ok(run('cmRenderGapLabel({ baseURL: "https://x", apiKey: "" })') === '渲染引擎缺 API Key', '缺口口径 · 缺 Key');
    ok(run('cmRenderGapLabel({ baseURL: "", apiKey: "k" })') === '渲染引擎缺服务地址（Base URL）', '缺口口径 · 缺地址');
    ok(run('cmRenderGapLabel({ baseURL: "https://x", apiKey: "k", imageModel: "", videoModel: "v" })') === '渲染引擎缺图像模型名', '缺口口径 · 缺图像模型名');
    ok(run('cmRenderGapLabel({ baseURL: "https://x", apiKey: "k", imageModel: "", videoModel: "" })') === '渲染引擎缺图像模型名 / 视频模型名', '缺口口径 · 双模型缺失并列点名');
    ok(run('cmRenderGapLabel({ baseURL: "https://x", apiKey: "k", imageModel: "i", videoModel: "v" })') === '', '缺口口径 · 完整可用');
    ok(run('cmRenderGapLabel({ baseURL: "https://x", apiKey: "k", imageModel: "i", videoModel: "v", voiceModel: "" })') === '', '缺口口径 · 配音可选不计');

    /* 启动预检失败弹层：错误全文不截断 + 直达配置入口 */
    threw = null;
    try { run('cmStartFail("渲染引擎缺少图像模型名（imageModel）：首帧生成需要。请到「设置 → 渲染引擎」填写（智谱预置为 cogview-4）")'); } catch (e) { threw = e; }
    ok(!threw && els['modal'].innerHTML.includes('cm-start-err')
      && els['modal'].innerHTML.includes('去配置渲染引擎')
      && els['modal'].innerHTML.includes('智谱预置为 cogview-4'), '预检失败弹层：全文承载 + 去配置入口');

    /* 新建表单按缺口点名（此前只查地址+Key，缺模型名会误显示「密钥已配置」） */
    run('comicRenderEngine = { provider: "zhipu", baseURL: "https://x", apiKey: "k", imageModel: "", videoModel: "v", voiceModel: "" }');
    threw = null;
    try { run('openNewComicModal()'); } catch (e) { threw = e; }
    ok(!threw && els['modal'].innerHTML.includes('渲染引擎缺图像模型名') && !els['modal'].innerHTML.includes('密钥已配置'), '新建表单 · 模型名缺口点名（不再误报就绪）');
    run('comicRenderEngine = { provider: "zhipu", baseURL: "https://x", apiKey: "k", imageModel: "cogview-4", videoModel: "cogvideox-3", voiceModel: "" }');
    threw = null;
    try { run('openNewComicModal()'); } catch (e) { threw = e; }
    ok(!threw && els['modal'].innerHTML.includes('密钥已配置') && !els['modal'].innerHTML.includes('去设置'), '新建表单 · 配置完整显示就绪');
    run('comicRenderEngine = null');
  }

  /* ============ 8. 看板融合（AC-5） ============ */
  console.log('\n[8] 看板融合 · 联动任务卡');
  run("S().tasks = (S().tasks || []).filter(x => !x.linkComicId)");   // 清掉前段事件可能生成的联动卡
  run('S().comics[0].status = \'running\'; S().comics[0].progress = { stage: \'video\', pct: 45, note: \'x\' }');
  run('syncComicTask(S(), comicById("cpTest01"))');
  const ltId = run('S().tasks.find(x => x.linkComicId === "cpTest01") && S().tasks.find(x => x.linkComicId === "cpTest01").id');
  const lt0 = JSON.parse(run('JSON.stringify(S().tasks.find(x => x.linkComicId === "cpTest01") || null)'));
  ok(lt0 && lt0.type === 'comic' && lt0.status === 'doing', '联动卡创建：comic 类型 · running→进行中');
  ok(run(`cardHTML(byId("${ltId}"))`).includes('openComicDetail'), '看板卡片渲染且点击直达漫剧详情');
  run(`openTask("${ltId}")`);
  ok(contentHTML().includes('cm-stagebar'), 'openTask 跳转详情页（不进任务抽屉）');
  run('comicById("cpTest01").status = \'done\'; syncComicTask(S(), comicById("cpTest01"))');
  ok(run(`byId("${ltId}").status`) === 'review', '生成完成 → 待验收');
  run(`setStatus(byId("${ltId}"), "doing")`);
  ok(run(`byId("${ltId}").assignee`) === null || run(`byId("${ltId}").assignee`) === undefined, '打回拖拽不自动指派/不触发 Agent 执行');
  ok(Number(run('Object.keys(runs).length')) === 0, '无 Agent 执行被启动');
  run(`setStatus(byId("${ltId}"), "done")`);
  ok(Number(run(`byId("${ltId}").doneAt`)) > 0, '拖拽验收 → 已归档（doneAt 落档）');
  run('syncComicTask(S(), comicById("cpTest01"))');
  ok(run(`byId("${ltId}").status`) === 'done', '归档后不被事件回流');
  run('deleteComic("cpTest01")');
  ok(!run('S().tasks.some(x => x.linkComicId === "cpTest01")'), '删除漫剧联动卡一并移除');

  console.log(`\n结果：${passed} 通过 · ${failed} 失败`);
  process.exit(failed ? 1 : 0);
}, 80);
