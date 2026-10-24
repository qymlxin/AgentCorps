# MCP 客户端

> 版本：0.1.0

## 已实现

`packages/mcp` 提供独立的 stdio MCP 客户端：

1. 启动外部 MCP server 进程
2. 发送 `initialize` 并接收协议、能力和服务版本
3. 发送 `notifications/initialized`
4. 发现 `tools/list`
5. 调用 `tools/call`
6. 处理 JSON-RPC 错误、超时、进程退出和关闭

`GuardedMcpToolExecutor` 在工具调用前把 MCP 工具映射为明确的 AgentCorps `SecurityCapability`，并通过 `PolicyEngine` 产生审计记录：

- `deny` 直接拒绝，不启动工具调用。
- `approval_required` 返回一次性 approval ID；调用方批准后必须用相同 request ID、task、工具名和参数再次提交。
- 匹配的批准会被消费，然后才执行 `tools/call`。
- 工具结果仍被视为外部不可信数据，不能自动变成指令或秘密记忆。

工具调用者必须显式提供 capability resolver，连接成功或工具名称本身不会授予权限。

## 尚未接入核心调度

当前客户端包可以独立发现和调用 MCP 工具，但还没有把所有 MCP 工具自动注入 Agent 的上下文。这是有意的安全边界：工具发现、信任来源、工作区范围、风险和人工审批必须先落地到能力注册表，再提供给运行时。

后续实现：

- `resources/list`、`resources/read`、`prompts/list`、`prompts/get`
- pagination、server notifications 和健康状态
- MCP server 清单、版本锁定、启动参数和权限声明
- 工具 schema 验证、调用审计、取消和隔离进程
- HTTP/SSE MCP transport
