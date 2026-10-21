/* Reins — Electron 主进程 */
const { app, BrowserWindow, Menu, shell, dialog, Tray, nativeImage, ipcMain, powerMonitor } = require('electron');
const path = require('path');
const fs = require('fs');
const store = require('./services/store');
const runner = require('./services/runner');
const secureKeys = require('./services/secure-keys');
const schedulerMod = require('./services/scheduler');
const pipelineMod = require('./services/pipeline');
const gitRemote = require('./services/git-remote');
const feishuBridgeMod = require('./services/feishu-bridge');
const pricing = require('./services/pricing');
const textstore = require('./services/textstore');
const integrity = require('./services/integrity');
const updateMod = require('./services/update');

const isMac = process.platform === 'darwin';
let mainWindow = null;
let tray = null;

/* 产品更名迁移：旧版 userData 目录带中文副名，改名前把数据原地带走，任务/密钥不丢 */
(() => {
  const oldUD = path.join(app.getPath('appData'), 'Reins 驭码');
  const newUD = path.join(app.getPath('appData'), 'Reins');
  try { if (fs.existsSync(oldUD) && !fs.existsSync(newUD)) fs.renameSync(oldUD, newUD); } catch (e) { }
})();

/* ---------- 客户端设置（userData/settings.json） ---------- */
/* 写方有多个（设置页 settings:set / 托盘首次提示），防交叉写丢配置：
     a) readSettings 解析失败时返回最近一次成功读到的整档（lastGood 兜底），
        避免下一个写方把纯默认值整档写回、抹掉 cloudToken 等自定义配置；
     b) writeSettings 静默吞错 —— 界面提示「已保存」但磁盘上没有（改为抛错，调用方透传给 UI）；
     c) 渲染层把 settings:get 的返回整包回传（带 platform/version 只读信息），
        保留字段在 settings:set 一律剔除。 */
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
const defaultFeishu = {
  enabled: false,                                  // 总开关（关闭时任何事件都不发）
  appId: '', appSecret: '', chatId: '',            // 自建应用：发群 + 读群指令（应用需开 im:message 权限）
  baseUrl: 'https://open.feishu.cn',               // 私有化/Lark 国际版可改为对应域名
  webhookUrl: '', webhookSecret: '',               // 自定义群机器人：仅出站（secret 为「加签」密钥）
  events: { create: true, done: true, reject: true, fail: true },   // 逐事件开关
  inbound: false,                                  // 读取群内 /reins 指令（双向同步入口）
  inboundIntervalMs: 45000,                        // 轮询间隔（15s–10min）
  lastSyncAt: 0, lastError: '',                    // 水位与最近错误（同步状态卡展示）
};
const defaultSettings = {
  launchAtLogin: false, keepInTray: true, webhookUrl: '', webhookEvents: { create: true, done: true, reject: true }, cloudUrl: '', cloudToken: '', preventSleep: false,
  jevUrl: 'https://api.typesafe.ai/v1/systemone', jevKey: '', jevModel: 'jev-latest', triageEngine: 'auto',
  /* REINS-128 新增：API 执行策略 / 模型参数 / 调度任务 / 密钥存储策略 / Git 托管令牌 */
  apiTimeoutMs: 120000,          // API 无响应超时（可调大防误杀长推理）
  apiRetries: 3,                 // 429/5xx/网络超时自动重试上限
  modelParams: { temperature: 0.6, maxTokens: 4096, topP: 1.0 },   // 全局默认模型参数
  schedules: [],                 // 自动化调度任务（scheduler.js 管理，随档持久化）
  keyStorage: 'auto',            // 密钥存储策略：auto（可用即加密）/ plain（用户明确选择不加密）
  gitTokens: { github: '', gitee: '' },   // PR 创建用的托管平台 PAT
  feishu: defaultFeishu,         // 飞书接入（自建应用 + 群机器人 + 群指令同步）
  modelPrices: {},               // 用户覆盖的模型单价（元/1M tokens，{模型名:{in,out}}），空则用内置参考价
};
let settingsLastGood = null;   // 最近一次成功读到的整档；坏档/瞬时读失败时回退，防止后续写盘把配置抹平

/* 新增数值/对象字段兜底归一：旧档升级后缺字段时补默认，坏值（越界/非数）回退默认 */
function normalizeNewFields(s) {
  if (!Number.isFinite(s.apiTimeoutMs) || s.apiTimeoutMs < 5000) s.apiTimeoutMs = defaultSettings.apiTimeoutMs;
  if (!Number.isFinite(s.apiRetries) || s.apiRetries < 0 || s.apiRetries > 10) s.apiRetries = defaultSettings.apiRetries;
  const mp = { ...defaultSettings.modelParams, ...(s.modelParams && typeof s.modelParams === 'object' ? s.modelParams : {}) };
  mp.temperature = Number.isFinite(Number(mp.temperature)) ? Math.min(2, Math.max(0, Number(mp.temperature))) : 0.6;
  mp.maxTokens = Number.isFinite(Number(mp.maxTokens)) ? Math.min(200000, Math.max(1, Math.round(Number(mp.maxTokens)))) : 4096;
  mp.topP = Number.isFinite(Number(mp.topP)) ? Math.min(1, Math.max(0.01, Number(mp.topP))) : 1.0;
  s.modelParams = mp;
  if (!Array.isArray(s.schedules)) s.schedules = [];
  if (s.keyStorage !== 'plain') s.keyStorage = 'auto';
  if (!s.gitTokens || typeof s.gitTokens !== 'object') s.gitTokens = { ...defaultSettings.gitTokens };
  /* 飞书配置逐字段兜底：旧档没有 feishu 字段、或用户手工改档写坏类型时都能起得来 */
  const f = s.feishu && typeof s.feishu === 'object' && !Array.isArray(s.feishu) ? s.feishu : {};
  s.feishu = {
    ...defaultFeishu, ...f,
    events: { ...defaultFeishu.events, ...(f.events && typeof f.events === 'object' ? f.events : {}) },
    inboundIntervalMs: Math.min(Math.max(Number(f.inboundIntervalMs) || defaultFeishu.inboundIntervalMs, 15000), 600000),
    lastSyncAt: Number(f.lastSyncAt) || 0,
  };
  for (const k of ['appId', 'chatId', 'baseUrl', 'webhookUrl']) if (typeof s.feishu[k] !== 'string') s.feishu[k] = defaultFeishu[k];
  /* 模型价格覆盖表：必须是「模型名 → {in,out} 数字」的普通对象，坏值逐项剔除（坏档不该拖垮计价） */
  if (!s.modelPrices || typeof s.modelPrices !== 'object' || Array.isArray(s.modelPrices)) s.modelPrices = {};
  else {
    const clean = {};
    for (const [k, v] of Object.entries(s.modelPrices)) {
      if (!v || typeof v !== 'object') continue;
      const i = Number(v.in), o = Number(v.out);
      if (Number.isFinite(i) && i >= 0 && Number.isFinite(o) && o >= 0) clean[String(k).slice(0, 80)] = { in: i, out: o };
    }
    s.modelPrices = clean;
  }
  return s;
}
function readSettings() {
  try {
    const s = normalizeNewFields({ ...defaultSettings, ...JSON.parse(fs.readFileSync(settingsFile(), 'utf-8')) });
    secureKeys.openSettings(s);   // 密文 cloudToken/jevKey → 内存明文（渲染层零改动）；解不开保留密文并标记 __*Locked
    settingsLastGood = s;
    return { ...s };
  } catch (e) {
    return settingsLastGood ? { ...settingsLastGood } : { ...defaultSettings };
  }
}
function writeSettings(s) {
  /* 原子写（tmp+rename，与 store.js 同策略）：直接覆写 settings.json 一旦中途失败/掉电，
     会留下半截文件，重启后配置整体丢失。
     写失败向上抛错：settings:set 把错误透给界面。
     落盘前对密钥字段加密（内存/lastGood 恒为明文，只有磁盘持密文） */
  const f = settingsFile(), tmp = f + '.tmp';
  const sealed = secureKeys.sealSettings({ ...s }, s.keyStorage).state;
  fs.writeFileSync(tmp, JSON.stringify(sealed, null, 2));
  fs.renameSync(tmp, f);
  settingsLastGood = { ...s };
}
/* 保留字段：platform/version 是 settings:get 附加的只读信息；schedules 只经
   reins:schedule:* 通道维护（校验/nextRun 由调度器负责），整包回传一律剔除。
   settings:set 收到这些键一律剔除，杜绝渲染层把读到的快照整包回传造成的交叉覆盖 */
const SETTINGS_RESERVED = new Set(['platform', 'version', 'schedules']);
function applySettings(s) {
  // 关闭态不调用系统 API：未签名/未打包环境下注册登录项会被 macOS 拒绝并打印报错
  if (!s.launchAtLogin) return;
  try { app.setLoginItemSettings({ openAtLogin: true, args: ['--hidden'] }); } catch (e) { }
}

ipcMain.handle('reins:settings:get', () => ({ ...readSettings(), platform: process.platform, version: app.getVersion() }));
/* 嵌套对象的「浅合并」字段：渲染层可以只提交变动项（如 {feishu:{enabled:true}}），
   不会把没提交的 feishu 字段整块覆盖成空值；events 再单独深合并一层 */
const SETTINGS_MERGE_KEYS = new Set(['feishu', 'gitTokens', 'webhookEvents', 'modelParams']);
ipcMain.handle('reins:settings:set', (_e, patch) => {
  /* 读-改-写保留字段剔除（返工修复①）：只接受普通客户端键，写失败如实返回，不假装成功 */
  const p = patch && typeof patch === 'object' ? patch : {};
  const s = readSettings();
  for (const k of Object.keys(p)) {
    if (SETTINGS_RESERVED.has(k)) continue;
    const cur = s[k];
    if (SETTINGS_MERGE_KEYS.has(k) && p[k] && typeof p[k] === 'object' && !Array.isArray(p[k])
      && cur && typeof cur === 'object' && !Array.isArray(cur)) {
      s[k] = { ...cur, ...p[k] };
      if (p[k].events && typeof p[k].events === 'object' && cur.events && typeof cur.events === 'object') {
        s[k].events = { ...cur.events, ...p[k].events };
      }
    } else s[k] = p[k];
  }
  try { writeSettings(s); } catch (e) { return { ok: false, error: '设置写入失败：' + e.message }; }
  applySettings(s);
  /* 飞书配置变化即时生效：同步器重排、token 缓存作废（改群/换应用无需重启） */
  try { feishuBridge.refresh(); } catch (e) { }
  return { ok: true, settings: s };
});

/* ---------- 任务数据（文件持久化） ----------
   落盘钩子加解密（REINS-128）：内存/渲染层恒为明文 apiKey，磁盘上只存
   safeStorage 密文（{__encrypted:true,data}）；后端不可用或用户选 plain 时明文透传 */
/* 正文库根目录（deliveries 下的 text/）：超过阈值的阶段产出与交付正文落这里，
   state 只留引用（见 services/textstore.js），避免每次保存序列化几 MB 正文 */
const textRoot = () => path.join(app.getPath('userData'), 'deliveries');
function writeTextRef(ref, text) {
  const abs = textstore.resolveRef(textRoot(), ref);
  if (!abs) throw new Error('非法正文引用：' + ref);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text, 'utf8');
  return abs;
}
/* 保存前置：把每个任务的大文本换成引用。就地改（渲染层传的是同一份对象引用，
   改完它自己也持有引用，下一次保存不必重复写盘）；写盘失败保留原字符串 */
function externalizeState(data) {
  let moved = 0, saved = 0;
  const walk = (task) => {
    if (!task || typeof task !== 'object' || !task.key) return;
    const swap = (holder, field, slot) => {
      const v = holder[field];
      if (typeof v !== 'string' || !v) return;
      const before = Buffer.byteLength(v, 'utf8');
      const r = textstore.toRef(v, task.key, slot, writeTextRef);
      if (r !== v) { holder[field] = r; moved++; saved += before - textstore.bytesOf(r); }
    };
    swap(task, 'result', 'result');
    if (Array.isArray(task.thread)) {
      task.thread.forEach((m, i) => { if (m && typeof m === 'object') swap(m, 'content', 'thread-' + i); });
    }
    if (task.pipeline && Array.isArray(task.pipeline.stages)) {
      task.pipeline.stages.forEach((s, i) => {
        if (s && typeof s === 'object') swap(s, 'result', 'stage-' + (s.id || i));
      });
      if (task.pipeline.reworkCtx && typeof task.pipeline.reworkCtx === 'object') {
        swap(task.pipeline.reworkCtx, 'qaReport', 'qa-report');
        swap(task.pipeline.reworkCtx, 'feedback', 'rework-feedback');
      }
      if (task.pipeline.gate && typeof task.pipeline.gate === 'object') swap(task.pipeline.gate, 'evidence', 'gate-evidence');
    }
  };
  for (const org of (data && data.orgs) || []) {
    for (const sp of (org && org.spaces) || []) for (const t of (sp && sp.tasks) || []) walk(t);
  }
  return { moved, saved };
}

ipcMain.handle('reins:state:load', () => {
  const d = store.loadState();
  if (!d) return d;
  try { secureKeys.openState(d); } catch (e) { }
  return d;
});
ipcMain.handle('reins:state:save', (_e, data, immediate) => {
  if (data && typeof data === 'object') {
    try { secureKeys.sealState(data, readSettings().keyStorage); } catch (e) { }
    try { externalizeState(data); } catch (e) { console.error('[textstore] 正文外置失败（保留原值）:', e.message); }
    invalidateIntegrity();
  }
  store.saveState(data, !!immediate);
  return true;
});
/* ---------- 交付文件清理 ----------
   删除任务时，磁盘上的 deliveries/<KEY>/（报告、diff、过程日志）与
   deliveries/text/<KEY>/（外置正文）不会被 state 带走——不清理就是永久残留。
   另外「孤儿回收」：state 里已不存在的任务，其目录可以安全删除（用户可能删过任务、换过档） */
const safeKeyDir = key => {
  const k = String(key || '').replace(/[^\w.-]+/g, '_');
  return k ? k : '';
};
ipcMain.handle('reins:delivery:purge', (_e, key) => {
  const k = safeKeyDir(key);
  if (!k) return { ok: false, error: '缺少任务号' };
  const root = app.getPath('userData');
  const targets = [path.join(root, 'deliveries', k), path.join(root, 'deliveries', 'text', k)];
  let removed = 0;
  for (const dir of targets) {
    const abs = path.resolve(dir);
    /* 只允许删 userData/deliveries 下的目录：防止 key 被篡改成 ../ 越界删库 */
    if (!abs.startsWith(path.resolve(root, 'deliveries') + path.sep)) continue;
    try {
      if (fs.existsSync(abs)) { fs.rmSync(abs, { recursive: true, force: true }); removed++; }
    } catch (e) { return { ok: false, error: '删除失败：' + e.message, removed }; }
  }
  invalidateIntegrity();
  return { ok: true, removed };
});
/* 孤儿回收：传入「仍存在的任务号数组」，删掉 deliveries 下不在其中的目录（text/ 里的同名子目录同样处理） */
ipcMain.handle('reins:delivery:gc', (_e, keepKeys) => {
  const keep = new Set((Array.isArray(keepKeys) ? keepKeys : []).map(k => safeKeyDir(k)).filter(Boolean));
  const base = path.join(app.getPath('userData'), 'deliveries');
  const stats = { scanned: 0, removed: 0, bytes: 0, errors: [] };
  const dirSize = dir => {
    let n = 0;
    const walk = p => {
      let st = null;
      try { st = fs.statSync(p); } catch (e) { return; }
      if (st.isDirectory()) { for (const f of fs.readdirSync(p)) walk(path.join(p, f)); }
      else n += st.size;
    };
    walk(dir);
    return n;
  };
  /* 只扫两层：deliveries/<KEY>（交付产物）与 deliveries/text/<KEY>（外置正文）。
     text/ 是正文库容器，不是一个任务目录——绝不能在顶层按 keep 清单判定它（会被整库删掉）。
     故这里显式跳过容器目录，只对它的子目录做孤儿判断 */
  const TEXT_DIR = 'text';
  const sweepKeys = (dir, skip) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      if (skip && skip.has(ent.name)) continue;
      stats.scanned++;
      if (keep.has(ent.name)) continue;
      const abs = path.join(dir, ent.name);
      try {
        stats.bytes += dirSize(abs);
        fs.rmSync(abs, { recursive: true, force: true });
        stats.removed++;
      } catch (e) { stats.errors.push(ent.name + '：' + e.message); }
    }
  };
  try {
    sweepKeys(base, new Set([TEXT_DIR]));            // 顶层：跳过正文库容器
    sweepKeys(path.join(base, TEXT_DIR), null);      // 正文库内：按 keep 判定
  } catch (e) { stats.errors.push(e.message); }
  return { ok: true, ...stats };
});

/* 正文回写：把渲染层持有的正文写回正文库（用于恢复——正文库被误删/迁移丢失时，
   内存或备份里还有原文，可以原样写回）。ref 同样受安全校验约束 */
ipcMain.handle('reins:text:write', (_e, payload) => {
  const p = payload && typeof payload === 'object' ? payload : {};
  const abs = textstore.resolveRef(textRoot(), p.ref);
  if (!abs) return { ok: false, error: '非法的正文引用' };
  if (typeof p.text !== 'string') return { ok: false, error: '缺少正文内容' };
  try {
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, p.text, 'utf8');
    return { ok: true, bytes: Buffer.byteLength(p.text, 'utf8') };
  } catch (e) { return { ok: false, error: '写入失败：' + e.message }; }
});

/* ---------- 数据自检（一致性体检） ----------
   外置带来的新失败模式：state 还在、正文文件没了 → 静默降级成摘要，用户很难察觉。
   这里做主进程侧的盘点：引用是否都有文件、有没有孤儿目录、磁盘占用多大。
   结论缓存 30 秒，避免设置页反复打开时重复扫盘；force=true 可强制重扫 */
let integrityCache = null;
ipcMain.handle('reins:integrity:check', (_e, force) => {
  if (!force && integrityCache && Date.now() - integrityCache.at < 30000) return integrityCache;
  const base = path.join(app.getPath('userData'), 'deliveries');
  const textBase = path.join(base, 'text');
  /* state 走只读加载（不解密密钥、不改动任何东西） */
  let state = null;
  try { state = store.loadState(); } catch (e) { state = null; }
  const refs = state ? integrity.collectRefs(state) : [];
  const exists = ref => {
    const abs = textstore.resolveRef(textRoot(), ref);
    if (!abs) return false;                    // 路径不安全：等同缺失，且会被报告出来
    try { return fs.statSync(abs).isFile(); } catch (e) { return false; }
  };
  const dirSize = dir => {
    let n = 0;
    const walk = p => {
      let st = null;
      try { st = fs.statSync(p); } catch (e) { return; }
      if (st.isDirectory()) { for (const f of fs.readdirSync(p)) walk(path.join(p, f)); }
      else n += st.size;
    };
    walk(dir);
    return n;
  };
  let dirNames = [];
  try { dirNames = fs.readdirSync(base, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name); } catch (e) { dirNames = []; }
  const keepKeys = [];
  for (const org of (state && state.orgs) || []) {
    for (const sp of (org.spaces || [])) for (const t of (sp.tasks || [])) if (t && t.key) keepKeys.push(String(t.key));
  }
  const orphans = integrity.findOrphans(dirNames, keepKeys);
  let orphanBytes = 0;
  for (const n of orphans) orphanBytes += dirSize(path.join(base, n));
  let textBytes = 0;
  try { textBytes = dirSize(textBase); } catch (e) { textBytes = 0; }
  const report = integrity.buildReport({ refs, exists, dirNames, keepKeys, orphanBytes });
  /* 正文库体积并入总占用（引用里的 bytes 只是记录值，磁盘上可能有更早的残留） */
  report.totalBytes = Math.max(report.totalBytes, textBytes + orphanBytes);
  report.at = Date.now();
  integrityCache = report;
  return report;
});
/* 报告失效：任务增删/正文写入后让下次检查重扫（不需要精确，只是省一次扫盘） */
function invalidateIntegrity() { integrityCache = null; }

/* 正文取回：引用 → 全文。ref 只允许 deliveries/text/ 下，越界直接拒绝 */
ipcMain.handle('reins:text:read', (_e, ref) => {
  const abs = textstore.resolveRef(textRoot(), ref);
  if (!abs) return { ok: false, error: '非法的正文引用' };
  try {
    const text = fs.readFileSync(abs, 'utf8');
    return { ok: true, text: text.length > 600000 ? text.slice(-600000) : text };
  } catch (e) { return { ok: false, error: '正文不存在或不可读：' + e.message }; }
});

/* 正文清理（归档任务显式清理）：删正文文件（路径同 read 的安全校验；文件本就不在时按成功返回） */
ipcMain.handle('reins:text:purge', (_e, ref) => {
  const abs = textstore.resolveRef(textRoot(), ref);
  if (!abs) return { ok: false, error: '非法的正文引用' };
  try { fs.unlinkSync(abs); } catch (e) { if (e.code !== 'ENOENT') return { ok: false, error: e.message }; }
  invalidateIntegrity();
  return { ok: true };
});

/* ---------- 真实执行引擎 ---------- */
ipcMain.handle('reins:providers', () => runner.PROVIDERS);
ipcMain.handle('reins:agent:test', (_e, agent) => runner.testAgent(agent));
ipcMain.handle('reins:triage:run', (_e, payload) => runner.triageTask(payload.task, payload.agent, payload.roster));
ipcMain.handle('reins:pipeline:plan', (_e, payload) => runner.planPipeline(payload.task, payload.agent));
ipcMain.handle('reins:pipeline:gate', (_e, payload) => runner.judgePipelineGate(payload.task, payload.agent, payload));
ipcMain.handle('reins:jev:triage', (_e, payload) => { const s = readSettings(); return runner.triageJev(payload.task, payload.roster, { ...s, ...(payload.cfg || {}) }); });
ipcMain.handle('reins:jev:test', (_e, cfg) => { const s = readSettings(); return runner.testJev({ ...s, ...(cfg || {}) }); });
ipcMain.handle('reins:cli:list', () => runner.CLI_PRESETS);
ipcMain.handle('reins:cli:detect', (_e, cmds) => runner.detectClis(cmds));
ipcMain.handle('reins:cli:models', (_e, agent) => runner.listAgentModels(agent));
ipcMain.handle('reins:runtimes:discover', () => runner.discoverAppRuntimes());

ipcMain.handle('reins:run:start', (e, payload) => {
  const { task, agent, extraPrompt, repoRoot, runtime, modelParams, stage } = payload || {};
  const win = BrowserWindow.fromWebContents(e.sender);
  if (!win) return false;
  /* 会话过程日志（第八轮）：tee 全部执行事件，结束时追加落盘 deliveries/<KEY>/session.log。
     四条执行通路（API/CLI/ACP/云端）同构覆盖；done/error/cancelled 都留痕 */
  const t0 = Date.now();
  const sessLines = [];
  let deliveryDir = path.join(app.getPath('userData'), 'deliveries', String(task.key || task.id).replace(/[^\w.-]+/g, '_'));
  /* 流水线任务：各阶段交付落 stages/sN 子目录（报告/日志互不覆盖）；最终交付阶段落根目录（聚合全流程产出）。
     并行阶段（REINS-128）：stage.no 显式指定子目录编号——并发阶段各自持有编号，
     不再依赖 task.pipeline.stageNo（并发下同字段会互相踩） */
  const stageNo = stage && Number.isFinite(Number(stage.no)) ? Number(stage.no) : (task.pipeline && task.pipeline.stageNo);
  if (task.pipeline && task.pipeline.on && !task.pipeline.final && stageNo) {
    deliveryDir = path.join(deliveryDir, 'stages', 's' + stageNo);
  }
  const tee = evt => {
    if (evt.type === 'start') sessLines.push('▶ 开始执行 · ' + (evt.model || '') + '\n');
    else if (evt.type === 'model') sessLines.push('◆ 执行模型 ' + evt.model + (evt.final ? '（引擎确认）' : '') + '\n');
    else if (evt.type === 'note') sessLines.push(evt.text + '\n');
    else if (evt.type === 'retry') sessLines.push(evt.text + '\n');   // 重试留痕：排障时能看到瞬态错误与重试节奏
    else if (evt.type === 'delta' && evt.text) sessLines.push(evt.text);
  };
  const emit = evt => {
    if (stage && Number.isFinite(Number(stage.no))) evt.stageNo = Number(stage.no);   // 并行阶段事件打标，渲染层分流
    tee(evt);
    if (evt.type === 'done') {
      // done 时构建类型化交付：diff 解析 + report.md/changes.patch 落盘（交付页预览/下载/访达显示）
      try { evt.delivery = runner.buildDelivery(evt, deliveryDir); } catch (err) { }
    }
    // 过程日志落盘：done 挂进交付清单；error/cancelled 也写文件并构造轻量交付（失败任务的排错线索不丢）
    if (evt.type === 'done' || evt.type === 'error' || evt.type === 'cancelled') {
      try {
        const log = runner.appendSessionLog(deliveryDir, { task, agent, evt, lines: sessLines, ms: Date.now() - t0, model: evt.model });
        if (log) {
          const item = { kind: 'log', file: 'session.log', name: '过程日志.log' };
          if (evt.type === 'done') { if (evt.delivery) evt.delivery.items.push(item); }
          else evt.delivery = evt.delivery || { dir: deliveryDir, items: [item], diff: null, files: [] };
        }
      } catch (err) { }
    }
    if (!win.isDestroyed()) win.webContents.send('reins:run:event', { taskId: task.id, ...evt });
  };
  if (runtime === 'cloud') {
    const s = readSettings();
    runner.runCloudTask(task, agent, extraPrompt, emit, { repoRoot, stage, cloud: { url: s.cloudUrl, token: s.cloudToken } });
  } else {
    const s = readSettings();
    runner.runTask(task, agent, extraPrompt, emit, {
      repoRoot, stage,
      params: modelParams || null,               // 任务创建时「高级选项」临时覆盖模型参数
      modelDefaults: s.modelParams,              // 设置页全局默认
      http: { timeoutMs: s.apiTimeoutMs, retries: s.apiRetries },
    });
  }
  return true;
});
ipcMain.handle('reins:run:cancel', (_e, taskId) => runner.cancelTask(taskId));

/* ---------- 云端节点连通测试 ---------- */
ipcMain.handle('reins:cloud:test', async (_e, url, token) => {
  const s = readSettings();
  const u = (url || s.cloudUrl || '').trim().replace(/\/+$/, '');
  const t = token !== undefined ? token : s.cloudToken;
  if (!u || !/^https?:\/\//.test(u)) return { ok: false, error: '地址需以 http:// 或 https:// 开头' };
  try {
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 8000);
    const resp = await fetch(u + '/health', { headers: { 'Authorization': 'Bearer ' + t }, signal: ctrl.signal });
    if (resp.status === 401) return { ok: false, error: '令牌不对（节点返回 401）' };
    if (!resp.ok) return { ok: false, error: 'HTTP ' + resp.status };
    const d = await resp.json();
    return { ok: true, name: d.name, version: d.version, agents: d.agents, repoRoot: d.repoRoot };
  } catch (e) { return { ok: false, error: e.name === 'AbortError' ? '超时（8s）' : e.message }; }
});

/* ---------- 开放集成：Webhook 推送（主进程发送，不受渲染层 CORS 限制） ---------- */
/* 地址指向飞书自定义机器人时，把通用 payload 转成飞书卡片协议再发（机器人对纯 JSON
   只显示一行乱码）；加签密钥取设置里的 feishu.webhookSecret。其它地址原样 POST */
async function postWebhook(url, payload) {
  const feishu = feishuBridgeMod.isFeishuHook(url);
  const body = feishu ? feishuBridgeMod.webhookToFeishu(payload) : payload;
  try {
    if (feishu) {
      const s = readSettings();
      const r = await feishuBridge.sendRawWebhook(url, body, { secret: (s.feishu && s.feishu.webhookSecret) || '' });
      return { ok: true, status: r.status, viaFeishu: true, signed: r.signed, note: r.note };
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10000);
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'Reins-Webhook/1.0' },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    return { ok: resp.ok, status: resp.status };
  } catch (e) {
    return { ok: false, error: (e.name === 'AbortError' ? '超时（10s）' : e.message) };
  }
}
ipcMain.handle('reins:webhook:send', async (_e, payload) => {
  const s = readSettings();
  if (!s.webhookUrl) return { ok: false, error: '未配置 Webhook 地址' };
  return postWebhook(s.webhookUrl, payload);
});
ipcMain.handle('reins:webhook:test', async () => {
  const s = readSettings();
  if (!s.webhookUrl) return { ok: false, error: '未配置 Webhook 地址' };
  return postWebhook(s.webhookUrl, {
    event: 'ping', at: new Date().toISOString(),
    text: 'Reins Webhook 连通性测试：收到即表示链路正常。',
  });
});

/* ---------- 飞书接入：事件推送 + 群指令同步 ---------- */
/* rendererCall：主进程 → 渲染层要数据（任务的创建 / 概览统计都由渲染层持有状态）。
   用一次性事件回包实现「invoke 反向调用」，超时或窗口关闭都返回 null，不阻塞群消息流转 */
let feishuCallSeq = 0;
function rendererCall(channel, payload, timeoutMs) {
  return new Promise(resolve => {
    const win = mainWindow;
    if (!win || win.isDestroyed() || !win.webContents) { resolve(null); return; }
    const id = 'fc' + (++feishuCallSeq);
    const done = r => { clearTimeout(timer); ipcMain.removeAllListeners('reins:feishu:reply'); resolve(r); };
    const timer = setTimeout(() => done(null), timeoutMs || 8000);
    ipcMain.once('reins:feishu:reply', (_e, reply) => { if (reply && reply.id === id) done(reply.data); });
    try { win.webContents.send('reins:feishu:call', { id, channel, payload }); } catch (e) { done(null); }
  });
}

const feishuBridge = feishuBridgeMod.createFeishuBridge({
  log: (...a) => console.log(...a),
  getSettings: () => readSettings(),
  saveSettings: patch => {
    /* 桥内回写（同步水位 / 最近错误）：走同一 read-改-写，失败不抛给调用方 */
    const s = readSettings();
    s.feishu = { ...s.feishu, ...(patch.feishu || {}) };
    try { writeSettings(s); } catch (e) { console.error('[feishu] 设置回写失败:', e.message); }
  },
  /* 群指令执行：任务创建与统计口径都在渲染层（多空间状态），这里只做转发与兜底文案 */
  runCommand: async (cmd, ctx) => {
    const r = await rendererCall('command', { cmd: cmd.cmd, arg: cmd.arg, taskKey: cmd.taskKey || '', reason: cmd.reason || '', raw: cmd.raw, operator: operatorOfMessage(ctx && ctx.message) });
    if (r) return r;
    return { error: 'Reins 控制台未就绪：请先打开客户端窗口再下发指令' };
  },
});
/* 飞书消息发送人：历史消息接口默认不返回显示名，只带 open_id。
   不把裸 open_id 写进卡片（既不好读也泄露标识），统一留空由回执卡片兜底为「群成员」 */
function operatorOfMessage() {
  return '';
}

/* 事件推送（渲染层在任务状态流转后调用）：同一事件 30s 内同任务只发一次，防抖。
   created 不参与去重：同一任务可能被不同入口重复创建提示，宁可多一张也不漏 */
const feishuDedup = new Map();
ipcMain.handle('reins:feishu:notify', async (_e, payload) => {
  const p = payload && typeof payload === 'object' ? payload : {};
  const kind = String(p.kind || '');
  const key = String((p.task && p.task.key) || '') + '|' + kind;
  const t = Date.now();
  if (kind !== 'created' && feishuDedup.get(key) && t - feishuDedup.get(key) < 30000) {
    return { ok: false, skipped: true, error: '重复事件已忽略' };
  }
  if (kind !== 'created') feishuDedup.set(key, t);
  if (feishuDedup.size > 200) feishuDedup.delete(feishuDedup.keys().next().value);
  return feishuBridge.notify(kind, p.task, { space: p.space, url: p.url, reason: p.reason, extra: p.extra });
});
/* 报告推送（站报 / 周报 / 每日摘要）：正文由渲染层生成，这里只负责发 */
ipcMain.handle('reins:feishu:report', async (_e, payload) => {
  const p = payload && typeof payload === 'object' ? payload : {};
  return feishuBridge.pushReport(p.title, p.text, { meta: p.meta, theme: p.theme });
});
/* 连通测试：可用未保存的临时配置（页面先填后测），缺省读已存配置 */
ipcMain.handle('reins:feishu:test', (_e, override) => feishuBridge.test(override || {}));
/* 同步状态（集成页展示 + 手动同步） */
ipcMain.handle('reins:feishu:status', () => feishuBridge.status());
ipcMain.handle('reins:feishu:sync', async () => feishuBridge.pollOnce());
ipcMain.handle('reins:feishu:reset', () => { feishuBridge.resetSeen(); feishuBridge.refresh(); return { ok: true }; });

/* ---------- 自动化调度器（REINS-128）：持久化在 settings.schedules，主进程常驻时间轮 ---------- */
const scheduler = schedulerMod.createScheduler({
  load: () => readSettings().schedules || [],
  save: list => {
    const s = readSettings();
    s.schedules = list;
    try { writeSettings(s); } catch (e) { console.error('[scheduler] 持久化失败:', e.message); }
  },
  /* 触发即通知渲染层生成站报/周报并写看板；manual/missed 标记随发，
     渲染层按 schedule.webhook 决定是否复用 webhook 通道推送（格式与手动触发一致） */
  onFire: (sc, info) => {
    try {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('reins:schedule:fire', { schedule: sc, ...info });
    } catch (e) { }
    /* digest（每日摘要）不需要看板内容生成，主进程直接可取：交给渲染层生成后再推飞书，
       保证摘要口径与站报/周报同源（概览统计、失败清单都在渲染层内存态里） */
  },
});
ipcMain.handle('reins:schedule:list', () => scheduler.list());
ipcMain.handle('reins:schedule:upsert', (_e, sc) => scheduler.upsert(sc));
ipcMain.handle('reins:schedule:remove', (_e, id) => scheduler.remove(id));
ipcMain.handle('reins:schedule:toggle', (_e, id, enabled) => scheduler.toggle(id, enabled));
ipcMain.handle('reins:schedule:run-now', (_e, id) => scheduler.runNow(id));

/* ---------- Git 远程操作（REINS-128）：任务分支推送 + PR 创建 ---------- */
ipcMain.handle('reins:git:remote', (_e, cwd) => gitRemote.remoteInfo(cwd));
ipcMain.handle('reins:git:testpat', (_e, p) => gitRemote.testToken(p && p.provider, p && p.token, { timeoutMs: 15000 }));
ipcMain.handle('reins:git:push', (_e, p) => gitRemote.pushBranch(p && p.cwd, p));
ipcMain.handle('reins:git:pr', async (_e, p) => {
  const s = readSettings();
  const tokens = { ...(s.gitTokens || {}), ...((p && p.tokens) || {}) };
  return gitRemote.createPR({ ...(p || {}), tokens });
});

/* ---------- Token 成本估算：渲染层无法 require 主进程模块，计价口径经 IPC 统一 ----------
   执行完成时渲染层同步算一次（一次 IPC 往返，不影响流式体验）；价格表在设置里可覆盖 */
ipcMain.handle('reins:price:estimate', (_e, payload) => {
  const p = payload && typeof payload === 'object' ? payload : {};
  const s = readSettings();
  return pricing.estimateCost(p.usage, p.model, p.provider, s.modelPrices);
});
ipcMain.handle('reins:price:table', () => ({
  defaults: pricing.DEFAULT_PRICES,
  fallback: pricing.PROVIDER_FALLBACK,
  overrides: readSettings().modelPrices || {},
}));

/* ---------- 流水线依赖编排（REINS-128）：并行波次 / 下游上下文合并 ----------
   渲染层无法 require 主进程模块，编排语义经 IPC 提供——执行器与甘特图共用同一结果 */
ipcMain.handle('reins:pipeline:deps', (_e, payload) => {
  const stages = (payload && payload.stages) || [];
  const normalized = pipelineMod.normalizeDeps(stages);
  const plan = pipelineMod.planWaves(normalized);
  return { ok: true, stages: normalized, waves: plan.waves, order: plan.order, hasCycle: plan.hasCycle };
});
ipcMain.handle('reins:pipeline:ctx', (_e, payload) => {
  const r = pipelineMod.mergeUpstream((payload && payload.stages) || [], payload && payload.stageId);
  return { ok: true, text: r.text, sources: r.sources };
});

/* ---------- 密钥存储状态（REINS-128）：设置页安全警示（safeStorage 不可用/明文密钥盘点） ---------- */
ipcMain.handle('reins:keystatus', () => {
  const info = secureKeys.backendInfo();
  const s = readSettings();
  let counts = { plaintext: 0, sealed: 0, locked: 0 };
  try { counts = secureKeys.countSecrets(store.loadState()); } catch (e) { }
  const gt = s.gitTokens || {};
  const plainTokens = ['github', 'gitee'].filter(p => typeof gt[p] === 'string' && gt[p]);
  return {
    available: info.available,
    backend: info.kind,
    policy: s.keyStorage,
    stateKeys: counts,
    plaintextSettings: ['cloudToken', 'jevKey'].filter(k => typeof s[k] === 'string' && s[k]).concat(plainTokens.map(p => 'gitTokens.' + p)),
    /* 需要弹警示的条件：加密后端不可用 且 用户未明确选择不加密 且 磁盘上确有明文密钥 */
    warning: !info.available && s.keyStorage !== 'plain' && (counts.plaintext > 0 || plainTokens.length > 0 || typeof s.cloudToken === 'string' && s.cloudToken || typeof s.jevKey === 'string' && s.jevKey),
  };
});

/* ---------- 执行期间防止系统休眠（caffeinate，接入电源时合盖也不中断） ---------- */
let caffeinateProc = null;
function setCaffeinate(on) {
  if (on && !caffeinateProc) {
    try { caffeinateProc = require('child_process').spawn('caffeinate', ['-s', '-w', String(process.pid)], { stdio: 'ignore' }); } catch (e) { }
  } else if (!on && caffeinateProc) { try { caffeinateProc.kill(); } catch (e) { } caffeinateProc = null; }
  return !!caffeinateProc;
}
ipcMain.handle('reins:caffeinate:set', (_e, on) => setCaffeinate(on));

/* ---------- 隔离工作区直达 ---------- */
ipcMain.handle('reins:worktree:reveal', (_e, p) => { shell.showItemInFolder(p); return true; });
/* 交付物：确认应用 / 放弃变更（worktree 拟议变更的显式裁决）/ 在访达中显示交付目录 / 读取过程日志 */
ipcMain.handle('reins:delivery:apply', (_e, worktree) => runner.applyDelivery(worktree));
ipcMain.handle('reins:delivery:discard', (_e, worktree) => runner.discardDelivery(worktree));
ipcMain.handle('reins:delivery:reveal', (_e, dir) => { shell.showItemInFolder(dir); return true; });
ipcMain.handle('reins:delivery:read', (_e, dir, file) => {
  try {
    const root = path.resolve(app.getPath('userData'), 'deliveries');
    const d = path.resolve(String(dir || ''));
    if (!d.startsWith(root + path.sep)) return { ok: false, error: '目录不在交付区' };
    const f = path.resolve(d, path.basename(String(file || '')));
    const text = fs.readFileSync(f, 'utf8');
    return { ok: true, text: text.length > 600000 ? '…（过长，只保留末尾）\n' + text.slice(-600000) : text };
  } catch (e) { return { ok: false, error: e.message }; }
});

/* ---------- 窗口 ---------- */
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show(); mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    applySettings(readSettings());
    buildMenu();
    // 应用图标（macOS 开发态 dock/Cmd+Tab 也会显示；打包后由 .icns 接管）
    const iconPath = path.join(__dirname, 'assets', 'icons', 'icon.png');
    if (process.platform === 'darwin' && app.dock) {
      try {
        const img = nativeImage.createFromPath(iconPath);
        if (!img.isEmpty()) app.dock.setIcon(img);
      } catch (e) { }
    }
    createWindow();
    createTray();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
      else if (mainWindow) mainWindow.show();
    });
  });
}

app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => store.flush());   // 退出前把去抖窗口内的最后变更落盘
app.whenReady().then(() => { if (readSettings().preventSleep) setCaffeinate(true); });

/* ---------- 密钥加密迁移（REINS-128）：启动即把磁盘上的明文密钥转为加密存储 ----------
   顺序保证不丢 Key：先在内存生成加密副本 → 回读校验（sealOne 内置）→ 原子写回。
   任何一步失败保留明文并记日志，绝不阻断启动 */
function migrateKeysOnDisk() {
  try {
    const policy = readSettings().keyStorage;
    const rawState = store.loadState();
    if (rawState) {
      const r = secureKeys.sealState(rawState, policy);
      if (r.sealed > 0) { store.saveState(r.state, true); console.log('[keys] 已迁移', r.sealed, '个明文 API Key 为加密存储'); }
    }
    const raw = fs.readFileSync(settingsFile(), 'utf-8');
    const rawSettings = JSON.parse(raw);
    const rs = secureKeys.sealSettings(rawSettings, policy);
    if (rs.sealed > 0) {
      const f = settingsFile(), tmp = f + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(rs.state, null, 2));
      fs.renameSync(tmp, f);
      console.log('[keys] 已迁移设置中的', rs.sealed, '个明文密钥为加密存储');
    }
  } catch (e) { console.error('[keys] 密钥迁移失败（保留明文，不阻断启动）:', e.message); }
}

app.whenReady().then(() => {
  migrateKeysOnDisk();
  /* 飞书群指令同步：配置齐全才启动（缺失时 scheduleInbound 自己空转返回），
     窗口/调度器就绪后再起，避免首轮回执抢在页面加载前 */
  try { feishuBridge.startInbound(); } catch (e) { console.error('[feishu] 同步器启动失败:', e.message); }
  /* 休眠唤醒/解锁：时间轮在休眠期停摆，唤醒立即对账——错过但落在 5 分钟补执行窗口内的照常触发 */
  try {
    powerMonitor.on('resume', () => { scheduler.wake(); feishuBridge.refresh(); });
    powerMonitor.on('unlock-screen', () => { scheduler.wake(); feishuBridge.refresh(); });
  } catch (e) { }
});

/* 调度器首 tick 延迟到渲染层就绪之后：onScheduleFire 监听器随页面加载注册，
   whenReady 时同步 tick 会把触发推给尚无监听器的 webContents（一次性调度会被
   消耗丢失）。页面加载异常时 10s 兜底启动，保证调度不因窗口问题整体停摆 */
let schedulerStarted = false;
function startSchedulerOnce() {
  if (schedulerStarted) return;
  schedulerStarted = true;
  scheduler.start();
}
setTimeout(startSchedulerOnce, 10000).unref();

function createWindow(hidden) {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 1080,
    minHeight: 680,
    backgroundColor: '#f6f4f0',
    title: 'Reins',
    show: false,
    icon: path.join(__dirname, 'assets', 'icons', 'icon.png'),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
      preload: path.join(__dirname, 'preload.js')
    }
  });
  mainWindow.loadFile(path.join(__dirname, 'web', 'app.html'));
  mainWindow.once('ready-to-show', () => { if (!hidden) mainWindow.show(); startSchedulerOnce(); });   // 渲染层就绪：调度器首 tick 放行（见 startSchedulerOnce 注释）

  // 关闭驻留托盘：保持本机节点在线（Agent 可继续接单），除非用户从托盘退出
  mainWindow.on('close', (e) => {
    console.log('[tray-close] hit, keepInTray=', readSettings().keepInTray, 'isQuitting=', app.isQuitting);
    if (readSettings().keepInTray && !app.isQuitting) {
      e.preventDefault();
      console.log('[tray-close] prevented, ack=', readSettings().trayNoticeAck);
      // 首次：页面内弹提示，用户点「好，收起窗口」后再隐藏（先 hide 再弹原生对话框会把窗口重新拉起来）
      if (readSettings().trayNoticeAck) { mainWindow.hide(); return; }
      try { const s = readSettings(); s.trayNoticeAck = true; writeSettings(s); } catch (e) { }   // 标记失败不阻断收起
      mainWindow.webContents.send('reins:tray-notice');
    }
  });
  ipcMain.handle('reins:tray-hide', () => { mainWindow?.hide(); });
  ipcMain.handle('reins:tray-quit', () => { app.isQuitting = true; app.quit(); });
  ipcMain.handle('reins:tray-badge', async (_e, n) => { await setTrayBadge(n); return { cur: trayBadgeCur, cache: [...trayBadgeCache.entries()].map(([k, im]) => ({ k, empty: im.isEmpty() })) }; });

  // 页面内的外部链接交给系统浏览器打开
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http')) shell.openExternal(url);
    return { action: 'deny' };
  });
}


/* ---------- 托盘 ---------- */
/* —— 托盘未读角标（企微式：青图形 + 右侧红圆白字徽章）：主窗口 canvas 绘制 2x 位图，按数字缓存 —— */
let trayBadgeCur = -1;
const trayBadgeCache = new Map();
async function renderTrayBadge(n) {
  // 画布在主窗口（app.html 隐藏 img/canvas）；首调可能图片未就绪，稍候重试一次
  for (let i = 0; i < 2; i++) {
    const r = await mainWindow?.webContents
      .executeJavaScript(`trayBadgeDataUrl(${n})`, true)
      .catch(() => null);
    if (r && r.url) {
      const bitmap = nativeImage.createFromDataURL(r.url);
      // 位图按 2x 生成，标记缩放因子保证逻辑尺寸正确、Retina 不糊；模板图随菜单栏明暗渲染（深色=纯白）
      const img = nativeImage.createFromBuffer(bitmap.toPNG(), { scaleFactor: 2, width: r.w / 2, height: r.h / 2 });
      if (!img.isEmpty()) { img.setTemplateImage(true); return img; }
    }
    await new Promise(r2 => setTimeout(r2, 500));
  }
  return null;
}
async function setTrayBadge(n) {
  n = Math.max(0, Math.min(99, n | 0));
  if (!tray || n === trayBadgeCur) return;
  const prev = trayBadgeCur;
  trayBadgeCur = n;
  let img = trayBadgeCache.get(n);
  if (!img || img.isEmpty()) {
    img = await renderTrayBadge(n);
    if (img) trayBadgeCache.set(n, img);
  }
  // 渲染失败时保留当前图标，别把好图标换成空图
  if (tray && img && !img.isEmpty()) tray.setImage(img);
  else trayBadgeCur = prev;
}

function createTray() {
  // 单色 template 图标（系统按菜单栏明暗自适应着色）；16pt 槽位 + 2x 表示，图形撑满槽位
  const tray16 = nativeImage.createFromPath(path.join(__dirname, 'assets', 'tray-16.png'));
  const tray32 = nativeImage.createFromPath(path.join(__dirname, 'assets', 'tray-32.png'));
  if (!tray16.isEmpty()) {
    if (!tray32.isEmpty()) tray16.addRepresentation({ scaleFactor: 2, width: 32, height: 32, buffer: tray32.toPNG() });
    tray16.setTemplateImage(true);
    tray = new Tray(tray16);
  } else {
    tray = new Tray(nativeImage.createEmpty());
  }
  tray.setToolTip('Reins — 本机节点在线');
  const rebuild = () => {
    const s = readSettings();
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: '显示控制台', click: () => { mainWindow?.show(); mainWindow?.focus(); } },
      { label: '新建任务', click: () => { mainWindow?.show(); send('openNewTaskModal()'); } },
      { type: 'separator' },
      { label: '● 本机节点在线', enabled: false },
      { label: s.keepInTray ? '关闭窗口时驻留：开' : '关闭窗口时驻留：关', enabled: false },
      { type: 'separator' },
      { label: '退出 Reins', click: () => { app.isQuitting = true; app.quit(); } }
    ]));
  };
  rebuild();
  tray.on('click', () => mainWindow?.isVisible() ? mainWindow.hide() : (mainWindow?.show(), mainWindow?.focus()));
}

/* ---------- 菜单 ---------- */
function send(js) {
  const w = BrowserWindow.getFocusedWindow() || mainWindow;
  if (w) w.webContents.executeJavaScript(js).catch(() => { });
}
function loadPage(file) {
  const w = BrowserWindow.getFocusedWindow() || mainWindow;
  if (w) w.loadFile(path.join(__dirname, 'web', file));
}

function buildMenu() {
  const tpl = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: '文件',
      submenu: [
        { label: '新建任务', accelerator: 'CmdOrCtrl+N', click: () => send('openNewTaskModal()') },
        { type: 'separator' },
        isMac ? { role: 'close', label: '关闭窗口' } : { role: 'quit', label: '退出' }
      ]
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' }
      ]
    },
    {
      label: '视图',
      submenu: [
        { label: '重新载入控制台', accelerator: 'CmdOrCtrl+R', click: () => loadPage('app.html') },
        { role: 'toggleDevTools', label: '开发者工具' },
        { type: 'separator' },
        { role: 'resetZoom', label: '实际大小' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '全屏' }
      ]
    },
    {
      label: '帮助',
      submenu: [
        {
          label: '关于 Reins', click: () => dialog.showMessageBox({
            type: 'info',
            title: '关于 Reins',
            message: 'Reins v' + app.getVersion(),
            detail: '一站式 Agent 统一指挥管理平台（演示原型）\n\n把任务交给 Agent，把缰绳留给自己。\n数据保存在本机，完全离线可用。'
          })
        },
        {
          label: '检查更新…', click: async () => {
            const cur = app.getVersion();
            let res;
            try { res = await updateMod.checkLatest({ currentVersion: cur }); }
            catch (e) { res = { ok: false, message: (e && e.message) || String(e) }; }
            if (res.ok && res.newer) {
              const r = await dialog.showMessageBox({
                type: 'info', title: '发现新版本',
                message: '最新版本 ' + res.latest + '（当前 v' + cur + '）',
                detail: '从 GitHub Releases 获取安装包，或拉取最新源码。',
                buttons: ['前往下载', '稍后再说'], defaultId: 0, cancelId: 1
              });
              if (r.response === 0) shell.openExternal(res.htmlUrl);
            } else if (res.ok && res.latest) {
              dialog.showMessageBox({ type: 'info', title: '已是最新', message: '当前 v' + cur + ' 已是最新版本。' });
            } else {
              dialog.showMessageBox({
                type: 'warning', title: '检查更新失败',
                message: '查询 GitHub Releases 失败：' + (res.message || '未知原因'),
                detail: '网络受限环境可手动访问 https://github.com/' + updateMod.UPDATE_REPO + '/releases',
                buttons: ['好']
              });
            }
          }
        },
        { label: '产品官网落地页', click: () => loadPage('index.html') },
        { label: '返回控制台', click: () => loadPage('app.html') }
      ]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(tpl));
}
