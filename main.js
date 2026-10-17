/* Reins — Electron 主进程 */
const { app, BrowserWindow, Menu, shell, dialog, Tray, nativeImage, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const store = require('./services/store');
const runner = require('./services/runner');

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
/* REINS-126 返工修复①（配置持久化交叉写入冲突）：
   settings.json 有多个写方（设置页 settings:set / 漫剧 comic:render:set / 托盘首次提示），
   交叉写丢配置的根源有三，逐一堵死：
     a) readSettings 解析失败时返回纯默认值 —— 下一个写方会把默认值整档写回，
        悄悄抹掉 renderEngine / cloudToken 等全部自定义配置（用 lastGood 记忆兜底）；
     b) writeSettings 静默吞错 —— 界面提示「已保存」但磁盘上没有（改为抛错，调用方透传给 UI）；
     c) 渲染层把 settings:get 的返回整包回传（带 platform/version 及过期 renderEngine 快照）
        会挤掉 comic:render:set 的结果（保留字段在 settings:set 一律剔除）。 */
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
const defaultSettings = { launchAtLogin: false, keepInTray: true, webhookUrl: '', webhookEvents: { create: true, done: true, reject: true }, cloudUrl: '', cloudToken: '' , preventSleep: false, jevUrl: 'https://api.typesafe.ai/v1/systemone', jevKey: '', jevModel: 'jev-latest', triageEngine: 'auto' };
let settingsLastGood = null;   // 最近一次成功读到的整档；坏档/瞬时读失败时回退，防止后续写盘把配置抹平
function readSettings() {
  try {
    const s = { ...defaultSettings, ...JSON.parse(fs.readFileSync(settingsFile(), 'utf-8')) };
    settingsLastGood = s;
    return { ...s };
  } catch (e) {
    return settingsLastGood ? { ...settingsLastGood } : { ...defaultSettings };
  }
}
function writeSettings(s) {
  /* 原子写（tmp+rename，与 store.js 同策略）：直接覆写 settings.json 一旦中途失败/掉电，
     会留下半截文件，重启后渲染引擎等配置整体丢失（REINS-126 返工修复）。
     写失败向上抛错：settings:set 把错误透给界面，comic:render:set 靠回读校验兜底 */
  const f = settingsFile(), tmp = f + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2));
  fs.renameSync(tmp, f);
  settingsLastGood = { ...s };
}
/* 保留字段：renderEngine 的唯一写通道是 reins:comic:render:set（带服务商切换语义 + 回读校验）；
   platform/version 是 settings:get 附加的只读信息。settings:set 收到这些键一律剔除，
   杜绝渲染层把读到的快照整包回传造成的交叉覆盖（返工修复①c） */
const SETTINGS_RESERVED = new Set(['renderEngine', 'platform', 'version']);
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

/* ---------- 任务数据（文件持久化） ---------- */
ipcMain.handle('reins:state:load', () => store.loadState());
ipcMain.handle('reins:state:save', (_e, data, immediate) => { store.saveState(data, !!immediate); return true; });

/* ---------- 真实执行引擎 ---------- */
ipcMain.handle('reins:providers', () => runner.PROVIDERS);
ipcMain.handle('reins:agent:test', (_e, agent) => runner.testAgent(agent));
ipcMain.handle('reins:triage:run', (_e, payload) => runner.triageTask(payload.task, payload.agent, payload.roster));
ipcMain.handle('reins:jev:triage', (_e, payload) => { const s = readSettings(); return runner.triageJev(payload.task, payload.roster, { ...s, ...(payload.cfg || {}) }); });
ipcMain.handle('reins:jev:test', (_e, cfg) => { const s = readSettings(); return runner.testJev({ ...s, ...(cfg || {}) }); });
ipcMain.handle('reins:cli:list', () => runner.CLI_PRESETS);
ipcMain.handle('reins:cli:detect', (_e, cmds) => runner.detectClis(cmds));
ipcMain.handle('reins:runtimes:discover', () => runner.discoverAppRuntimes());

ipcMain.handle('reins:run:start', (e, { task, agent, extraPrompt, repoRoot, runtime }) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (!win) return false;
  const emit = evt => { if (!win.isDestroyed()) win.webContents.send('reins:run:event', { taskId: task.id, ...evt }); };
  if (runtime === 'cloud') {
    const s = readSettings();
    runner.runCloudTask(task, agent, extraPrompt, emit, { repoRoot, cloud: { url: s.cloudUrl, token: s.cloudToken } });
  } else {
    runner.runTask(task, agent, extraPrompt, emit, { repoRoot });
  }
  return true;
});
ipcMain.handle('reins:run:cancel', (_e, taskId) => runner.cancelTask(taskId));

/* ---------- 漫剧生成工作流（REINS-126）：引擎接入 + 渲染引擎配置 ----------
   comic 对象由渲染层持有并随 state:save 持久化；这里只负责工厂/体检、
   引擎装配与执行、事件推送（reins:comic:event）。接口契约见 docs/REINS-126-backend.md */
const comicMgr = require('./services/comic-manager').create({
  readSettings, writeSettings,   // 渲染引擎配置落在 settings.json；任务启动时读快照，改配置只影响新任务
});
ipcMain.handle('reins:comic:meta', () => comicMgr.meta());
ipcMain.handle('reins:comic:create', (_e, input) => comicMgr.create(input));
ipcMain.handle('reins:comic:normalize', (_e, raw) => comicMgr.normalize(raw));
ipcMain.handle('reins:comic:adopt', (_e, c) => comicMgr.adopt(c));
ipcMain.handle('reins:comic:render:get', () => comicMgr.getRenderEngine());
ipcMain.handle('reins:comic:render:set', (_e, patch) => comicMgr.setRenderEngine(patch));
ipcMain.handle('reins:comic:render:test', (_e, cfg) => comicMgr.testRenderEngine(cfg));
ipcMain.handle('reins:comic:start', (e, payload) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (!win) return { ok: false, error: '窗口不可用' };
  // 与 reins:run:start 同款守卫：窗口销毁后静默丢弃事件，不阻塞引擎执行
  const emit = evt => { if (!win.isDestroyed()) win.webContents.send('reins:comic:event', evt); };
  return comicMgr.start(payload, emit);
});
ipcMain.handle('reins:comic:cancel', (_e, comicId) => comicMgr.cancel(comicId));
ipcMain.handle('reins:comic:snapshot', (_e, comicId) => comicMgr.snapshot(comicId));
/* 导出前按渲染层最新数据重建合成包：单镜头重跑/打回重生成后不再拿到旧包 */
ipcMain.handle('reins:comic:package', (_e, comicRaw, episodeId) => comicMgr.rebuildPackage(comicRaw, episodeId));

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
  mainWindow.once('ready-to-show', () => { if (!hidden) mainWindow.show(); });

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
