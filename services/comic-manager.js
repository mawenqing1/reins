/* ============================================================
   Reins — 漫剧工作流服务层（REINS-126）
   在引擎 services/comic.js 之上补齐主进程接入：
     · 渲染引擎配置（settings.renderEngine）：独立于 LLM Agent 配置；
       每次任务启动时读取一次快照 —— 配置变更只影响新任务，进行中任务不受影响
     · 编剧引擎解析：payload.writer 直配，或 roster 中的 API Agent
       （服务商预置回退与 runner.js 同源，避免两套默认值漂移）
     · 任务启动/终止/快照/状态收养；引擎事件按窗口批量成单条 IPC 推送
       （{type:'batch', events:[...]}，delta 在批内继续合并），压平逐 token 消息压力
   渲染层数据流约定：comic 对象由渲染层持有并随 reins:state:save 持久化；
   主进程在体检后的独立副本上执行，comic/episode/shot 补丁事件回传渲染层增量应用，
   页面重载后用 comic:snapshot 整量对齐。
   纯 Node 可测：create({ readSettings, writeSettings, audioDir, fetchImpl, deltaMs }) 注入依赖
   ============================================================ */
'use strict';
const os = require('os');
const path = require('path');
const comic = require('./comic');
const { PROVIDERS } = require('./runner');

/* 部分服务的 WAF 会按 TLS 指纹丢弃 Node fetch 握手；Electron 主进程优先 net.fetch（与 comic.js/runner.js 同策略） */
let _netFetch = null;
try { _netFetch = require('electron').net.fetch; } catch (e) { }
const pfetch = (...a) => (_netFetch || global.fetch)(...a);

/* 配音落盘目录：Electron 下进 userData（随应用数据管理），纯 Node 测试回退临时目录 */
function defaultAudioDir() {
  try { return path.join(require('electron').app.getPath('userData'), 'comic-media'); } catch (e) { }
  return path.join(os.tmpdir(), 'reins-comic-media');
}

/* 主进程 → 渲染层事件批量器（REINS-126 返工修复：逐事件 IPC 频率过高导致 UI 卡顿）
   引擎所有事件攒进窗口（默认 120ms）后合成一条 {type:'batch', events:[...]} 推送：
     · 渲染层每个窗口最多收 1 条 IPC 消息，窗口内事件一次性应用、只做一次落盘与 UI 收尾
     · 相邻同阶段 delta 的文本直接追加（保留原 delta 合并语义，缩小批次体积）
     · 终态事件（done/cancelled/error）立即冲刷，收尾观感不延迟
     · 批内事件相对顺序全部保持（seq 依旧单调，渲染层乱序丢弃逻辑不变） */
const TERMINAL_EVT = new Set(['done', 'cancelled', 'error']);
function eventBatcher(emit, ms = 120) {
  let queue = [], timer = null;
  const flush = () => {
    if (timer) { clearTimeout(timer); timer = null; }
    if (!queue.length) return;
    const evts = queue; queue = [];
    try { emit({ type: 'batch', events: evts }); } catch (e) { }
  };
  return evt => {
    if (TERMINAL_EVT.has(evt.type)) { queue.push(evt); flush(); return; }
    const last = queue[queue.length - 1];
    if (evt.type === 'delta' && last && last.type === 'delta' && last.stage === evt.stage
      && (last.episodeId || '') === (evt.episodeId || '')) last.text += evt.text;
    else queue.push(evt);
    if (!timer) { timer = setTimeout(flush, ms); if (timer.unref) timer.unref(); }
  };
}

/* ---------- 工厂：依赖注入，主进程与测试各自装配 ---------- */
function create(deps = {}) {
  const readSettings = deps.readSettings || (() => ({}));
  const writeSettings = deps.writeSettings || (() => { });
  const audioDir = deps.audioDir || defaultAudioDir();
  const fetchImpl = deps.fetchImpl || undefined;      // undefined → 引擎/探测用各自默认 fetch
  const batchMs = Number(deps.batchMs ?? deps.deltaMs) > 0 ? Number(deps.batchMs ?? deps.deltaMs) : 120;

  /* ===== 渲染引擎配置（settings.renderEngine） ===== */
  function normalizeRenderEngine(raw) {
    const c = raw && typeof raw === 'object' ? raw : {};
    const provider = comic.RENDER_PROVIDERS[c.provider] ? c.provider : 'zhipu';
    const preset = comic.RENDER_PROVIDERS[provider];
    return {
      provider,
      baseURL: String(c.baseURL ?? preset.baseURL ?? '').trim(),
      apiKey: String(c.apiKey || '').trim(),
      imageModel: String(c.imageModel ?? preset.imageModel ?? '').trim(),
      videoModel: String(c.videoModel ?? preset.videoModel ?? '').trim(),
      voiceModel: String(c.voiceModel ?? preset.voiceModel ?? '').trim(),
    };
  }
  function getRenderEngine() { return normalizeRenderEngine((readSettings() || {}).renderEngine); }

  function setRenderEngine(patch) {
    const p = patch && typeof patch === 'object' ? patch : {};
    if (p.provider && !comic.RENDER_PROVIDERS[p.provider]) return { ok: false, error: '未知渲染服务商：' + p.provider };
    /* 单次读档（返工修复①）：读-改-写一气呵成，不与 getRenderEngine 的第二次读盘交叉，
       同步执行期内其他写方无法插入，settings.json 的整档写回不会夹带过期字段 */
    const s = readSettings() || {};
    const cur = normalizeRenderEngine(s.renderEngine);
    // 切换服务商先落到新预置默认，再应用本次显式字段：设置页换服务商无需手动清空旧字段
    const base = p.provider && p.provider !== cur.provider ? normalizeRenderEngine({ provider: p.provider }) : cur;
    const next = normalizeRenderEngine({
      ...base,
      provider: p.provider || base.provider,
      baseURL: p.baseURL !== undefined ? p.baseURL : base.baseURL,
      apiKey: p.apiKey !== undefined ? p.apiKey : base.apiKey,
      imageModel: p.imageModel !== undefined ? p.imageModel : base.imageModel,
      videoModel: p.videoModel !== undefined ? p.videoModel : base.videoModel,
      voiceModel: p.voiceModel !== undefined ? p.voiceModel : base.voiceModel,
    });
    s.renderEngine = next;
    try { writeSettings(s); }
    catch (e) { return { ok: false, error: '配置写入失败：' + (e && e.message) }; }
    /* 落盘回读校验（REINS-126 返工修复：写盘失败此前被静默吞掉，界面提示「已保存」
       但重启后配置丢失）。校验失败把错误上抛给 UI，绝不假装保存成功；
       归一化后比较，与磁盘键序无关（返工①：键序漂移不再误报） */
    const back = normalizeRenderEngine((readSettings() || {}).renderEngine);
    if (JSON.stringify(back) !== JSON.stringify(next)) {
      return { ok: false, error: '配置未能写入 settings.json：请检查本机磁盘与 userData 目录权限后重试' };
    }
    return { ok: true, engine: next };
  }

  /* 渲染引擎连通测试（零成本探测）：带鉴权发一个刻意缺参的生成请求——
     401/403 = Key 无效；400/422 = 鉴权通过、被参数校验拒绝（预期，不产生消耗）；2xx = 完全通 */
  async function testRenderEngine(cfg) {
    const e = cfg && typeof cfg === 'object' ? normalizeRenderEngine(cfg) : getRenderEngine();
    if (!e.baseURL) return { ok: false, message: '未配置渲染服务地址（baseURL）' };
    if (!/^https?:\/\//.test(e.baseURL)) return { ok: false, message: '地址需以 http:// 或 https:// 开头' };
    if (!e.apiKey) return { ok: false, message: '未配置 API Key' };
    const doFetch = fetchImpl || pfetch;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    try {
      const resp = await doFetch(e.baseURL.replace(/\/+$/, '') + '/images/generations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + e.apiKey },
        body: JSON.stringify({ model: e.imageModel || '', prompt: '' }),
        signal: ctrl.signal,
      });
      if (resp.status === 401 || resp.status === 403) return { ok: false, message: `API Key 无效（HTTP ${resp.status}）` };
      if (resp.status === 404) return { ok: false, message: '端点不存在（404）：请确认地址为智谱兼容 API 根路径（如 …/api/paas/v4）' };
      if (resp.ok) return { ok: true, message: '渲染引擎连接成功（探测请求被接受）' };
      const t = await resp.text().catch(() => '');
      return { ok: true, message: `链路可达且鉴权通过（HTTP ${resp.status} 参数校验拒绝属预期，未产生消耗）${t.slice(0, 80)}` };
    } catch (err) {
      return { ok: false, message: err.name === 'AbortError' ? '超时（8s）' : err.message };
    } finally { clearTimeout(timer); }
  }

  /* ===== 编剧引擎解析：writer 直配优先，否则 roster 中的 API Agent（预置回退与 runner 同源） ===== */
  function resolveWriter(w, agent) {
    if (w && typeof w === 'object' && w.baseURL && w.apiKey) {
      return { baseURL: String(w.baseURL).trim().replace(/\/+$/, ''), apiKey: String(w.apiKey), model: String(w.model || 'glm-4.7') };
    }
    if (agent && typeof agent === 'object') {
      if (agent.mode === 'cli') return { error: '编剧 Agent 需为 API 模型（本机 CLI 无法稳定产出设定/剧本 JSON）' };
      const p = PROVIDERS[agent.provider] || PROVIDERS.custom;
      const baseURL = String(agent.baseURL || p.baseURL || '').trim().replace(/\/+$/, '');
      const apiKey = String(agent.apiKey || '').trim();
      if (!baseURL || !apiKey) return { error: '编剧 Agent 未配置 baseURL 或 API Key（设置 → 模型与密钥）' };
      return { baseURL, apiKey, model: String(agent.model || p.model || 'glm-4.7') };
    }
    return { error: '缺少编剧引擎：请指定 writerAgent（API 模型 Agent）或 writer 直配' };
  }

  /* 按目标阶段决定需要哪类引擎（与引擎 precheck 同口径）：
     文本阶段要 LLM，渲染阶段要渲染引擎，合成阶段纯本地零依赖 */
  /* 渲染引擎配置缺口细查（REINS-126 返工修复③）：此前未配置时只报一句
     「需要生成服务地址与 API Key」，不区分缺哪个字段、影响哪些阶段、去哪配。
     逐字段给可行动错误：baseURL / apiKey / 模型名分开点名，模型名按目标阶段点名
     （image→图像模型、video→视频模型、voice→配音模型），并始终保留「渲染引擎」
     关键字与设置入口文案（UI 冒烟断言口径不变） */
  function renderConfigError(render, scope = {}) {
    const st = comic.STAGES.find(x => x.id === scope.stage);
    const target = st ? `「${st.label}」阶段` : '首帧 / 视频（及配音）渲染';
    const where = '设置 → 渲染引擎';
    if (!render.baseURL && !render.apiKey)
      return `渲染引擎未配置：${target}需要图像 / 视频生成服务。请到「${where}」填写服务地址（Base URL，如 https://open.bigmodel.cn/api/paas/v4）与 API Key 后重试`;
    if (!render.baseURL)
      return `渲染引擎缺少服务地址（Base URL）：${target}需要。请到「${where}」填写 API 根路径（服务商兼容端点）`;
    if (!render.apiKey)
      return `渲染引擎缺少 API Key：${target}需要。请到「${where}」填写（仅保存在本机 settings.json）`;
    /* 模型名按目标阶段点名；未指定阶段（全流程）需要图像 + 视频，配音可选不强制 */
    if ((scope.stage === 'image' || !scope.stage) && !render.imageModel)
      return `渲染引擎缺少图像模型名（imageModel）：${st ? `「${st.label}」阶段` : '首帧生成'}需要。请到「${where}」填写（智谱预置为 cogview-4）`;
    if ((scope.stage === 'video' || !scope.stage) && !render.videoModel)
      return `渲染引擎缺少视频模型名（videoModel）：${st ? `「${st.label}」阶段` : '镜头视频生成'}需要。请到「${where}」填写（智谱预置为 cogvideox-3）`;
    if (scope.stage === 'voice' && !render.voiceModel)
      return `渲染引擎缺少配音模型（voiceModel）：「配音」为可选阶段，请到「${where}」填写模型名；留空则启动时自动跳过该阶段`;
    return null;
  }
  function resolveEngines(payload = {}) {
    const scope = payload.scope || {};
    const st = comic.STAGES.find(x => x.id === scope.stage);
    let writer = null, render = null;
    if (!st || st.kind === 'llm') {
      const w = resolveWriter(payload.writer, payload.writerAgent);
      if (w.error) return { error: w.error };
      writer = w;
    }
    if (!st || st.kind === 'render') {
      render = payload.render && typeof payload.render === 'object' ? normalizeRenderEngine(payload.render) : getRenderEngine();
      const gap = renderConfigError(render, scope);   // 逐字段细查（返工修复③）
      if (gap) return { error: gap };
    }
    return { writer, render };
  }

  /* ===== 任务生命周期 ===== */
  function start(payload, emit) {
    const p = payload && typeof payload === 'object' ? payload : {};
    if (!p.comic || typeof p.comic !== 'object' || !p.comic.id) return { ok: false, error: '缺少漫剧项目对象（需要 comic.id）' };
    const eng = resolveEngines(p);
    if (eng.error) return { ok: false, error: eng.error };
    const c = comic.normalizeComic(p.comic);   // 归档体检：主进程持独立副本，渲染层脏档不直入引擎
    const fwd = eventBatcher(evt => { try { emit && emit(evt); } catch (e) { } }, batchMs);
    return comic.runJob({ comic: c, scope: p.scope || {} }, { writer: eng.writer, render: eng.render }, fwd, {
      audioDir,
      fetchImpl,
      pollMs: Number(p.pollMs) > 0 ? Math.min(60000, Math.round(Number(p.pollMs))) : 3000,
      concurrency: Math.max(1, Math.min(4, Math.round(Number(p.concurrency) || 2))),
    });
  }
  const cancel = comicId => comic.cancelJob(comicId);
  const snapshot = comicId => comic.jobSnapshot(comicId);

  /* 合成包按需重建（REINS-126 返工修复）：导出前用渲染层最新 comic 数据重算一次，
     兜住「单镜头重跑成功后，下载的 ffmpeg concat / 分镜表还是旧包缺镜头」的过期档 */
  function rebuildPackage(rawComic, episodeId) {
    if (!rawComic || typeof rawComic !== 'object' || !episodeId) return { ok: false, error: '缺少漫剧或剧集参数' };
    const c = comic.normalizeComic(rawComic);
    const ep = c.episodes.find(e => e.id === episodeId);
    if (!ep) return { ok: false, error: '剧集不存在：' + episodeId };
    if (!ep.shots.length) return { ok: false, error: '本集尚未拆分镜头，无合成包' };
    return { ok: true, package: comic.buildPackage(ep, c.aspect) };
  }

  /* 状态收养：应用重启/页面崩溃后，持久化档里的 running 态在主进程已无对应任务，
     收养为 paused（产物保留、断点续跑语义不变），由渲染层加载时调用 */
  function adopt(raw) {
    const c = comic.normalizeComic(raw);
    if (c.status === 'running' && !comic.jobSnapshot(c.id)) {
      c.status = 'paused';
      c.progress = { stage: c.progress?.stage || '', pct: c.progress?.pct || 0, note: '应用重启后转为暂停，可续跑' };
    }
    return c;
  }

  /* ===== 元信息与工厂透传 ===== */
  const meta = () => ({ stages: comic.STAGES, stageIds: comic.STAGE_IDS, renderProviders: comic.RENDER_PROVIDERS });
  const createComicWrap = input => comic.createComic(input);
  const normalize = raw => comic.normalizeComic(raw);

  return { meta, create: createComicWrap, normalize, adopt, getRenderEngine, setRenderEngine, testRenderEngine, renderConfigError, resolveEngines, start, cancel, snapshot, rebuildPackage };
}

module.exports = { create };
