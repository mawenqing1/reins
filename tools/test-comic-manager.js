/* ============================================================
   REINS-126 漫剧服务层 · 自测（纯 Node，零依赖、零网络）
   用注入的 mock settings / mock fetch 驱动 services/comic-manager.js：
     1) 渲染引擎配置：默认预置 / 局部合并 / 切换服务商重置 / 非法服务商拒绝
     2) 渲染引擎连通测试：401 拒 Key / 400 零成本通过 / 网络错误 / 缺配置不发请求
     3) 引擎装配前置校验：CLI Agent 拒绝 / 缺 Key 拒绝 / 纯本地阶段零引擎放行 / voice 缺模型拦截
     4) manager 全流程：start→done，事件按窗口批量成单条 IPC（delta 批内合并、顺序保持）
     5) 终止 + 状态收养（running 无任务 → paused）
     6) 渲染引擎配置持久化：真实文件跨「重启」读回 / 其他设置写入不挤掉 / 写失败可见（返工）
     7) 批量推送：全部为 batch 帧 / 帧数<事件数 / seq 单调 / 终态立即冲刷（返工）
     8) 合成包按需重建：导出前按最新镜头数据重算，concat/分镜表不缺镜头（返工）
   运行：node tools/test-comic-manager.js
   ============================================================ */
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const comicManager = require('../services/comic-manager');

let passed = 0, failed = 0;
function ok(cond, name) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.error('  ✕ ' + name); }
}

/* ---------- mock fetch：与 test-comic.js 同款，SSE 帧改支持多 chunk（验证 delta 合并） ---------- */
function sseResponse(chunks) {
  const frames = chunks.map(c => 'data: ' + JSON.stringify({ choices: [{ delta: { content: c } }] }) + '\n\n').join('') + 'data: [DONE]\n\n';
  return {
    ok: true,
    body: {
      getReader() {
        const enc = new TextEncoder();
        let sent = false;
        return {
          read: async () => {
            if (sent) return { done: true };
            sent = true;
            return { done: false, value: enc.encode(frames) };
          },
        };
      },
    },
  };
}
const jsonResponse = obj => ({ ok: true, status: 200, json: async () => obj, text: async () => JSON.stringify(obj) });

const BIBLE = JSON.stringify({
  logline: '外卖骑手意外获得时间回溯能力', style: '国漫风,高饱和,夜城市',
  characters: [{ name: '林小满', role: '主角', look: '红色冲锋衣,马尾', voice: '清亮女声' }],
  scenes: [{ name: '霓虹街头', look: '雨夜,霓虹灯' }],
});
/* 剧本/分镜各拆成 3 个流式 chunk：引擎会发 3 个 delta 事件，用于验证合并 */
const SCRIPT_OBJ = {
  title: '第一单', synopsis: '第一次触发回溯。',
  shots: [{ desc: '雨夜骑车穿行', dialogue: '今晚最后一单！', camera: '中景/跟拍', duration: 5 }],
};
const STORYBOARD_OBJ = { shots: [{ index: 1, imagePrompt: '红衣马尾骑手雨夜霓虹街头,中景', motionPrompt: '骑行穿越车流' }] };

function makeFetch(behavior = {}) {
  const b = Object.assign({ pollCount: 1, stallVideo: false }, behavior);
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, method: init.method || 'GET' });
    const body = init.body ? JSON.parse(init.body) : null;
    if (url.endsWith('/chat/completions')) {
      const raw = String(init.body);
      if (raw.includes('制片助手')) return sseResponse([BIBLE]);
      if (raw.includes('编剧')) return sseResponse(JSON.stringify(SCRIPT_OBJ).match(/.{1,30}/g));   // 3+ chunk
      if (raw.includes('分镜师')) return sseResponse(JSON.stringify(STORYBOARD_OBJ).match(/.{1,30}/g));
      return sseResponse(['{}']);
    }
    if (url.endsWith('/images/generations')) return jsonResponse({ data: [{ url: 'https://img.mock/a.png' }] });
    if (url.endsWith('/videos/generations')) return jsonResponse({ id: 'task-' + calls.length });
    const m = url.match(/\/videos\/generations\/(.+)$/);
    if (m) {
      if (b.stallVideo) return jsonResponse({ task_status: 'PROCESSING' });
      b.polled = (b.polled || 0) + 1;
      if (b.polled % b.pollCount !== 0) return jsonResponse({ task_status: 'PROCESSING' });
      return jsonResponse({ task_status: 'SUCCESS', video_result: [{ url: 'https://vid.mock/v.mp4', cover_image_url: 'https://img.mock/c.jpg' }] });
    }
    return jsonResponse({ error: 'mock 未覆盖: ' + url });
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

/* ---------- 装配：可注入的 settings + 固定大窗口 batchMs（批量行为确定性） ---------- */
const audioDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reins-comic-mgr-test-'));
function makeManager(overrides = {}) {
  let settings = overrides.settings || {};
  const written = [];
  const mgr = comicManager.create({
    readSettings: () => settings,
    writeSettings: s => { settings = s; written.push(JSON.parse(JSON.stringify(s))); },
    audioDir,
    fetchImpl: overrides.fetchImpl,
    batchMs: overrides.batchMs || 60000,   // 测试窗口内不靠定时器冲刷，只靠终态事件冲刷（确定性）
  });
  return { mgr, getSettings: () => settings, written };
}
const RENDER_OK = { provider: 'zhipu', baseURL: 'http://mock.test/v1', apiKey: 'k-render', imageModel: 'cogview-mock', videoModel: 'cogvideox-mock', voiceModel: '' };
const WRITER = { baseURL: 'http://mock.test/v1', apiKey: 'k-writer', model: 'glm-mock' };

/* 主进程按窗口批量推送 {type:'batch', events:[...]}：收集器解包成扁平事件流，既有断言口径不变 */
const collect = events => e => {
  if (e && e.type === 'batch' && Array.isArray(e.events)) events.push(...e.events);
  else events.push(e);
};
async function waitTerminal(events, timeoutMs = 20000) {
  const t0 = Date.now();
  for (;;) {
    if (events.some(e => ['done', 'error', 'cancelled'].includes(e.type))) return;
    if (Date.now() - t0 > timeoutMs) throw new Error('等待终态事件超时：' + events.map(e => e.type).join(','));
    await new Promise(r => setTimeout(r, 10));
  }
}

/* 用例部分包异步 IIFE（顶层 await 需在函数体内，保持文件可按 CommonJS 运行，与 test-comic.js 同款） */
(async () => {

/* ============ 1. 渲染引擎配置 ============ */
console.log('\n[1] 渲染引擎配置（settings.renderEngine）');
{
  const { mgr, getSettings, written } = makeManager();
  const dft = mgr.getRenderEngine();
  ok(dft.provider === 'zhipu' && dft.baseURL.includes('bigmodel') && dft.imageModel === 'cogview-4' && dft.apiKey === '', '默认取智谱预置，Key 为空');
  const r1 = mgr.setRenderEngine({ apiKey: 'k1' });
  ok(r1.ok && r1.engine.apiKey === 'k1' && r1.engine.videoModel === 'cogvideox-3', '局部补丁合并，预置字段保留');
  ok(getSettings().renderEngine.apiKey === 'k1' && written.length === 1, '配置写入 settings.json（经注入的 writeSettings）');
  const r2 = mgr.setRenderEngine({ provider: 'custom', baseURL: 'http://gpu.local/v1', apiKey: 'k2' });
  ok(r2.ok && r2.engine.imageModel === '' && r2.engine.videoModel === '' && r2.engine.baseURL === 'http://gpu.local/v1', '切换 custom 重置模型字段（不残留智谱预置）');
  const r3 = mgr.setRenderEngine({ provider: 'nope' });
  ok(!r3.ok && r3.error.includes('未知渲染服务商'), '未知服务商被拒绝');
}

/* ============ 2. 连通测试（零成本探测） ============ */
console.log('\n[2] 渲染引擎连通测试');
{
  const statusFetch = status => async () => ({ ok: status < 400, status, text: async () => '{"error":{"code":"1210"}}' });
  const mk = f => makeManager({ fetchImpl: f, settings: { renderEngine: RENDER_OK } }).mgr;

  const r401 = await mk(statusFetch(401)).testRenderEngine();
  ok(!r401.ok && r401.message.includes('API Key 无效'), '401 → Key 无效');
  const r403 = await mk(statusFetch(403)).testRenderEngine();
  ok(!r403.ok && r403.message.includes('API Key 无效'), '403 → Key 无效');
  const r400 = await mk(statusFetch(400)).testRenderEngine();
  ok(r400.ok && r400.message.includes('未产生消耗'), '400 → 鉴权通过（零成本探测语义）');
  const r200 = await mk(statusFetch(200)).testRenderEngine();
  ok(r200.ok, '200 → 完全连通');

  let calls = 0;
  const netErr = mk(async () => { calls++; throw new Error('ECONNREFUSED 测试'); });
  const rNet = await netErr.testRenderEngine();
  ok(!rNet.ok && rNet.message.includes('ECONNREFUSED'), '网络错误透传可读信息');

  let zero = 0;
  const mgrNoKey = makeManager({ fetchImpl: async () => { zero++; return statusFetch(200)(); } }).mgr;  // settings 空 → apiKey 空
  const rNoKey = await mgrNoKey.testRenderEngine();
  ok(!rNoKey.ok && rNoKey.message.includes('API Key') && zero === 0, '缺 Key 前置拦截，不发请求');
  const rBadUrl = mk(statusFetch(200)).testRenderEngine({ baseURL: 'ftp://x', apiKey: 'k' });
  ok(!(await rBadUrl).ok && (await rBadUrl).message.includes('http'), '非 http(s) 地址拦截');
}

/* ============ 3. 引擎装配前置校验 ============ */
console.log('\n[3] start 前置校验（按阶段按需装配引擎）');
{
  const fetchImpl = makeFetch();
  const { mgr } = makeManager({ fetchImpl, settings: { renderEngine: RENDER_OK } });
  const created = mgr.create({ title: '时间快递', episodesPer: 1 });
  ok(created.ok && created.comic.id, 'comicCreate 工厂透传可用');

  const evts = [];
  let r = mgr.start({ comic: created.comic, writerAgent: { id: 'a1', mode: 'cli', cliId: 'zcode' } }, collect(evts));
  ok(!r.ok && r.error.includes('API 模型'), 'CLI Agent 当编剧被拒绝');
  r = mgr.start({ comic: created.comic, writerAgent: { id: 'a2', mode: 'api', provider: 'glm' } }, collect(evts));
  ok(!r.ok && r.error.includes('API Key'), 'API Agent 缺 Key 被拒绝');
  r = mgr.start({ comic: created.comic, scope: { stage: 'voice' }, writer: WRITER }, collect(evts));
  ok(!r.ok && r.error.includes('配音模型'), '指定 voice 阶段但未配 voiceModel 被拦截');
  ok(evts.length === 0 && fetchImpl.calls.length === 0, '前置失败零事件零请求（同步可读错误）');

  const noRender = makeManager({ fetchImpl, settings: {} }).mgr;
  r = noRender.start({ comic: created.comic, writer: WRITER }, () => { });
  ok(!r.ok && r.error.includes('渲染引擎'), '未配置渲染引擎被拦截');

  /* REINS-126 返工③：渲染引擎配置缺口逐字段细查（缺什么、影响哪个阶段、去哪配） */
  const mkNoRun = cfg => makeManager({ fetchImpl, settings: { renderEngine: cfg } }).mgr;
  r = mkNoRun({ ...RENDER_OK, baseURL: '' }).start({ comic: created.comic, writer: WRITER }, () => { });
  ok(!r.ok && r.error.includes('服务地址') && r.error.includes('Base URL') && r.error.includes('渲染引擎'), '缺 baseURL：点名服务地址 + 设置入口');
  r = mkNoRun({ ...RENDER_OK, apiKey: '' }).start({ comic: created.comic, writer: WRITER }, () => { });
  ok(!r.ok && r.error.includes('API Key') && r.error.includes('渲染引擎'), '缺 apiKey：单独点名 Key');
  r = mkNoRun({ provider: 'custom', baseURL: 'http://x/v1', apiKey: 'k', imageModel: '', videoModel: '' }).start({ comic: created.comic, writer: WRITER }, () => { });
  ok(!r.ok && r.error.includes('图像模型'), '自定义端点缺图像模型被点名');
  r = mkNoRun({ provider: 'custom', baseURL: 'http://x/v1', apiKey: 'k', imageModel: 'im', videoModel: '' }).start({ comic: created.comic, writer: WRITER, scope: { stage: 'video' } }, () => { });
  ok(!r.ok && r.error.includes('视频模型') && r.error.includes('视频」阶段'), 'video 阶段缺视频模型：点名模型 + 阶段');
  r = mkNoRun(RENDER_OK).start({ comic: created.comic, writer: WRITER, scope: { stage: 'voice' } }, () => { });
  ok(!r.ok && r.error.includes('配音模型') && r.error.includes('跳过'), 'voice 阶段缺配音模型：点名 + 说明可跳过');

  /* 纯本地阶段（assemble）：零引擎放行，且不触发任何网络请求 */
  const done = comicManager.create({
    readSettings: () => ({}), writeSettings: () => { }, audioDir, fetchImpl,
  });
  const withShots = comicManager.create({ readSettings: () => ({}), writeSettings: () => { }, audioDir, fetchImpl })
    .normalize({ id: 'cpAssemble', title: '本地合成', episodes: [{ id: 'epA', shots: [{ id: 'shA1', desc: 'x', videoUrl: 'https://v/1.mp4', duration: 5 }] }] });
  const evtsA = [];
  const rA = done.start({ comic: withShots, scope: { stage: 'assemble' } }, collect(evtsA));
  ok(rA.ok, 'assemble 阶段无需任何引擎即可启动');
  await waitTerminal(evtsA);
  ok(evtsA.some(e => e.type === 'done') && fetchImpl.calls.length === 0, 'assemble 纯本地完成，零网络请求');
}

/* ============ 4. manager 全流程 + delta 合并 ============ */
console.log('\n[4] 全流程（start → done，delta 合并与事件顺序）');
{
  const fetchImpl = makeFetch();
  const { mgr } = makeManager({ fetchImpl, settings: { renderEngine: RENDER_OK } });
  const created = mgr.create({ title: '时间快递', episodesPer: 1 });
  const events = [];
  const r = mgr.start({ comic: created.comic, writer: WRITER, pollMs: 1 }, collect(events));
  ok(r.ok, 'start 通过（writer 直配 + settings 渲染引擎）');
  const snap = mgr.snapshot(created.comic.id);
  ok(snap && snap.running === true && snap.comic.id === created.comic.id, 'snapshot 运行中可见');
  await waitTerminal(events);
  ok(events.some(e => e.type === 'done') && !events.some(e => e.type === 'error'), '收到 done 且无 error');
  ok(mgr.snapshot(created.comic.id) === null, '结束后 snapshot 清空');

  /* delta 合并：script/storyboard 各 3+ chunk，合并后每阶段只剩 1 个 delta 事件，文本完整 */
  const scriptDeltas = events.filter(e => e.type === 'delta' && e.stage === 'script');
  ok(scriptDeltas.length === 1, `script 阶段 3+ 个流式 chunk 合并为 1 个 delta 事件（实际 ${scriptDeltas.length}）`);
  ok(scriptDeltas[0] && scriptDeltas[0].text === JSON.stringify(SCRIPT_OBJ), '合并后文本与原始完整输出一致');
  const sbDeltas = events.filter(e => e.type === 'delta' && e.stage === 'storyboard');
  ok(sbDeltas.length === 1 && sbDeltas[0].text === JSON.stringify(STORYBOARD_OBJ), 'storyboard 同样合并完整');
  /* 顺序：合并后的 delta 必须位于本阶段 start 之后、end 之前 */
  const idx = pred => events.findIndex(pred);
  ok(idx(e => e.type === 'stage' && e.stage === 'script' && e.state === 'start') < idx(e => e.type === 'delta' && e.stage === 'script')
    && idx(e => e.type === 'delta' && e.stage === 'script') < idx(e => e.type === 'stage' && e.stage === 'script' && e.state === 'end'),
    '合并 delta 保持在阶段 start/end 边界之间（顺序不乱）');
  /* 补丁事件齐备：comic 状态推进 + 镜头产物回填 */
  ok(events.some(e => e.type === 'comic' && e.patch && e.patch.status === 'done'), 'comic 补丁事件回传终态');
  ok(events.filter(e => e.type === 'shot' && e.patch && e.patch.videoUrl).length === 1, 'shot 补丁事件回传视频产物');
  const live = events.filter(e => e.type === 'comic').at(-1);
  ok(live && fetchImpl.calls.some(x => x.url.endsWith('/videos/generations')), '真实走了视频提交+轮询');
}

/* ============ 5. 终止 + 状态收养 ============ */
console.log('\n[5] 终止 / 状态收养（adopt）');
{
  /* 本段需在运行中途观察到 video 阶段开始再取消：batchMs 用小窗口（10ms），
     让 stage 事件按定时器及时冲刷可见；§4 用大窗口验证的是「仅终态冲刷」的确定性 */
  const fetchImpl = makeFetch({ stallVideo: true });
  const { mgr } = makeManager({ fetchImpl, settings: { renderEngine: RENDER_OK }, batchMs: 10 });
  const created = mgr.create({ title: '时间快递', episodesPer: 1 });
  const events = [];
  mgr.start({ comic: created.comic, writer: WRITER, pollMs: 5 }, collect(events));
  const t0 = Date.now();
  for (;;) {   // 等视频轮询开始再取消
    if (events.some(e => e.stage === 'video' && e.type === 'stage' && e.state === 'start')) break;
    if (Date.now() - t0 > 15000) throw new Error('等待视频阶段超时');
    await new Promise(r => setTimeout(r, 10));
  }
  ok(mgr.cancel(created.comic.id) === true, 'cancel 命中运行中任务');
  await waitTerminal(events);
  ok(events.some(e => e.type === 'cancelled'), '收到 cancelled 事件');
  const snap = mgr.snapshot(created.comic.id);
  const pausedComic = (snap && snap.comic) || events.filter(e => e.type === 'comic').at(-1)?.patch;
  ok(pausedComic && pausedComic.status !== 'running', '终止后不在运行态');

  /* 收养：持久化档遗留 running（主进程无任务）→ paused；真运行中的不被误伤 */
  const { mgr: mgr2 } = makeManager({ fetchImpl: makeFetch(), settings: { renderEngine: RENDER_OK } });
  const stale = mgr2.normalize({ id: 'cpStale', title: '重启遗留', status: 'running', progress: { stage: 'video', pct: 40, note: '' } });
  const adopted = mgr2.adopt(stale);
  ok(adopted.status === 'paused' && adopted.progress.note.includes('重启'), '遗留 running 收养为 paused 并注明');
  const fresh = mgr2.normalize({ id: 'cpFresh', title: '草稿', status: 'draft' });
  ok(mgr2.adopt(fresh).status === 'draft', '非 running 状态原样保留');
}

/* ============ 6. 渲染引擎配置持久化（REINS-126 返工：重启丢配置） ============ */
console.log('\n[6] 渲染引擎配置持久化（真实文件 · 跨重启 · 写失败可见）');
{
  /* 与 main.js 同款 read/write：默认值合并 + 原子写 + 独立文件句柄（每次读盘） */
  const setFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'reins-comic-set-')), 'settings.json');
  const defaults = { launchAtLogin: false, keepInTray: true, cloudUrl: '' };
  const readF = () => { try { return { ...defaults, ...JSON.parse(fs.readFileSync(setFile, 'utf-8')) }; } catch (e) { return { ...defaults }; } };
  const writeF = s => { const tmp = setFile + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(s, null, 2)); fs.renameSync(tmp, setFile); };

  const mgrA = comicManager.create({ readSettings: readF, writeSettings: writeF, audioDir });
  const r = mgrA.setRenderEngine({ provider: 'custom', baseURL: 'http://gpu.local/v1', apiKey: 'k9', imageModel: 'im9', videoModel: 'vm9' });
  ok(r.ok, '配置保存成功（回读校验通过）');

  /* 其他设置走「读-改-写」（reins:settings:set 同款）：不得挤掉 renderEngine */
  const s = readF(); s.cloudUrl = 'https://node.example.com'; writeF(s);

  /* 模拟应用重启：全新工厂实例 + 全新 readF 闭包读同一文件 */
  const mgrB = comicManager.create({ readSettings: readF, writeSettings: writeF, audioDir });
  const back = mgrB.getRenderEngine();
  ok(back.provider === 'custom' && back.baseURL === 'http://gpu.local/v1' && back.apiKey === 'k9' && back.imageModel === 'im9' && back.videoModel === 'vm9',
    '重启后配置完整读回（且其他设置写入后仍保留）');

  /* 写盘失败必须可见：静默吞错正是「界面提示已保存、重启即丢」的根源 */
  const broken = comicManager.create({ readSettings: () => ({}), writeSettings: () => { throw new Error('disk full（模拟）'); }, audioDir });
  const rb = broken.setRenderEngine({ apiKey: 'kX' });
  ok(!rb.ok && rb.error.includes('写入失败'), 'writeSettings 抛错 → 返回可读失败');
  const noop = comicManager.create({ readSettings: () => ({}), writeSettings: () => { }, audioDir });   // 写入未落盘（读回仍空）
  const rn = noop.setRenderEngine({ apiKey: 'kY' });
  ok(!rn.ok && rn.error.includes('settings.json'), '写入未生效（回读不一致）→ 返回可读失败，不假装成功');

  /* 返工①：增量配置叠加不覆盖既有字段（多轮写不互相挤掉）；回读校验与磁盘键序无关 */
  const rInc = mgrA.setRenderEngine({ voiceModel: 'cogtts' });
  ok(rInc.ok && rInc.engine.voiceModel === 'cogtts' && rInc.engine.apiKey === 'k9'
    && rInc.engine.baseURL === 'http://gpu.local/v1' && rInc.engine.provider === 'custom', '增量配置叠加：新字段生效、既有字段保留');
  const sAfter = readF();
  ok(sAfter.cloudUrl === 'https://node.example.com' && sAfter.renderEngine.voiceModel === 'cogtts',
    '其他设置与渲染引擎配置共存一份 settings.json（无交叉覆盖）');
}

/* ============ 7. 事件批量推送（REINS-126 返工：IPC 频率过高致 UI 卡顿） ============ */
console.log('\n[7] 事件批量推送（{type:"batch"} 单条 IPC）');
{
  const frames = [];                       // 收集主进程实际推送的「帧」（不解包）
  const fetchImpl = makeFetch();
  const mgr = comicManager.create({
    readSettings: () => ({ renderEngine: RENDER_OK }), writeSettings: () => { },
    audioDir, fetchImpl, batchMs: 40,
  });
  const created = mgr.create({ title: '批量推送', episodesPer: 1 });
  const r = mgr.start({ comic: created.comic, writer: WRITER, pollMs: 1 }, f => frames.push(f));
  ok(r.ok, 'start 通过');
  const flat = () => frames.flatMap(f => (f && f.type === 'batch' && Array.isArray(f.events)) ? f.events : [f]);
  /* flat() 每次是快照：轮询活视图等终态（waitTerminal 只认持久数组引用） */
  {
    const t0 = Date.now();
    for (;;) {
      if (flat().some(e => ['done', 'error', 'cancelled'].includes(e.type))) break;
      if (Date.now() - t0 > 20000) throw new Error('等待终态事件超时：' + flat().map(e => e.type).join(','));
      await new Promise(r => setTimeout(r, 10));
    }
  }
  ok(frames.length >= 1 && frames.every(f => f.type === 'batch' && Array.isArray(f.events) && f.events.length), '所有推送均为非空批量帧');
  ok(frames.length < flat().length, `消息条数（${frames.length}）< 事件数（${flat().length}）：IPC 频率被窗口压平`);
  const seqs = flat().filter(e => e.seq).map(e => e.seq);
  ok(seqs.length > 1 && seqs.every((v, i) => i === 0 || v > seqs[i - 1]), '批内/批间 seq 严格递增（乱序丢弃依据不破）');
  const lastFrame = frames[frames.length - 1], lastEvt = flat()[flat().length - 1];
  ok(lastFrame.events[lastFrame.events.length - 1].type === 'done' && lastEvt.type === 'done', '终态事件立即冲刷且位于最后一帧末尾');
}

/* ============ 8. 合成包按需重建（REINS-126 返工：导出旧包缺镜头） ============ */
console.log('\n[8] rebuildPackage（导出前按最新镜头数据重算）');
{
  const { mgr } = makeManager({ settings: { renderEngine: RENDER_OK } });
  const stale = mgr.normalize({
    id: 'cpPkg', title: '合成包刷新', aspect: '9:16',
    episodes: [{
      id: 'ep1', n: 1, title: '第一集',
      shots: [
        { id: 's1', index: 1, desc: 'a', duration: 5, imageUrl: 'http://i/1', videoUrl: 'http://v/1' },
        { id: 's2', index: 2, desc: 'b', duration: 5, imageUrl: 'http://i/2', videoUrl: '' },       // 旧包时代 shot2 缺视频
        { id: 's3', index: 3, desc: 'c', duration: 5, imageUrl: 'http://i/3', videoUrl: 'http://v/3' },
      ],
      package: { srt: '', ffmpegSh: '#!/bin/sh\n# 旧包只有 2 个镜头', shotlistMd: '| # |\n|---|', durationSec: 15, missing: 1, at: 1 },
    }],
  });
  /* 模拟单镜头重跑成功后渲染层回填 */
  stale.episodes[0].shots[1].videoUrl = 'http://v/2';
  const rp = mgr.rebuildPackage(stale, 'ep1');
  ok(rp.ok && rp.package.missing === 0, '按最新镜头数据重建：missing 归零');
  ok((rp.package.ffmpegSh.match(/^file 'shot-/gm) || []).length === 3, 'concat 清单含全部 3 个镜头');
  ok(rp.package.shotlistMd.includes('http://v/2'), '分镜表明细含重跑镜头地址');
  ok(rp.package.at > 1, '重建时间戳更新');
  ok(!mgr.rebuildPackage(stale, 'ep404').ok, '剧集不存在返回错误');
  ok(!mgr.rebuildPackage(mgr.normalize({ id: 'cpE', title: '空集', episodes: [{ id: 'ep0', shots: [] }] }), 'ep0').ok, '无镜头剧集返回错误');
}

console.log(`\n结果：${passed} 通过 · ${failed} 失败`);
process.exit(failed ? 1 : 0);
})().catch(e => { console.error('测试运行异常：', e); process.exit(1); });
