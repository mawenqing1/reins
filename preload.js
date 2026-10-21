/* Reins — preload：向渲染进程暴露最小客户端能力 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('reins', {
  /* 客户端设置：{ launchAtLogin, keepInTray, platform, version } */
  getSettings: () => ipcRenderer.invoke('reins:settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('reins:settings:set', patch),

  /* 任务数据持久化（主进程写盘；浏览器模式下渲染层自行降级 localStorage） */
  stateLoad: () => ipcRenderer.invoke('reins:state:load'),
  stateSave: (data, immediate) => ipcRenderer.invoke('reins:state:save', data, immediate),
  /* 大文本取回（state 里存引用，全文落在 deliveries/text/ 下） */
  textRead: (ref) => ipcRenderer.invoke('reins:text:read', ref),
  textPurge: (ref) => ipcRenderer.invoke('reins:text:purge', ref),
  /* 正文回写（恢复丢失的正文库） */
  textWrite: (ref, text) => ipcRenderer.invoke('reins:text:write', { ref, text }),
  /* 交付文件清理：删除任务时同步清理磁盘；孤儿目录回收 */
  deliveryPurge: (key) => ipcRenderer.invoke('reins:delivery:purge', key),
  deliveryGC: (keepKeys) => ipcRenderer.invoke('reins:delivery:gc', keepKeys),
  /* 数据自检：引用完整性 / 孤儿目录 / 磁盘占用（force=true 强制重扫） */
  integrityCheck: (force) => ipcRenderer.invoke('reins:integrity:check', force),

  /* 真实执行引擎 */
  providers: () => ipcRenderer.invoke('reins:providers'),
  agentTest: (agent) => ipcRenderer.invoke('reins:agent:test', agent),
  triageRun: (payload) => ipcRenderer.invoke('reins:triage:run', payload),
  pipelinePlan: (payload) => ipcRenderer.invoke('reins:pipeline:plan', payload),
  pipelineGate: (payload) => ipcRenderer.invoke('reins:pipeline:gate', payload),
  /* 流水线依赖编排（REINS-128）：波次规划（并行执行/甘特图）与下游上下文合并 */
  pipelineDeps: (payload) => ipcRenderer.invoke('reins:pipeline:deps', payload),
  pipelineCtx: (payload) => ipcRenderer.invoke('reins:pipeline:ctx', payload),
  cliList: () => ipcRenderer.invoke('reins:cli:list'),
  cliDetect: (cmds) => ipcRenderer.invoke('reins:cli:detect', cmds),
  cliModels: (agent) => ipcRenderer.invoke('reins:cli:models', agent),
  runtimeDiscover: () => ipcRenderer.invoke('reins:runtimes:discover'),
  runStart: ({ task, agent, extraPrompt, repoRoot, runtime, modelParams, stage }) => ipcRenderer.invoke('reins:run:start', { task, agent, extraPrompt, repoRoot, runtime, modelParams, stage }),
  runCancel: (taskId) => ipcRenderer.invoke('reins:run:cancel', taskId),

  /* 自动化调度器（REINS-128）：设置页调度管理 + 定时触发通知（渲染层生成站报/周报） */
  scheduleList: () => ipcRenderer.invoke('reins:schedule:list'),
  scheduleUpsert: (sc) => ipcRenderer.invoke('reins:schedule:upsert', sc),
  scheduleRemove: (id) => ipcRenderer.invoke('reins:schedule:remove', id),
  scheduleToggle: (id, enabled) => ipcRenderer.invoke('reins:schedule:toggle', id, enabled),
  scheduleRunNow: (id) => ipcRenderer.invoke('reins:schedule:run-now', id),
  onScheduleFire: (cb) => ipcRenderer.on('reins:schedule:fire', (_e, info) => cb(info)),

  /* Git 远程操作（REINS-128）：远程识别 / 分支推送 / PR 创建 / PAT 探活 */
  gitRemote: (cwd) => ipcRenderer.invoke('reins:git:remote', cwd),
  gitPatTest: (p) => ipcRenderer.invoke('reins:git:testpat', p),
  gitPush: (p) => ipcRenderer.invoke('reins:git:push', p),
  gitCreatePR: (p) => ipcRenderer.invoke('reins:git:pr', p),

  /* 密钥存储状态（REINS-128）：设置页安全警示（safeStorage 不可用降级提示） */
  keyStatus: () => ipcRenderer.invoke('reins:keystatus'),

  /* 云端节点 */
  cloudTest: (url, token) => ipcRenderer.invoke('reins:cloud:test', url, token),

  /* 执行期间防止系统休眠 */
  caffeinateSet: (on) => ipcRenderer.invoke('reins:caffeinate:set', on),
  onRunEvent: (cb) => ipcRenderer.on('reins:run:event', (_e, evt) => cb(evt)),

  /* 开放集成：Webhook 推送与连通测试（主进程发送，不受 CORS 限制） */
  webhookSend: (payload) => ipcRenderer.invoke('reins:webhook:send', payload),
  webhookTest: () => ipcRenderer.invoke('reins:webhook:test'),

  /* 飞书接入：事件卡片推送 / 报告推送 / 连通测试 / 群指令同步状态 */
  feishuNotify: (payload) => ipcRenderer.invoke('reins:feishu:notify', payload),
  feishuReport: (payload) => ipcRenderer.invoke('reins:feishu:report', payload),
  feishuTest: (override) => ipcRenderer.invoke('reins:feishu:test', override),
  feishuStatus: () => ipcRenderer.invoke('reins:feishu:status'),
  feishuSync: () => ipcRenderer.invoke('reins:feishu:sync'),
  feishuReset: () => ipcRenderer.invoke('reins:feishu:reset'),
  /* 主进程 → 渲染层的反向调用（群指令执行需要渲染层的任务状态），按 id 回包 */
  onFeishuCall: (cb) => ipcRenderer.on('reins:feishu:call', (_e, req) => {
    Promise.resolve(cb(req)).then(data => ipcRenderer.send('reins:feishu:reply', { id: req.id, data }))
      .catch(err => ipcRenderer.send('reins:feishu:reply', { id: req.id, data: { error: String((err && err.message) || err) } }));
  }),

  /* Jev 决策模型：结构化分诊判断与连通测试 */
  jevTriage: (payload) => ipcRenderer.invoke('reins:jev:triage', payload),
  jevTest: (cfg) => ipcRenderer.invoke('reins:jev:test', cfg),

  /* Token 成本估算：按 usage × 模型单价折算金额（价格表可在设置里覆盖） */
  priceEstimate: (payload) => ipcRenderer.invoke('reins:price:estimate', payload),
  priceTable: () => ipcRenderer.invoke('reins:price:table'),

  /* 隔离工作区：在访达中定位 */
  revealWorktree: (p) => ipcRenderer.invoke('reins:worktree:reveal', p),
  deliveryApply: (worktree) => ipcRenderer.invoke('reins:delivery:apply', worktree),
  deliveryDiscard: (worktree) => ipcRenderer.invoke('reins:delivery:discard', worktree),
  deliveryReveal: (dir) => ipcRenderer.invoke('reins:delivery:reveal', dir),
  deliveryRead: (dir, file) => ipcRenderer.invoke('reins:delivery:read', dir, file),

  /* 关窗驻留提示：主进程通知渲染层弹窗，确认后隐藏/退出 */
  onTrayNotice: (cb) => ipcRenderer.on('reins:tray-notice', () => cb()),
  trayHide: () => ipcRenderer.invoke('reins:tray-hide'),
  trayQuit: () => ipcRenderer.invoke('reins:tray-quit'),
  /* 托盘未读角标 */
  traySetBadge: (n) => ipcRenderer.invoke('reins:tray-badge', n),
});
