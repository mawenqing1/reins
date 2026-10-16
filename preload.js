/* Reins 驭码 — preload：向渲染进程暴露最小客户端能力 */
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
  runStart: ({ task, agent, extraPrompt, repoRoot, runtime }) => ipcRenderer.invoke('reins:run:start', { task, agent, extraPrompt, repoRoot, runtime }),
  runCancel: (taskId) => ipcRenderer.invoke('reins:run:cancel', taskId),

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
});
