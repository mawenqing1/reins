# 贡献指南

感谢你关注 Reins！这是一个「能真跑」的 AI Agent 任务协作平台，欢迎提交 Issue 与 PR。

## 开发环境

- Node.js ≥ 20（TypeScript 编译与测试；运行桌面客户端建议 20+）
- 平台：macOS / Windows / Linux（样式为 LESS，`npm start` 会先编译）

```bash
git clone git@github.com:mawenqing1/reins.git
cd reins
npm install        # 自动触发 tsc 编译（prepare → npm run build）
npm start          # 编译 LESS → 启动桌面客户端
npm test           # 编译 + 全量回归（必须全绿再提交）
```

网络受限环境：`ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ npm install`

## TypeScript 规范

**本项目源码一律 TypeScript，禁止新增 .js 源文件**（`.ts` 源 + tsc 编译，产物不入库）：

- 三套编译配置：`tsconfig.json`（node 侧：主进程 / preload / services / 云端节点 / 工具 / 测试 → `dist/`）、`tsconfig.shared.json`（渲染层 UMD 共享模块 execlog / taskflow → `web/assets/`）、`tsconfig.plain.json`（渲染层经典脚本 app / icons / brands → `web/assets/`，`module: none` 保持 `<script>` 直引语义）
- 模块风格：node 侧统一 `import x = require('...')` / `export = {...}`（与既有 CJS 语义一致）；渲染层经典脚本顶层就是全局，共享声明进 `web/assets/globals.d.ts`
- 渲染层 execlog / taskflow 的 UMD 壳是手写的（TS 原生 `export as namespace` 仅限 .d.ts，且 tsc 的 umd 产物没有浏览器分支），改这两个文件别拆壳
- 类型收紧路线图：node 侧 `strictNullChecks` 与渲染层 app.ts 的 `strict` 目前**暂关**（14k 行存量代码的空值流收紧是重构级工程，分步做）；新增代码请主动标注参数与返回类型，别依赖 `noImplicitAny: false` 的宽限

## 代码结构速览

| 位置 | 职责 | 改动须知 |
|---|---|---|
| `main.ts` | Electron 主进程（窗口 / 托盘 / IPC） | **改主进程后必须完全退出并重启应用再测**（托盘驻留的旧进程不会热更新） |
| `services/*.ts` | 业务逻辑层（执行引擎 / 调度 / Git / 飞书 / 计价 / 加密…） | 纯 Node 可测，新逻辑优先放这里并配测试 |
| `web/assets/app.ts` | 渲染层全部逻辑（单文件，兼容浏览器降级模式） | 不引入运行时构建步骤与外部依赖；新纯函数可下沉 `services/` |
| `src/*.less` | 样式唯一维护入口 | **勿手改 `web/assets/*.css`**（编译产物），改完跑 `npm run build:css` |
| `reins-node/server.ts` | 云端执行节点（零依赖单文件） | 保持零依赖，编译后 Node 18+ 可直接跑 |
| `test/*.test.ts` | 零运行时依赖测试套件（`npm test` → `node dist/test/run.js`） | 见下文测试约定 |

## 提交前必做

```bash
npm test                # tsc 编译 + 全量回归（dist/test/run.js），必须全绿
npm run build:css       # 改过 LESS 时
```

CI（GitHub Actions）会在 push / PR 时自动执行编译门与全量测试。

## 测试约定

- 测试零运行时依赖、纯 Node，入口 `test/run.ts`（编译后在 `dist/test/run.js`）顺序执行 `test/*.test.js`，每个文件导出 `async run()` 并返回断言数
- 断言用最小实现（各文件自带头部），不引测试框架
- 渲染层逻辑的测试采用两种既有模式：
  - **源码断言**：从 `.ts` 源码（`web/assets/app.ts` / `main.ts`）提取函数真身验证行为，再断言接线不回退；正则写法需容忍类型注解（如 `\(v[^)]*, onReady[^)]*\)`）
  - **vm 沙箱**：装载编译产物 `web/assets/app.js`（源码含类型注解，vm 不能直接跑）、受控定时器手动驱动（见 `test/pipeline-sim.test.ts`）
- 修缺陷先写能复现的用例（参考 `test/git-remote.test.js` 的缺陷回归风格），再修

## 分支与提交

- 分支命名：`reins/REINS-<编号>` 或 `reins/<主题>`
- 提交信息用中文一句话说清「做了什么 + 为什么」，参照 `git log` 既有风格
- 一次 PR 一件事；改主进程的 PR 请在描述里写明已重启实测

## 报告缺陷

提 Issue 请选 Bug 模板，附上：复现步骤、预期 / 实际、控制台输出（⌘⌥I 或 `view-source`）、数据自检结果（设置 → 数据自检 → 重新检查）。密钥与令牌请打码。
