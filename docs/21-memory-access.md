# 记忆访问入口

> 版本：0.1.0  
> 状态：Gateway 和 CLI 已接入 MemoryService；默认 Gateway 记忆是进程内存，CLI `serve` 使用数据目录中的 JSONL 持久化。  
> 更新日期：2026-10-24

## 1. Gateway 接口

### 保存记忆

```text
POST /memory
```

请求体支持：

```json
{
  "scope": "global | workspace | session",
  "workspaceId": "workspace-id",
  "sessionId": "session-id",
  "content": "User prefers concise release notes",
  "source": "user | agent | system",
  "sensitivity": "public | private | secret",
  "confidence": 0.9,
  "expiresAt": "2027-01-01T00:00:00.000Z"
}
```

`MemoryService` 会校验作用域所需的 workspace/session 标识、内容非空、置信度范围和过期时间字段。保存接口不会把 Agent 输出自动提升为长期记忆；调用方必须明确提交来源和内容。

### 检索记忆

```text
GET /memory?query=release&workspaceId=workspace-id&sessionId=session-id&limit=10
```

检索遵循既有可见性规则：全局记忆可见，workspace 记忆要求 workspace 匹配，session 记忆同时要求 workspace 和 session 匹配。`secret` 记忆默认不会返回；只有 Gateway 显式配置 `allowSensitiveSearch` 后，调用方携带 `includeSensitive=true` 才能请求它。

### 软删除记忆

```text
DELETE /memory/:memoryId
```

删除写入 tombstone，不会从 JSONL 历史中物理擦除，避免备份或恢复过程意外复活已删除内容。

## 2. CLI 接口

CLI 使用 `--data-dir` 指定数据目录，默认是 `~/.agentcorps`。记忆保存在 `memory.jsonl`，与 SQLite 任务事件和 Session 文件分开，便于迁移与审阅。

```bash
agentcorps memory save \
  --scope global \
  --content "User prefers concise release notes" \
  --sensitivity private

agentcorps memory save \
  --scope workspace \
  --workspace-id my-project \
  --content "The project uses pnpm"

agentcorps memory search \
  --query "pnpm project" \
  --workspace-id my-project

agentcorps memory list
agentcorps memory delete MEMORY_ID
```

`memory search` 默认隐藏秘密记忆；仅在本机明确使用 `--include-sensitive` 时才请求包含它们。

启动 CLI Gateway 时，会把同一个数据目录中的 `memory.jsonl` 注入 Gateway：

```bash
agentcorps serve --data-dir ~/.agentcorps
```

## 3. Task 运行时注入和安全边界

`TaskRuntime` 可以接收同一个 `MemoryService`。每次任务开始前，它会使用任务的 objective、workspace 和 session 检索可见记忆，并通过 `AgentRequest.memory` 传递给 Agent。默认上下文只包含 global、匹配 workspace 和匹配 session 的非过期记忆；`secret` 记忆不会自动注入。

本地进程适配器会在发送前再次过滤 `secret`：

- `JsonlAgentAdapter` 在 legacy JSONL frame 的 `task.memory` 中发送 `{ scope, content }` 摘要，并将同一内容加入 objective 的明确 context 区段。
- `CommandAgentAdapter` 将同一 context 区段放入命令参数或 stdin prompt。
- context 区段会标注为不可信参考资料，Agent 不应把其中内容当作指令。

CLI 的 `task run` 和 `serve` 使用数据目录中的同一个 `memory.jsonl`，因此通过 CLI 保存的记忆会参与后续本地任务运行时检索。Gateway 的 `/memory` 路由与其他远程路由一样受 Bearer token 配置保护；远程敏感记忆检索仍需显式配置 `allowSensitiveSearch` 和 `includeSensitive=true`，这不会改变任务运行时默认排除 secret 的规则。

记忆敏感度不是加密机制；秘密内容仍需要系统密钥链、文件权限和备份保护。默认 Gateway 的内存存储适合测试；长期运行使用 CLI 的 `serve` 以启用 JSONL 持久化。当前检索是关键词匹配，后续可以在保持 `MemoryService` 接口不变的前提下增加 SQLite FTS5 或本地向量索引。
