/* ============================================================
   Reins — 漫剧生成工作流引擎（REINS-126）
   在「单条视频生成」之上补齐完整漫剧生产线：
     bible(设定) → script(分集剧本) → storyboard(分镜)
     → image(首帧) → video(镜头视频) → voice(配音, 可选) → assemble(合成清单)
   · 文本阶段走 OpenAI 兼容 /chat/completions（与 runner.js 同协议，SSE 流式）
   · 渲染阶段走智谱 CogView/CogVideoX 协议（可自定义兼容端点）：
       POST /images/generations  → 同步返回 url
       POST /videos/generations  → 异步任务，轮询 GET /videos/generations/{id}
   · 合成阶段零依赖本地生成：SRT 字幕 + ffmpeg 脚本 + 分镜表（不实际渲染视频）
   纯 Node 可 require（自测用）；Electron 下优先 net.fetch（WAF 兼容），失败回退原生 fetch
   ============================================================ */
'use strict';

/* ---------- 渲染引擎预置（图像/视频/语音能力，区别于 chat 的 PROVIDERS） ---------- */
const RENDER_PROVIDERS = {
  comfy:  { label: '本地 ComfyUI（FLUX 首帧 · Wan2.2 图生视频）', baseURL: 'http://127.0.0.1:8188', imageModel: 'flux1-schnell-Q4_K_S', videoModel: 'Wan2.2-TI2V-5B-Q4_K_M', voiceModel: '', local: true },
  zhipu:  { label: '智谱（CogView · CogVideoX）', baseURL: 'https://open.bigmodel.cn/api/paas/v4', imageModel: 'cogview-4', videoModel: 'cogvideox-3', voiceModel: '' },
  custom: { label: '自定义（兼容端点）', baseURL: '', imageModel: '', videoModel: '', voiceModel: '' },
};

/* ---------- 配音引擎预置（独立于渲染引擎：任何说 OpenAI /audio/speech 协议的 TTS 都能接，本地免费） ---------- */
/* 内置音色表对应 ~/reins-tts 的 Kokoro v1.1-zh 扩展音色包（zf_xxx 女 / zm_xxx 男 编号）；
   标签按基频与语速实测：女声 180-226Hz、男声 109-205Hz */
const KOKORO_ZH_VOICES = [
  ['zf_003', '女声 · 清亮年轻'],
  ['zf_001', '女声 · 干练利落'],
  ['zf_017', '女声 · 成熟知性'],
  ['zf_049', '女声 · 从容舒缓'],
  ['zm_010', '男声 · 明亮青年'],
  ['zm_009', '男声 · 沉稳青年'],
  ['zm_029', '男声 · 低沉磁性'],
  ['zm_020', '男声 · 少年感'],
];
const VOICE_ENGINE_PRESETS = {
  kokoro: { label: '本地 TTS（Kokoro · 中文音色，零消耗）', baseURL: 'http://127.0.0.1:8884/v1', apiKey: '', model: 'kokoro', voice: 'zf_001', voices: '' },
  custom: { label: '自定义（OpenAI 兼容 /audio/speech）', baseURL: '', apiKey: '', model: '', voice: '', voices: '' },
};
/* 音色表：配置里voices（"id=描述,…"）优先；留空回落 Kokoro 中文内置表；custom 且未填则无表（不注入提示词） */
function parseVoiceTable(voice) {
  const raw = String((voice && voice.voices) || '').trim();
  if (raw) {
    const rows = raw.split(/[,，\n]/).map(x => x.split('=')).filter(p => p[0] && p[0].trim())
      .map(p => [p[0].trim(), (p[1] || '').trim()]);
    if (rows.length) return rows;
  }
  if (voice && voice.preset === 'kokoro') return KOKORO_ZH_VOICES;
  return null;
}

/* ---------- 流水线阶段定义（顺序即依赖顺序） ---------- */
const STAGES = [
  { id: 'bible',      label: '设定', per: 'project',  kind: 'llm' },
  { id: 'script',     label: '剧本', per: 'episode', kind: 'llm' },
  { id: 'storyboard', label: '分镜', per: 'episode', kind: 'llm' },
  { id: 'image',      label: '首帧', per: 'shot',    kind: 'render' },
  { id: 'video',      label: '视频', per: 'shot',    kind: 'render' },
  { id: 'voice',      label: '配音', per: 'shot',    kind: 'render', optional: true },
  { id: 'assemble',   label: '合成', per: 'episode', kind: 'local' },
];
const STAGE_IDS = STAGES.map(s => s.id);

/* 部分服务的 WAF 会按 TLS 指纹丢弃 Node fetch 握手；Electron 主进程优先 net.fetch（与 runner.js 同策略） */
let _netFetch = null;
try { _netFetch = require('electron').net.fetch; } catch (e) { }
const defaultFetch = (...a) => (_netFetch || global.fetch)(...a);

/* ============ 小工具 ============ */
const newId = p => p + Date.now().toString(36).slice(-4) + Math.random().toString(36).slice(2, 8);
const cleanStr = (v, max = 200) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const clampInt = (v, lo, hi, dft) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dft; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const clone = o => JSON.parse(JSON.stringify(o));
const pad2 = n => String(n).padStart(2, '0');

/* 多信号联动：任一上游 abort 即 abort（用于 任务取消 × 单请求超时 组合） */
function linkedSignal(sigs) {
  const c = new AbortController();
  const onab = () => c.abort();
  for (const s of sigs) {
    if (!s) continue;
    if (s.aborted) { c.abort(); break; }
    s.addEventListener('abort', onab, { once: true });
  }
  return { signal: c.signal, dispose: () => sigs.forEach(s => s && s.removeEventListener('abort', onab)) };
}
class CancelError extends Error { constructor() { super('cancelled'); this.name = 'CancelError'; } }

/* 带超时+重试的 fetch：网络错误/5xx/429 重试，4xx 不重试（配置问题重试无意义） */
async function fetchRetry(url, init, { signal, timeoutMs = 30000, retries = 2, fetchImpl }) {
  const doFetch = fetchImpl || defaultFetch;
  let lastErr = null;
  for (let i = 0; i <= retries; i++) {
    const to = new AbortController();
    const link = linkedSignal([signal, to.signal]);
    const timer = setTimeout(() => to.abort(), timeoutMs);
    try {
      const resp = await doFetch(url, { ...init, signal: link.signal });
      clearTimeout(timer); link.dispose();
      if (resp.ok) return resp;
      const text = await resp.text().catch(() => '');
      if (resp.status >= 500 || resp.status === 429) { lastErr = new Error(`HTTP ${resp.status} ${text.slice(0, 200)}`); continue; }
      throw new Error(`HTTP ${resp.status} ${text.slice(0, 200)}`);   // 4xx：直接抛，调用方给用户可读的错误
    } catch (e) {
      clearTimeout(timer); link.dispose();
      if (e.name === 'AbortError' && (signal && signal.aborted)) throw new CancelError();
      lastErr = e;
      if (e.name === 'AbortError') { lastErr = new Error('请求超时'); continue; }  // 仅超时 abort，任务取消上面已抛
    }
  }
  throw lastErr || new Error('网络请求失败');
}

/* ============ 数据模型（渲染层持有，服务层负责工厂/体检/钳制） ============ */
const ASPECTS = ['9:16', '16:9', '1:1'];
const COMIC_STATUS = ['draft', 'running', 'done', 'failed', 'paused'];

/* 漫剧项目：
   { id, title, theme, style, aspect, shotsPer,
     bible:{logline,style,characters:[{name,role,look,voice}],scenes:[{name,look}]},
     episodes:[Episode], status, progress:{stage,pct,note},
     writerAgentId, renderAgentId, createdAt, updatedAt }            */
function normalizeBible(b) {
  if (!b || typeof b !== 'object') return null;
  const chars = Array.isArray(b.characters) ? b.characters.slice(0, 12).map(c => ({
    name: cleanStr(c && c.name, 24) || '角色',
    role: cleanStr(c && c.role, 12),
    look: cleanStr(c && c.look, 160),
    voice: cleanStr(c && c.voice, 60),
  })) : [];
  const scenes = Array.isArray(b.scenes) ? b.scenes.slice(0, 16).map(s => ({
    name: cleanStr(s && s.name, 24) || '场景',
    look: cleanStr(s && s.look, 120),
  })) : [];
  if (!chars.length && !scenes.length && !b.logline) return null;
  return { logline: cleanStr(b.logline, 200), style: cleanStr(b.style, 120), characters: chars, scenes };
}

/* 镜头：{ id, index, desc, who, dialogue, camera, duration,
          imagePrompt, motionPrompt, imageUrl, videoUrl, coverUrl, audioUrl, err, updatedAt } */
function normalizeShot(s, i) {
  const url = v => typeof v === 'string' ? v.slice(0, 2000) : '';
  return {
    id: String(s && s.id || newId('sh')),
    index: clampInt(s && s.index, 1, 999, i + 1),
    desc: cleanStr(s && s.desc, 400),
    who: cleanStr(s && s.who, 24),
    dialogue: String((s && s.dialogue) || '').trim().slice(0, 300),
    camera: cleanStr(s && s.camera, 40),
    duration: clampInt(s && s.duration, 2, 10, 5),
    imagePrompt: cleanStr(s && s.imagePrompt, 600),
    motionPrompt: cleanStr(s && s.motionPrompt, 400),
    imageUrl: url(s && s.imageUrl),
    videoUrl: url(s && s.videoUrl),
    coverUrl: url(s && s.coverUrl),
    audioUrl: url(s && s.audioUrl),
    err: cleanStr(s && s.err, 300),
    updatedAt: Number(s && s.updatedAt) || 0,
  };
}

/* 剧集：{ id, n, title, synopsis, script(json 原文), shots:[Shot], status, err, package } */
function normalizeEpisode(e, i) {
  const shots = Array.isArray(e && e.shots) ? e.shots.slice(0, 60).map(normalizeShot) : [];
  const ids = new Set();
  shots.forEach(s => { while (ids.has(s.id)) s.id = newId('sh'); ids.add(s.id); });
  shots.sort((a, b) => a.index - b.index);
  shots.forEach((s, j) => { s.index = j + 1; });
  return {
    id: String(e && e.id || newId('ep')),
    n: clampInt(e && e.n, 1, 999, i + 1),
    title: cleanStr(e && e.title, 60) || `第 ${i + 1} 集`,
    synopsis: cleanStr(e && e.synopsis, 300),
    script: typeof e && e.script === 'string' ? e.script.slice(0, 20000) : '',
    shots,
    status: ['draft', 'running', 'done', 'failed'].includes(e && e.status) ? e.status : 'draft',
    err: cleanStr(e && e.err, 300),
    package: e && e.package && typeof e.package === 'object' ? e.package : null,
  };
}

/* 归档体检：坏档回退骨架不丢数据；所有数值钳制进安全区间 */
function normalizeComic(raw) {
  const c = raw && typeof raw === 'object' ? raw : {};
  const episodes = Array.isArray(c.episodes) ? c.episodes.slice(0, 60).map(normalizeEpisode) : [];
  const eids = new Set();
  episodes.forEach(ep => { while (eids.has(ep.id)) ep.id = newId('ep'); eids.add(ep.id); });
  return {
    id: String(c.id || newId('cp')),
    title: cleanStr(c.title, 60) || '未命名漫剧',
    theme: cleanStr(c.theme, 200),
    style: cleanStr(c.style, 120),
    aspect: ASPECTS.includes(c.aspect) ? c.aspect : '9:16',
    shotsPer: clampInt(c.shotsPer, 4, 16, 8),
    bible: normalizeBible(c.bible),
    episodes,
    status: COMIC_STATUS.includes(c.status) ? c.status : 'draft',
    progress: c.progress && typeof c.progress === 'object'
      ? { stage: STAGE_IDS.includes(c.progress.stage) ? c.progress.stage : '', pct: clampInt(c.progress.pct, 0, 100, 0), note: cleanStr(c.progress.note, 120) }
      : null,
    writerAgentId: String(c.writerAgentId || ''),
    renderAgentId: String(c.renderAgentId || ''),
    createdAt: Number(c.createdAt) || Date.now(),
    updatedAt: Number(c.updatedAt) || Date.now(),
  };
}

/* 创建项目：输入校验 + 生成 N 集空壳（后续 script 阶段逐集填充） */
function createComic(input) {
  const inp = input && typeof input === 'object' ? input : {};
  const title = cleanStr(inp.title, 60);
  if (!title) return { ok: false, code: 'TITLE', error: '漫剧标题不能为空' };
  const episodesPer = clampInt(inp.episodesPer, 1, 24, 6);
  const base = normalizeComic({
    title, theme: inp.theme, style: inp.style, aspect: inp.aspect, shotsPer: inp.shotsPer,
    episodes: Array.from({ length: episodesPer }, (_, i) => ({ n: i + 1, title: `第 ${i + 1} 集`, synopsis: '' })),
    writerAgentId: inp.writerAgentId, renderAgentId: inp.renderAgentId,
  });
  return { ok: true, comic: base };
}

/* ============ 阶段完成判定（断点续跑依据：产物在场即完成） ============ */
const bibleDone = c => !!(c.bible && Array.isArray(c.bible.characters) && c.bible.characters.length);
const scriptDone = ep => Array.isArray(ep.shots) && ep.shots.length > 0;
const storyboardDone = ep => scriptDone(ep) && ep.shots.every(s => !!s.imagePrompt);
const shotImageDone = s => !!s.imageUrl;
const shotVideoDone = s => !!s.videoUrl;
const shotVoiceDone = s => !!s.audioUrl;
const assembleDone = ep => !!ep.package;

/* ============ LLM 阶段：OpenAI 兼容流式调用 + 严格 JSON ============ */
/* 引擎参数 writer: { baseURL, apiKey, model }；onDelta 回传流式文本 */
async function chatJson(writer, sys, user, { onDelta, signal, fetchImpl, maxTokens = 4096 }) {
  if (!writer || !writer.baseURL || !writer.apiKey) throw new Error('未配置编剧引擎（OpenAI 兼容地址与 API Key）');
  const base = String(writer.baseURL).replace(/\/+$/, '');
  const resp = await fetchRetry(base + '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + writer.apiKey },
    body: JSON.stringify({ model: writer.model || 'glm-4.7', messages: [{ role: 'system', content: sys }, { role: 'user', content: user }], stream: true, temperature: 0.4, max_tokens: maxTokens }),
  }, { signal, timeoutMs: 120000, fetchImpl });

  let text = '';
  if (resp.body && typeof resp.body.getReader === 'function') {
    // SSE 流式：逐行取 data: 帧的 delta（与 runner.runTask 相同解析）
    const reader = resp.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      if (signal && signal.aborted) throw new CancelError();
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n'); buf = lines.pop() || '';
      for (const line of lines) {
        const s = line.trim();
        if (!s.startsWith('data:')) continue;
        const payload = s.slice(5).trim();
        if (payload === '[DONE]') continue;
        let j; try { j = JSON.parse(payload); } catch (e) { continue; }
        const d = j.choices?.[0]?.delta?.content;
        if (d) { text += d; onDelta && onDelta(d); }
      }
    }
  } else {
    const data = await resp.json().catch(() => null);
    text = String(data?.choices?.[0]?.message?.content || '');
    if (text) onDelta && onDelta(text);
  }
  if (!text.trim()) throw new Error('编剧模型未返回内容');

  const raw = text.trim().replace(/^```(json)?\s*/i, '').replace(/```\s*$/, '').trim();
  const m = raw.match(/\{[\s\S]*\}/);
  try { return JSON.parse(m ? m[0] : raw); }
  catch (e) { throw new Error('编剧输出不是合法 JSON：' + raw.slice(0, 120)); }
}

/* ============ 渲染引擎客户端（本地 ComfyUI，provider === 'comfy'） ============
   首帧：FLUX.1-schnell GGUF 文生图（4 步 · 数秒出图，零 API 消耗）
   视频：Wan2.2-TI2V-5B 图生视频（Wan22ImageToVideoLatent 首帧经 VAE 进 latent，无需 clip_vision）
   工作流内嵌为默认模板：节点 4 = 正向提示词占位，节点 30 = 首帧 LoadImage 占位；
   提交 POST /prompt → 轮询 GET /history/{id} → /view 取产物；i2v 前先把首帧 /upload/image 回传 */
const COMFY_WF_IMAGE = {
  /* 16G 内存适配（2026-10-18 实测）：fp8 t5(4.9G)+Q4_K_S unet(6.6G) 同驻 11.5G 必然 swap 抖动
     （单步采样 200-450 秒）；改 t5 Q4_K_M GGUF(2.9G) + unet Q3_K_S(4.7G)，峰值 ~7.6G 可驻留。
     DualCLIPLoaderGGUF：clip_l 走 safetensors（246M 小件无谓量化），t5 走 GGUF */
  '1': { class_type: 'UnetLoaderGGUF', inputs: { unet_name: '__UNET__' } },   // 提交时按 render.imageModel 注入
  '3': { class_type: 'DualCLIPLoaderGGUF', inputs: { clip_name1: 'clip_l.safetensors', clip_name2: 't5-v1_1-xxl-encoder-Q4_K_M.gguf', type: 'flux' } },
  '4': { class_type: 'CLIPTextEncode', inputs: { text: '__PROMPT__', clip: ['3', 0] } },
  '5': { class_type: 'CLIPTextEncode', inputs: { text: '', clip: ['3', 0] } },   // schnell 引导 1.0，负向留空
  '6': { class_type: 'VAELoader', inputs: { vae_name: 'ae.safetensors' } },
  '7': { class_type: 'EmptySD3LatentImage', inputs: { width: 1024, height: 576, batch_size: 1 } },
  '8': { class_type: 'KSampler', inputs: { model: ['1', 0], positive: ['4', 0], negative: ['5', 0], latent_image: ['7', 0], seed: 0, control_after_generate: 'randomize', steps: 4, cfg: 1, sampler_name: 'euler', scheduler: 'simple', denoise: 1 } },
  '9': { class_type: 'VAEDecode', inputs: { samples: ['8', 0], vae: ['6', 0] } },
  '11': { class_type: 'SaveImage', inputs: { images: ['9', 0], filename_prefix: 'comic/firstframe' } },
};
const COMFY_WF_VIDEO = {
  '1': { class_type: 'UnetLoaderGGUF', inputs: { unet_name: '__UNET__' } },   // 提交时按 render.videoModel 注入
  '2': { class_type: 'ModelSamplingSD3', inputs: { model: ['1', 0], shift: 5 } },
  '3': { class_type: 'CLIPLoaderGGUF', inputs: { clip_name: 'umt5-xxl-encoder-Q4_K_M.gguf', type: 'wan', device: 'default' } },
  '4': { class_type: 'CLIPTextEncode', inputs: { text: '__PROMPT__', clip: ['3', 0] } },
  '5': { class_type: 'CLIPTextEncode', inputs: { text: '模糊，低质量，画质差，jpeg压缩残留，变形，畸形肢体，多余手指，残缺，字幕，水印，文字，静止，画面呆滞，色调艳丽，过曝，整体发灰，最差质量', clip: ['3', 0] } },
  '6': { class_type: 'VAELoader', inputs: { vae_name: 'wan2.2_vae.safetensors' } },
  '7': { class_type: 'Wan22ImageToVideoLatent', inputs: { vae: ['6', 0], width: 848, height: 480, length: 17, batch_size: 1, start_image: ['30', 0] } },
  '8': { class_type: 'KSampler', inputs: { model: ['2', 0], positive: ['4', 0], negative: ['5', 0], latent_image: ['7', 0], seed: 0, control_after_generate: 'randomize', steps: 20, cfg: 3.5, sampler_name: 'euler', scheduler: 'simple', denoise: 1 } },
  '9': { class_type: 'VAEDecode', inputs: { samples: ['8', 0], vae: ['6', 0] } },
  '10': { class_type: 'CreateVideo', inputs: { images: ['21', 0], fps: 24 } },
  '11': { class_type: 'SaveVideo', inputs: { video: ['10', 0], filename_prefix: 'video/Comic_i2v', format: 'auto' } },
  '20': { class_type: 'FrameInterpolationModelLoader', inputs: { model_name: 'rife_v4.26.safetensors' } },
  '21': { class_type: 'FrameInterpolate', inputs: { interp_model: ['20', 0], images: ['9', 0], multiplier: 3 } },
  '30': { class_type: 'LoadImage', inputs: { image: '__COMIC_FF__' } },
};
const comfyDim = (aspect, dims) => aspect === '9:16' ? dims[1] : aspect === '1:1' ? dims[2] : dims[0];

async function comfySubmit(base, workflow, { signal, fetchImpl }) {
  /* 不走 fetchRetry：非 2xx 时要读 body 拿节点校验详情（模型缺失/节点接线错可诊断），统一 throw 会丢 */
  const doFetch = fetchImpl || defaultFetch;
  const ctrl = signal ? null : null;
  const resp = await doFetch(base + '/prompt', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: workflow, client_id: 'reins-comic' }),
  });
  const d = await resp.json().catch(() => null);
  if (!resp.ok || !d || !d.prompt_id) {
    const err = d && (d.error || d.node_errors) ? JSON.stringify(d.error || d.node_errors) : (d && d.error ? '' : 'HTTP ' + resp.status);
    throw new Error('ComfyUI 提交失败：' + cleanStr(err || '未返回 prompt_id', 200));
  }
  return d.prompt_id;
}
/* 轮询直到完成；产物 = outputs 中首个含 filename 的文件对象（SaveImage→images / SaveVideo→gifs|videos 通吃） */
async function comfyWait(base, promptId, { signal, fetchImpl, pollMs = 3000, pollTimeoutMs = 1200000 }) {
  /* 活动感知等待：只要我们的任务还在 ComfyUI 队列里（排队或执行中），就把截止时间往后推——
     冷启动加载 FLUX/Wan 模型实测 15 分钟起（16G 内存 GGUF 换入换出更久），固定超时必然误杀；
     截止时间只对「队列里消失且 history 无记录」（服务重启/被清队列）生效。
     pollTimeoutMs 语义随之变为「无活动超时」；另有 hardCapMs 绝对上限防 GPU 卡死无限等 */
  const hardCapMs = Math.max(pollTimeoutMs, 3600000);   // 绝对上限 1 小时
  const giveUp = async err => {
    try { await (fetchImpl || defaultFetch)(base + '/queue', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ delete: [promptId] }) }); } catch (e) { }
    throw err;
  };
  const submittedAt = Date.now();
  let deadline = Date.now() + pollTimeoutMs;
  for (;;) {
    if (signal && signal.aborted) throw await giveUp(new CancelError());
    if (Date.now() > deadline) throw await giveUp(new Error('ComfyUI 队列消失（' + Math.round(pollTimeoutMs / 60000) + ' 分钟内无进度，可能服务重启或队列被清）'));
    if (Date.now() - submittedAt > hardCapMs) throw await giveUp(new Error('ComfyUI 执行超绝对上限（' + Math.round(hardCapMs / 60000) + ' 分钟），请检查 GPU/显存状态'));
    await sleep(pollMs);
    const resp = await fetchRetry(base + '/history/' + encodeURIComponent(promptId), {}, { signal, timeoutMs: 30000, retries: 3, fetchImpl });
    const h = await resp.json().catch(() => null);
    const rec = h && h[promptId];
    if (!rec) {
      /* history 无记录：任务要么还在排队/执行（/queue 可见 → 活着，续期），要么彻底丢了 */
      const qr = await fetchRetry(base + '/queue', {}, { signal, timeoutMs: 30000, retries: 3, fetchImpl });
      const q = await qr.json().catch(() => null);
      const alive = q && [...(q.queue_running || []), ...(q.queue_pending || [])]
        .some(item => Array.isArray(item) && String(item[1]) === String(promptId));
      if (alive) deadline = Math.min(submittedAt + hardCapMs, Date.now() + pollTimeoutMs);   // 还在干活，续期
      continue;
    }
    if (rec.status && rec.status.completed) {
      if (rec.status.status_str === 'error') throw new Error('ComfyUI 执行失败：' + cleanStr(JSON.stringify(rec.status.messages || ''), 200));
      for (const out of Object.values(rec.outputs || {})) {
        for (const v of Object.values(out || {})) {
          if (Array.isArray(v)) {
            const f = v.find(x => x && typeof x === 'object' && x.filename);
            if (f) return f;
          }
        }
      }
      throw await giveUp(new Error('ComfyUI 已完成但产物里没有文件'));
    }
    /* completed=false 但已有 history 记录：执行中，同样续期 */
    deadline = Math.min(submittedAt + hardCapMs, Date.now() + pollTimeoutMs);
  }
}
const comfyViewUrl = (base, f) => base + '/view?filename=' + encodeURIComponent(f.filename) + '&subfolder=' + encodeURIComponent(f.subfolder || '') + '&type=' + encodeURIComponent(f.type || 'output');
/* 首帧图回传 input 目录（LoadImage 只认 input；图像阶段的产物在 output） */
async function comfyUploadImage(base, bytes, { signal, fetchImpl }) {
  const fd = new FormData();
  fd.append('image', new Blob([bytes]), 'comic_firstframe.png');
  fd.append('overwrite', 'true');
  const resp = await fetchRetry(base + '/upload/image', { method: 'POST', body: fd }, { signal, timeoutMs: 60000, fetchImpl });
  const d = await resp.json().catch(() => null);
  if (!d || !d.name) throw new Error('ComfyUI 首帧上传失败');
  return d.name;
}

async function comfyGenImage(render, prompt, { aspect, signal, fetchImpl, pollMs }) {
  const base = String(render.baseURL).replace(/\/+$/, '');
  const wf = JSON.parse(JSON.stringify(COMFY_WF_IMAGE));
  const dim = comfyDim(aspect, [[1024, 576], [576, 1024], [896, 896]]);
  wf['7'].inputs.width = dim[0]; wf['7'].inputs.height = dim[1];
  wf['4'].inputs.text = String(prompt || '').slice(0, 2000);
  if (render.imageModel) wf['1'].inputs.unet_name = render.imageModel + '.gguf';   // 量化档位配置驱动（Q4_K_S/Q3_K_S…）
  const pid = await comfySubmit(base, wf, { signal, fetchImpl });
  const f = await comfyWait(base, pid, { signal, fetchImpl, pollMs, pollTimeoutMs: 10 * 60 * 1000 });
  return { url: comfyViewUrl(base, f) };
}
async function comfyGenVideo(render, { prompt, imageUrl, aspect }, { signal, fetchImpl, pollMs }) {
  const base = String(render.baseURL).replace(/\/+$/, '');
  const wf = JSON.parse(JSON.stringify(COMFY_WF_VIDEO));
  const dim = comfyDim(aspect, [[848, 480], [480, 848], [608, 608]]);
  wf['7'].inputs.width = dim[0]; wf['7'].inputs.height = dim[1];
  wf['4'].inputs.text = String(prompt || '').slice(0, 2000);
  if (render.videoModel) wf['1'].inputs.unet_name = render.videoModel + '.gguf';   // 量化档位配置驱动
  if (imageUrl) {
    /* 首帧是本地 /view URL：取回字节再上传回 input 目录，交给 LoadImage */
    const imgResp = await fetchRetry(imageUrl, {}, { signal, timeoutMs: 60000, fetchImpl });
    const bytes = Buffer.from(await imgResp.arrayBuffer());
    wf['30'].inputs.image = await comfyUploadImage(base, bytes, { signal, fetchImpl });
  } else {
    wf['30'].inputs.image = 'comic_firstframe.png';       // 无首帧：沿用上次上传（兜底）
  }
  const pid = await comfySubmit(base, wf, { signal, fetchImpl });
  const f = await comfyWait(base, pid, { signal, fetchImpl, pollMs, pollTimeoutMs: 20 * 60 * 1000 });
  return { url: comfyViewUrl(base, f), coverUrl: imageUrl || '' };
}

/* ============ 渲染引擎客户端（智谱协议） ============ */
/* 比例 → 生成尺寸（模型不支持的尺寸由服务端报错，4xx 不重试直接见错） */
function sizeOf(aspect) { return aspect === '16:9' ? '1920x1080' : aspect === '1:1' ? '1024x1024' : '1080x1920'; }

async function genImage(render, prompt, opts) {
  if (render.provider === 'comfy') return comfyGenImage(render, prompt, opts);
  const { aspect, signal, fetchImpl } = opts;
  const base = String(render.baseURL).replace(/\/+$/, '');
  const resp = await fetchRetry(base + '/images/generations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + render.apiKey },
    body: JSON.stringify({ model: render.imageModel, prompt, size: sizeOf(aspect) }),
  }, { signal, timeoutMs: 120000, fetchImpl });
  const data = await resp.json().catch(() => null);
  const url = data?.data?.[0]?.url;
  if (!url) throw new Error('图像生成未返回 url');
  return { url: String(url) };
}

/* 异步视频任务：提交 → 轮询直到 SUCCESS/FAIL；默认 3s 一拍、10 分钟封顶 */
async function genVideo(render, params, opts) {
  if (render.provider === 'comfy') return comfyGenVideo(render, params, opts);
  const { signal, fetchImpl, pollMs = 3000, pollTimeoutMs = 600000 } = opts;
  const { prompt, imageUrl, aspect, duration } = params;
  const base = String(render.baseURL).replace(/\/+$/, '');
  const body = { model: render.videoModel, prompt: String(prompt || '').slice(0, 2000) };
  if (imageUrl) body.image_url = imageUrl;                       // 有首帧走图生视频，一致性更好
  body.size = sizeOf(aspect);
  if (/cogvideox/i.test(render.videoModel || '')) body.duration = [5, 10].includes(duration) ? duration : 5;  // CogVideoX 仅支持 5/10s

  const sub = await fetchRetry(base + '/videos/generations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + render.apiKey },
    body: JSON.stringify(body),
  }, { signal, timeoutMs: 60000, fetchImpl });
  const subData = await sub.json().catch(() => null);
  const taskId = subData?.id;
  if (!taskId) throw new Error('视频任务提交失败：未返回任务 id');

  const deadline = Date.now() + pollTimeoutMs;
  for (;;) {
    if (signal && signal.aborted) throw new CancelError();
    if (Date.now() > deadline) throw new Error('视频生成超时（10 分钟）');
    await sleep(pollMs);
    const st = await fetchRetry(base + '/videos/generations/' + encodeURIComponent(taskId), {
      headers: { 'Authorization': 'Bearer ' + render.apiKey },
    }, { signal, timeoutMs: 30000, retries: 3, fetchImpl });
    const d = await st.json().catch(() => null);
    const status = d?.task_status;
    if (status === 'SUCCESS') {
      const r = d?.video_result?.[0] || {};
      if (!r.url) throw new Error('视频任务成功但未返回 url');
      return { url: String(r.url), coverUrl: r.cover_image_url ? String(r.cover_image_url) : '' };
    }
    if (status === 'FAIL') throw new Error('视频生成失败（' + cleanStr(d?.msg || d?.error?.message, 120) + '）');
    // PROCESSING / PENDING → 继续轮询
  }
}

/* 配音：走独立配音引擎（OpenAI 兼容 /audio/speech，本地 TTS 或云端均可），落盘到 opts.audioDir。
   voiceId 为该镜头角色对应的音色 id（来自设定 characters[].voice），缺省回落引擎默认音色 */
async function genVoice(voice, text, destPath, { signal, fetchImpl, voiceId } = {}) {
  if (!voice || !voice.baseURL || !voice.model) throw new Error('未配置配音引擎（服务地址与模型名）');
  const base = String(voice.baseURL).replace(/\/+$/, '');
  const vid = String(voiceId || voice.voice || '').trim();
  const headers = { 'Content-Type': 'application/json' };
  if (voice.apiKey) headers.Authorization = 'Bearer ' + voice.apiKey;   // 本地 TTS 通常免鉴权
  const resp = await fetchRetry(base + '/audio/speech', {
    method: 'POST',
    headers,
    body: JSON.stringify({ model: voice.model, input: String(text).slice(0, 500), ...(vid ? { voice: vid } : {}) }),
  }, { signal, timeoutMs: 120000, fetchImpl });
  const buf = Buffer.from(await resp.arrayBuffer());
  if (!buf.length) throw new Error('配音返回空音频');
  const fs = require('fs');
  fs.mkdirSync(require('path').dirname(destPath), { recursive: true });
  fs.writeFileSync(destPath, buf);
  return { bytes: buf.length };
}

/* ============ 阶段实现 ============ */
function biblePrompt(c, voiceTable) {
  const sys = [
    '你是漫剧制片助手。根据题材与要求产出世界观与角色设定，供后续每镜头生成使用。',
    '只输出一个 JSON 对象，不要任何其他文字、不要代码块标记。格式：',
    '{"logline":"一句话故事","style":"画面风格关键词（中文逗号分隔）","characters":[{"name":"角色名","role":"主角/配角/反派","look":"外貌发型服装关键词，用于保持每镜头形象一致","voice":"音色描述"}],"scenes":[{"name":"场景名","look":"场景视觉关键词"}]}',
    '角色 2-6 个、场景 2-6 个；look 关键词面向图像生成模型，具体、可画。',
  ];
  /* 配音引擎启用且带音色表：角色的 voice 从音色表挑 id，后续每镜头按说话角色选音色 */
  if (voiceTable && voiceTable.length) {
    sys.push('【配音音色】characters[].voice 不写描述，改为从下列音色 id 中为每个角色挑选最贴合的一个（只能用表内 id，原样填写）：'
      + voiceTable.map(([id, desc]) => `${id}（${desc}）`).join('、'));
  }
  return { sys: sys.join('\n'), user: [
    `【漫剧】${c.title}`,
    c.theme ? `【题材/故事方向】\n${c.theme}` : '【题材/故事方向】（自由发挥，题材自定）',
    c.style ? `【画风偏好】${c.style}` : '',
    `【体量】${c.episodes.length} 集，每集约 ${c.shotsPer} 个镜头（竖屏短剧节奏）`,
  ].filter(Boolean).join('\n\n') };
}

function scriptPrompt(c, ep) {
  const sys = [
    '你是漫剧编剧。为指定的一集写剧本并直接拆成镜头。只输出一个 JSON 对象，不要任何其他文字：',
    '{"title":"本集标题","synopsis":"本集梗概（80字内）","shots":[{"desc":"画面描述（一个动作或事件）","who":"本镜头台词的说话者角色名（旁白写 旁白，无台词写空字符串）","dialogue":"台词（没有旁白台词用空字符串）","camera":"景别与运镜，如：近景/中景/推镜头","duration":5}]}',
    `每集 ${Math.max(4, Math.min(16, c.shotsPer))} 个镜头上下可浮动；duration 为 3-10 的整数秒；剧情要有钩子与结尾悬念；who 必须是设定里出现过的角色名或"旁白"。`,
  ].join('\n');
  const user = [
    '【世界观与角色设定】\n' + JSON.stringify(c.bible, null, 0),
    `【本集】第 ${ep.n} 集${ep.synopsis ? ' · 梗概要求：' + ep.synopsis : ''}`,
    c.episodes.length > 1 ? `（全剧共 ${c.episodes.length} 集，注意前后衔接）` : '',
  ].filter(Boolean).join('\n\n');
  return { sys, user };
}

function storyboardPrompt(c, ep) {
  const sys = [
    '你是分镜师。把剧本镜头扩写为图像/视频生成提示词。只输出一个 JSON 对象，不要任何其他文字：',
    '{"shots":[{"index":1,"imagePrompt":"首帧静态画面提示词：角色外貌关键词+场景+构图+光线，中文","motionPrompt":"本镜头动态描述：人物动作、镜头运动，中文"}]}',
    'imagePrompt 必须原样复用设定里的角色 look 关键词与整体风格，保证形象跨镜头一致；不得新增设定之外的角色；index 与输入镜头一一对应。',
  ].join('\n');
  const user = [
    '【设定】\n' + JSON.stringify(c.bible, null, 0),
    '【剧本镜头】\n' + JSON.stringify(ep.shots.map(s => ({ index: s.index, desc: s.desc, dialogue: s.dialogue, camera: s.camera })), null, 0),
  ].join('\n\n');
  return { sys, user };
}

/* 合成包：SRT 字幕（按镜头时长切分）+ ffmpeg 脚本（下载/拼接/烧字幕/混配音）+ 分镜表。零依赖本地计算 */
function fmtSrtTime(sec) {
  const ms = Math.round(sec * 1000);
  const h = Math.floor(ms / 3600000), m = Math.floor(ms % 3600000 / 60000), s = Math.floor(ms % 60000 / 1000);
  return `${pad2(h)}:${pad2(m)}:${pad2(s)},${String(ms % 1000).padStart(3, '0')}`;
}
/* markdown 表格单元格转义：内容里的竖线会撕裂表格行（下载的 .md 打开即缺列），换行压成空格 */
const mdCell = v => String(v ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim() || '-';
function buildPackage(ep, aspect) {
  let t = 0;
  const px = sizeOf(aspect) || '1080x1920';
  const srt = []; const dl = []; const mix = []; const list = []; const rows = []; const detail = [];
  ep.shots.forEach((s, i) => {
    const d = s.duration, n = pad2(i + 1);
    if (s.dialogue) srt.push(`${i + 1}\n${fmtSrtTime(t)} --> ${fmtSrtTime(t + d)}\n${s.dialogue.replace(/\n/g, ' ')}\n`);
    if (s.videoUrl) {
      dl.push(`ffmpeg -y -i "${s.videoUrl}" -t ${d} -r 30 -s ${px} shot-${n}.mp4`);
      list.push(`file 'shot-${n}.mp4'`);
      if (s.audioUrl) mix.push(`ffmpeg -y -i shot-${n}.mp4 -i "${s.audioUrl}" -map 0:v -map 1:a -c:v copy -shortest shot-${n}-v.mp4 && mv shot-${n}-v.mp4 shot-${n}.mp4`);
    }
    /* 表格给结论（✓/✗），完整信息（URL/提示词/失败原因）进下方明细，避免长 URL 撑爆表格 */
    rows.push(`| ${s.index} | ${mdCell(s.desc).slice(0, 40)} | ${mdCell(s.dialogue).slice(0, 30)} | ${mdCell(s.camera)} | ${d}s | ${s.imageUrl ? '✓' : '✗'} | ${s.videoUrl ? '✓' : '✗'} | ${s.audioUrl ? '✓' : '—'} |`);
    detail.push(
      `### 镜头 ${s.index}（shot-${n} · ${d}s）`,
      `- 画面：${s.desc || '-'}`,
      `- 台词：${s.dialogue || '（无）'}`,
      `- 景别：${s.camera || '-'} · 时长 ${d}s`,
      `- 首帧图：${s.imageUrl || '未生成'}`,
      `- 视频地址：${s.videoUrl || '未生成'}`,
      `- 配音文件：${s.audioUrl || '无'}`,
      `- 首帧提示词：${s.imagePrompt || '-'}`,
      `- 动态提示词：${s.motionPrompt || '-'}`,
      s.err ? `- ⚠ 失败原因：${s.err}` : '',
      '',
    );
    t += d;
  });
  const missing = ep.shots.filter(s => !s.videoUrl).length;
  /* 无镜头视频时不产 concat 段（对空 list.txt 执行 concat 必报错）；无字幕时跳过烧字幕 */
  const ffmpegSh = [
    '#!/bin/sh', `# Reins 漫剧合成脚本 · ${ep.title}（${ep.shots.length} 镜头 · 约 ${Math.round(t)}s${missing ? ` · 缺 ${missing} 个镜头视频` : ''}）`,
    'set -e', '# 1) 下载并统一转码各镜头',
    ...dl, '',
    '# 2) 混入配音（有配音的镜头）', ...mix, '',
    ...(list.length ? [
      '# 3) 拼接 + 烧字幕（字幕文件 ep.srt 由 Reins 导出）',
      `cat > list.txt <<'EOF'`, ...list, 'EOF',
      'ffmpeg -y -f concat -safe 0 -i list.txt -c copy merged.mp4',
      ...(srt.length ? ['ffmpeg -y -i merged.mp4 -vf "subtitles=ep.srt" -c:a copy final.mp4'] : ['cp merged.mp4 final.mp4']),
      'echo 完成：final.mp4',
    ] : ['# 3) 没有镜头视频可拼接：请先生成/重跑镜头视频后重新导出合成包', 'echo 没有镜头视频，跳过拼接']),
  ].join('\n');
  const shotlistMd = [
    `# ${ep.title} · 分镜表`, '',
    `共 ${ep.shots.length} 个镜头 · 约 ${Math.round(t)}s${missing ? ` · 缺 ${missing} 个镜头视频` : ''}`, '',
    '| # | 画面 | 台词 | 景别 | 时长 | 首帧 | 视频 | 配音 |',
    '|---|---|---|---|---|---|---|---|', ...rows, '',
    '## 镜头明细（含产物地址与提示词）', '', ...detail,
  ].join('\n');
  return { srt: srt.join('\n'), ffmpegSh, shotlistMd, durationSec: Math.round(t), missing, at: Date.now() };
}

/* ============ 任务编排 ============ */
const jobs = new Map();   // comicId -> { ac, comic, seq, startedAt }

function jobSnapshot(comicId) {
  const j = jobs.get(comicId);
  if (!j) return null;
  try { return { running: true, comic: clone(j.comic) }; } catch (e) { return { running: true }; }
}
function cancelJob(comicId) {
  const j = jobs.get(comicId);
  if (!j) return false;
  try { j.ac.abort(); } catch (e) { }
  return true;
}

/* 预检：scope 合法性 + 将要执行的阶段所需引擎是否配置。
   渲染引擎缺口逐字段点名（REINS-126 返工修复③，与服务层 renderConfigError 同口径）：
   缺什么字段、影响哪个阶段、去哪配，一眼可行动 */
function precheck(job, engines) {
  const { comic, scope = {} } = job || {};
  if (!comic || !comic.id) return { ok: false, error: '缺少漫剧项目对象' };
  if (scope.stage && !STAGE_IDS.includes(scope.stage)) return { ok: false, error: '未知阶段：' + scope.stage };
  const st = STAGES.find(s => s.id === scope.stage);
  const wantLlm = !st || st.kind === 'llm';
  const wantRender = !st || st.kind === 'render';
  const w = engines.writer || {}, r = engines.render || {};
  if (wantLlm && (!w.baseURL || !w.apiKey)) return { ok: false, error: '未配置编剧引擎：需要 OpenAI 兼容地址与 API Key（设置 → 模型与密钥）' };
  if (wantRender) {
    const target = st ? `「${st.label}」阶段` : '首帧 / 视频渲染';
    /* 本地 ComfyUI：无 Key、模型走内嵌工作流，只需服务地址（与 manager renderConfigError 同口径） */
    if (r.provider === 'comfy') {
      if (!r.baseURL) return { ok: false, error: `本地 ComfyUI 未配置地址：${target}需要，请到「设置 → 渲染引擎」填写服务地址（默认 http://127.0.0.1:8188）` };
    } else {
      if (!r.baseURL && !r.apiKey) return { ok: false, error: `渲染引擎未配置：${target}需要图像 / 视频生成服务（设置 → 渲染引擎）` };
      if (!r.baseURL) return { ok: false, error: `渲染引擎缺少服务地址（Base URL）：${target}需要，请到「设置 → 渲染引擎」填写 API 根路径` };
      if (!r.apiKey) return { ok: false, error: `渲染引擎缺少 API Key：${target}需要，请到「设置 → 渲染引擎」填写` };
    }
    /* 配音独立引擎（可选阶段）：显式单跑配音时才强校验 */
    const v = engines.voice || {};
    if (scope.stage === 'voice' && !(v.baseURL && v.model))
      return { ok: false, error: '配音引擎未配置：请到「设置 → 配音引擎」填写服务地址与模型名（本地 TTS 全程免费）；不配置时配音阶段自动跳过' };
  }
  if (scope.episodeId && !comic.episodes.some(e => e.id === scope.episodeId)) return { ok: false, error: '剧集不存在：' + scope.episodeId };
  if (scope.shotId) {
    const ep = comic.episodes.find(e => e.id === scope.episodeId);
    if (!ep) return { ok: false, error: '指定镜头必须同时指定所属剧集' };
    if (!ep.shots.some(s => s.id === scope.shotId)) return { ok: false, error: '镜头不存在：' + scope.shotId };
  }
  return { ok: true };
}

/* 供 main.js 调用的入口：同步预检，异步执行（不 await，事件驱动回传） */
function runJob(job, engines, onEvent, opts = {}) {
  const pre = precheck(job, engines);
  const comic = job && job.comic;
  if (!pre.ok) {
    onEvent && onEvent({ comicId: comic && comic.id, type: 'error', stage: 'precheck', message: pre.error });
    return pre;
  }
  if (jobs.has(comic.id)) return { ok: false, error: '该漫剧已在执行中，请先终止或等待完成' };
  const ac = new AbortController();
  const ctx = { ac, comic, seq: 0, startedAt: Date.now() };
  jobs.set(comic.id, ctx);
  executeJob(ctx, comic, job.scope || {}, engines || {}, onEvent, opts).catch(e => {
    // executeJob 内部已兜底，这里只防御编程错误
    onEvent && onEvent({ comicId: comic.id, type: 'error', stage: 'internal', message: e.message });
    comic.status = 'failed';
    jobs.delete(comic.id);
  });
  return { ok: true };
}

/* 简单并发池：镜头级渲染阶段并发执行（默认 2），单条失败不拖垮其余 */
async function runPool(items, limit, worker) {
  const queue = [...items];
  const runners = Array.from({ length: Math.max(1, Math.min(limit || 2, queue.length || 1)) }, async () => {
    for (;;) {
      const it = queue.shift();
      if (!it) return;
      await worker(it);   // worker 自行吞错并落 shot.err
    }
  });
  await Promise.all(runners);
}

async function executeJob(ctx, comic, scope, engines, onEvent, opts) {
  const emit = evt => {
    onEvent && onEvent({ comicId: comic.id, seq: ++ctx.seq, at: Date.now(), ...evt });
  };
  const patchComic = patch => {
    Object.assign(comic, patch, { updatedAt: Date.now() });
    emit({ type: 'comic', patch: { ...patch, updatedAt: comic.updatedAt } });
  };
  const patchEpisode = (ep, patch) => {
    Object.assign(ep, patch);
    emit({ type: 'episode', episodeId: ep.id, patch });
  };
  const patchShot = (ep, s, patch) => {
    Object.assign(s, patch, { updatedAt: Date.now() });
    emit({ type: 'shot', episodeId: ep.id, shotId: s.id, patch: { ...patch, updatedAt: s.updatedAt } });
  };
  /* 统一把 AbortError 折算成 CancelError（任务取消），业务错误原样上抛 */
  const guard = async fn => {
    try { return await fn(); }
    catch (e) {
      if (e instanceof CancelError || e.name === 'AbortError') throw new CancelError();
      throw e;
    }
  };

  const writer = engines.writer, render = engines.render;
  const voice = engines.voice || null;   // 配音引擎独立于渲染引擎（本地 TTS / 云端均可，可选）
  const fetchImpl = opts.fetchImpl;
  const pollMs = opts.pollMs || 3000;
  const concurrency = clampInt(opts.concurrency, 1, 4, 2);
  const voiceEnabled = !!(voice && voice.baseURL && voice.model && opts.audioDir);
  const voiceTable = voiceEnabled ? parseVoiceTable(voice) : null;   // 音色表：注入设定提示词，角色选 id
  /* 镜头说话者 → 音色 id：命中音色表用角色音色，否则回落引擎默认音色 */
  const shotVoiceId = s => {
    const who = String(s.who || '').trim();
    if (!who || who === '旁白') return '';
    const ch = (comic.bible && Array.isArray(comic.bible.characters) ? comic.bible.characters : [])
      .find(x => x && who.includes(String(x.name || '').slice(0, 4)) || String(x && x.name || '').includes(who));
    const v = ch ? String(ch.voice || '').trim() : '';
    if (!v) return '';
    if (!voiceTable || voiceTable.some(([id]) => id === v)) return v;
    return /^[a-z][a-z0-9_-]{1,40}$/.test(v) ? v : '';   // 无表的自定义引擎：像 id 才透传，描述性文字不透传
  };

  /* 进度：以“工作单元”计 —— bible 1 + 每集(script 1 + storyboard 1 + 镜头×(image+video+voice) + assemble 1) */
  const eps = scope.episodeId ? comic.episodes.filter(e => e.id === scope.episodeId) : comic.episodes;
  const totalUnits = 1 + eps.reduce((n, e) => n + 2 + (e.shots.length || comic.shotsPer) * (2 + (voiceEnabled ? 1 : 0)) + 1, 0);
  let doneUnits = 0;
  const tick = (stage, note) => {
    doneUnits++;
    patchComic({ progress: { stage, pct: Math.min(99, Math.round(doneUnits / totalUnits * 100)), note: note || '' } });
  };

  try {
    comic.status = 'running';
    patchComic({ status: 'running', progress: { stage: scope.stage || 'bible', pct: 0, note: '' } });

    const need = stageId => {
      if (scope.stage && scope.stage !== stageId) return false;   // 指定阶段：只跑该阶段
      if (scope.stage === stageId) return true;
      return !scope.stage;                                        // 未指定：按序跑全部未完成
    };

    /* ---- 1. 设定（bible） ---- */
    if (need('bible') && (scope.stage === 'bible' || scope.force || !bibleDone(comic))) {
      emit({ stage: 'bible', type: 'stage', state: 'start' });
      const p = biblePrompt(comic, voiceTable);
      const b = await guard(() => chatJson(writer, p.sys, p.user, {
        onDelta: d => emit({ stage: 'bible', type: 'delta', text: d }), signal: ctx.ac.signal, fetchImpl,
      }));
      const bible = normalizeBible(b);
      if (!bible || !bible.characters.length) throw new Error('设定产出无效：缺少角色');
      patchComic({ bible });
      emit({ stage: 'bible', type: 'stage', state: 'end' });
      tick('bible', `设定完成 · ${bible.characters.length} 角色`);
    }

    /* ---- 2. 逐集：剧本 → 分镜 → 镜头渲染 → 合成 ---- */
    for (const ep of eps) {
      if (ctx.ac.signal.aborted) throw new CancelError();

      if (need('script') && (scope.stage === 'script' || scope.force || !scriptDone(ep))) {
        emit({ stage: 'script', episodeId: ep.id, type: 'stage', state: 'start' });
        patchEpisode(ep, { status: 'running', err: '' });
        if (!bibleDone(comic)) throw new Error(`第 ${ep.n} 集缺少设定（bible），请先运行「设定」阶段`);
        if (scope.stage === 'script' || scope.force) patchEpisode(ep, { shots: [], package: null });   // 重跑剧本：旧镜头、旧产物与旧合成包一并作废
        const p = scriptPrompt(comic, ep);
        const sc = await guard(() => chatJson(writer, p.sys, p.user, {
          onDelta: d => emit({ stage: 'script', episodeId: ep.id, type: 'delta', text: d }), signal: ctx.ac.signal, fetchImpl,
        }));
        const shots = Array.isArray(sc.shots) ? sc.shots.slice(0, 16).map((s, i) => normalizeShot({
          id: newId('sh'), index: i + 1, desc: s.desc, dialogue: s.dialogue, camera: s.camera, duration: s.duration,
        }, i)) : [];
        if (!shots.length) throw new Error(`第 ${ep.n} 集剧本未产出镜头`);
        patchEpisode(ep, { title: cleanStr(sc.title, 60) || ep.title, synopsis: cleanStr(sc.synopsis, 300) || ep.synopsis, script: JSON.stringify(sc), shots });
        emit({ stage: 'script', episodeId: ep.id, type: 'stage', state: 'end' });
        tick('script', `${ep.title} · ${shots.length} 镜头`);
      }
      if (!scriptDone(ep)) continue;   // 剧本没就绪（跳过或失败），后续阶段无从谈起

      if (need('storyboard') && (scope.stage === 'storyboard' || scope.force || !storyboardDone(ep))) {
        emit({ stage: 'storyboard', episodeId: ep.id, type: 'stage', state: 'start' });
        const p = storyboardPrompt(comic, ep);
        const sb = await guard(() => chatJson(writer, p.sys, p.user, {
          onDelta: d => emit({ stage: 'storyboard', episodeId: ep.id, type: 'delta', text: d }), signal: ctx.ac.signal, fetchImpl, maxTokens: 8192,
        }));
        let fallback = 0;
        ep.shots.forEach(s => {
          const hit = (sb.shots || []).find(x => Number(x.index) === s.index) || (sb.shots || [])[s.index - 1];
          const ip = cleanStr(hit && hit.imagePrompt, 600);
          if (ip) patchShot(ep, s, { imagePrompt: ip, motionPrompt: cleanStr(hit.motionPrompt, 400) });
          else { fallback++; patchShot(ep, s, { imagePrompt: [comic.bible?.style, s.desc, s.camera].filter(Boolean).join('，'), motionPrompt: s.desc }); }
        });
        if (fallback) emit({ stage: 'storyboard', episodeId: ep.id, type: 'note', text: `${fallback} 个镜头使用画面描述兜底提示词` });
        emit({ stage: 'storyboard', episodeId: ep.id, type: 'stage', state: 'end' });
        tick('storyboard', `${ep.title} 分镜就绪`);
      }

      /* ---- 镜头级阶段：并发池 ---- */
      const shotStage = async (stageId, isDone, runOne) => {
        if (!need(stageId)) return false;
        const targets = ep.shots.filter(s => (scope.shotId ? s.id === scope.shotId : true) && (scope.stage === stageId || scope.force || !isDone(s)));
        if (!targets.length) return false;
        emit({ stage: stageId, episodeId: ep.id, type: 'stage', state: 'start', count: targets.length });
        await runPool(targets, concurrency, async s => {
          if (ctx.ac.signal.aborted) throw new CancelError();
          try {
            // 仅当失败点正是本阶段才清 err：后置阶段（如配音）开跑时不能洗掉前置阶段（如视频）的失败标记
            const failAt = !s.imageUrl ? 'image' : !s.videoUrl ? 'video' : 'voice';
            if (!s.err || failAt === stageId) patchShot(ep, s, { err: '' });
            const r = await runOne(s);
            patchShot(ep, s, r);
            emit({ stage: stageId, episodeId: ep.id, shotId: s.id, type: 'note', text: `✓ 镜头 ${s.index} ${STAGES.find(x => x.id === stageId).label}完成` });
          } catch (e) {
            if (e instanceof CancelError || e.name === 'AbortError') throw e;
            patchShot(ep, s, { err: cleanStr(e.message, 300) });   // 单镜头失败落 shot.err，不中断其余镜头
            emit({ stage: stageId, episodeId: ep.id, shotId: s.id, type: 'note', text: `✕ 镜头 ${s.index} 失败：${cleanStr(e.message, 120)}` });
          } finally {
            tick(stageId, `${ep.title} 镜头 ${s.index}`);
          }
        });
        emit({ stage: stageId, episodeId: ep.id, type: 'stage', state: 'end' });
        return true;
      };

      let ranShotStage = false;
      ranShotStage = (await shotStage('image', shotImageDone, async s => {
        const { url } = await genImage(render, s.imagePrompt, { aspect: comic.aspect, signal: ctx.ac.signal, fetchImpl });
        return { imageUrl: url };
      })) || ranShotStage;
      ranShotStage = (await shotStage('video', shotVideoDone, async s => {
        const { url, coverUrl } = await genVideo(render, {
          prompt: s.motionPrompt || s.desc, imageUrl: s.imageUrl, aspect: comic.aspect, duration: s.duration,
        }, { signal: ctx.ac.signal, fetchImpl, pollMs });
        return { videoUrl: url, coverUrl };
      })) || ranShotStage;
      if (voiceEnabled) ranShotStage = (await shotStage('voice', shotVoiceDone, async s => {
        if (!s.dialogue) return {};                                 // 无台词镜头无需配音
        const fs = require('fs'), path = require('path');
        const f = path.join(opts.audioDir, comic.id, ep.id, `shot-${pad2(s.index)}.wav`);
        const { bytes } = await genVoice(voice, s.dialogue, f, { signal: ctx.ac.signal, fetchImpl, voiceId: shotVoiceId(s) });
        return { audioUrl: f, audioBytes: bytes };
      })) || ranShotStage;
      else if (need('voice') && !scope.stage && voice && voice.baseURL && voice.model && !opts.audioDir) {
        emit({ stage: 'voice', episodeId: ep.id, type: 'note', text: '配音阶段跳过：未配置音频输出目录' });
      }

      /* ---- 合成（assemble）：本地计算，永远可跑（缺视频的镜头会在清单中标注）；
             全量续跑时即使已有合成包也重建（镜头可能重跑过） ---- */
      const assembleRuns = need('assemble') && (scope.stage === 'assemble' || scope.force || !scope.stage || !assembleDone(ep));
      /* 单镜头/单阶段重跑后本次不会走 assemble：已有合成包必须就地刷新，
         否则导出的 ffmpeg concat 清单与分镜表仍是重跑前的旧包（缺已补齐的镜头） */
      if (ranShotStage && !assembleRuns && ep.package) {
        const pkg = buildPackage(ep, comic.aspect);
        const failed = ep.shots.filter(s => s.err).length;
        patchEpisode(ep, { package: pkg, status: failed ? 'failed' : 'done', err: failed ? `${failed} 个镜头失败，可单镜头重跑` : '' });
        emit({ stage: 'assemble', episodeId: ep.id, type: 'note', text: pkg.missing ? `合成包已刷新（仍缺 ${pkg.missing} 个镜头视频）` : '合成包已刷新（全部镜头就绪）' });
        tick('assemble', `${ep.title} 合成包已刷新`);
      }
      if (assembleRuns) {
        emit({ stage: 'assemble', episodeId: ep.id, type: 'stage', state: 'start' });
        const pkg = buildPackage(ep, comic.aspect);
        const failed = ep.shots.filter(s => s.err).length;
        patchEpisode(ep, { package: pkg, status: failed ? 'failed' : 'done', err: failed ? `${failed} 个镜头失败，可单镜头重跑` : '' });
        emit({ stage: 'assemble', episodeId: ep.id, type: 'stage', state: 'end' });
        tick('assemble', pkg.missing ? `${ep.title} 合成（缺 ${pkg.missing} 镜头）` : `${ep.title} 合成完成`);
      }
    }

    /* ---- 收尾：按失败镜头聚合项目状态 ---- */
    const failedShots = eps.flatMap(e => e.shots.filter(s => s.err).map(s => ({ episodeId: e.id, shotId: s.id, index: s.index, err: s.err })));
    comic.status = failedShots.length ? 'failed' : 'done';
    patchComic({ status: comic.status, progress: { stage: '', pct: 100, note: failedShots.length ? `${failedShots.length} 个镜头待重跑` : '全部完成' } });
    emit({ type: 'done', summary: { episodes: eps.length, shots: eps.reduce((n, e) => n + e.shots.length, 0), failed: failedShots, elapsedMs: Date.now() - ctx.startedAt } });
  } catch (e) {
    const cancelled = e instanceof CancelError || e.name === 'AbortError' || ctx.ac.signal.aborted;
    if (cancelled) {
      comic.status = 'paused';
      patchComic({ status: 'paused', progress: { stage: comic.progress?.stage || '', pct: comic.progress?.pct || 0, note: '已终止，可续跑' } });
      emit({ type: 'cancelled' });
    } else {
      comic.status = 'failed';
      patchComic({ status: 'failed', progress: { stage: comic.progress?.stage || '', pct: comic.progress?.pct || 0, note: cleanStr(e.message, 120) } });
      emit({ type: 'error', stage: comic.progress?.stage || '', message: cleanStr(e.message, 300) });
    }
  } finally {
    jobs.delete(comic.id);
  }
}

module.exports = {
  RENDER_PROVIDERS, VOICE_ENGINE_PRESETS, KOKORO_ZH_VOICES, STAGES, STAGE_IDS,
  createComic, normalizeComic, normalizeEpisode, normalizeShot, buildPackage,
  runJob, cancelJob, jobSnapshot,
  /* 测试可见的内部谓词 */
  _predicates: { bibleDone, scriptDone, storyboardDone, shotImageDone, shotVideoDone, shotVoiceDone, assembleDone },
  _internal: { genImage, genVideo, genVoice, comfyGenImage, comfyGenVideo, comfySubmit, comfyWait, comfyUploadImage, precheck, parseVoiceTable, biblePrompt, scriptPrompt },
};
