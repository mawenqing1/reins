# Reins 驭码

**AI Agent 任务协作平台** —— 你的 AI 同事，已经到岗。

像给同事派活一样给 AI Agent 派任务：写代码、做调研、整资料、写文案、处理工单——把活儿说清楚，派出去，进度、过程、结果都在你眼前，验收你说了算。

**这是能真跑的版本**：Agent 可配置为「真实 API」模式（OpenAI 兼容协议，支持智谱 GLM / DeepSeek / Kimi / 通义 / OpenAI / 自定义），流式执行、真实 token 计量、打回带反馈重跑；也内置零配置的「演示引擎」（本地模拟）。

## 快速开始

```bash
cd xfw/reins
npm install        # 首次（已装好可跳过）
npm start          # 编译 LESS → 启动桌面客户端
```

**开启真实执行**：控制台 → 设置 → 模型与密钥 → 「GLM · 去配置」→ 填入你的 API Key → 测试连接 → 保存。之后把任何任务指派给该 Agent，即是真实调用（流式输出、真实 tokens）。

- 样式源码全部为 **LESS**（`src/*.less`），`npm start` 会先编译再启动；改样式用 `npm run watch:css` 监听增量编译
- 官网落地页：`web/index.html`（浏览器直接打开，或客户端菜单「帮助 → 产品官网落地页」）
- 控制台：客户端窗口本体；浏览器打开 `web/app.html` 为降级模式（localStorage + 仅演示引擎）
- 网络受限环境重装依赖时：`ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ npm install`

## 说明

应用以**空白工作区**起步，不带任何演示数据：首次打开只有「我的团队 → 我的空间」和一个空看板，到 Agent 页接入真实服务后即可开始派活。内置的三个例程（站会报告 / AI 分诊 / 周报生成）为真实计算功能，基于你的实际任务数据生成。

## 功能一览

| 模块 | 说明 |
|---|---|
| **组织层** | 组织 → 空间 → 成员三层结构；Agent 与密钥随组织隔离（公司 / 个人互不可见）；组织切换、设置、新建、删除（带守卫）；v1/v2 存档自动迁移 v3 |
| 团队空间 | 多空间（创建/切换/重命名/删除），数据按组织与空间双层隔离；成员角色（管理员/成员/访客）、邀请链接；空间可配置代码仓库根目录 |
| 迭代与史诗 | 空间内管理迭代（Sprint）与史诗/版本，任务可归属，看板按迭代筛选 |
| 看板 | 四列流转，拖拽即流转；拖给 Agent 即自动执行；**泳道视图**（按经办人分组，看每人/每 Agent 的负载分布）；任务可删除（确认弹窗防误触，执行中的任务先终止 Agent 再删，动态留痕） |
| Agent 生态 | **双引擎**：真实 API（GLM/DeepSeek/Kimi/通义/OpenAI/硅基流动/自定义）+ **本机 CLI 子进程调用**（Claude Code、Codex、CodeBuddy、WorkBuddy、**ZCode**（桌面版内置 CLI 桥接，无头 `-p` 执行）、OpenCode、Gemini CLI、Cursor CLI、Qwen Code、Copilot CLI、Droid、Amp、OpenClaw、Hermes、Pi），本机安装自动检测、命令模板可自定义；另有零配置演示引擎 |
| **Worktree 隔离执行** | 空间配置仓库根目录后，CLI 型 Agent 每个任务在 `.reins-wt/<任务号>` 独立工作区 + `reins/<任务号>` 分支执行，多 Agent 并行互不干扰，node_modules 自动链接；抽屉内直达工作区目录 |
| 场景化 Agent | 每个 Agent 可配置「场景/角色附加提示」（如测试专家、调研助手），执行时随任务发送 |
| 验收闭环 | 流式输出、可终止、真实 token 计量；打回重做带多轮反馈 |
| **交付物中心** | 全部产出物统一浏览：预览 / 复制 / 下载 .md，按时间倒序，含待验收标记 |
| **Webhook 开放集成** | 任务创建 / 完成归档 / 验收打回事件实时 JSON POST 到自配地址（飞书机器人、企微、Slack、n8n 均可接收），主进程发送、带连通测试 |
| **收件箱** | 跨空间聚合的任务事件收件箱：类型筛选（交付/执行/打回/创建分诊）、未读高亮、点击直达对应任务、全部已读 |
| **节点视图** | 本机节点（在线状态、运行时检测、**执行期间防休眠**——caffeinate 守护，接电合盖不中断）+ 云端节点（健康、可用运行时、仓库配置）一页总览 |
| **云端 Runtime** | 零依赖单文件节点服务（`reins-node/server.js`，Node 18+）：Token 鉴权、任务级隔离目录 / git worktree、SSE 流式回传、超时与取消、并发上限。CLI 型 Agent 可选「云端执行」——合盖断线不影响，输出实时流回抽屉；设置 → 云端节点配置地址与令牌、连通测试 |
| **AI 分诊** | 待办任务一键分析：类型 / 优先级 / 建议经办 + 理由。**三级引擎链**：Jev 决策模型（结构化判断，输出各选项概率，百毫秒级）→ API Agent 模型分诊（严格 JSON）→ 本地关键词规则，逐级降级、如实标注来源；集成页配置 Jev（Key / 地址 / 模型 / 引擎策略）并带连通测试；支持任务抽屉单条与自动化批量（逐条理由、单条/全部应用，写入时间线） |
| 通知中心 | 顶栏铃铛：空间动态未读徽标、下拉通知列表 |
| 任务时间线 | 每张卡片记录完整动态（创建/指派/状态流转/执行/交付/打回/归档） |
| 提示词库 | 团队共享，执行时可附加到任务 |
| 自动化 | 站会、**周报**（真实数据聚合，可复制 / 下载 .md）、分诊例程（Jev / 模型 / 本地规则三级引擎） |
| 数据管理 | JSON 导出备份 / 导入恢复（自动体检补齐字段）/ 一键重置 |
| 快捷键 | ⌘K 搜索、⌘0-9 切换视图、⌘N 新建任务、⌘B 折叠侧栏、⌘/ 快捷键帮助 |
| 客户端 | 托盘常驻、关闭驻留、开机自启、侧栏可折叠窄栏（记忆状态） |

## 目录结构

```
xfw/reins/
├── main.js            # Electron 主进程（窗口/托盘/菜单/IPC）
├── reins-node/        # 云端执行节点（零依赖单文件 server.js + 部署文档）
├── preload.js         # contextBridge：设置、状态、执行引擎事件
├── services/
│   ├── store.js       # 状态持久化（userData/reins-data.json，原子写+去抖）
│   └── runner.js      # 真实执行引擎（OpenAI 兼容 /chat/completions SSE 流式、取消、连通测试）
├── package.json       # electron + less 依赖、electron-builder 打包配置
├── assets/            # 图标（icons/icon.icns、tray template 图标等）
├── src/               # 样式源码（LESS，唯一维护入口）
│   ├── _variables.less # 共享设计变量（品牌色/状态色/字体/圆角）
│   ├── _mixins.less    # 共享 mixin（滚动条/省略号）
│   ├── app.less        # 控制台样式
│   └── landing.less    # 官网落地页样式
├── tools/
│   └── build-css.js    # LESS 编译脚本（支持 --watch）
└── web/               # 运行/打包资源（CSS 为编译产物，勿手改）
    ├── index.html     # 产品官网落地页
    ├── app.html       # 控制台骨架
    └── assets/
        ├── app.css / landing.css  # 编译产物
        └── app.js     # 全部逻辑（状态/看板/执行引擎/自动化/集成/设置）
```

## 真实执行的工作方式

1. 任务指派给 API 模式的 Agent 后，主进程直接调用你所选服务商（密钥只存本机 userData，不经任何第三方）
2. 执行过程流式回传：详情抽屉实时显示模型输出，可随时「终止执行」
3. 完成后交付物进入「待验收」：通过归档，或**打回重做**——Agent 会带着此前交付与你的反馈继续修改（多轮对话）
4. token 消耗按 API 返回真实累计；真实 API 模式的任务重启后不自动续跑（避免无感知计费），可手动重新启动

## 打包分发（可选）

```bash
npm run dist    # 需要先安装 electron-builder（Node ≥ 18）
```

已在 `package.json > build` 配置 mac（dmg/zip）、win（nsis/portable）、linux（AppImage/deb）。打包时仅含 `main.js` 与 `web/`，不含 node_modules 源码。

## 设计说明

- **产品形态**：桌面客户端 = 控制台 + 本地执行节点。已落地「本机节点在线」「Agent 接入检测」「独立工作区执行」「托盘常驻」等概念；真实执行走 OpenAI 兼容 API（见上节），如需接入本机 CLI Agent，可在主进程扩展子进程管理与 CDP。
- 任务/提示词/自动化等数据按**团队空间**隔离，空间可创建、切换、重命名、管理成员（管理员/成员/访客）与邀请；Agent 与密钥为本机全局配置，跨空间共享。
- 数据持久化：任务与空间数据存 `userData/reins-data.json`，客户端设置存 `userData/settings.json`；浏览器打开为降级模式（localStorage + 仅演示引擎）。
