---
version: 1
slug: "web-index-html"
primary_target: "web/index.html"
related_targets: []
---

# Surface brief — web/index.html（官网落地页）

## Scope & mode
Persuade。首次到访的开发者/团队负责人决定是否获取源码并接入。

## Audience / job / action
开发者为主、团队为辅（两者并重）；任务：判断"能不能把我已有的 Agent 变成听得指挥的队伍"。动作：GitHub 获取源码（主）、三步工作方式（次）。

## Proof / content
真实功能清单（README 功能表）、接入不换账单、token 不抽成、过程可回放。无客户案例可引用，不得虚构。

## Direction contract
THESIS: 官网是一台正在开工的调度台面板——每项功能一枚实体开关，"看得见的过程"直接以仪表呈现；拒绝聊天机器人页、终端 cosplay 与灰色 SaaS 模板。
OWN-WORLD: 拉丝铝面板为地、米色机身包边、蚀刻黑油墨为字（带 1px 高光浮雕）；琥珀 LED 与点阵计数只出现在深色玻璃窗内；功能件=塑模方键、拨杆开关、VU 电平表、点阵计数屏、香蕉插孔、磁带仓；分区以蚀刻细线与铆钉定界。
STORY: 访客懂得——接入已有 Agent 像上磁带一样上机；并行执行=电平表同时跳动；过程可回放=计数器与走带记录；验收键握在人的手里。
FIRST VIEWPORT: 整幅机箱面板：顶部铭牌导航（Reins 徽标+五锚点+GitHub 键+点阵时钟）；左列两行蚀刻巨题、机械精度正文、琥珀主键（GitHub 获取源码）+米色副键（三步）、资费注记；右列仪表区：三路 VU 电平表（Agent 负载）、三窗点阵计数（时长/ tokens/在役）、三枚拨杆（并行/回放/云端）。面板分界用蚀刻线与螺钉铆点。
FORM: challenger-deck（SOURCE ID pop-culture-shelf-cassette-futurism-deck）胜出，首屏按锁定草图 .impeccable/mocks/decision/card-deck.html 的构图、密度与配色。seed:18613c7e04f04cea。
SIGNATURE INTERACTION: 在役仪表——首屏三路 VU 持续微跳（节流 rAF）、点阵计时按墙钟走动、拨杆开关带 detent 阻尼；滚动显现统一为一次"上电"节奏（内容默认可见，ease-out）。
FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance.

## Constraints
CSP 关死外连：零外部字体/图片/脚本，全部系统字体栈与内联 SVG。`:root` CSS 变量接口仅 app.css 承担，landing 独立。语义文案事实可复用旧页，视觉层全换。

## Unresolved
无。
