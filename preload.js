/* Reins — preload：向渲染进程暴露最小客户端能力 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('reins', {
  /* 客户端设置：{ launchAtLogin, keepInTray, platform, version } */
  getSettings: () => ipcRenderer.invoke('reins:settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('reins:settings:set', patch),

  /* 任务数据持久化（主进程写盘；浏览器模式下渲染层自行降级 localStorage） */
  stateLoad: () => ipcRenderer.invoke('reins:state:load'),
  stateSave: (data, immediate) => ipcRenderer.invoke('reins:state:save', data, immediate),

  /* 真实执行引擎 */
  providers: () => ipcRenderer.invoke('reins:providers'),
  agentTest: (agent) => ipcRenderer.invoke('reins:agent:test', agent),
  triageRun: (payload) => ipcRenderer.invoke('reins:triage:run', payload),
  cliList: () => ipcRenderer.invoke('reins:cli:list'),
  cliDetect: (cmds) => ipcRenderer.invoke('reins:cli:detect', cmds),
  runtimeDiscover: () => ipcRenderer.invoke('reins:runtimes:discover'),
  runStart: ({ task, agent, extraPrompt, repoRoot, runtime }) => ipcRenderer.invoke('reins:run:start', { task, agent, extraPrompt, repoRoot, runtime }),
  runCancel: (taskId) => ipcRenderer.invoke('reins:run:cancel', taskId),

  /* 漫剧生成工作流（REINS-126）：项目工厂/体检 + 引擎执行 + 渲染引擎配置（契约见 docs/REINS-126-backend.md） */
  comicMeta: () => ipcRenderer.invoke('reins:comic:meta'),
  comicCreate: (input) => ipcRenderer.invoke('reins:comic:create', input),
  comicNormalize: (raw) => ipcRenderer.invoke('reins:comic:normalize', raw),
  comicAdopt: (comic) => ipcRenderer.invoke('reins:comic:adopt', comic),
  comicRenderGet: () => ipcRenderer.invoke('reins:comic:render:get'),
  comicRenderSet: (patch) => ipcRenderer.invoke('reins:comic:render:set', patch),
  comicRenderTest: (cfg) => ipcRenderer.invoke('reins:comic:render:test', cfg),
  comicStart: (payload) => ipcRenderer.invoke('reins:comic:start', payload),
  comicCancel: (comicId) => ipcRenderer.invoke('reins:comic:cancel', comicId),
  comicSnapshot: (comicId) => ipcRenderer.invoke('reins:comic:snapshot', comicId),
  comicPackage: (comic, episodeId) => ipcRenderer.invoke('reins:comic:package', comic, episodeId),
  /* 事件通道：主进程按窗口批量推送 {type:'batch', events:[...]}（终态立即冲刷），渲染层一次应用整批 */
  onComicEvent: (cb) => ipcRenderer.on('reins:comic:event', (_e, evt) => cb(evt)),

  /* 云端节点 */
  cloudTest: (url, token) => ipcRenderer.invoke('reins:cloud:test', url, token),

  /* 执行期间防止系统休眠 */
  caffeinateSet: (on) => ipcRenderer.invoke('reins:caffeinate:set', on),
  onRunEvent: (cb) => ipcRenderer.on('reins:run:event', (_e, evt) => cb(evt)),

  /* 开放集成：Webhook 推送与连通测试（主进程发送，不受 CORS 限制） */
  webhookSend: (payload) => ipcRenderer.invoke('reins:webhook:send', payload),
  webhookTest: () => ipcRenderer.invoke('reins:webhook:test'),

  /* Jev 决策模型：结构化分诊判断与连通测试 */
  jevTriage: (payload) => ipcRenderer.invoke('reins:jev:triage', payload),
  jevTest: (cfg) => ipcRenderer.invoke('reins:jev:test', cfg),

  /* 隔离工作区：在访达中定位 */
  revealWorktree: (p) => ipcRenderer.invoke('reins:worktree:reveal', p),

  /* 关窗驻留提示：主进程通知渲染层弹窗，确认后隐藏/退出 */
  onTrayNotice: (cb) => ipcRenderer.on('reins:tray-notice', () => cb()),
  trayHide: () => ipcRenderer.invoke('reins:tray-hide'),
  trayQuit: () => ipcRenderer.invoke('reins:tray-quit'),
  /* 托盘未读角标 */
  traySetBadge: (n) => ipcRenderer.invoke('reins:tray-badge', n),
});
