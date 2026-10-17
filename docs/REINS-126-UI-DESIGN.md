# REINS-126 · 漫剧生成工作流 — UI 设计方案（v3 · 设计终审版）

> 阶段：UI 设计（3/6）｜日期：2026-10-17
> 输入：PRD（回复正文）+ 后端契约 `docs/REINS-126-backend.md`（返工后版本）+ 控制台设计系统 `src/app.less`。
> v3 性质：在 v2（返工对齐版）基础上完成**实现走查终审**——对照已落地代码逐项核验令牌/组件/类名引用，修正两处规格（封面高度封顶、可访问性表述），其余全部确认与实现一致。文末附 v1→v2、v2→v3 修订记录。

---

## 0. 方案要点（先读这页）

1. **一个导航入口 + 两层界面**：侧栏「工作台」分组新增 **漫剧** 视图（项目库）；点击卡片进入 **漫剧详情**（隐藏路由 `comic-detail`，不进侧栏）。**不用抽屉**——镜头网格与阶段轨需要横向空间；复用 `#content` 单区切换，不新增壳层。
2. **流水线可视化是详情页骨架**：七阶段（设定→剧本→分镜→首帧→视频→配音→合成）渲染为常驻 **阶段轨（stage rail）**，节点本身即「从此阶段重跑」入口（对应 `comicStart` 的 `scope.stage/episodeId/shotId/force`）；完成度口径与引擎 `_predicates` 等价（产物在场即完成）。
3. **零新增色相、零新增字体**：状态只走五个语义槽 `--todo/--doing/--done/--red/--review`；操作色只用 `--accent` 系；字号沿用 13px 基准 / 12px 辅助 / 11px 微标签 / mono 11.5px 代码。
4. **通用新组件只有两个**：进度条 `.prog`（项目内首个进度条）与通用迷你菜单 `.cm-menu`；其余全部复用既有组件（`btn/btn-p/btn-o/btn-sm/btn-danger`、`panel`、`f-row/f-2col`、`modal`、`result-box`、`set-banner/set-h/set-row`、`ds()` 下拉、`toast`、`view-head`）。
5. **漫剧专属样式统一 `cm-` 前缀**，全部写在 LESS 源 `src/app.less`（「漫剧工作流」段，约 1174–1508 行），经 `npm run build:css` 编译，**不手改 `web/assets/app.css`**。
6. **流式过程 = 控制台日志面板**：LLM 阶段 `delta` 与镜头级 `note` 汇入右栏 mono 日志区（终端同款 `--term-*` 用色），运行时展示「AI 正在写什么」；**消费侧按批量帧渲染**（见 §10）。
7. **状态胶囊新做 `cm-pill`**（s-draft/s-running/s-paused/s-failed/s-done 五语义槽，配色与任务状态胶囊同族），running 态内嵌复用的 `.pulse` 呼吸点。
8. **图标**：`web/assets/icons.js` 本地 Lucide 子集新增 5 个节点 `clapperboard/book-open/image/film/mic`；`ICON_CHAR` 表补 `🎬→clapperboard` 映射；其余复用 `chevron-right/more-horizontal/refresh-cw/play/power/trash-2/list/check/triangle-alert/x`。

---

## 1. 设计令牌基线（控制台范围，`src/app.less`）

| 令牌 | 值 | 用途 |
|---|---|---|
| `--bg/--paper` | `#f6f7f8` | 界面底、详情吸附头背景 |
| `--panel/--card` | `#ffffff` | 卡片/面板/菜单底 |
| `--line / --line-strong` | `#e5e7ea / #ced2d8` | 描边；hover 升级用 strong |
| `--ink / --ink-dim / --ink-faint` | `#1f2226 / #61666d / #989ea6` | 三级文字 |
| `--accent / --accent-soft` | `#0e7a70 / #e8f1ef` | 操作色与浅底（墨青，仅按钮/选中态） |
| `--todo` `--doing` `--done` `--red` `--review` | `#8a8f94` `#c47f17` `#36855a` `#d05656` `#4659b8` | 五语义状态槽（胶囊用同族的深浅字底对，见 §10.1） |
| 圆角 `@r-md/@r-sm/@r-xs` | `10px / 7px / 6px`（控制台覆盖值） | 卡片/输入与小按钮/迷你件；模态固定 `12px` |
| 阴影 | hover `0 2px 8px rgba(24,24,30,.09)`；菜单 `0 8px 24px rgba(20,22,26,.14)`；模态 `0 12px 40px rgba(20,20,26,.14)` | 三档既有字面值 |
| 字体 | `@sans` 系统栈 / `@mono` ui-monospace | 正文 / 日志·序号·步进值·提示词 |
| 终端面板 | `@term-bg #f7f8f9` · `@term-line #e0e3e7` · `@term-ink #575e66` | 运行日志、合成包代码预览 |

字号阶梯：`20px/700`（view-head h2）→ `15px/700`（详情标题）→ `13px`（基准/卡片标题/正文）→ `12~12.5px`（辅助）→ `11px`（微标签/胶囊/阶段标签）→ `9~10px`（上标/角色 pill）。

---

## 2. 信息架构与导航

- `VIEWS` 数组插入：`{ id:'comics', ic:'clapperboard', label:'漫剧', sub:'从设定到成片的漫剧生产线', group:'work' }`；位置在 `deliveries` 之后、`nodes` 之前（产出型工作流与交付相邻）。
- `renderNav()` 分组：`sec('工作台', ['dash','kanban','list','deliveries','comics','nodes'])`；数字快捷键随 VIEWS 顺序自动生效。
- **角标**：`v.id==='comics'` 时 `cnt = 状态为 running 的漫剧数`（数据源 `S().comics`）——用户切走后仍能感知后台渲染。
- **数据挂载**：漫剧数据放 `S().comics`（归一化结构原样持有），随既有 `save()` IPC 落盘；启动时 `hydrateComics()` 对账（§10.3）。
- 详情页为隐藏视图 `comic-detail`（`curComicId` 路由），不进侧栏。

---

## 3. 视图一：漫剧库 `viewComics()`

```
┌ content ──────────────────────────────────────────────┐
│ view-head: 漫剧 | 共 N 部 · M 部生成中   [＋ 新建漫剧] │
│ ┌ cm-grid（auto-fill, minmax(232px,1fr), gap 14px）─┐ │
│ │  cm-card × N                                      │ │
│ └───────────────────────────────────────────────────┘ │
└────────────────────────────────────────────────────────┘
```

- **空态**：`panel` + `padding:40px` 居中 + `--ink-dim` 文案「还没有漫剧项目。新建一部，Reins 将从世界观设定一路生成到可下载的成片合成包。」+ 主按钮「新建漫剧」。

### 项目卡 `cm-card`

```
┌────────────────┐
│  cm-cover      │ ← 首帧图（第 1 集镜头 1 的 coverUrl/imageUrl）
│  比例随画幅     │   无图：--accent-soft 底 + clapperboard 图标（26px，--accent）
│  max-h 320px   │   9:16 封顶居中裁切；16:9 / 1:1 永不触及上限（v3）
 [状态胶囊]     │ ← cm-pill 左上角悬浮
│           [⋯]  │ ← cm-more 右上角，hover 浮现
│ ▓▓▓░░ 62%      │ ← .prog 底部悬浮（仅 running/failed）
├────────────────┤
│ 未命名漫剧      │ ← 13px/600 单行省略
│ 6 集 · 约 8 镜/集│ ← 12px --ink-dim
│ 9:16 · 3 分钟前 │ ← 画幅 + fmtRel(updatedAt)
└────────────────┘
```

| 属性 | 规格 |
|---|---|
| 卡片 | `--card` 底 + `--line` 描边 + `@r-md` 10px 圆角；hover `--line-strong` 边 + `0 2px 8px rgba(24,24,30,.09)`；整卡可点进详情 |
| 封面 | `aspect-ratio` 随项目画幅（9:16/16:9/1:1 内联样式）+ **`max-height:320px` 封顶**（宽窗口下 9:16 列不再产出 530px+ 超高海报墙，`object-fit:cover` 居中裁切保持构图），底色 `--line`；图 `loading=lazy`，`onerror` 隐藏回落占位 |
| 胶囊 | `cm-pill` 绝对定位 `top:8 left:8`，`0 1px 3px rgba(20,22,26,.18)` 投影；failed 且有 note 时 `title` 显示原因 |
| 进度条 | `.prog`（高 3px）贴封面底部，running 用 `.doing`、failed 用 `.fail`（100%）；轨道加深色背衬 `rgba(0,0,0,.25)` 提对比；`role=progressbar aria-valuenow` |
| ⋯ 菜单 | `cm-more` 26px 方钮，默认透明、hover/聚焦显现（白 .88 底 + 投影）；菜单项：打开 / 重命名 / 复制项目 / 删除漫剧（danger 红，走确认模态；running 先 cancel） |

---

## 4. 视图二：新建漫剧（模态 `cm-wide` 560px）

复用 `openModal` 骨架 + `f-row/f-2col` 表单行；头部副题即流水线自述「设定 → 剧本 → 分镜 → 首帧 → 视频 → 配音 → 合成」。

| 字段 | 控件 | 规格 / 校验 |
|---|---|---|
| 标题 | `input[type=text]` | 必填，`maxlength=60`；空则 `--red` 边框 + focus（同 `createTask` 交互） |
| 题材/故事方向 | `textarea`（min-height 56px） | placeholder「例：都市逆袭、末世求生、甜宠日常……越具体，设定越准」 |
| 画风偏好 | `input`（maxlength 120） | placeholder「例：电影感厚涂、高饱和国漫、黑白漫画」 |
| 画幅 | 分段选择器 `.cm-seg` | 三项：竖屏 9:16 / 横屏 16:9 / 方形 1:1，默认 9:16；文字前 10px 比例小方框（1.5px currentColor 描边、2px 圆角；9:16 为 8×14、16:9 为 14×8、1:1 为 10×10） |
| 集数（1–24） | 步进器 `.cm-step` | 默认 6；`−`/`＋` 26px 方钮（`@r-xs`），当前值 mono 14px/600 宽 2ch 居中，触界钳制 |
| 每集镜头数（4–16） | 步进器 | 默认 8，同上 |
| 编剧引擎 | `ds()` 下拉 | 选项 = `mode==='api'` 且有 Key 的在线 Agent；无可用项显示禁用项「暂无可用编剧 Agent」 |
| 渲染引擎 | 状态行 `.cm-engine-line`（**只读展示，不在此配置**） | 已配：`check` 图标 + 「智谱 CogView · CogVideoX / 自定义端点 · 密钥已配置」（绿 #3d8a5f/600）；未配：`triangle-alert` +「未配置」+「去设置 →」链接跳设置页 |

- 辅助提示：无可用编剧 Agent 时 `.cm-hint` 琥珀条（`#fdf3e3` 底 / `#8a5a10` 字）+「去接入 →」；底部 `set-banner`（品牌浅底）提示额度消耗与「配音为可选阶段，未配置自动跳过」。
- 底部按钮：左侧链接「仅创建草稿」（不启动）｜`取消`（btn-o）｜`创建并开始生成`（btn-p + play 图标，创建即 `comicStart` 全量并直达详情页）。

---

## 5. 视图三：漫剧详情（核心）

```
┌ content ────────────────────────────────────────────────────────┐
│ ① cm-head（sticky）：返回 · 标题 · 胶囊 · 进度摘要 · [主操作][终止][⋯]│
│    └ 下缘横贯 .prog（running 时）                                 │
│ ② cm-stagebar：●设定─●剧本─●分镜─●首帧─●视频─●配音ᵒᵖ─●合成        │
│ ③ cm-detail 双栏：左 minmax(0,2fr) 剧集列表 ｜ 右 320px 设定卡+日志 │
└──────────────────────────────────────────────────────────────────┘
```

### 5.1 详情头 `cm-head`

- `position:sticky; top:0; z-index:6; background:var(--bg)`；负边距 `-24px -28px 14px` 吃掉内容区 padding，`padding:13px 28px` + 底描边——长流水线滚动时状态与「终止」恒可见。
- 左：返回钮 `cm-back`（28px 方钮，chevron-right 旋转 180°）→ 标题 `15px/700 -0.01em` → `cm-pill` → 进度摘要 `12px --ink-dim`（`note · pct%`；paused/failed 只显示 note，failed 的 note 同时进胶囊 `title`）。
- 右侧主操作随状态：running→`■ 终止`（btn-danger + power）；done→`↻ 重新生成`（btn-o，确认后全量 force 重跑）；draft/paused/failed→`▶ 开始生成 / 继续生成`（btn-p + play；空 scope = 断点续跑）。尾随 `⋯` 菜单（重命名/复制/删除）。
- running 时下缘绝对定位 `.prog.doing.cm-prog-line`（3px、宽度 = pct）。

### 5.2 阶段轨 `cm-stagebar`

白卡横排（`padding:13px 18px`、`@r-md` 圆角、`overflow-x:auto` + 浅色滚动条）；节点为**真实 button**（`title` + `aria-label` = 「X 阶段：d/t 完成」，可选阶段加注）：

| 元素 | 规格 |
|---|---|
| 节点圆点 | 18px 圆、2px 描边；done：`--done` 实心 + 白色 `check`（10px、描边 3）；doing：`--doing` 空心 + 内嵌 `.pulse`；error：`--red` 实心 + 白色 `!`；todo：`--line-strong` 空心 |
| 标签 | 11px；done `--ink-dim` / doing `--doing`·600 / error `--red` / todo `--ink-faint`；「配音」右上 9px 上标「可选」 |
| 连线 | 24×2px；左节点完成染 `--done`，否则 `--line` |
| 交互 | hover 标签转 `--ink`；点击弹 `.cm-menu`「从此阶段重跑」（danger 项）→ 确认模态（说明覆盖/作废产物与额度消耗）→ `cmRun({stage}, force)` |

七阶段完成度口径（与引擎谓词等价，`cmStageStats`）：设定 = 有角色；剧本 = 该集有镜头；分镜 = 该集每镜头有 imagePrompt；首帧/视频 = 全项目镜头有 imageUrl/videoUrl；配音 = **有台词镜头**有 audioUrl（无台词不计入分母）；合成 = 该集有 package。doing 态 = `comic.status==='running'` 且 `progress.stage===该阶段`；error 态按各阶段失败残留判定。

### 5.3 左栏：剧集列表 + 镜头网格

**剧集行 `cm-ep-row`**（panel 去内衬、行间 `--line` 分隔、默认折叠）：

```
▸ 第 1 集 · 觉醒            [✓ 已完成]  ⋯
  梗概两行截断（12px --ink-dim）
  12 镜头 · 约 58s · 合成包就绪（11px --ink-faint）
```

- 行头 `padding:11px 16px`，hover `#f7f8fa`；caret 13px 旋转 90° 展开；`cm-pill` 在右（running 时附该集视频完成度 `N%`）；`⋯` 菜单：重跑本集 / 复制梗概 / 导出本集合成包（有包才显示）。
- 展开体 `padding:14px 16px`；未拆镜头时 `.cm-shot-empty` 引导文案（按运行态区分措辞）。

**镜头网格 `cm-shotgrid`**（`auto-fill, minmax(172px,1fr), gap 12px`）：

| 区块 | 规格 |
|---|---|
| 媒体区 | `aspect-ratio` 随项目画幅，底 `#eef0f3`；首帧 `cover`，无图占位 `image` 图标 20px `--ink-faint` |
| 序号 | 左上胶囊 `#N`：min-20×20px、`rgba(0,0,0,.55)` 底白字 11px/600、99px 圆角 |
| 视频角标 | 右下 18px 圆片：`--accent-soft` 底 + `--accent` 的 film 11px（hover title「视频已生成」） |
| 进行中遮罩 | `rgba(255,255,255,.72)` + `spin` 旋转 refresh-cw（15px `--doing`）+「首帧/视频/配音生成中…」11px；遮罩只在「当前渲染阶段 + 该镜头缺对应产物 + 无 err」时出现 |
| 文本区 | `padding:8px 10px`；meta 行 11px mono `--ink-faint`（`5s · 近景`）；desc 12px `--ink` 两行截断；台词 `q` 12px `--ink-dim` 斜体一行截断 |
| 三阶段微标 | 底部虚线分隔行：`image/film/mic` 三图标 12px；完成 `--done` / 进行中 `--doing` / 未开始 `--ink-faint`；**无台词镜头 mic 位显示 `—`**（title「无台词，无需配音」） |
| 失败态 | 卡片描边 `fade(@danger,55%)`；`shot-err` = triangle-alert 12px + 11px `--red` 两行截断；`↻ 重跑此镜头`（btn-o btn-sm）——重跑阶段自动定位：缺首帧→image，否则缺视频→video，否则 voice |
| 点击卡片 | 打开镜头预览模态（§6） |

### 5.4 右栏（sticky `top:68px`，320px）

**设定卡 `cm-bible`**（panel；头部 = book-open 图标 15px `--accent` + 「世界观设定」13px/600 + 「重生成」btn-o btn-sm）：

- `logline` 12.5px `--ink`；`style` 按标点切词渲染 `.cm-chip`（20px 高、`@r-xs` 圆角、`--accent-soft` 底 `--accent` 字、11px）。
- 角色 `cm-char`：虚线顶边分行；名字 12px/600 + 角色 pill 10px（主角 `--accent-soft/--accent`、反派 `#fdeaea/#c05656`、配角中性）；`look` 11px `--ink-dim` 两行截断，声线以 mic 10px 前缀内联。
- 场景：中性 chips 一行 wrap（`#eef0f3` 底 / `--ink-dim` 字，title=look）。
- 空态：clapperboard 24px `--ink-faint` + 「尚无设定。开始生成后，编剧引擎将先产出世界观与角色。」

**运行日志 `cm-log`**（panel；头部 = list 图标 + 「运行日志」 + 清屏 trash-2 ghost 钮）：

- 主体：终端视觉（`@term-bg/#e0e3e7` 边/7px 圆角）、mono 11.5px/1.7、`max-height:260px` 自动滚底；行 = 左 2px 状态色竖线 + `padding-left:9px`。
- 行语义：`[分镜] 第 1 集 · 开始 · N 个镜头`（dim）；`delta` 同 key 流式并入一行实时刷字（rAF 节流，key=`stage:episodeId`）；`note` 按 `✓/✕` 前缀着 ok/bad；`error` 整行红 + 顶部 toast；`done` 汇总行 ok（`完成：N 集 · M 镜头 · X 个镜头待重跑 · m分s秒`）；`cancelled` dim 汇总。缓冲上限 400 行。

---

## 6. 镜头预览模态（默认 520px）

- 媒体：`video.cm-shot-media`（`controls autoplay playsinline`，首帧 poster）优先，其次大图；两者皆无 → 220px 虚线空态「尚无首帧」。媒体统一 `max-height:52vh`、`object-fit:contain`、`#0f1114` 底、7px 圆角（黑色底衬托任意画幅内容）。
- 台词 13px/600、画面描述 12.5px `--ink-dim`；首帧/动态提示词进 `result-box.cm-prompt`（mono 11.5px、`max-height:140px`、pre-wrap，可滚动查阅）。
- 失败原因 `.cm-shot-err` 12px 红；非 running 态按缺失产物给对应「重跑首帧/重跑视频/重跑配音」btn-o btn-sm。
- 底部：`复制提示词`（两段合并带【首帧】【动态】标头）/ `关闭`（btn-p）。

---

## 7. 合成包导出模态（`cm-xwide` 720px）

- **打开即重建**：先经 `reins:comic:package` 按渲染层最新镜头数据重建一次（兜住历史过期档，返工修复点），失败静默回退存量包，不阻塞导出。
- 头部 meta：`N 镜头 · 约 Xs · 全镜头就绪 / 缺 X 个镜头视频（--red 加粗）`。
- 三段 `cm-pkg-sec`，每段标题行 = 名称 12px/600 + 说明 11px `--ink-faint` + 「复制」「下载」btn-o btn-sm：
  1. **字幕 ep.srt** — mono 预览前 12 行（`@term-*` 用色，`max-height:180px`）；
  2. **合成脚本 ffmpeg.sh** — 预览前 10 行，说明「下载后放同目录执行：下载镜头、拼接、烧字幕、混配音」；
  3. **分镜表 shotlist.md** — `mdToHtml()` 渲染进 `result-box`（`max-height:220px`）。
- 下载走 Blob + `a[download]`，文件名 `{漫剧名}-第{N}集.ep.{srt|sh|md}`（标题净化非法字符、截 40 字）。

---

## 8. 设置页：渲染引擎区块

位置：「模型与密钥」panel 内、Agent 列表之后（`#re-cfg`）。

- **摘要行 `set-row`**：`<b>智谱 CogView · CogVideoX <span class="mode-pill api">智谱/自定义</span></b>` + `set-desc`（baseURL · 图像 X / 视频 Y · 密钥已配置/未配置（红 #c05656）· 配音 Z 或「未启用（可选阶段）」）+ 右侧「配置 / 去配置」btn-o btn-sm。
- **配置模态**（默认 520px，`f-2col`）：服务商预设下拉（智谱/自定义，切换自动带入 baseURL 与默认模型）｜API Key（password，仅存本机）｜Base URL｜图像模型｜视频模型｜配音模型（可选 · 留空 = 跳过配音阶段）。`set-banner` 说明「配置变更只影响之后启动的任务」。
- 底部：`测试连接`（零成本探测，结果 toast）｜`取消`｜`保存`（保存失败返回可读错误并 toast——后端写后回读校验，不再假装成功）。
- **单一全局引擎**（存 `settings.renderEngine`），非多引擎列表；新建漫剧表单只读引用其状态。

---

## 9. 看板融合（AC-5）

- 每个漫剧自动挂一张联动任务卡：`task.linkComicId` 双向定位；`type:'comic'`（TYPE_LABEL 补「漫剧」）；标题「漫剧 · {title}」跟随重命名。
- 状态单向同步（`COMIC_TASK_ST`）：draft/paused/failed→待办、running→进行中、done→**待验收**；验收 = 原生拖拽到已归档，**已归档不回流**（除非漫剧重新启动）。
- 卡片增强：running 时底部细进度条（宽度 = 漫剧 pct）；failed 时红 chip「✕ 生成失败 · 可续跑」（`#fbe5e5/#b04848`）；点击卡片直达漫剧详情（不打开任务抽屉）。联动卡不触发 Agent 自动执行、可正常拖拽分配。

---

## 10. 状态与事件映射（渲染契约）

### 10.1 状态 → 令牌（`cm-pill` 五语义槽）

| 状态 | 文案 | 底/字 |
|---|---|---|
| draft | 草稿 | `#eef0f3` / `--todo` |
| running | 生成中（+pulse） | `#f9efdc` / `#a26a14`（琥珀系，与任务 doing 同族） |
| paused | 已暂停 · 可续跑 | `--review-bg` / `--review` |
| failed | 失败（title=原因） | `#fdeaea` / `#c05656` |
| done | 已完成 | `--done-bg` / `#3d8a5f` |

剧集四态同上映射（无 paused）；镜头三档：完成 `--done` / 进行中 `--doing` / 待执行 `--ink-faint`。

### 10.2 批量帧渲染策略（返工核心）

事件经 `reins:comic:event` 以 **`{type:'batch', events:[...]}` 单帧**推送（兼容旧单事件）。渲染层 `handleComicEvent` 每帧只做：

1. **应用**：`seq` 单调守卫丢弃乱序；`comic/episode/shot` 补丁 `Object.assign` 就地合并（批内每集/每镜头只留最后一次）。
2. **落盘**：终态（error/done/cancelled）立即 `save()`，过程态走 250ms 节流合并落盘（`beforeunload` 兜底冲刷）——**这是 UI 卡顿修复的关键**（此前逐事件全量 save + 全量重渲）。
3. **UI 收尾（定向 DOM，禁止整页重渲）**：状态翻转才 `renderNav()`（角标）；库视图整渲；详情视图按需——头部/阶段轨 `outerHTML` 定点替换；`cmSyncEp`（集头替换 + 镜头数变化才重建网格体）；`cmSyncShot`（单卡 `innerHTML` + err class 切换）；设定首次产出 / 日志面板缺位才整页重渲。
4. **看板联动**：每帧尾部 `syncComicTask`。

### 10.3 启动对账 `hydrateComics()`

应用重启/页面重载后：running 档逐个 `comicSnapshot`——主进程有活任务则以主进程副本为准；无则 `comicAdopt` 收养为 paused。渲染中断不丢进度、不留幽灵 running。

### 10.4 启动/终止交互

- `cmRun`：乐观切 running（`progress.note` = 「启动中…」/「从断点续跑…」）+ 清空日志与 seq 基线；IPC 同步失败（预检不过/已在执行）toast 错误并回滚渲染。
- 终止走确认模态（文案明确：产物保留、续跑不重复消耗、渲染中镜头回退待执行）；取消后 1s snapshot 对账兜底（事件丢失也能恢复可操作态）。

---

## 11. 空态 / 边界 / 可访问性 / 动效 / 响应式

- **占位与懒加载**：封面/首帧 `loading=lazy`，`onerror` 隐藏回落占位；无骨架动画，保持轻量。
- **并发约束**：running 中再点启动 → toast「执行中」；删除 running 项目先自动 cancel 并连带移除联动任务卡。
- **可访问性**：所有**操作控件**为真实 button（⋯ 菜单/阶段节点/步进器/分段选择器，全局 `:focus-visible` 品牌描边生效）；卡片/镜头卡为可点区域（`onclick` div，与看板 `.tcard` 同一屋规），键盘路径经 ⋯ 菜单「打开」可达；阶段节点 `title`+`aria-label`（完成度）；进度条 `role=progressbar + aria-valuenow`；步进器增减钮 `aria-label`；菜单 Esc/点外关闭。
- **动效克制**（全功能仅 4 处）：`pulse` 呼吸（1.4s）、`spin` 旋转（1.2s，cm-rot 关键帧）、`.prog` width .4s 过渡、卡片 hover 抬起 .15s。
- **响应式** `@1080px`：`cm-detail` 收单栏、右栏取消 sticky（复用既有断点）。
- **性能红线**（返工验收口径）：事件窗口 120ms 批推 + 渲染侧每批一次落盘/一次收尾 + 图片懒加载 + 定向 DOM 更新；任何路径不得逐事件 `save()` 或整页 `innerHTML` 重渲。

---

## 12. 新增样式与图标清单

**LESS（`src/app.less`「漫剧工作流」段，编译进 app.css）**：`.prog`（通用）｜`.cm-pill.s-*`｜`.cm-menu`（通用迷你菜单）｜`.cm-grid/.cm-card/.cm-cover/.cm-more/.cm-card-txt`｜`.cm-seg/.cm-step/.cm-engine-line/.cm-hint`｜`.cm-head/.cm-back/.cm-head-main/.cm-head-acts/.cm-prog-line`｜`.cm-stagebar/.cm-stage(.done/.doing/.error)/.lnk`｜`.cm-detail/.cm-main/.cm-side`｜`.cm-ep-list/.cm-ep-row/.cm-ep-head/.cm-ep-body/.cm-shot-empty`｜`.cm-shotgrid/.cm-shot(.media/.txt/.mini/.busy/.idx/.vico)`｜`.spin + @keyframes cm-rot`｜`.shot-err/.cm-shot-err/.cm-shot-media/.cm-shot-line/.cm-shot-desc/.cm-shot-retry/.cm-prompt`｜`.cm-bible/.cm-panel-head/.cm-chips(.neutral)/.cm-chip/.cm-char/.cm-bible-empty`｜`.cm-log/.cm-log-clear/.cm-log-body/.cm-log-row`｜`.cm-pkg-sec/.cm-pkg-h/.cm-pkg-pre/.cm-pkg-md`｜`.modal.cm-wide(560)/.cm-xwide(720)`。

**图标（icons.js 本地 Lucide 子集）**：新增 `clapperboard / book-open / image / film / mic`；复用 `chevron-right（返回/折叠，旋转 180°/90°）、more-horizontal、refresh-cw、play、power、trash-2、list、check、triangle-alert、x`；`ICON_CHAR` 补 `🎬→clapperboard`。

---

## 13. v1 → v2 修订记录（对齐返工后契约与实现）

| # | v1（返工前） | v2（本文） |
|---|---|---|
| 1 | 事件逐条推送、逐条处理 | **批量帧** `{type:'batch'}` + 每批一次落盘（250ms 节流/终态立即）+ 定向 DOM 收尾（§10.2） |
| 2 | 新建表单含「渲染引擎下拉」（每项目 `renderAgentId`） | 渲染引擎为**全局 settings.renderEngine**；表单内只读状态行 `cm-engine-line` + 去设置引导（§4/§8） |
| 3 | 状态胶囊复用 `.status-pill` | 新做 `.cm-pill` 五语义槽（与任务胶囊同族配色，含 paused 槽与 pulse 点）（§10.1） |
| 4 | 合成包直接读 `ep.package` | 导出前经 `reins:comic:package` **重建**（旧包 concat/分镜表缺镜头问题的兜底）（§7） |
| 5 | 设置页为「多引擎列表 + 添加」 | 单一全局引擎摘要行 + 配置模态（预设自动填充、测试连接、保存回读校验失败可见）（§8） |
| 6 | 更新策略笼统「禁止整页重渲」 | 明确三档：整渲（库视图/结构变化）/ 定点 outerHTML（头/阶段轨/集头）/ innerHTML（单镜头卡）（§10.2） |
| 7 | 阶段轨完成度「由服务端谓词推导」 | 前端等价实现口径逐阶段列明（含配音「有台词镜头」分母）（§5.2） |
| 8 | 未涉及看板卡视觉 | 联动卡进度条/失败 chip/点击直达/归档不回流（§9） |
| 9 | 通用组件只列 `.prog` | 补 `.cm-menu` 通用迷你菜单（四处 ⋯ 共用）；补 `.cm-engine-line/.cm-hint/.cm-pkg-*` 等缺漏 class（§12） |

## 14. v2 → v3 设计终审记录（实现走查）

对已落地实现（`src/app.less` 漫剧段 / `web/assets/app.js` 漫剧函数群 / `web/assets/icons.js`）逐项走查，结论如下：

**核验通过（无需改动）：**
- 令牌引用全部落在既有体系：五语义槽/终端三色/圆角阶梯/三档阴影/字号阶梯与 §1 基线一致；`:root` 变量与 LESS 变量分层使用正确（如 `s-paused` 用编译期 `@st-review-bg`）。
- 类名引用无悬空：`.lnk`/`.ghost`/`.set-banner`/`.result-box`/`.view-head .act`/`.pulse`/`.mode-pill.api` 均有既有定义；`.ttag.comic`（品牌浅底青字）已在类型标签族补齐。
- 布局数学成立：`.content` padding `24px 28px 32px` 与 `cm-head` 负边距 `-24px -28px 14px` 精确咬合（吸附头满幅出血）；`cm-side` sticky `top:68px` 与头高（~66px）匹配；镜头卡 media/txt 拆段与签名更新的 DOM 契约自洽。
- 看板联动、设置页渲染引擎区、`@1080px` 单栏断点、动效克制（全功能仅 4 处）均按 §8/§9/§11 落地。

**修正两处（本版变更）：**

| # | 问题 | 修正 |
|---|------|------|
| 1 | 默认画幅 9:16 下库卡片封面随列宽无上限拉高（宽窗口 336px 列 → 597px 封面，库页沦为超长海报墙，扫读性差） | `.cm-cover` 增加 `max-height:320px` 封顶，`object-fit:cover` 居中裁切保持构图；16:9/1:1 永不触及上限（§3） |
| 2 | v2 §11「所有可点元素为真实 button」表述超出实现事实（卡片/镜头卡是 `onclick` div，与看板 `.tcard` 同一屋规） | 表述修正为「操作控件为真实 button；卡片为可点区域，键盘路径经 ⋯ 菜单可达」（§11） |

**回归验证：** `test-comic.js`(49) + `test-comic-manager.js`(58) + `test-comic-ui.js`(52) = 159 项断言全绿；`npm run build:css` 同步编译 `web/assets/app.css`。

## 15. 落地对照（供测试/验收勾选）

| 本文章节 | 载体 |
|---|---|
| §2 导航 | `web/assets/app.js` VIEWS/renderNav 角标 |
| §3 库 | `viewComics/cmCardHTML/cmCardMenu` |
| §4 新建 | `openNewComicModal/cmSegHTML/cmStepHTML/cmCreate` |
| §5 详情 | `viewComicDetail/cmHeadHTML/cmStagebarHTML/cmStageStats/cmEpListHTML/cmShotgridHTML/cmShotInner/cmBibleHTML/cmLogHTML` |
| §6 预览 | `openComicShot/copyShotPrompts` |
| §7 合成包 | `openComicPackage/cmPackCopy/cmPackDownload` |
| §8 设置 | `hydrateRenderEngineCfg/openRenderEngineModal/reSave/reTest` |
| §9 看板 | `syncComicTask/cardHTML`（联动卡分支） |
| §10 事件 | `handleComicEvent/cmSyncEp/cmSyncShot/hydrateComics/cmSaveSoon` |
| 样式 | `src/app.less` 漫剧段 → `npm run build:css` → `web/assets/app.css` |
| 图标 | `web/assets/icons.js` |
