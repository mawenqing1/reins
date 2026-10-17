# REINS-126 · 漫剧生成工作流 — 后端接口契约

> 面向：前端 / 测试 / 后续维护。实现：`services/comic.js`（引擎）+ `services/comic-manager.js`（服务层）+ `main.js`/`preload.js`（IPC）。
> 本文随 2026-10-17 返工更新：事件批量推送、合成包重建、渲染引擎配置持久化加固。
> 2026-10-17 二次返工（测试打回三项）：①settings.json 交叉写入冲突加固；②快速连续事件 DOM 稳定层；③渲染引擎未配时预检错误逐字段细化。

## 一、IPC 通道（`reins:comic:*`）

| 通道 | 入参 | 出参 | 说明 |
|------|------|------|------|
| `reins:comic:meta` | — | `{ stages, stageIds, renderProviders }` | 阶段定义与服务商预置 |
| `reins:comic:create` | `{ title, theme?, style?, aspect?, shotsPer?, episodesPer?, writerAgentId? }` | `{ ok, comic }` / `{ ok:false, code:'TITLE' }` | 工厂：归一化 + 生成 N 集空壳；title 必填 |
| `reins:comic:normalize` | `rawComic` | 归一化后的 comic | 坏档体检回退骨架不丢数据 |
| `reins:comic:adopt` | `comic` | comic | 重启遗留 `running` 且主进程无任务 → 收养 `paused` |
| `reins:comic:render:get` | — | `{ provider, baseURL, apiKey, imageModel, videoModel, voiceModel }` | 读 `settings.renderEngine`（含预置回退） |
| `reins:comic:render:set` | 同上局部字段 | `{ ok, engine }` / `{ ok:false, error }` | 写入后**回读校验**；写盘失败返回可读错误（不再静默丢配置） |
| `reins:comic:render:test` | 同上（缺省用已存配置） | `{ ok, message }` | 零成本探测：401/403=Key 无效，4xx=鉴权通过 |
| `reins:comic:start` | `{ comic, scope?, writer?, writerAgent? }` | `{ ok }` / `{ ok:false, error }` | 引擎装配预检失败同步返回错误；成功后事件经 `reins:comic:event` 回传 |
| `reins:comic:cancel` | `comicId` | `boolean` | 终止运行中任务（产物保留，状态 `paused`） |
| `reins:comic:snapshot` | `comicId` | `{ running, comic }` / `null` | 运行中任务主进程副本（页面重载对账用） |
| `reins:comic:package` | `(comic, episodeId)` | `{ ok, package }` / `{ ok:false, error }` | **导出前重建合成包**：按渲染层最新镜头数据重算 SRT/ffmpeg.sh/分镜表 |

`scope`：`{ stage?, episodeId?, shotId?, force? }` — 指定则只跑对应范围；`force` 强制重跑（覆盖已有产物）。

## 二、事件协议（主进程 → 渲染层 `reins:comic:event`）

主进程把引擎事件按窗口（默认 120ms）打包成**单条**批量帧推送（REINS-126 返工：此前逐事件推送，频率过高导致 UI 卡顿）：

```jsonc
{ "type": "batch", "events": [ /* 引擎事件，批内顺序 = 产生顺序 */ ] }
```

- 单事件字段不变：`{ comicId, seq, at, type, ... }`，`type ∈ comic|episode|shot|stage|delta|note|error|done|cancelled`。
- 相邻同阶段 `delta` 在批内合并文本（token 不逐条透传）。
- 终态事件（`done`/`cancelled`/`error`）**立即冲刷**，不等窗口。
- `seq` 全程严格递增；渲染层按 `seq` 丢弃乱序/过期事件。
- 渲染层每批只做一次落盘（250ms 节流，终态立即）与一次 UI 收尾；状态翻转才重渲侧栏。

**渲染层 DOM 稳定层（二次返工②）**——快速连续事件（批背靠背到达）下的约定：

- 数据应用仍在批内即时完成（`seq` / 落盘语义不变）；**DOM 收尾合并进单一 rAF**：同帧多批 → 脏集合去重一次写入。
- 头部 / 阶段轨 / 集头 / 镜头 media 节点携带 `data-sig` 签名（`cmHeadSig` / `cmStagebarSig` / `cmEpHeadSig` / `cmShotMediaSig`），内容未变零 DOM 写入。
- 镜头卡拆 media / txt 两段：产物地址与忙碌态没变绝不重建 `<img>`（消除封面反复重载闪烁）；剧集镜头网格按 **ID 序列**（`cmEpShotSig`）而非数量判定重建（同数量换 ID 的重跑不再停留在旧网格）。
- 库视图按卡定向刷新（`cmSyncCard`：胶囊 / 进度条 / 文案就地更新，封面 src 变化才换节点），不再每批整页重渲。
- 一批事件的日志行一次插入（`cmLogAppendMany`），同 key 流式增量仍并进最后一行。

## 三、settings.renderEngine（渲染引擎配置）

- 独立于 LLM Agent 配置；存 `userData/settings.json` 的 `renderEngine` 键。
- 写入走原子写（tmp+rename，与 `reins-data.json` 同策略），写后回读校验（归一化比较，与磁盘键序无关）。
- 服务商：`zhipu`（CogView/CogVideoX 预置）/ `custom`（兼容端点）；切换服务商自动带入新预置再应用显式字段。
- 每次任务启动读一次快照：**配置变更只影响新任务，进行中任务不受影响**。

### 三·1 settings.json 交叉写入防护（二次返工①）

settings.json 有多个写方（设置页 `reins:settings:set` / 漫剧 `reins:comic:render:set` / 托盘首次提示），防冲突约定：

| 机制 | 说明 |
|------|------|
| 保留字段 | `reins:settings:set` 的 patch 中 `renderEngine` / `platform` / `version` 一律剔除——`renderEngine` 的唯一写通道是 `reins:comic:render:set`（带服务商切换语义 + 回读校验），杜绝渲染层把 settings:get 快照整包回传造成的交叉覆盖 |
| 坏档记忆 | `readSettings` 解析失败时回退内存中最近一次好档（`settingsLastGood`）而非纯默认值，防止一次瞬时读失败后的写盘把全部自定义配置抹平 |
| 写失败可见 | `writeSettings` 写失败向上抛错：`settings:set` 返回 `{ok:false,error}` 透给界面；`comic:render:set` 靠回读校验兜底 |

**`reins:settings:set` 返回值变更（二次返工）**：由「直接返回 settings 对象」改为 `{ ok:true, settings }` / `{ ok:false, error }`；渲染层 `cloudSave`/`setClient` 已适配并兼容旧形状。

### 三·2 渲染引擎预检错误细化（二次返工③）

启动预检（manager `resolveEngines` → 引擎 `precheck` 两级同口径）按缺口逐字段给可行动错误，均含「渲染引擎」关键字与设置入口：

| 缺口 | 错误要点（示例关键词） |
|------|----------------------|
| baseURL + apiKey 均缺 | `渲染引擎未配置：首帧 / 视频（及配音）渲染需要…请到「设置 → 渲染引擎」填写服务地址（Base URL，如 https://open.bigmodel.cn/api/paas/v4）与 API Key` |
| 仅缺 baseURL | `渲染引擎缺少服务地址（Base URL）…` |
| 仅缺 apiKey | `渲染引擎缺少 API Key…` |
| 缺 imageModel / videoModel | `渲染引擎缺少图像模型名（imageModel）…` / `视频模型名（videoModel）…`（按目标阶段点名；智谱预置自动带默认值，仅自定义端点会遇到） |
| voice 阶段缺 voiceModel | `渲染引擎缺少配音模型（voiceModel）…留空则启动时自动跳过该阶段` |

指定 `scope.stage` 时错误文案带上阶段名（如「视频」阶段）；未指定（全流程）需要图像+视频模型，配音可选不强制。

## 四、合成包（`episode.package`）

`buildPackage(ep, aspect)` 本地零依赖生成：

- `srt`：按镜头时长切分的 SRT 字幕；
- `ffmpegSh`：下载/转码/混配音/concat 拼接/烧字幕脚本；零视频镜头不进 concat 清单，全空时不产 concat 段；
- `shotlistMd`：分镜表（表格含首帧/视频/配音三列 ✓ 标记，单元格转义竖线）+ 镜头明细（完整 URL、提示词、失败原因）；
- `missing`：缺视频镜头计数。

**保鲜机制（返工）**：单镜头/单阶段重跑后引擎就地重建已有合成包；渲染层导出前再经 `reins:comic:package` 按最新数据重建一次（兜住历史过期档）。

## 五、测试

- `node tools/test-comic.js` — 引擎：工厂/全流程/失败隔离/终止/预检（含逐字段细化）+ 合成包构造与重跑刷新（49 项）
- `node tools/test-comic-manager.js` — 服务层：配置/连通/装配（含缺口细查）/批量推送/持久化跨重启与增量叠加/合成包重建（58 项）
- `node tools/test-comic-ui.js` — 渲染层：视图/模态/批量帧应用/看板联动 + DOM 稳定层签名与背靠背批（52 项）
