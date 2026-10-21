# 贡献指南

感谢你关注 Reins！这是一个「能真跑」的 AI Agent 任务协作平台，欢迎提交 Issue 与 PR。

## 开发环境

- Node.js ≥ 18（测试套件兼容 16+，运行桌面客户端建议 18+）
- 平台：macOS / Windows / Linux（样式为 LESS，`npm start` 会先编译）

```bash
git clone git@github.com:mawenqing1/reins.git
cd reins
npm install
npm start          # 编译 LESS → 启动桌面客户端
```

网络受限环境：`ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ npm install`

## 代码结构速览

| 位置 | 职责 | 改动须知 |
|---|---|---|
| `main.js` | Electron 主进程（窗口 / 托盘 / IPC） | **改主进程后必须完全退出并重启应用再测**（托盘驻留的旧进程不会热更新） |
| `services/*.js` | 业务逻辑层（执行引擎 / 调度 / Git / 飞书 / 计价 / 加密…） | 纯 Node 可测，新逻辑优先放这里并配测试 |
| `web/assets/app.js` | 渲染层全部逻辑（单文件，兼容浏览器降级模式） | 不引入构建步骤与外部依赖；新纯函数可下沉 `services/` |
| `src/*.less` | 样式唯一维护入口 | **勿手改 `web/assets/*.css`**（编译产物），改完跑 `npm run build:css` |
| `reins-node/server.js` | 云端执行节点（零依赖单文件） | 保持零依赖，Node 18+ 可直接跑 |
| `test/*.test.js` | 零依赖测试套件（`node test/run.js`） | 见下文测试约定 |

## 提交前必做

```bash
node test/run.js        # 全量回归，必须全绿
npm run build:css       # 改过 LESS 时
node --check web/assets/app.js   # 改过渲染层时
```

CI（GitHub Actions）会在 push / PR 时自动执行同様检查。

## 测试约定

- 测试零依赖、纯 Node，入口 `test/run.js` 顺序执行 `test/*.test.js`，每个文件导出 `async run()` 并返回断言数
- 断言用最小实现（各文件自带头部），不引测试框架
- 渲染层逻辑的测试采用两种既有模式：
  - **源码断言**：从 `web/assets/app.js` 提取函数真身（`fnSource`）验证行为，再断言接线不回退
  - **vm 沙箱**：装载真实 app.js、受控定时器手动驱动（见 `test/pipeline-sim.test.js`）
- 修缺陷先写能复现的用例（参考 `test/git-remote.test.js` 的缺陷回归风格），再修

## 分支与提交

- 分支命名：`reins/REINS-<编号>` 或 `reins/<主题>`
- 提交信息用中文一句话说清「做了什么 + 为什么」，参照 `git log` 既有风格
- 一次 PR 一件事；改主进程的 PR 请在描述里写明已重启实测

## 报告缺陷

提 Issue 请选 Bug 模板，附上：复现步骤、预期 / 实际、控制台输出（⌘⌥I 或 `view-source`）、数据自检结果（设置 → 数据自检 → 重新检查）。密钥与令牌请打码。
