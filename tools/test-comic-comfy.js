/* ============================================================
   漫剧本地渲染（ComfyUI 通道）· 自测（纯 Node，零依赖、零网络）
   mock ComfyUI HTTP（/prompt /history /upload/image /view /system_stats）驱动：
     1) comfyGenImage：提交→轮询→/view 首帧 URL；画幅→尺寸映射
     2) comfyGenVideo：首帧取回→上传回 input→i2v 工作流注入（提示词/首帧文件名）→产物 URL
     3) 提交失败传播（节点校验错误信息）；排队→完成两拍轮询
     4) genImage/genVideo 按 provider 分发（comfy 不碰云端 /images|/videos/generations）
     5) comic-manager：comfy 预设归一化 / 配置缺口只查地址 / 连通探活
   运行：node tools/test-comic-comfy.js
   ============================================================ */
'use strict';
const assert = require('assert');
const comic = require('../services/comic');

let passed = 0, failed = 0;
function ok(cond, name) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.error('  ✕ ' + name); }
}

const BASE = 'http://127.0.0.1:8188';
async function main() {
  /* 简版 mock fetch：按方法+URL 前缀路由，可编排 /history 前几拍为空（排队） */
  function makeComfyFetch({ histPolls = 0, outputs = { '11': { images: [{ filename: 'ff_0001.png', subfolder: 'comic', type: 'output' }] } }, submitError = null, uploaded = [], queueAlivePolls = 0 } = {}) {
    const calls = [];
    let polls = 0;
    const json = (obj) => ({ ok: true, json: async () => obj });
    const fetchImpl = async (url, init = {}) => {
      const u = String(url);
      calls.push({ method: init.method || 'GET', url: u, init });
      if (u.startsWith(BASE + '/prompt')) {
        if (submitError) return { ok: false, status: 400, json: async () => submitError };
        const wf = JSON.parse(init.body).prompt;
        return json({ prompt_id: 'pid-1' });
      }
      if (u.startsWith(BASE + '/history/')) {
        if (polls++ < histPolls) return json({});            // 排队中（history 未出现）
        return json({ 'pid-1': { status: { completed: true, status_str: 'success' }, outputs } });
      }
      if (u.startsWith(BASE + '/upload/image')) {
        uploaded.push(init.body);
        return json({ name: 'comic_firstframe_0.png', subfolder: '', type: 'input' });
      }
      if (u.startsWith(BASE + '/queue')) {
        /* 活动感知等待探活：前 queueAlivePolls 次返回我们的任务在执行，之后空队列 */
        fetchImpl.qCalls = (fetchImpl.qCalls || 0) + 1;
        return json(fetchImpl.qCalls <= queueAlivePolls
          ? { queue_running: [['n1', 'pid-1']], queue_pending: [] }
          : { queue_running: [], queue_pending: [] });
      }
      if (u.startsWith(BASE + '/view')) {
        return { ok: true, arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer };
      }
      if (u.startsWith(BASE + '/system_stats')) return json({ system: { comfyui_version: '0.34.0' } });
      throw new Error('mock 未覆盖: ' + u);
    };
    fetchImpl.calls = calls;
    fetchImpl.capturedWorkflow = () => JSON.parse(fetchImpl.calls.find(c => c.url.startsWith(BASE + '/prompt')).init.body).prompt;
    return fetchImpl;
  }
  const render = { provider: 'comfy', baseURL: BASE, apiKey: '', imageModel: 'flux1-schnell-Q4_K_S', videoModel: 'Wan2.2-TI2V-5B-Q4_K_M', voiceModel: '' };

  console.log('\n[1] 首帧（comfyGenImage）');
  {
    const f = makeComfyFetch();
    const r = await comic._internal.comfyGenImage(render, '夜晚霓虹街头，少女回眸，电影感', { aspect: '16:9', signal: null, fetchImpl: f, pollMs: 1 });
    ok(r.url === BASE + '/view?filename=ff_0001.png&subfolder=comic&type=output', '产物为本地 /view URL');
    const wf = f.capturedWorkflow();
    ok(wf['4'].inputs.text.includes('霓虹') && wf['4'].inputs.text.includes('__') === false, '提示词注入正向节点（占位已替换）');
    ok(wf['7'].inputs.width === 1024 && wf['7'].inputs.height === 576, '16:9 → 1024×576');
    ok(wf['1'].inputs.unet_name === 'flux1-schnell-Q4_K_S.gguf' && wf['8'].inputs.steps === 4, 'FLUX schnell 4 步工作流');
  }
  {
    const f = makeComfyFetch();
    await comic._internal.comfyGenImage(render, 'p', { aspect: '9:16', signal: null, fetchImpl: f, pollMs: 1 });
    const wf = f.capturedWorkflow();
    ok(wf['7'].inputs.width === 576 && wf['7'].inputs.height === 1024, '9:16 → 576×1024');
  }

  console.log('\n[2] 镜头视频（comfyGenVideo · 图生视频）');
  {
    const uploaded = [];
    const f = makeComfyFetch({ outputs: { '11': { gifs: [{ filename: 'Comic_i2v_0001.webm', subfolder: 'video', type: 'output' }] } }, uploaded });
    const imageUrl = BASE + '/view?filename=ff_0001.png&subfolder=comic&type=output';
    const r = await comic._internal.comfyGenVideo(render, { prompt: '镜头缓慢推近', imageUrl, aspect: '16:9' }, { signal: null, fetchImpl: f, pollMs: 1 });
    ok(r.url.includes('/view?filename=Comic_i2v_0001.webm'), '视频产物 URL');
    ok(r.coverUrl === imageUrl, '封面沿用首帧');
    const up = f.calls.find(c => c.url.startsWith(BASE + '/upload/image'));
    ok(!!up, '首帧已上传回 input 目录');
    const wf = f.capturedWorkflow();
    ok(wf['30'].inputs.image === 'comic_firstframe_0.png', 'LoadImage 注入上传后的首帧文件名');
    ok(wf['4'].inputs.text === '镜头缓慢推近', '运镜提示词注入');
    ok(wf['7'].class_type === 'Wan22ImageToVideoLatent' && wf['7'].inputs.start_image[0] === '30', 'Wan2.2 i2v：首帧经 VAE 进 latent');
  }

  console.log('\n[2.5] comfyWait 活动感知：在队列就续期 / 队列消失才报错（冷加载 15 分钟不再误杀）');
  {
    /* 完成点在固定超时之后（120ms > 60ms），但任务一直在队列里 → 每次探活续期，最终成功 */
    const f = makeComfyFetch({ histPolls: 8, queueAlivePolls: 8 });
    const r = await comic._internal.comfyWait(BASE, 'pid-1', { signal: null, fetchImpl: f, pollMs: 15, pollTimeoutMs: 60 });
    ok(r && r.filename === 'ff_0001.png', '队列存活期间持续续期（超固定时限仍等到产物）');
  }
  {
    /* history 永不出现且队列里也没有 → 无活动超时点名「队列消失」 */
    const f = makeComfyFetch({ histPolls: 9999, queueAlivePolls: 0 });
    let msg = '';
    try { await comic._internal.comfyWait(BASE, 'pid-1', { signal: null, fetchImpl: f, pollMs: 20, pollTimeoutMs: 100 }); }
    catch (e) { msg = e.message; }
    ok(/队列消失/.test(msg), '队列+history 双缺失 → 快速失败并点名原因');
  }

  console.log('\n[3] 提交失败与排队轮询');
  {
    const f = makeComfyFetch({ submitError: { error: { type: 'value_error', message: 'UnetLoaderGGUF.gguf_name not in list: flux1-schnell-Q4_K_S.gguf' } } });
    let threw = '';
    try { await comic._internal.comfyGenImage(render, 'p', { aspect: '16:9', signal: null, fetchImpl: f, pollMs: 1 }); } catch (e) { threw = e.message; }
    ok(threw.includes('ComfyUI 提交失败') && threw.includes('flux1-schnell'), '节点校验错误透传（模型缺失可诊断）');
  }
  {
    const f = makeComfyFetch({ histPolls: 2 });
    const r = await comic._internal.comfyGenImage(render, 'p', { aspect: '16:9', signal: null, fetchImpl: f, pollMs: 1 });
    ok(!!r.url && f.calls.filter(c => c.url.includes('/history/')).length >= 3, '排队两拍后完成（轮询不提前放弃）');
  }

  console.log('\n[4] provider 分发（genImage/genVideo 入口）');
  {
    const f = makeComfyFetch();
    await comic._internal.genImage(render, '分发测试', { aspect: '16:9', signal: null, fetchImpl: f, pollMs: 1 });
    ok(!f.calls.some(c => c.url.includes('/images/generations')), 'comfy 不触碰云端 images 端点');
    ok(f.calls.some(c => c.url.startsWith(BASE + '/prompt')), '走 ComfyUI /prompt');
  }
  {
    const f = makeComfyFetch({ outputs: { '11': { gifs: [{ filename: 'v.webm', subfolder: '', type: 'output' }] } } });
    await comic._internal.genVideo(render, { prompt: 'x', imageUrl: BASE + '/view?filename=a.png', aspect: '16:9', duration: 5 }, { signal: null, fetchImpl: f, pollMs: 1 });
    ok(!f.calls.some(c => c.url.includes('/videos/generations')), 'comfy 不触碰云端 videos 端点');
  }

  console.log('\n[5.5] precheck：comfy 无 Key 放行（启动被拦回归——此前 precheck 仍无条件要 apiKey）');
  {
    const eng = { writer: { baseURL: 'https://x', apiKey: 'k' }, render: { provider: 'comfy', baseURL: BASE, apiKey: '' } };
    const job = { comic: { id: 'c1', episodes: [] }, scope: {} };
    const r = comic._internal.precheck(job, eng);
    ok(r.ok === true, 'comfy + 地址 + 空 Key → 预检通过');
    const r2 = comic._internal.precheck(job, { ...eng, render: { provider: 'comfy', baseURL: '', apiKey: '' } });
    ok(r2.ok === false && /本地 ComfyUI 未配置地址/.test(r2.error), 'comfy 缺地址 → 点名地址而非 Key');
    const r3 = comic._internal.precheck(job, { ...eng, render: { provider: 'zhipu', baseURL: 'https://x', apiKey: '' } });
    ok(r3.ok === false && /缺少 API Key/.test(r3.error), '云端引擎无 Key 仍拦截（口径不回退）');
  }

  console.log('\n[6] comic-manager：comfy 预设 / 缺口口径 / 探活');
  {
    const os = require('os'); const path = require('path'); const fs = require('fs');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'reins-cm-comfy-'));
    const settingsFile = path.join(tmp, 'settings.json');
    const mgr = require('../services/comic-manager').create({
      readSettings: () => { try { return JSON.parse(fs.readFileSync(settingsFile, 'utf8')); } catch (e) { return {}; } },
      writeSettings: s => fs.writeFileSync(settingsFile, JSON.stringify(s)),
      audioDir: path.join(tmp, 'audio'),
    });
    const r1 = await mgr.setRenderEngine({ provider: 'comfy' });
    ok(r1.ok && r1.engine.provider === 'comfy' && r1.engine.baseURL === BASE, '切到本地 ComfyUI 预设（带默认端口，无 Key 要求）');
    ok(mgr.renderConfigError(mgr.getRenderEngine(), {}) === null, '配置缺口：comfy 只查地址 → 无缺口');
    const r2 = await mgr.testRenderEngine({ provider: 'comfy' });
    ok(r2.ok && /ComfyUI 在线/.test(r2.message), '连通探活：system_stats（真实本机 ComfyUI，零消耗）');
    const r3 = await mgr.setRenderEngine({ provider: 'zhipu' });
    ok(r3.ok && r3.engine.provider === 'zhipu' && r3.engine.baseURL.includes('bigmodel') && r3.engine.imageModel === 'cogview-4' && !r3.engine.apiKey, '切回智谱：带预置默认且不串用旧 Key');
  }

  console.log(`\n结果：${passed} 通过 · ${failed} 失败`);
  process.exit(failed ? 1 : 0);
}
main().catch(e => { console.error('测试异常:', e); process.exit(1); });
