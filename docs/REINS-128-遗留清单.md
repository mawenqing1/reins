# REINS-128 · Reins 迭代 — 交付遗留清单

> 阶段：后端开发（2/6 · 二轮返工）＋ 前端开发（3/6 · 返工）　日期：2026-10-19
> 范围：执行引擎可靠性 / 自动化调度器 / API Key 安全存储 / 流水线并行阶段 / Git 远程操作
> 自动化回归：`node test/run.js` → **10 个文件通过，268 断言全绿**（基线 190 → 223 → 268）

---

## 〇、前端返工修复项（测试终审归属前端的 R-5/R-6/R-8，本轮全部处置）

### 1. R-5 · 流水线失败阶段独立状态

**问题**：阶段失败后 `state` 重置 `pending`，与「从未启动」不可区分，甘特图无失败可视化。
**修复**（`web/assets/app.js`）：新增 `'failed'` 状态——error 事件路径与「两轮求助文本」暂停路径置 `failed`；断点续跑（startPipeline 暂停恢复分支）把 `failed` 归位 `pending` 原地重试；`pipeDepsDone` 只认 `done`，失败阶段照旧阻塞下游。阶段清单与甘特图渲染 ✕ 图标、`failed` 配色类与「失败（可从断点重试）」标注；配色复用 `.bug` 既有红色系（`src/app.less`，已重构建 app.css）。
**测试**：`test/pipeline-ui.test.js`（接线源码断言）+ `test/pipeline-sim.test.js` 场景 2（error 事件 → failed → 暂停 → 渲染 → 续跑重新派发，全链路真身驱动）。

### 2. R-6 · 打回精确清空（兄弟分支产出不再被误删）

**问题**：rework 从首个目标阶段下标向后整段清空 `result`——并行流水线中已完成非目标阶段的产出被不必要丢弃。
**修复**（`web/assets/app.js`）：提取 `pipeReworkIds(stages, targets)` 纯函数——重跑集合 = 目标角色阶段（含同角色多实例）+ 传递依赖它们的所有下游；只清空集合内阶段（目标带返工标记，下游按普通重跑）。串行链（链式依赖）下与原整段清空行为完全一致（向后兼容）；QA/交付总结依赖全部阶段，自动连锁重跑。
**测试**：`test/pipeline-ui.test.js` §1–4（并行图兄弟保留 / 串行链兼容 / 同角色多实例）+ `test/pipeline-sim.test.js` 场景 1（打回 be 后 ui 产出保留、fe/qa 连锁重跑、二轮通过全链交付）。

### 3. R-8 · 演示引擎（sim / 浏览器模式）并行阶段并行执行

**问题**：`simDispatched` 守卫每次 pipeStep 只派发一个阶段——甘特图显示并行、实际串行，原因是演示引擎 run 实例共用裸键 `taskId` 会互相覆盖。
**修复**（`web/assets/app.js`）：演示引擎阶段实例与真实引擎同构——独立键 `taskId#阶段id`、携带 `stageId/stageNo`（完成事件按 stageNo 分流回编排器）；`pipeStep` 移除单发守卫，无依赖阶段全部派发；`cancelRun` 对演示引擎实例（渲染层定时器，主进程不持有）本地清停并按取消语义收尾（并行阶段归位 pending、流水线暂停）；`init()` 恢复路径支持多并行阶段实例逐个续跑（刷新页面不再让兄弟阶段卡在运行态）。
**测试**：`test/pipeline-sim.test.js` 场景 1/3（同波次双实例同时在途 + 独立终端盒、并行在途取消→暂停→续跑恢复并行）。

> 浏览器实测说明：会话环境浏览器桥接不可用（`bridge unsupported`），运行时验证改用 vm 沙箱装载真实 app.js、受控定时器手动驱动节拍的集成测试（`test/pipeline-sim.test.js`，10 文件 268 断言全绿）；桌面端 UI 链路仍建议真机走查一遍（见 A.1/A.5）。

## 〇′、UI 设计阶段打磨项（5/6，视觉走查后随本阶段落地）

| # | 修正 | 位置 | 性质 |
|---|---|---|---|
| U-1 | `.f-row` 表单样式纳入 `input[type=number]`——本轮 8 个参数输入（超时/重试/三参数 × 设置页与新建任务）此前为浏览器默认外观（系统蓝焦点环、高度不一） | `src/app.less` | 视觉缺陷 |
| U-2 | 重试行 `.ln.retry` 色值 `#d29a3f→#9a6413`（@warn-ink）：原值对终端底对比度 ~2.5:1 不达 AA | `src/app.less` | 可访问性 |
| U-3 | 琥珀警示族 / 失败族收敛为 LESS 令牌（@warn-bg/line/ink、@fail-bg/ink/line），替换此前 4 组「近似但不同」的硬编码 | `src/app.less` | 令牌收敛 |
| U-4 | 暂停调度行视觉退隐（`.off` opacity .55）+「已暂停」标签 + 副行改「暂停中（不触发）」（不再显示过时的下次执行时间）；类型标签由 `mode-pill`（执行引擎语义）改为中性 `sr-tag` | `web/assets/app.js` + less | 状态可见性 |
| U-5 | 甘特运行中/返工胶囊补 `pw-breathe` 呼吸光环（与 pdot.running、状态点 pulse 同动效语言）；`adv-opts` summary 补 hover 反馈 | `src/app.less` | 一致性 |

**验证**：`npm run build:css` 产物含全部新选择器；`node --check web/assets/app.js` 通过；`node test/run.js` 10 文件 / 268 断言全绿（无回归）。完整视觉与布局规范见 `docs/REINS-128-UI设计规范.md`。

---

## 一、二轮返工修复项（测试终审 4/6 打回后，按测试报告逐项处置）

### 1. F-1 · callJev 接入共享重试层 — Jev 出站调用与 API Agent 同等待遇

**问题**：`callJev` 直接 `pfetch` + 硬编码 15s 超时，不经过 `fetchWithRetry`——429/5xx/超时无重试、无 Retry-After 解析。
**修复**（`services/runner.js`）：改走 `fetchWithRetry`（保留 15s 短超时；`retries=2` 平衡交互等待与瞬态容错），`triageJev`/`testJev` 增加 opts 透传（fetchImpl/timeoutMs/retries 可注入，离线可测）。重试耗尽错误自带状态码与重试次数。
**测试**：`test/runner-net.test.js` §1–3（503→重试成功共 2 次请求 / 恒 503 耗尽报错含状态码与次数 / testJev 探活）。

### 2. F-2 · runCloudTask 派发与事件流接入重试层 + 流断流看门狗

**问题**：派发 POST 与 SSE GET 均为裸 `fetch`——无重试、无超时；事件流断网时 reader 无限挂起；取消只发 cancel 请求、不断开本地等待。
**修复**（`services/runner.js`）：
- 派发 POST / SSE GET 均走 `fetchWithRetry`（30s 建连超时、重试 2 次、Retry-After 生效）；
- **派发重试安全性**：云端节点对同一 runId 幂等拒绝（400「runId 已存在」，见 `reins-node/server.js` startRun），重试撞上已存在按「已派发」续接事件流，不会双跑任务；
- **流断流看门狗**：SSE 建连后超过 `stallMs`（默认 10 分钟，CLI 长静默属正常故放宽；`http.stallMs` 可覆盖）无任何字节 → 中止本地等待并如实报「任务可能仍在节点上执行」；
- **取消通道统一**：派发阶段即可取消（aborts 先行登记）；取消 = 断开本地事件流（挂起连接立即退出）+ POST cancel 通知节点；
- `http.fetchImpl` 可注入（离线测试），取消回调对纯 Node 无 fetch 环境做防护。
**测试**：`test/runner-net.test.js` §4–8（派发 503 重试后全链路 done / 派发耗尽报错 / runId 已存在幂等续接 / 断流看门狗超时 / 用户取消同时断流+通知节点）。

### 3. 深层根因修复 · http.js 终止响应保留 outer→attempt 取消传播

**问题**（在 F-2 修复过程中发现的存量缺陷，同样影响 API 路径）：`fetchWithRetry` 在 fetch 落定（拿到响应头）后即解除「外部取消信号 → 本次尝试信号」的监听，而**响应体绑定的是每次尝试的内部 signal**——`runTask` 的流内断流看门狗 abort 外部信号后，在途流实际不会被掐断（此前测试只覆盖建连期挂起，未覆盖流中静默，故 190 断言全绿下仍潜伏）。
**修复**（`services/http.js`）：终止响应（2xx/不可重试 4xx）交还调用方时**保留**传播监听（`once` 且随外部信号生命周期自清，不随调用累积）；作废尝试（重试/耗尽）才解除。`runTask` 与 `runCloudTask` 的流内看门狗自此才真正具备掐断能力。
**测试**：`test/http-retry.test.js` §11–12（终止响应恰保留一个监听器、abort 外部信号掐断在途流 / 重试与耗尽路径零残留监听器）。

### 4. F-3 · Gitee 重复开 PR 的回退查找补 access_token

**问题**：Gitee 返回 400 "already exists" 后，查找已有 PR 的请求未携带 `access_token`——私有仓库该请求 401，去重逻辑失败，用户只看到「PR 已存在但无法获取链接」。
**修复**（`services/git-remote.js`）：查找 URL 追加 `&access_token=<同一令牌>`（Gitee v5 查询参数鉴权），GitHub 仍走 Authorization 头。
**测试**：`test/git-remote.test.js`（Gitee 重复开 PR 找回链接 + 断言查找请求携带 access_token）。

### 5. R-7 / R-9 · Git 远程识别与推送报错（低风险顺手修复）

- **R-7 detached HEAD**：`remoteInfo` 识别游离头指针（`branch` 置空 + `detached: true` 标记）；按 `'HEAD'` 推送返回可操作指引（先 `git switch -c` 建分支）而非裸 git 报错。
- **R-9 裸 `ssh://` 解析**：`ssh://gitee.com/foo/bar`（无 `user@` 前缀）此前匹配失败，现与 https 同构解析。

### 6. R-1 / R-2 / R-4 · 注释对齐与调度时序（低风险顺手修复）

- **R-1**：`http.js` 退避表注释与默认行为对齐（默认重试 3 次用 1s→2s→4s 前 3 档；表尾 8s 仅在 retries 调大时生效）。
- **R-2**：调度器首 tick 从 `app.whenReady` 延后到渲染器 `ready-to-show` 之后（`onScheduleFire` 监听器随页面加载注册，过早 tick 会把触发推入虚空——一次性调度会被消耗丢失）；页面加载异常时 10s 兜底启动，调度不因窗口问题停摆。`powerMonitor` 唤醒对账不受影响。
- **R-4**：编辑暂停中的调度不再「先 upsert(enabled=true) 再补 toggle」——两次 IPC 之间命中 30s tick 会误触发。渲染层单次 upsert 直接带原启用态（`web/assets/app.js` schedSave）；主进程 `scheduler.upsert` 对 `enabled` 缺省继承原值兜底（`services/scheduler.js`）。
**测试**：`test/scheduler.test.js`（编辑继承原启用态：暂停保持暂停）。

---

## 二、一轮返工修复项（保留记录）

### 1. gitTokens（GitHub/Gitee PAT）纳入 safeStorage 加密体系 — 安全缺口修复

**问题**：任务卡 5 新增的 `settings.gitTokens`（PR 创建用的托管平台 PAT）是密钥，但任务卡 3 的加密层只覆盖 `cloudToken/jevKey/agent.apiKey`——PAT 会以明文落盘 `settings.json`，违背本轮"密钥不明文存储"主线。

**修复**：
- `services/secure-keys.js`：`sealSettings/openSettings` 对 `gitTokens` 按成员（github/gitee）逐个加解密；空成员不动；解锁失败的成员密文原样保留（PR 调用按"令牌无效"报错并提示重配，不静默清空）。启动迁移 `migrateKeysOnDisk` 复用同一路径，存量明文 PAT 重启自动加密。
- `main.js` `reins:keystatus`：明文盘点与降级警示条件纳入 PAT（`gitTokens.github` 等）。
- `test/secure-keys.test.js`：+8 断言（PAT 加密往返 / 空成员 / 明文策略 / 锁定保留 / 保存带回）。

### 2. 锁定密文 Key（`__keyLocked`）在渲染层的处理 — 数据损坏隐患修复

**问题**：safeStorage 解锁失败（换机器/钥匙串重置）时 `agent.apiKey` 保留为密文对象 `{__encrypted:true,...}`，旧代码把它当真值：
- `agentUsable`/分诊/裁决引擎选型判定"已配置密钥"，实际会把 `[object Object]` 当 Bearer 发出去；
- Agent 配置表单回显 `value="[object Object]"`，用户一保存就**把密文副本覆盖成垃圾字符串**（密钥彻底丢失）。

**修复**（`web/assets/app.js`）：
- 新增 `keyOf(a)` 助手：密文对象一律视同"未配置"，8 处判定点统一替换（agentUsable / 启动前置检查 / pipelineJudgeAgent / triageAgent / 配置页盘点等）；
- 配置表单：锁定态不回显对象值，改为显式警示文案（"该密钥已加密但本机解锁失败：留空保存可保留密文，重新填写则覆盖"）；**空值保存不抹掉密文副本**，与主进程"不做静默清空"策略对齐；
- Agent 列表/设置页对锁定态显示"密钥已加密但本机解锁失败（重配一次即恢复）"。

### 3. 设置档密钥表单的密文对象防护补全 — 数据损坏隐患修复（前端返工）

**问题**：上轮 `keyOf` 修复只覆盖 `agent.apiKey` 与 GitHub 令牌的回显，设置档其余密钥（`cloudToken` / `jevKey` / `gitTokens.gitee`）在 safeStorage 解锁失败时同样是密文对象，渲染层仍当字符串用：
- Gitee 令牌 / 云端访问令牌 / Jev Key 三处输入框回显 `value="[object Object]"`，用户一保存就**把密文副本覆盖成垃圾字符串**；
- `gitTokensSave` 整键替换下，留空的 GitHub 输入框会把锁定密文静默抹成空串（改一边毁一边）；
- 集成页 Jev 徽标对密文对象显示"已配置"；自动分诊的 Jev 链路真值判定会把密文对象当 Bearer 发出。

**修复**（`web/assets/app.js`）：
- 新增 `secretOf / secretLocked / secretPick` 三助手（与 `keyOf` 同语义）：密文对象视同未配置；密钥输入框收集统一"留空且现值为密文 → 原样带回，重填或明文清空才覆盖"；
- 四处表单（GitHub/Gitee PAT、云端令牌、Jev Key）回显走 `secretOf`，锁定态显示与 Agent 表单一致的警示文案；三处保存函数（`gitTokensSave` 按成员 / `cloudSave` / `jevSave`）走 `secretPick`；Jev 徽标与自动分诊真值判定走 `secretOf`。
- `test/secure-forms.test.js`：**+23 断言**——从渲染层源码提取助手真身验证语义（含 gitTokensSave 整键替换下"改一边不抹另一边"），并源码断言表单接线防回退。

---

## 三、验收标准覆盖对照（均已有实现 + 自动化/走查证据）

| 任务卡 | 验收点 | 实现 | 证据 |
|---|---|---|---|
| 1 可靠性 | 429/5xx/超时自动重试 + UI 提示 | `services/http.js` + `runner.js` onRetry→`retry` 事件 | http-retry 35 断言 / runner-params 20 断言 |
| | 重试耗尽报错含状态码与次数 | `HttpRetryError`（status/attempts 入消息） | http-retry / runner-net（Jev 与云端同规格） |
| | 120s 无响应超时可配置 | `apiTimeoutMs` 设置 + 每次尝试独立 AbortController | http-retry.test.js |
| | 全局默认/任务级覆盖模型参数 | 五层优先级 `resolveModelParams` | runner-params.test.js |
| | CLI/ACP/Cloud 路径不受影响（Cloud 更享重试） | 三路径改传 opts 对象；云端二轮接入重试层+看门狗 | runner-net.test.js §4–8 |
| 2 调度器 | CRUD/暂停/立即运行 | `reins:schedule:*` IPC + 设置页区块 | scheduler 42 断言 |
| | 站报定时生成入看板 / 周报生成+下载 | `handleScheduleFire` 写 Done 卡 + `downloadReportMd` | 走查（渲染层） |
| | 重启恢复 / 唤醒 5 分钟补执行 | `startSchedulerOnce`（渲染层就绪后启动）+ `powerMonitor`→`wake()` | scheduler.test.js 补执行窗口 |
| | Webhook 可选、格式一致 | `sc.webhook` → 复用 `reins:webhook:send` | 走查 |
| 3 密钥安全 | 新 Key 加密存储 / 旧明文自动迁移 | save 钩子 seal + 启动 `migrateKeysOnDisk` | secure-keys 35 断言 |
| | 磁盘无明文（含 PAT，一轮补） | sealState/sealSettings 双档覆盖 | secure-keys.test.js §5/7/8 |
| | 降级警示 + 用户确认明文 | `reins:keystatus`.warning + `confirmSecPlain` | secure-keys.test.js §4 |
| | 加解密失败不阻断启动 | 回读校验/try-catch 全包 | secure-keys.test.js §3/6 |
| 4 并行阶段 | 无依赖并行 / 失败不阻塞兄弟但阻塞下游 | `planWaves` + 渲染层 `pipeStep` 依赖就绪派发（演示引擎同构并行，前端返工 R-8） | pipeline-waves 14 断言 / pipeline-sim 场景 1、3 |
| | 甘特图展示并行关系 / 失败可视化 | `pp-gantt` 同波左右并列 + `failed` 红标（R-5） | pipeline-sim 场景 1、2（真身渲染断言） |
| | QA 门统一评审 / 上下文合并 | QA 依赖全部阶段；`mergeUpstream` 按完成时间拼接 | pipeline-waves.test.js |
| | 串行完全向后兼容 | 无 `dependsOn` 声明 → 单波次链式 | pipeline-waves.test.js |
| 5 Git 远程 | 推送 + 错误分类指引（含 detached HEAD） | `pushBranch/classifyPushError` | git-remote 34 断言 |
| | PR 创建（GitHub/Gitee）+ 重复找回（带鉴权） | `buildPRRequest/createPR` 422/400 找回（Gitee 查找带 access_token） | git-remote.test.js |

---

## 四、遗留清单（不阻塞验收，按处理建议分类）

### A. 需真机人工验证（自动化只覆盖主进程逻辑，UI 链路需桌面端实测）

1. **重试提示的界面呈现**（TC-1.1 UI 部分）：`retry` 事件 → 流式输出区黄色"↻ …s 后自动重试（第 N/3 次）"行，需配一个可注入 429 的 mock 服务实测。
2. **休眠唤醒补执行**：`powerMonitor` resume/unlock-screen 事件与 5 分钟补执行窗口的联动，需真机合盖/唤醒实测（时间轮逻辑已有单测）。
3. **Linux 无 libsecret 降级链路**：警示弹出 → 用户确认明文 → 恢复自动加密，需 Linux 真机验证（macOS/Windows 用假后端覆盖了逻辑分支）。
4. **PR 创建全链路**：需真实 GitHub/Gitee 仓库 + PAT 实测（请求构造、错误分类与重复找回含令牌已有离线单测）。
5. **调度器渲染层就绪后启动**：`ready-to-show` → 首 tick 的实际时序与 10s 兜底路径，需桌面端冷启动/托盘启动实测。

### B. 设计决策（有意不做，附理由）

1. **重试提示不显示"已消耗 token 数"**（PRD 风险缓解建议）：可重试失败（429/5xx/超时）均发生在响应体消费之前，服务端错误响应不含 `usage` 字段，无从取数；已改为在会话日志（session.log）留痕每次重试的原因与节奏，成功后的 usage 照常累计展示。
2. **流内断流（已开始输出后超时）不自动重试**：重放会把已上屏输出重复一遍；仅中止并如实报"已收到 N 字符"（云端路径报"任务可能仍在节点上执行"），由用户决定重跑。
3. **cron 仅支持 5 字段标准表达式**：PRD 明确"5 字段"，不支持秒级/`@daily` 别名；非法表达式在保存时被校验拒绝并提示。
4. **错过补执行窗口（>5 分钟）只跳过不补**：`lastSkip` 留痕 + 控制台告警，避免一觉醒来补跑十份报告（PRD 风险项的取舍）。
5. **云端派发重试依赖节点幂等拒绝**（`runId 已存在` → 400）：按"已派发"续接而非报错；若第三方自建节点不实现该语义，重试窗口内可能双派发（官方 reins-node 节点已实现）。

### C. 已知边界（低频场景的行为说明；R-5/R-6/R-8 已在前端返工处置，见第〇节）

1. **调度生成的报告写入"当前激活空间"**（测试报告 R-3）：多空间场景未提供空间定向配置，报告落在触发时刻用户所在空间（`S()`）。建议后续迭代给调度任务加"空间定向"字段。
2. **并行阶段共用同一 Agent 时**：API 型可并发（无锁）；token/完成数记账记到最后派发阶段的 Agent 头上（`t.assignee` 被后派发者覆盖），仅统计展示粒度问题，不影响执行与交付。
3. **锁定密文 Key 的 Agent 与设置档密钥**：执行/分诊/裁决选型会跳过锁定 Agent，Jev 自动分诊跳过锁定 `jevKey`（两轮修复后均视同未配置）；表单留空保存保留密文副本，需重配一次恢复；不做自动清空。
4. **`reins:pipeline:ctx` IPC 为预留接口**：渲染层当前在本地做上下文合并（同语义），该通道暴露 `mergeUpstream` 供后续甘特图/外挂编排复用，暂无调用方。
5. ~~流水线失败阶段无独立状态（R-5）~~ / ~~Rework 清除非目标阶段产出（R-6）~~ / ~~Sim 并行串行执行（R-8）~~：**前端返工已修复**（第〇节）。

### D. 后续迭代建议（超出本轮 PRD 范围）

1. 设置页 `gitTokens` 表单可加"测试 PAT 有效性"按钮（调 GitHub `/user` 探活）。
2. 调度任务支持"空间定向"与自定义 Webhook 目标（当前复用全局 webhookUrl）。
3. 并行阶段输出冲突检测：当前各阶段独立 worktree 天然隔离，合并回宿主时的冲突提示可再细化。
4. 云端 SSE 断流后可尝试自动重连（服务端有全量事件回放缓冲，天然支持续读）；本轮按"如实报错+用户决定"收敛。

---

## 五、改动文件索引（两轮返工累计）

| 文件 | 改动 |
|---|---|
| `services/http.js` | 共享 HTTP 客户端（一轮新建）；**二轮**：终止响应保留 outer→attempt 取消传播（流内看门狗真正生效），退避表注释对齐 |
| `services/runner.js` | 模型参数/重试事件/stage 键（一轮）；**二轮**：callJev 接入重试层（F-1）、runCloudTask 重试层+断流看门狗+取消通道统一（F-2） |
| `services/git-remote.js` | Git 推送/PR（一轮新建）；**二轮**：Gitee 重复 PR 查找带 access_token（F-3）、detached HEAD 识别与指引（R-7）、裸 ssh:// 解析（R-9） |
| `services/scheduler.js` | 时间轮调度器（一轮新建）；**二轮**：upsert 对 enabled 缺省继承原值（R-4 兜底） |
| `services/secure-keys.js` | safeStorage 加密层（一轮新建）；gitTokens 按成员加解密（一轮返工） |
| `main.js` | 密钥迁移/keystatus/IPC（一轮）；**二轮**：调度器首 tick 延后到渲染层就绪 + 10s 兜底（R-2） |
| `preload.js` | schedule/git IPC 桥（一轮） |
| `web/assets/app.js` | 设置页调度区块/看板联动（一轮）；密文 Key 防护（一轮返工）；**二轮**：schedSave 编辑保留原启用态、消除二次 IPC 窗口（R-4）；**前端返工**：失败阶段独立状态 failed + 断点续跑重试（R-5）、pipeReworkIds 打回精确清空（R-6）、演示引擎阶段实例独立键并行化 + 取消/恢复配套（R-8） |
| `src/app.less` → `web/assets/app.css` | **前端返工**：`.pp-stage.failed` / `.pw-stage.failed` 失败配色（复用 .bug 红色系令牌），已重构建 |
| `test/pipeline-ui.test.js` | **新建（前端返工）** +23 断言：pipeReworkIds 行为（兄弟保留/串行兼容/多实例）+ R-5/R-6/R-8 接线源码断言 + 构建产物样式断言 |
| `test/pipeline-sim.test.js` | **新建（前端返工）** +22 断言：vm 沙箱装载真实 app.js 手动驱动 sim 节拍——并行派发双实例、独立终端盒、打回兄弟保留、failed 全链路、并行取消/续跑 |
| `services/pipeline.js` | 依赖波次编排（一轮新建） |
| `test/runner-net.test.js` | **新建（二轮）** +20 断言：Jev 重试/耗尽/探活、云端派发重试/幂等续接/断流看门狗/取消 |
| `test/http-retry.test.js` | 一轮 28 断言；**二轮 +7**：终止响应取消传播保留/重试不累积监听器 |
| `test/git-remote.test.js` | 一轮 29 断言；**二轮 +5**：Gitee 查找带令牌、detached HEAD、裸 ssh:// |
| `test/scheduler.test.js` | 一轮 41 断言；**二轮 +1**：编辑继承原启用态 |
| `test/runner-params.test.js` / `test/pipeline-waves.test.js` / `test/secure-keys.test.js` / `test/secure-forms.test.js` | 一轮/一轮返工产出，本轮无改动 |
| `docs/REINS-128-遗留清单.md` | 本文档 |
