# AgentCorps

AgentCorps 是一个运行在个人电脑上的本地优先（local-first）多 Agent 协同平台。它统一连接 Codex、Claude Code、Cursor 以及其他命令行、桌面或远程 Agent，通过一个共享的会话、事件、任务、记忆和策略模型，让用户可以在终端、桌面端、手机浏览器和企业聊天渠道中继续同一个工作。

> 当前状态：项目处于架构与基础骨架阶段。所有产品决策、接口约束和实现进度都会在 `docs/` 中版本化留档。

## 设计目标

- **本地优先**：核心运行时、会话、记忆、凭据和审计数据默认留在用户电脑上。
- **适配优先**：外部 Agent 通过适配器接入，不把某一家工具的私有协议写死在核心。
- **事件驱动**：所有任务进度、消息、工具调用和审批都以可重放事件记录。
- **安全默认**：权限、沙箱、审批和审计是运行时的一部分，而不是事后补丁。
- **可演进**：桌面端、CLI、远程访问和聊天渠道共享同一套本地 API 和事件模型。

## 文档索引

- [构建提示词](docs/00-builder-prompt.md)
- [产品需求与验收标准](docs/01-product-requirements.md)
- [技术架构](docs/02-architecture.md)
- [安全与威胁模型](docs/03-security-model.md)
- [协议与生态调研](docs/04-agent-landscape.md)
- [实施路线图](docs/05-roadmap.md)
- [本地控制面 API](docs/06-local-api.md)
- [Agent 适配器](docs/07-agent-adapters.md)
- [全局记忆](docs/08-memory.md)
- [多 Agent 协同与委派](docs/09-orchestration.md)
- [MCP 客户端](docs/10-mcp.md)
- [决策记录](docs/decisions/)
- [系统架构图（SVG）](docs/diagrams/system-architecture.svg)

## 预期开发方式

本仓库使用 pnpm workspace 管理 TypeScript 包。计划中的主要模块为：

- `packages/domain`：与平台无关的领域对象和事件类型
- `packages/runtime`：本地编排运行时、事件存储、任务状态机和策略执行
- `packages/adapters`：Codex、Claude Code、Cursor、MCP、插件和聊天渠道适配器
- `packages/mcp`：MCP 工具发现、调用和外部服务适配
- `packages/memory`：全局记忆索引、检索、生命周期和隐私分区
- `apps/cli`：终端控制面
- `apps/desktop`：桌面控制面（后续使用 Tauri）
- `apps/gateway`：本地 HTTP/WebSocket API 与远程访问边界

## 当前开发

```bash
pnpm install
pnpm typecheck
pnpm test
```

具体命令和运行方式会随第一阶段实现一起补充。
