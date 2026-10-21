# 更新日志

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 格式与语义化版本。

## [1.2.0] — 2026-10-21

### 变更

- **全量 TypeScript 化**：44 个源文件（主进程 / preload / services / 云端节点 / 工具 / 渲染层 / 全部测试）改为 `.ts`，tsc 编译到 `dist/`（node 侧）与 `web/assets/`（渲染层产物，不入库）。运行时行为零变动——全量 831 条断言逐一对齐后才提交。此后项目一律 TypeScript，不再新增 `.js` 源文件
- 编译管线：三套 tsconfig（node+test / 渲染层 UMD 共享模块 / 渲染层经典脚本）；`npm install` 经 `prepare` 自动编译，`npm test` = 编译 + 全量回归
- CI 改为「TypeScript 编译门 + 全量测试」（Node 22，跳过 Electron 二进制下载提速）
- electron-builder 输出目录改为 `release/`（与编译产物 `dist/` 区分），打包清单补入 `assets/`（托盘 / Dock 图标此前未进包）与 `dist/`

### 修复

- **「创建空间」按钮自基线起失效**：`createSpace()` 引用了不存在的标识符 `tpl`，点「创建」即 ReferenceError（既有空间均来自演示种子路径）。改为与种子路径同款的 `seedPrompts()/seedAutos()`，并补回归断言

### 已知限制

- 类型收紧分步推进：node 侧 `strictNullChecks` 与渲染层 `app.ts` 的 `strict` 暂关（存量 14k 行的空值流收紧按重构立项），共享模块 execlog / taskflow 与全部新代码的公共签名已带类型
- 渲染层 execlog / taskflow 保留手写 UMD 壳（TS 原生 `export as namespace` 仅限 .d.ts，且 tsc 的 umd 产物无浏览器分支），仅补类型注解

## [1.1.0] — 2026-10-21

### 新增

- **执行流水表**：每次 Agent 执行逐条落账（时间 / 任务 / Agent / 模型 / 耗时 / tokens / 花费 / 是否一次通过），概览页新增「今日花费」与最近执行明细，成本不再只有累计值
- **Agent 首次成功率**：区分「一次通过」与「返工后成功」，质量指标不再虚高
- **云端 SSE 断流自动重连**：云端执行事件流断开后自动续读服务端回放缓冲（按事件序号去重），网络抖动不再丢任务；重连失败才如实报错
- **调度任务空间定向**：站报 / 周报 / 每日摘要可指定归属空间，不再隐式落「当前激活空间」
- **检查更新**：客户端菜单「帮助 → 检查更新」查询 GitHub Releases，有新版时一键直达下载页
- **PAT 有效性测试**：设置页 GitHub/Gitee 令牌配置处新增「测试」按钮，探活并回显账号名
- **归档正文清理**：设置页可清理已归档任务的外置正文（引用降级为摘要、精确留痕），`deliveries/text` 不再只增不减
- **CI**：GitHub Actions（语法门 + 全量测试，零依赖纯 Node）
- **CSP**：控制台与落地页启用 Content-Security-Policy，渲染层拒绝一切远程脚本与回连

### 变更

- 状态迁移规则（通过 / 打回 / 撤回）收敛到共享模块 `services/taskflow.js`，客户端按钮与飞书群指令走同一份判定源

## [1.1.1] — 2026-10-21

### 新增

- **飞书指令就绪排队**：控制台未就绪（页面加载/重载中）时群指令不再被丢弃——主进程排队并回「已排队」卡，渲染层就绪后自动回放执行并回真实结果卡（有限次重试，超限如实回失败卡）
- **近 7 日花费图表**：概览「最近执行」面板顶部新增逐日花费柱状图（悬停看次数/未定价/计价中明细）

### 变更

- 打回的应用层（多轮对话写入 / 状态 / 打回计数 / 流水线重置）收敛进 `TaskFlow.applyReject`，客户端按钮与飞书指令共用同一份落位逻辑

## [1.0.0] — 2026-10-20

首个公开发布版本。

- 组织 / 空间 / 成员三层结构，看板四列流转、泳道视图、拖拽派发
- Agent 双引擎：真实 API（OpenAI 兼容协议，GLM / DeepSeek / Kimi / 通义 / OpenAI / 自定义）+ 本机 CLI 子进程（Claude Code、Codex、ZCode 等十余种，自动检测）；零配置演示引擎
- Worktree 隔离执行（`.reins-wt/<任务号>` 独立分支）、Git 交付闭环（提交 / 推送体检 / PR 创建，GitHub 与 Gitee）
- 流水线（虚拟团队）：项目经理总控、阶段并行、QA 裁决返工循环、断点续跑
- 自动化调度（站报 / 周报 / 每日摘要，cron 5 字段）、错过补执行窗口、唤醒对账
- 飞书双向同步：卡片推送 + 群指令（status / list / new / approve / reject / revoke），密钥钥匙串加密
- 成本与质量指标：token 计量、模型价格表折算（未知模型如实「未定价」）
- 云端 Runtime 节点（`reins-node/server.js` 零依赖单文件，Token 鉴权、SSE 流式回传）
- 大文本外置 + 数据自检（引用盘点 / 缺失检测 / 孤儿回收）
- 密钥安全：safeStorage 加密、明文自动迁移、降级警示
