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
ipcMain.handle('reins:settings:set', (_e, patch) => {
  /* 读-改-写保留字段剔除（返工修复①）：只接受普通客户端键，写失败如实返回，不假装成功 */
  const p = patch && typeof patch === 'object' ? patch : {};
  const s = readSettings();
  for (const k of Object.keys(p)) {
    if (!SETTINGS_RESERVED.has(k)) s[k] = p[k];
  }
  try { writeSettings(s); } catch (e) { return { ok: false, error: '设置写入失败：' + e.message }; }
  applySettings(s);
  return { ok: true, settings: s };
});

/* ---------- 任务数据（文件持久化） ----------
   落盘钩子加解密（REINS-128）：内存/渲染层恒为明文 apiKey，磁盘上只存
   safeStorage 密文（{__encrypted:true,data}）；后端不可用或用户选 plain 时明文透传 */
ipcMain.handle('reins:state:load', () => {
  const d = store.loadState();
  if (!d) return d;
  try { secureKeys.openState(d); } catch (e) { }
  return d;
});
ipcMain.handle('reins:state:save', (_e, data, immediate) => {
  if (data && typeof data === 'object') {
    try { secureKeys.sealState(data, readSettings().keyStorage); } catch (e) { }
  }
  store.saveState(data, !!immediate);
  return true;
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
async function postWebhook(url, payload) {
  try {
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
  },
});
ipcMain.handle('reins:schedule:list', () => scheduler.list());
ipcMain.handle('reins:schedule:upsert', (_e, sc) => scheduler.upsert(sc));
ipcMain.handle('reins:schedule:remove', (_e, id) => scheduler.remove(id));
ipcMain.handle('reins:schedule:toggle', (_e, id, enabled) => scheduler.toggle(id, enabled));
ipcMain.handle('reins:schedule:run-now', (_e, id) => scheduler.runNow(id));

/* ---------- Git 远程操作（REINS-128）：任务分支推送 + PR 创建 ---------- */
ipcMain.handle('reins:git:remote', (_e, cwd) => gitRemote.remoteInfo(cwd));
ipcMain.handle('reins:git:push', (_e, p) => gitRemote.pushBranch(p && p.cwd, p));
ipcMain.handle('reins:git:pr', async (_e, p) => {
  const s = readSettings();
  const tokens = { ...(s.gitTokens || {}), ...((p && p.tokens) || {}) };
  return gitRemote.createPR({ ...(p || {}), tokens });
});

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
  /* 休眠唤醒/解锁：时间轮在休眠期停摆，唤醒立即对账——错过但落在 5 分钟补执行窗口内的照常触发 */
  try {
    powerMonitor.on('resume', () => scheduler.wake());
    powerMonitor.on('unlock-screen', () => scheduler.wake());
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
        { label: '产品官网落地页', click: () => loadPage('index.html') },
        { label: '返回控制台', click: () => loadPage('app.html') }
      ]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(tpl));
}
