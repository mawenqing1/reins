---
name: Reins（驭码）
description: 卡带未来主义调度台——米色机身、拉丝铝面板、蚀刻黑油墨，琥珀仪表只活在深色玻璃窗内
colors:
  chassis-beige: "#e3e4d9"
  landing-body: "#e4e2d3"
  alu-face: "#dcdfd5"
  alu-mid: "#c9ccc1"
  alu-deep: "#bfc3b6"
  alu-rail: "#d3d5c9"
  etched-card: "#eef0e5"
  etched-card-top: "#f4f5eb"
  ink: "#1d1c1a"
  ink-body: "#4c4a44"
  ink-faint: "#676459"
  ink-note: "#4a4740"
  engrave: "#4e4b42"
  glass-face: "#1c1a13"
  glass-deep: "#17150f"
  glass-rim: "#0c0b08"
  glass-head: "#211e15"
  led: "#ff9d00"
  led-hot: "#ffad29"
  dotmatrix: "#ffb23e"
  glass-label: "#918c7a"
  glass-text: "#cdc7b2"
  amber-press: "#a06a08"
  amber-live: "#c9891a"
  amber-wash: "#f6ecd7"
  amber-deep: "#7d5206"
  amber-ink: "#6f4904"
  amber-key-end: "#e08800"
  amber-rim: "#b06e10"
  amber-black: "#241a04"
  key-face: "#f4f2e8"
  key-well: "#ddd9c9"
  key-rim: "#a8a696"
  key-shadow: "#8f8d7c"
  off-key-face: "#f6f7ee"
  off-key-well: "#e6e8db"
  todo: "#8a8f94"
  doing: "#c47f17"
  review: "#7c6bd6"
  done: "#36855a"
  red: "#c14e4e"
  ember: "#d05636"
  input-fill: "#f2f3e9"
  form-fill: "#f7f8ef"
  alu-track: "#c2c4b7"
  steel-thumb: "#86887a"
typography:
  display:
    fontFamily: "-apple-system, BlinkMacSystemFont, \"PingFang SC\", \"Hiragino Sans GB\", \"Microsoft YaHei\", \"Segoe UI\", sans-serif"
    fontSize: "clamp(38px, 4.6vw, 58px)"
    fontWeight: 800
    lineHeight: 1.22
    letterSpacing: "0.015em"
  headline:
    fontFamily: "-apple-system, BlinkMacSystemFont, \"SF Pro SC\", \"PingFang SC\", \"Segoe UI\", sans-serif"
    fontSize: "20px"
    fontWeight: 800
    lineHeight: 1.4
    letterSpacing: "0.01em"
  title:
    fontFamily: "-apple-system, BlinkMacSystemFont, \"SF Pro SC\", \"PingFang SC\", \"Segoe UI\", sans-serif"
    fontSize: "14px"
    fontWeight: 800
    lineHeight: 1.4
    letterSpacing: "normal"
  body:
    fontFamily: "-apple-system, BlinkMacSystemFont, \"SF Pro SC\", \"PingFang SC\", \"Segoe UI\", \"Hiragino Sans GB\", \"Microsoft YaHei\", sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.55
    letterSpacing: "-0.006em"
  body-landing:
    fontFamily: "-apple-system, BlinkMacSystemFont, \"PingFang SC\", \"Hiragino Sans GB\", \"Microsoft YaHei\", \"Segoe UI\", sans-serif"
    fontSize: "15px"
    fontWeight: 400
    lineHeight: 1.75
    letterSpacing: "-0.004em"
  mono:
    fontFamily: "ui-monospace, \"SF Mono\", SFMono-Regular, Menlo, Consolas, \"Liberation Mono\", monospace"
    fontSize: "12px"
    fontWeight: 600
    lineHeight: 1.8
    letterSpacing: "0.06em"
    fontFeature: "font-variant-numeric: tabular-nums"
  nameplate:
    fontFamily: "\"Avenir Next Condensed\", \"AvenirNextCondensed-Heavy\", \"Arial Narrow\", \"Helvetica Neue\", -apple-system, sans-serif"
    fontSize: "11px"
    fontWeight: 600
    lineHeight: 1
    letterSpacing: "0.22em"
rounded:
  chassis: "18px"
  deck: "14px"
  panel: "12px"
  card: "10px"
  control: "8px"
  key: "7px"
  chip: "4px"
  pill: "99px"
spacing:
  xs: "8px"
  sm: "14px"
  md: "20px"
  lg: "28px"
  xl: "40px"
  zone: "46px"
components:
  btn-primary:
    backgroundColor: "linear-gradient(180deg, #ff9d00, #e08800)"
    textColor: "#241a04"
    rounded: "{rounded.key}"
    padding: "8px 15px"
  btn-secondary:
    backgroundColor: "linear-gradient(180deg, #f6f7ee, #e6e8db)"
    textColor: "{colors.ink}"
    rounded: "{rounded.key}"
    padding: "8px 15px"
  key-primary:
    backgroundColor: "linear-gradient(180deg, #ff9d00, #e08800)"
    textColor: "#241a04"
    rounded: "9px"
    padding: "13px 24px"
  panel:
    backgroundColor: "linear-gradient(180deg, #f4f5eb, #eef0e5 70%)"
    textColor: "{colors.ink}"
    rounded: "{rounded.card}"
    padding: "20px"
  glass-counter:
    backgroundColor: "linear-gradient(180deg, #1c1a13, #17150f 60%)"
    textColor: "#ffb23e"
    rounded: "{rounded.card}"
    padding: "16px 20px 14px"
  input:
    backgroundColor: "#f7f8ef"
    textColor: "{colors.ink}"
    rounded: "{rounded.key}"
    padding: "9px 12px"
---

# Design System: Reins（驭码）

## Overview

**Creative North Star: "开工中的调度台（The On-Duty Deck）"**

Reins 的视觉世界是一台正在开工的卡带调度台：用户面对的不是"又一个后台"，而是一块米色机身包裹、拉丝铝面板作地的实体设备。信息分层即物理分层——机身是地面，铝面板是骨架，暖白蚀刻卡片是操作区，深色玻璃窗是仪表，琥珀是唯一通电的颜色。一切可按压的东西都有行程，一切仪表都读真实数据。

两个表面共享同一套物料：官网（web/index.html + landing.css）是整幅机箱面板，五区（磁带仓 / 曲目单 / 走带三键 / 配线盘 / 维修手册）以蚀刻细线与一字槽螺钉定界；控制台（web/app.html + app.css）是在役面板，216px 铝面侧栏 + 四盘点阵计数窗 + 三路电平表先行。密度上官网是展示密度（15px/1.75），控制台是工作密度（13px/1.55）——同一世界，两种握感。

**Key Characteristics:**
- 米色机身 + 拉丝铝 + 暖白蚀刻卡的三层地面，靠 1px 上缘高光与蚀刻细线塑形，不靠大阴影。
- 交互琥珀只在深色玻璃窗内通电（LED、点阵数字、辉光）；浅底上的琥珀一律压深。
- 蚀刻黑油墨字带 1px 白高光浮雕（text-shadow 0 1px 0 rgba(255,255,255,.5)）。
- EN 铭牌刻字是独立的第四种字声：Avenir Next Condensed 栈、11px、.22em、大写。
- 可按压件必有 2–4px 硬底影行程；拨杆带 detent 阻尼回弹。
- 全部为 CSS/SVG/系统字体，零位图、零外源（CSP connect-src 'none'）。

## Colors

一套"物料色板"：大地色承担机身与面板，琥珀是唯一的交互电流，四枚语义色承担任务状态，全部偏灰调以维持实体感。

### Primary
- **通电琥珀 LED** (#ff9d00)：唯一的"亮"色。只以三种形态存在：深色玻璃窗内的点阵数字/辉光（#ffb23e 文字 + 0 0 6~7px rgba(255,157,0,.45~.5) 辉光）、塑模主键面（#ff9d00→#e08800 渐变，字 #241a04，底影 #6f4904/#7d5206）、浏览器原生件上漆（::selection 底）。官网 VU 表顶部两段过载转为炽炭色（#ff7a45→#d05636）。
- **压深琥珀** (#a06a08)：浅底上的交互琥珀——控制台链接、caret、focus 可见环、kanban 拖拽落点边框。是 #ff9d00 的"关电"形态。
- **深压琥珀** (#7d5206)：浅底上的琥珀文字（运行中甘特片、git 日志动作行）；同时是控制台主键的行程底影色。

### Secondary
- **运行琥珀** (#c47f17)：任务"进行中"语义色与执行呼吸光环（rgba(196,127,23,.16~.18)）。它同时是 --doing 接口值，说明本世界的状态语言就是电流语言。
- **待验收紫** (#7c6bd6)：review 状态点与相关小件。唯一一枚冷色语义，用来把"等人的事"从电流色系里拉开。

### Tertiary
- **完成绿** (#36855a) / **告警红** (#c14e4e)：done/red 语义点、危险键（#c96565→#c14e4e 渐变，底影 #762929）。红只作破坏性动作与失败态，不作装饰。
- **待办灰** (#8a8f94)：todo 状态点。灰也是一枚状态色，不是缺省色。

### Neutral
- **机身米** (#e3e4d9)：控制台地面（--bg/--paper）。官网 body 用同族渐变（#e8e6d9→#dedcca）+ 顶部径向白光呈现机身受光。
- **铝面板族** (#dcdfd5 / #c9ccc1 / #bfc3b6 / #d3d5c9)：拉丝铝配方的基础色阶，从受光面到暗部。侧栏/官网机壳用斜向光渐变 + 细横纹 repeating-gradient 叠出金属纹。
- **蚀刻暖白** (#eef0e5，上缘 #f4f5eb)：控制台卡片/表格面板；官网浅键与纸签同族（#f4f2e8、#efece0）。
- **蚀刻黑** (#1d1c1a)：标题与强调字油墨，永远带 1px 白高光浮雕。
- **正文墨** (#4c4a44)：两表面一致的正文色。
- **弱字双值** (#676459 控制台 / #4a4740 官网)：--ink-faint 在两个表面各有定值，各自表面内不自混用。
- **刻字灰** (#4e4b42)：铝面板上的次级铭牌刻字（导航英文、tape 标签、en 区）。
- **玻璃窗四色** (#1c1a13 / #17150f / #0c0b08 / #211e15)：深色玻璃窗的面、深、边框、窗头。窗内辅助字 #918c7a、正文 #cdc7b2。
- **键件族** (#f4f2e8 / #ddd9c9 / #a8a696 / #8f8d7c)：塑模键面、键底、键边、行程底影。
- **输入凹槽** (#f2f3e9 / #f7f8ef)：搜索/筛选槽与表单域填充，配 inset 0 2px 4px 阴影呈现凹陷。
- **铝槽钢灰** (#c2c4b7 / #86887a)：滚动条轨道与滑块（官网略深：#babeb0 / #7e8176）。

### Named Rules
**The Glass Window Rule（玻璃窗法规）。** 交互琥珀只活在深色玻璃窗内：LED、点阵数字、辉光只出现在 linear-gradient(180deg,#1c1a13,#17150f 60%) 的窗体上。浅底上的琥珀一律压深为 #a06a08 / #7d5206 / #c9891a。琥珀出现在浅底亮面上等于短路。

**The Real Load Rule（真实负载法规）。** 仪表读数必须来自真实数据（电平段数 = 负载百分比、计数 = 真实任务/花费）；演示数据必须就地标注（官网 deck 角注"演示走带 · 非实时数据"）。

**The State Slot Rule（状态槽法规）。** 四枚语义色 #8a8f94/#c47f17/#7c6bd6/#36855a + #c14e4e 以 :root 自定义属性 --todo/--doing/--review/--done/--red 暴露，app.ts 经 `var(--${st})` 消费——这些名字是 JS 运行时接口，任何重绘都不得改名。

## Typography

**Display Font:** 系统栈（-apple-system → PingFang SC → Microsoft YaHei）——中文界面无衬线油墨，CSP 禁外源
**Body Font:** 同上，两表面共享字族、不同密度
**Label/Mono Font:** ui-monospace / SF Mono / Menlo（点阵仪表字）
**Nameplate Font:** "Avenir Next Condensed" / Arial Narrow（英文铭牌刻字，仅 EN）

**Character:** 三种字声各司其职：中文系统字承担全部语义内容；等宽字只承担"仪表读数"（数字、键位、流水），永远 tabular-nums + 0.06~0.14em 疏排 + 玻璃窗内辉光；Condensed 铭牌字只承担英文微刻（DOING / LOAD / PARALLEL），是设备上的丝印而非内容。

### Hierarchy
- **Display** (800, clamp(38px, 4.6vw, 58px), 1.22): 官网 hero 双行巨题；`<em>` 用琥珀底半高光带（linear-gradient(transparent 64%, rgba(255,157,0,.5) 64%)）作荧光笔刻痕。
- **Headline** (800, 19–20px): 分区题（官网 .zone-head h2 带 0.06em 疏排）与控制台视图题（h2 20px）。顶部导航题 15px/800。
- **Title** (800, 14–16.5px): 面板题 h3，后缀 `<i.zen>` 铭牌刻字。
- **Body** (400, 13px/1.55 控制台 · 15px/1.75 官网, letter-spacing -0.004~-0.006em): 正文与表单；官网长文限宽 33–44em。
- **Label** (600, 12px): 表单标签、表头（12px 弱字色，11px 16px 内边距）。
- **Mono** (600, 11–21px, tabular-nums): 计数窗 b 26px、点阵时钟 15px、流水 11–12px；玻璃窗内 0.06~0.14em 疏排。
- **Nameplate** (600, 11px, letter-spacing .22em, 大写 EN): `i.zen` 面板刻字、VU 名、sw 副标、en 区注记。控制台在浅底用弱字色，玻璃窗内用 #918c7a。

### Named Rules
**The Nameplate Rule（铭牌法规）。** Condensed 刻字只用于英文铭牌语声（全大写、11px、.22em、600），不承载中文，不作正文强调。它是丝印，不是排版花样。

**The Instrument Digit Rule（仪表示数法规）。** 一切读数用 ui-monospace 栈 + tabular-nums；数字宽度不稳定等于表针抖动。

## Layout

**官网**：.chassis 容器 max-width 1280px 居中，18px 圆角机壳。分区节奏 zone 级（padding 46px 40px 52px；bay 30px 40px 34px；hero 54px 40px），分界线 = 1px 蚀刻线 rgba(29,28,26,.18) + 下邻 1px 白高光。栅格：功能面板 12 列（7/5 跨）、曲目单双栏、走带三键三栏。**控制台**：固定桌面网格 216px 侧栏 + 1fr 主区，60px 顶栏，内容区 24px 28px 32px。栅格：概览四盘 4 列、grid2/grid3 14px 间距、kanban 四列 14px。

**间距节奏**：8 / 14 / 20 / 28 / 40 / 46——面板内边距 20px，栅格间距 14px，分区间距 28–46px。间距始终成对出现（如 16px 20px），不出现悬空的单边距。

**断点**：官网 1100px（hero 收单列、面板 2 列）→ 860px（导航收进横滑 m-nav、clock 隐藏）→ 620px（页边收 8px、仪表窗两列）；控制台 1080px 单一收缩点。所有动效受 prefers-reduced-motion 全关。

## Elevation & Depth

本世界用"雕塑式浮雕"而非悬浮阴影：深度来自**上亮下影**——每块浅色面板上缘一条 inset 0 1px 0 rgba(255,255,255,.5~.65) 白高光，下缘一次 0 2px 8px rgba(40,38,30,.07~.14) 的贴地投影；机壳整体才允许一次大投影（0 30px 70px rgba(40,38,30,.3)）。凹与凸是同一语法的反向：输入槽与玻璃窗用 inset 0 2px 8px rgba(0,0,0,.6) 下陷，面板用白高光凸起。分层不靠 z 轴距离，靠材质明暗。

### Shadow Vocabulary
- **贴地面**（`inset 0 1px 0 rgba(255,255,255,.6), 0 2px 8px rgba(40,38,30,.07)`）: 控制台卡片/表格/面板。官网面板类放大一档（0 8px 22px .12~.14）。
- **机壳投影**（`0 30px 70px rgba(40,38,30,.3)`）: 仅官网最外层机壳一次。
- **玻璃窗**（`inset 0 2px 8px rgba(0,0,0,.6), inset 0 -1px 0 rgba(255,255,255,.05), 0 1px 0 rgba(255,255,255,.35)`）: 一切深色仪表窗（计数/电平/终端/流水）。
- **键行程**（`0 3px 0 #8f8d7c` 主形；琥珀主键 `0 3~4px 0 #6f4904/#7d5206`）: 硬底影即"键高"，active 归零。
- **辉光**（`0 0 6~7px rgba(255,157,0,.35~.55)`）: 仅玻璃窗内点阵字与点亮电平段。
- **焦点环**（`0 0 0 3px rgba(255,157,0,.13)` + 边框 rgba(160,106,8,.42)）: 输入域聚焦；:focus-visible 用 2px outline #c9891a（官网 #6f4904）。

### Named Rules
**The Etched Highlight Rule（蚀刻法规）。** 每块凸面板必有 1px 上缘白高光，每条分界线（1px rgba(29,28,26,.15~.18)）下邻必有一条白高光线——线是刻出来的，浮起的不是卡片而是面板。

## Shapes

圆角即机加工：大件 10–14px（面板 10、官网面板 12、仪表座 14、机壳 18），控件 7–8px（按钮 7、官网键 8、输入 7–8、玻璃窗 6–7），小件 4–5px（标签、键位帽），胶囊 99px（状态数、开关轨、进度条）。圆形专属于机械件：螺钉、香蕉插座、旋钮、卷带、状态点（7–8px）。边界一律 1px 实线（浅面 rgba(29,28,26,.15~.3)，深面 #0c0b08）；虚线边框（1.5px dashed rgba(29,28,26,.3)）是"空位"的专用语声——空态面板与虚位磁带/加卡槽。装饰几何只有一种：铆钉螺钉（radial 金属渐变圆 + 斜向 38° 一字槽，12px，仅官网 hero 两角）。

## Components

### Buttons
- **Shape:** 微圆角方块（控制台 7px，官网键 8px / 主键 9px），全大内边距 8px 15px（官网主键 13px 24px）。
- **Primary（琥珀塑模键）:** 面 #ff9d00→#e08800，字 #241a04，边 #b06e10，底影 0 3px 0 #7d5206（官网 0 4px 0 #6f4904）+ inset 0 1~2px 0 白高光。
- **Secondary（米白塑模键）:** 面 #f6f7ee→#e6e8db（官网 #f4f2e8→#ddd9c9），边 rgba(29,28,26,.24) / #a8a696，底影 0 2~3px 0 rgba(29,28,26,.18) / #8f8d7c。
- **Hover / Active:** 不上浮、不变色——按压 = translateY(1~2px) + 底影减 1~2px；active = 底影归零。过渡 0.12s ease-out。
- **Danger:** 面 #c96565→#c14e4e、字 #fff、底影 #762929；描边变体透明底 + rgba(193,78,78,.45) 边。

### Cards / Containers
- **Corner Style:** 10px（控制台）/ 12px（官网面板）。
- **Background:** 蚀刻暖白渐变（#f4f5eb→#eef0e5 70%）；官网铝面板 #dcdfd5→#c9ccc1。
- **Shadow Strategy:** 见 Elevation——上高光 + 贴地小投影。
- **Border:** 1px rgba(29,28,26,.17)。
- **Internal Padding:** 20px；空态用 1.5px dashed rgba(29,28,26,.3) 虚线框 + 居中弱字（.panel-empty / .add-card）。

### Inputs / Fields
- **Style:** 凹槽语声——填充 #f7f8ef / #f2f3e9，1px rgba(29,28,26,.3) 边，inset 0 2px 4px 阴影，7–8px 圆角。
- **Focus:** 边框转 rgba(160,106,8,.42) + 3px rgba(255,157,0,.13) 琥珀环；搜索框聚焦展宽 240→300px。
- **Error / Disabled:** 失败用 #c14e4e 系文字与 #f7e4e4 底；无漂浮错误框。

### Navigation
- **官网铭牌导航:** 铝面板条，logo + 五锚点 + 玻璃点阵时钟 + GitHub 塑模键；hover 仅加深油墨。移动端收横滑条。
- **控制台侧栏:** 216px 铝面（#dedfd4→#d3d5c9），1px 右蚀刻线 + 1px 白高光；导航项 active 态用琥珀压深语义。

### 玻璃窗与仪表（Signature）
一切仪表长在深色玻璃窗里：**点阵计数窗**（.stat：26px 点阵数字 + 辉光 + 右上角弱化图标 + 趋势小字）；**在役电平表**（.vu-row：10 段琥珀梯，段高 4px 间距 2px，负载 % 驱动点亮数，执行中 vu-breathe 1.8s 呼吸，空闲段退隐为 #3b382b）；**执行终端**（.run-box + .term-scroll：窗头 #211e15 + 等宽流水 + 4px 琥珀进度条）。官网演示 deck 同构（三路 VU + 三窗计数 + 三枚拨杆）。

### 拨杆开关（Signature）
轨 40×20px 圆胶囊，off 面 #14120d→#2c2a22 凹槽，on 面 #b06e10→#d98c0d 通电；旋钮 16px 象牙渐变球，行程 translateX(20px)，transition .22s **cubic-bezier(.34,1.56,.64,1)** detent 阻尼。这是全站唯一的弹性动效，专属于"拨杆"这一个手势。

## Do's and Don'ts

### Do:
- **Do** 按物料配方上漆：拉丝铝 = repeating-linear-gradient(0deg, rgba(255,255,255,.06) 0 1px, rgba(0,0,0,.035) 1px 2px) 叠 linear-gradient(168deg,#dcdfd5,#c9ccc1 46%,#bfc3b6) + 斜向光；蚀刻卡 = #f4f5eb→#eef0e5 渐变 + inset 白高光。
- **Do** 给浏览器原生件上漆：::selection #ff9d00/#241a04、滚动条铝槽（track #c2c4b7）+ 钢灰渐变滑块（#a2a496→#86887a，3px 同色边框内缩）、caret #a06a08、:focus-visible 2px outline。
- **Do** 一切循环动效走柔和呼吸：状态点 pulse 1.4s（透明度+缩放）、电平 vu-breathe 1.8s（透明度 1→.72）、运行片 pw-breathe 1.8s（光环 0→3px）；卷带 spin 2.4s 仅 hover 供带。
- **Do** 滚动显现由 JS 加 .pre 类、IntersectionObserver 换 .on——无 JS 时内容默认完整可见。
- **Do** 状态语义小件统一走状态点/点阵：7–8px 圆点（2~3px 圆角方点用于列头）+ 语义色，克制使用。

### Don't:
- **Don't** 引入任何外部字体、图片、脚本（CSP 关死外连，connect-src 'none'）；资产只能是系统栈、内联 SVG 与本地文件。
- **Don't** 让亮琥珀 (#ff9d00/#ffb23e) 出现在浅色底上；浅底琥珀只允许 #a06a08 / #7d5206 / #c9891a。
- **Don't** 给面板加漂浮大阴影或 hover 上浮；投影词汇表之外只有键行程硬底影。
- **Don't** 改动 :root 状态变量名（--todo/--doing/--review/--done/--red/--accent 等）——它们是 app.ts 的运行时接口。
- **Don't** 用装饰性彩色渐变或品牌大色块；彩色只承担状态语义与玻璃窗内仪表。
- **Don't** 编造仪表读数或省略"演示"标注；空态用虚线框如实写"还没有"，不放假数据。

<!-- 溯源：全部 token 自 web/assets/landing.css 与 web/assets/app.css 编译产物实测（2026-10-21）；本构建零位图资产，raster 溯源清单为空。 -->
