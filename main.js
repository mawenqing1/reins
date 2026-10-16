/* Reins 驭码 — Electron 主进程 */
const { app, BrowserWindow, Menu, shell, dialog, Tray, nativeImage, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const store = require('./services/store');
const runner = require('./services/runner');

const isMac = process.platform === 'darwin';
let mainWindow = null;
let tray = null;

/* ---------- 客户端设置（userData/settings.json） ---------- */
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
const defaultSettings = { launchAtLogin: false, keepInTray: true, webhookUrl: '', webhookEvents: { create: true, done: true, reject: true }, cloudUrl: '', cloudToken: '' , preventSleep: false, jevUrl: 'https://api.typesafe.ai/v1/systemone', jevKey: '', jevModel: 'jev-latest', triageEngine: 'auto' };
function readSettings() {
  try { return { ...defaultSettings, ...JSON.parse(fs.readFileSync(settingsFile(), 'utf-8')) }; }
  catch (e) { return { ...defaultSettings }; }
}
function writeSettings(s) { try { fs.writeFileSync(settingsFile(), JSON.stringify(s, null, 2)); } catch (e) { } }
function applySettings(s) {
  // 关闭态不调用系统 API：未签名/未打包环境下注册登录项会被 macOS 拒绝并打印报错
  if (!s.launchAtLogin) return;
  try { app.setLoginItemSettings({ openAtLogin: true, args: ['--hidden'] }); } catch (e) { }
}

ipcMain.handle('reins:settings:get', () => ({ ...readSettings(), platform: process.platform, version: app.getVersion() }));
ipcMain.handle('reins:settings:set', (_e, patch) => {
  const s = { ...readSettings(), ...patch };
  writeSettings(s); applySettings(s);
  return s;
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
    text: 'Reins 驭码 Webhook 连通性测试：收到即表示链路正常。',
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
    title: 'Reins 驭码',
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
    if (readSettings().keepInTray && !app.isQuitting) {
      e.preventDefault();
      mainWindow.hide();
      if (!trayShownOnce) {
        trayShownOnce = true;
        dialog.showMessageBox(mainWindow, {
          type: 'info',
          title: 'Reins 仍在运行',
          message: 'Reins 已驻留菜单栏',
          detail: '本机节点保持在线，Agent 可继续接收并执行任务。\n如需完全退出，请使用托盘菜单中的「退出」。'
        }).catch(() => { });
      }
    }
  });

  // 页面内的外部链接交给系统浏览器打开
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http')) shell.openExternal(url);
    return { action: 'deny' };
  });
}
let trayShownOnce = false;

/* ---------- 托盘 ---------- */
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
  tray.setToolTip('Reins 驭码 — 本机节点在线');
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
            message: 'Reins 驭码 v' + app.getVersion(),
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
