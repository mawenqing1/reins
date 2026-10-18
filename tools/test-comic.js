/* ============================================================
   REINS-126 漫剧工作流 · 自测（纯 Node，零依赖、零网络）
   用注入的 mock fetch 驱动 services/comic.js：
     1) createComic 输入校验 / normalizeComic 归档体检
     2) 全流程：bible → script → storyboard → image → video → voice → assemble
     3) 单镜头失败隔离（其余镜头照常完成，episode 标 failed）
     4) 终止（cancel → paused + cancelled 事件）
     5) 单镜头重跑（scope.shotId + stage）
   运行：node tools/test-comic.js
   ============================================================ */
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const comic = require('../services/comic');

let passed = 0, failed = 0;
function ok(cond, name) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.error('  ✕ ' + name); }
}

/* ---------- mock fetch：按 URL + 调用序返回预置响应 ---------- */
function sseResponse(chunks) {
  // 模拟 OpenAI 兼容 SSE：每个 chunk 一个 data: 帧，结尾 [DONE]
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
const jsonResponse = obj => ({ ok: true, json: async () => obj, text: async () => JSON.stringify(obj) });

const BIBLE_JSON = JSON.stringify({
  logline: '外卖骑手意外获得时间回溯能力', style: '国漫风,高饱和,夜城市',
  characters: [{ name: '林小满', role: '主角', look: '红色冲锋衣,马尾,圆脸', voice: '清亮女声' }, { name: '老周', role: '配角', look: '灰色工装,络腮胡', voice: '低沉男声' }],
  scenes: [{ name: '霓虹街头', look: '雨夜,霓虹灯,湿地面反光' }],
});
const SCRIPT_JSON = JSON.stringify({
  title: '第一单', synopsis: '林小满第一次触发回溯。',
  shots: [
    { desc: '雨夜骑车穿行', dialogue: '今晚最后一单！', camera: '中景/跟拍', duration: 5 },
    { desc: '差点撞上货车，时间凝固', dialogue: '', camera: '特写/推镜头', duration: 5 },
    { desc: '时间倒回三秒', dialogue: '刚才……发生了什么？', camera: '近景', duration: 5 },
  ],
});
const STORYBOARD_JSON = JSON.stringify({
  shots: [
    { index: 1, imagePrompt: '红衣马尾骑手雨夜霓虹街头,中景', motionPrompt: '骑行穿越车流,镜头跟随' },
    { index: 2, imagePrompt: '红衣马尾骑手特写,货车灯光,恐惧表情', motionPrompt: '雨滴悬停,镜头缓推' },
    { index: 3, imagePrompt: '红衣马尾骑手近景,雨滴倒流', motionPrompt: '时间倒流粒子效果' },
  ],
});

function makeFetch(behavior) {
  // behavior: { failShot2Video, pollCount } —— 供各用例定制
  const b = Object.assign({ pollCount: 2, failShot2Video: false }, behavior);
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, method: init.method || 'GET' });
    const body = init.body ? JSON.parse(init.body) : null;
    if (url.endsWith('/chat/completions')) {
      const sys = JSON.parse(JSON.stringify(init.body));
      if (sys.includes('制片助手')) return sseResponse([BIBLE_JSON]);
      if (sys.includes('编剧')) return sseResponse([SCRIPT_JSON]);
      if (sys.includes('分镜师')) return sseResponse([STORYBOARD_JSON]);
      return sseResponse(['{}']);
    }
    if (url.endsWith('/images/generations')) return jsonResponse({ data: [{ url: 'https://img.mock/' + Math.random().toString(36).slice(2, 8) + '.png' }] });
    if (url.endsWith('/videos/generations')) {
      // 提交：按 prompt/镜头序号区分（镜头 2 的 motionPrompt 含"悬停"）
      const isShot2 = /悬停/.test(body.prompt || '');
      return jsonResponse({ id: 'task-' + (isShot2 ? '2' : 'x') + '-' + calls.length });
    }
    const m = url.match(/\/videos\/generations\/(.+)$/);
    if (m) {
      const isShot2 = m[1].startsWith('task-2-');
      if (isShot2 && b.failShot2Video) return jsonResponse({ task_status: 'FAIL', msg: '内容审核未通过' });
      b.polled = (b.polled || 0) + 1;
      if (b.polled % b.pollCount !== 0) return jsonResponse({ task_status: 'PROCESSING' });
      return jsonResponse({ task_status: 'SUCCESS', video_result: [{ url: 'https://vid.mock/' + m[1] + '.mp4', cover_image_url: 'https://img.mock/cover.jpg' }] });
    }
    if (url.endsWith('/audio/speech')) return { ok: true, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer };
    return jsonResponse({ error: 'mock 未覆盖: ' + url });
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

const WRITER = { baseURL: 'http://mock.test/v1', apiKey: 'k-writer', model: 'glm-mock' };
const RENDER = { provider: 'custom', baseURL: 'http://mock.test/v1', apiKey: 'k-render', imageModel: 'cogview-mock', videoModel: 'cogvideox-mock' };
const VOICE = { preset: 'custom', baseURL: 'http://mock.test/v1', model: 'tts-mock', voice: 'zf_001' };
const audioDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reins-comic-test-'));

function collect(events) { return e => events.push(e); }

async function waitJob(events, predicate, timeoutMs = 20000) {
  const t0 = Date.now();
  for (;;) {
    if (predicate(events)) return;
    if (Date.now() - t0 > timeoutMs) throw new Error('等待事件超时：' + events.map(e => e.type).join(','));
    await new Promise(r => setTimeout(r, 10));
  }
}
const saw = (events, type) => events.some(e => e.type === type);

/* ============ 1. 工厂与体检 ============ */
console.log('\n[1] createComic / normalizeComic');
{
  const bad = comic.createComic({ title: '   ' });
  ok(!bad.ok && bad.code === 'TITLE', '空标题被拒绝（code=TITLE）');
  const bad2 = comic.runJob({}, {}, null);
  ok(!bad2.ok, '空任务对象被预检拒绝');
  const c = comic.createComic({ title: '  时间快递  ', theme: '都市奇幻', episodesPer: 99, shotsPer: 3, aspect: '4:3' }) ;
  ok(c.ok && c.comic.title === '时间快递', '标题去空白');
  ok(c.comic.episodesPer === undefined && c.comic.episodes.length === 24, '集数钳制到 24 并生成空壳剧集');
  ok(c.comic.shotsPer === 4, 'shotsPer 钳制下限 4');
  ok(c.comic.aspect === '9:16', '非法比例回退 9:16');
  const n = comic.normalizeComic({ id: 'cpX', title: '旧档', episodes: [{ shots: [{ index: 9, duration: 999 }, { index: 1 }] }], status: 'weird' });
  ok(n.episodes[0].shots.length === 2 && n.episodes[0].shots[1].duration === 10, '镜头时长钳制 2-10');
  ok(n.episodes[0].shots.map(s => s.index).join() === '1,2', '镜头重排序号连续');
  ok(n.status === 'draft', '未知状态回退 draft');
}

/* ============ 1b. 合成包构造（REINS-126 返工：分镜表缺信息 / concat 缺镜头） ============ */
console.log('\n[1b] buildPackage（表格转义 · 镜头明细 · concat 守卫）');
{
  const ep = comic.normalizeEpisode({
    title: '转义测试', shots: [
      { id: 'a', index: 1, desc: '含|竖线|的画面', dialogue: '带|管道|的台词', camera: '中景', duration: 5, imageUrl: 'http://x/1.png', videoUrl: 'http://x/1.mp4', imagePrompt: 'p1', motionPrompt: 'm1' },
      { id: 'b', index: 2, desc: '无视频镜头', dialogue: '', camera: '近景', duration: 3, imageUrl: 'http://x/2.png', videoUrl: '', err: '视频生成失败（mock）' },
    ],
  }, 0);
  const pkg = comic.buildPackage(ep, '9:16');
  ok(pkg.missing === 1, 'missing 统计缺视频镜头');
  ok((pkg.ffmpegSh.match(/^file 'shot-/gm) || []).length === 1, 'concat 清单只含有视频镜头');
  ok(pkg.shotlistMd.includes('含\\|竖线\\|'), '表格单元格转义竖线（markdown 表格不撕裂）');
  ok(pkg.shotlistMd.includes('镜头明细') && pkg.shotlistMd.includes('http://x/1.mp4') && pkg.shotlistMd.includes('p1') && pkg.shotlistMd.includes('视频生成失败（mock）'), '明细段含产物地址/提示词/失败原因');
  ok((pkg.shotlistMd.match(/^\| (\d) /gm) || []).length === 2, '表格行数 = 镜头数（无缺行）');
  const empty = comic.buildPackage(comic.normalizeEpisode({ title: '空', shots: [{ id: 'z', index: 1, desc: 'x', duration: 5 }] }, 0), '9:16');
  ok(!empty.ffmpegSh.includes('concat') && empty.ffmpegSh.includes('没有镜头视频'), '零视频时不产 concat 段并提示');
}

/* 用例 2-5 依赖任务异步完成：套 async IIFE 逐段 await（原版缺 await，未等任务跑完即断言，全量误报） */
(async () => {

/* ============ 2. 全流程 ============ */
console.log('\n[2] 全流程 bible→…→assemble（含轮询/配音落盘/合成包）');
{
  const created = comic.createComic({ title: '时间快递', theme: '都市奇幻', episodesPer: 1, shotsPer: 3 });
  const c = created.comic;
  const events = [];
  const fetchImpl = makeFetch({});
  const start = comic.runJob({ comic: c, scope: {} }, { writer: WRITER, render: RENDER, voice: VOICE }, collect(events), { fetchImpl, pollMs: 1, audioDir, concurrency: 3 });
  ok(start.ok, 'runJob 预检通过并启动');
  ok(comic.jobSnapshot(c.id) && comic.jobSnapshot(c.id).running === true, 'jobSnapshot 运行中可见');
  const dup = comic.runJob({ comic: c, scope: {} }, { writer: WRITER, render: RENDER, voice: VOICE }, () => { }, { fetchImpl });
  ok(!dup.ok, '重复启动被拒绝');

  await waitJobSync(events);
  ok(saw(events, 'done') && !saw(events, 'error'), '收到 done 且无 error');
  const ep = c.episodes[0];
  ok(c.bible && c.bible.characters.length === 2, 'bible：2 个角色');
  ok(ep.shots.length === 3 && ep.title === '第一单', 'script：3 镜头 + 集标题');
  ok(ep.shots.every(s => s.imagePrompt && s.imageUrl), 'storyboard+image：每镜头有提示词与首帧');
  ok(ep.shots.every(s => s.videoUrl && s.coverUrl), 'video：每镜头有视频与封面');
  const voiced = ep.shots.filter(s => s.dialogue);
  ok(voiced.length === 2 && voiced.every(s => s.audioUrl && fs.existsSync(s.audioUrl)), 'voice：有台词镜头配音已落盘');
  ok(ep.package && ep.package.srt.includes('00:00:05,000') && ep.package.ffmpegSh.includes('concat'), 'assemble：SRT 时间轴 + ffmpeg 拼接脚本');
  ok(c.status === 'done' && c.progress.pct === 100, '项目终态 done / 100%');
  ok(fetchImpl.calls.some(x => x.method === 'GET' && /\/videos\/generations\/.+/.test(x.url)), '视频轮询真实发生');
  ok(!comic.jobSnapshot(c.id), '任务结束后 snapshot 清空');

  // 断点续跑：已完成的全流程再跑一遍，不应再触发任何 LLM/渲染调用
  const before = fetchImpl.calls.length;
  const events2 = [];
  comic.runJob({ comic: c, scope: {} }, { writer: WRITER, render: RENDER, voice: VOICE }, collect(events2), { fetchImpl, pollMs: 1, audioDir });
  await waitJobSync(events2);
  ok(saw(events2, 'done') && fetchImpl.calls.length === before, '幂等续跑：全部已完成，零额外请求');
}
function waitJobSync(events) { return waitJob(events, evs => evs.some(e => e.type === 'done' || e.type === 'error' || e.type === 'cancelled')); }

/* ============ 3. 失败隔离 ============ */
console.log('\n[3] 单镜头失败隔离');
{
  const created = comic.createComic({ title: '时间快递', theme: '都市奇幻', episodesPer: 1 });
  const c = created.comic;
  const events = [];
  const fetchImpl = makeFetch({ failShot2Video: true });
  comic.runJob({ comic: c, scope: {} }, { writer: WRITER, render: RENDER, voice: VOICE }, collect(events), { fetchImpl, pollMs: 1, audioDir });
  await waitJobSync(events);
  const ep = c.episodes[0];
  ok(saw(events, 'done'), '失败不阻断：仍收到 done（summary 携带失败清单）');
  const doneEv = events.find(e => e.type === 'done') || {};
  ok((doneEv.summary?.failed || []).length === 1 && doneEv.summary.failed[0].index === 2, 'summary 标记镜头 2 失败');
  ok(ep.shots[0].videoUrl && ep.shots[2].videoUrl && ep.shots[1].err.includes('审核'), '镜头 1/3 正常，镜头 2 落 err');
  ok(c.status === 'failed' && ep.status === 'failed' && ep.package.missing === 1, '项目/剧集标 failed，合成包标注缺失');

  // 单镜头重跑：只重跑镜头 2 的 video 阶段
  const events3 = [];
  const fetchImpl2 = makeFetch({});
  comic.runJob({ comic: c, scope: { episodeId: ep.id, shotId: ep.shots[1].id, stage: 'video' } }, { writer: WRITER, render: RENDER, voice: VOICE }, collect(events3), { fetchImpl: fetchImpl2, pollMs: 1, audioDir });
  await waitJobSync(events3);
  ok(saw(events3, 'done') && ep.shots[1].videoUrl && !ep.shots[1].err, '单镜头重跑成功');
  const llmCalls = fetchImpl2.calls.filter(x => x.url.endsWith('/chat/completions')).length;
  const imgCalls = fetchImpl2.calls.filter(x => x.url.endsWith('/images/generations')).length;
  ok(llmCalls === 0 && imgCalls === 0, '重跑 video 不重复调用 LLM/图像接口');
  /* REINS-126 返工修复：单镜头重跑后已有合成包必须就地刷新，
     否则导出的 ffmpeg concat / 分镜表仍是缺该镜头的旧包 */
  ok(ep.package.missing === 0 && ep.status === 'done', '重跑后合成包就地刷新（missing 归零、集状态回 done）');
  ok((ep.package.ffmpegSh.match(/^file 'shot-/gm) || []).length === 3, 'concat 清单含全部 3 个镜头（含重跑镜头）');
  ok(ep.package.shotlistMd.includes('task-2-'), '分镜表明细含重跑镜头的视频地址');
}

/* ============ 4. 终止 ============ */
console.log('\n[4] 终止（cancel → paused）');
{
  const created = comic.createComic({ title: '时间快递', episodesPer: 1 });
  const c = created.comic;
  const events = [];
  const fetchImpl = makeFetch({ pollCount: 100000 });   // 视频永远 PROCESSING，卡在轮询
  comic.runJob({ comic: c, scope: {} }, { writer: WRITER, render: RENDER, voice: VOICE }, collect(events), { fetchImpl, pollMs: 5, audioDir });
  // 等视频阶段开始后取消
  await waitJob(events, evs => evs.some(e => e.stage === 'video' && e.type === 'stage' && e.state === 'start'));
  ok(comic.cancelJob(c.id) === true, 'cancelJob 命中运行中任务');
  await waitJobSync(events);
  ok(saw(events, 'cancelled'), '收到 cancelled 事件');
  ok(c.status === 'paused', '终态 paused（可续跑）');
  ok(!comic.cancelJob(c.id), '结束后再取消返回 false');
}

/* ============ 5. 预检：缺引擎 ============ */
console.log('\n[5] 引擎缺失预检');
{
  const created = comic.createComic({ title: '时间快递' });
  const events = [];
  const r = comic.runJob({ comic: created.comic, scope: {} }, { writer: WRITER }, collect(events));
  ok(!r.ok && r.error.includes('渲染引擎'), '缺 render 引擎被预检拦截');
  ok(saw(events, 'error'), '预检失败也发 error 事件（供 UI 提示）');
  const r2 = comic.runJob({ comic: created.comic, scope: { stage: 'nope' } }, { writer: WRITER, render: RENDER, voice: VOICE }, () => { });
  ok(!r2.ok && r2.error.includes('未知阶段'), '非法 stage 拦截');
  const r3 = comic.runJob({ comic: created.comic, scope: { shotId: 'shX', stage: 'video' } }, { writer: WRITER, render: RENDER, voice: VOICE }, () => { });
  ok(!r3.ok && r3.error.includes('剧集'), 'shotId 缺 episodeId 拦截');
  /* REINS-126 返工③：渲染引擎未配时逐字段点名（缺什么、影响哪个阶段、去哪配） */
  const r4 = comic.runJob({ comic: created.comic, scope: {} }, { writer: WRITER, render: { ...RENDER, baseURL: '' } }, () => { });
  ok(!r4.ok && r4.error.includes('服务地址') && r4.error.includes('Base URL') && r4.error.includes('渲染引擎'), '缺 baseURL：单独点名服务地址');
  const r5 = comic.runJob({ comic: created.comic, scope: {} }, { writer: WRITER, render: { ...RENDER, apiKey: '' } }, () => { });
  ok(!r5.ok && r5.error.includes('API Key') && r5.error.includes('渲染引擎'), '缺 apiKey：单独点名 Key');
  const r6 = comic.runJob({ comic: created.comic, scope: { stage: 'video' } }, { writer: WRITER, render: { ...RENDER, apiKey: '' } }, () => { });
  ok(!r6.ok && r6.error.includes('视频」阶段'), '指定阶段时错误带上阶段名');
}

console.log(`\n结果：${passed} 通过 · ${failed} 失败`);
process.exit(failed ? 1 : 0);
})().catch(e => { console.error('测试运行异常：', e); process.exit(1); });
