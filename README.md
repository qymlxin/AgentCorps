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

# One-shot run: creates the session and task automatically
node apps/cli/dist/index.js run "Explain the main modules in this repository" --agent mock --data-dir ~/.agentcorps

# Interactive terminal client
node apps/cli/dist/index.js tui --agent mock --data-dir ~/.agentcorps

node apps/cli/dist/index.js doctor
node apps/cli/dist/index.js doctor --json

# Start the desktop control plane (auto-starts a local gateway when needed)
pnpm --filter @agentcorps/desktop build:desktop
open apps/desktop/src-tauri/target/release/bundle/macos/AgentCorps.app
```可通过 `pnpm --filter @agentcorps/console dev` 启动，采用 **React 19 + TypeScript + Vite**，使用 Vitest 和 React Testing Library 做前端回归测试；它使用网关的 HTTP、SSE 和 WebSocket 控制面，不直接执行 Agent 命令。远程部署应使用长随机 `--token`，只读设备可使用 `--read-only-token`。

## 外部工具与角色

内置注册了 Codex、Claude Code、Cursor，以及新增的 **Kimi Code、Qwen Code、GLM / ZCode、DeepSeek Harness、OpenCode、Gemini CLI、Aider**。工具必须自行安装并按官方方式配置鉴权。所有工具共享六种提示词角色：开发、审查、规划、测试、安全审查和文档写作，也可以通过显式角色文件自定义。

```bash
node apps/cli/dist/index.js agents
node apps/cli/dist/index.js roles
node apps/cli/dist/index.js task run TASK_ID --agent qwen --role reviewer --instructions "用中文报告已确认的问题"
node apps/cli/dist/index.js serve --agent kimi --role developer --data-dir ~/.agentcorps
```

角色通过提示词影响执行，不代表权限限制。`task run` 可逐次选工具；`serve` 参数用于网关启动的所有任务。工具定义、模型参数和输出解码由统一注册表管理；通过 `--agents-config` 可以显式加载可信工具配置，无需增加 CLI 分支。详细用法见 [适配器与扩展机制](docs/07-agent-adapters.md) 和 [各工具接入及验证边界](docs/24-agent-tools.md)。

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
