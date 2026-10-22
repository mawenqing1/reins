---
version: 1
slug: "web-app-html"
primary_target: "web/app.html"
related_targets: []
---

# Surface brief — web/app.html（控制台）

## Scope & mode
Operate。团队/个人在日常工作中派活、跟执行、做验收；高频使用，效率与性格兼顾（用户已确认）。

## Audience / job / action
开发者为主、团队为辅；任务：派活（建卡/指派）、跟执行（流式输出）、验收（归档/打回）。动作：新建任务、拖卡指派、抽屉内验收。

## Proof / content
真实数据：任务/Agent/执行流水（execlog）/成本（pricing）/首过率。无演示假数。

## Direction contract
THESIS: 控制台是一台开工中的调度台——"在役"永远可见：仪表先行（概览=在役面板），点阵计数与电平表承载真实数据；拒绝又一个灰色后台。
OWN-WORLD: 米色机身地面 + 铝面板侧栏 + 暖白蚀刻卡片；交互琥珀只以"塑模主键 + 深色玻璃窗内的 LED/点阵数字"出现；状态色（灰/琥珀/紫/绿/红）承担语义小件；终端与执行输出为深色玻璃窗。
STORY: 用户打开即在"在役面板"读到全局健康（今日花费/在役/首过率/今日完成 四盘点阵计数、三路 Agent 电平表、最近执行明细表），一次点击进看板派活，抽屉里看流式输出。
FIRST VIEWPORT: 侧栏 208px 铝面（组织/空间切换、导航、节点胶囊、用户行）；主区顶栏（视图题 + 搜索 + 新建任务琥珀键）；概览 = 四盘深色玻璃计数窗 → 三路 Agent 电平窗（真实负载百分比驱动段数）→ 成本条 → 近 7 日吞吐/花费 → 最近执行明细表 → 最近动态。
FORM: 表面轮 deal 领卡 surface-assigned「在役面板（仪表先行）」，构图按锁定草图 .impeccable/mocks/decision/surface-assigned.html；世界继承方向轮 challenger-deck。seed:283ecd91ebe0d358。
SIGNATURE INTERACTION: 在役电平表——Agent 负载 % 驱动 10 段琥珀电平梯（执行中柔和呼吸，空闲熄灭）；点阵计数窗数字以等宽+微辉光呈现真实数据。
FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance.

## Constraints
- `:root` 自定义属性（--doing 等）是 JS 运行时接口，全部保留同名。
- app.ts 改动保持克制：仅概览负载区换电平梯标记，逻辑/数据/快捷键/测试相关纯函数不动。
- 全部视图（看板/列表/Agent/交付/节点/提示词/自动化/集成/设置/抽屉/模态/通知）功能性样式必须逐一保留（选择器级映射到新世界）。
- 18 文件全量测试必须通过。

## Unresolved
无。
