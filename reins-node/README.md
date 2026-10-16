# Reins 云端执行节点

把一台服务器变成 Reins 的「云端 Runtime」：CLI 型 Agent（Claude Code、Codex 等）可以把任务派发到这台服务器上执行——合盖、断网、换电脑都不影响，输出实时流回客户端。

## 特性

- **零依赖单文件**：Node 18+ 直接运行，无需 `npm install`
- **Token 鉴权**：Bearer token + 时间安全比较；只执行 argv 数组，不经 shell 拼接
- **任务隔离**：每个任务在独立目录执行；配置仓库后自动创建 git worktree（分支 `reins/<任务号>`），多任务并行互不干扰，node_modules 自动链接
- **流式回传**：SSE 实时推送 stdout/stderr，断线重连可回放缓冲
- **超时与取消**：任务级超时（默认 20 分钟）+ 客户端可随时终止
- **并发上限**：默认同时 8 个任务，`--max-runs` 调整

## 快速开始

```bash
node server.js --port 8787 --token 换成一长串随机密钥
```

启动后把 `http://<服务器IP>:8787` 和 token 填进客户端「设置 → 云端节点」，点「测试连接」。

### 参数

| 参数 | 说明 | 默认 |
|---|---|---|
| `--port` | 监听端口 | 8787 |
| `--token` | 鉴权令牌（建议 32+ 位随机串） | 随机生成（每次重启变化） |
| `--workspace` | 无仓库时任务目录的根 | `./workspace` |
| `--repo-root` | git 仓库根目录（开启 worktree 隔离） | 无 |
| `--name` | 节点名（客户端展示） | 主机名 |
| `--max-runs` | 并发任务上限 | 8 |
| `--timeout` | 默认任务超时（毫秒） | 1200000 |

也支持环境变量 `REINS_PORT / REINS_TOKEN / REINS_WORKSPACE / REINS_REPO_ROOT`。

## 生产部署建议

```bash
# 生成固定密钥
openssl rand -hex 24

# 常驻（任选其一）
pm2 start server.js --name reins-node -- -p 8787 --token <密钥> --repo-root /srv/code/main-repo
# 或 systemd：ExecStart=/usr/bin/node /opt/reins-node/server.js --port 8787 --token <密钥>
```

- **TLS**：建议前置 nginx/caddy 做 HTTPS 反代（SSE 需关闭缓冲：`proxy_buffering off;`，已发送 `X-Accel-Buffering: no` 头）
- **防火墙**：只放行端口给需要的来源；token 泄露即等于服务器执行权，妥善保管
- **仓库权限**：`--repo-root` 指向的仓库就是云端 Agent 的工作对象，建议专用部署仓库/分支

## API（客户端内部使用）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/health` | 节点信息 + 已检测 CLI |
| POST | `/run` | `{runId, taskKey, cmd, args[], repoRoot?, timeoutMs?}` 派发执行 |
| GET | `/run/:id/events` | SSE：`{t:'start'\|'out'\|'err'\|'note'\|'done'\|'killed', ...}` |
| POST | `/run/:id/cancel` | 终止执行 |

所有请求带 `Authorization: Bearer <token>`。
