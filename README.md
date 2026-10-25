# AgentCorps

AgentCorps 是一个运行在个人电脑上的本地优先（local-first）多 Agent 协同平台。它统一连接 Codex、Claude Code、Cursor 以及其他命令行、桌面或远程 Agent，通过共享的会话、事件、任务、记忆和策略模型，让用户可以在终端、浏览器控制台、Tauri 桌面端和企业聊天渠道中继续同一个工作。

当前仓库提供可运行的核心控制面：CLI、SQLite 持久化运行时、任务和工作流模型、JSONL/命令型 Agent 适配器、MCP/A2A/ACP 协议边界、记忆和会话服务、审批与沙箱策略、渠道 webhook、PWA 控制台，以及复用控制台的 Tauri `.app` 桌面壳。外部厂商租户、真实 OIDC 部署、Docker/macOS 权限和渠道生产凭据仍需要在目标环境中验证。

## 快速开始

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm --filter @agentcorps/cli build
node apps/cli/dist/index.js serve --data-dir ~/.agentcorps
```

控制台可通过 `pnpm --filter @agentcorps/console dev` 启动；它使用网关的 HTTP、SSE 和 WebSocket 控制面，不直接执行 Agent 命令。远程部署应使用长随机 `--token`，只读设备可使用 `--read-only-token`。

## 主要模块

- `packages/domain`：领域对象和事件类型
- `packages/runtime`：本地编排运行时、事件存储、任务状态机和恢复
- `packages/workflows`：DAG 工作流、并发、重试、超时、取消、补偿和恢复
- `packages/adapters`：命令、JSONL、MCP、A2A 和 ACP 适配器
- `packages/security`：能力策略、审批、沙箱、身份、审计和凭据脱敏
- `packages/session`：跨 CLI、网关、桌面端和渠道的会话与消息存储
- `packages/extensions`：扩展清单、来源、权限、哈希和目录扫描
- `packages/channels`：飞书、钉钉、企微和自研渠道规范化、签名和投递
- `packages/memory`：全局、工作区和会话记忆，SQLite FTS5 候选检索和敏感度过滤
- `apps/cli`：终端控制面和数据迁移、导出、备份命令
- `apps/console`：桌面/浏览器控制台与移动友好任务视图
- `apps/desktop`：Tauri 桌面控制面

## 文档索引

完整的产品需求、架构、API、安全模型、协议边界和部署限制见 `docs/`。每个外部协议和部署功能都明确区分本地 fixture 证据与真实环境验证边界。
