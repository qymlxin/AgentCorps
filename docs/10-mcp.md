# MCP 客户端与工具执行

> 状态：stdio MCP 客户端、分页资源/提示词发现、服务通知、取消、策略审批、动态工具发现、签名来源验证和任务适配器已通过本地 fixture；真实服务版本兼容矩阵、HTTP/SSE transport 和镜像仓库联调仍需部署环境验证。

`packages/mcp` 提供：

1. 启动外部 MCP server 进程并完成 initialize/initialized 握手。
2. 发现工具、资源和提示词，支持分页并拒绝重复游标。
3. 读取资源、获取提示词、调用工具。
4. 转发服务通知、处理 JSON-RPC 错误、超时、取消、进程退出和关闭。
5. `GuardedMcpToolExecutor` 在每次工具调用前执行 `PolicyEngine`，必要时创建并消费一次性审批。

`packages/adapters` 的 `McpAgentAdapter` 支持显式工具和动态工具发现。未显式提供工具时，它会分页发现服务工具，并通过调用方选择器或任务目标与工具名称/说明的确定性匹配选择工具；发现本身不会绕过策略。

- `deny` 不会启动工具调用。
- `approval_required` 会创建审批并让任务进入 `waiting_approval`。
- 恢复执行时绑定原始 request ID、任务、工具和参数，批准被消费后才调用 MCP。
- 取消信号会向 MCP server 发送 `notifications/cancelled`，并结束本地等待。
- `sourceAttestation` 在启动 MCP server 前校验 SHA-256 摘要和 Ed25519 签名；来源未验证时不会创建子进程。
- 协议元数据进入运行时 `run.protocol` 事件，工具结果作为外部数据输出，不自动写入秘密记忆。

工具选择、信任来源、工作区范围、风险和人工审批仍需显式配置。连接成功、工具名称或工具 schema 本身不会授予权限。命令执行还会经过命令风险分类和沙箱资源限制。

仍需真实环境验证的内容包括 MCP server 版本兼容、HTTP/SSE transport、server 身份/签名、容器或 macOS sandbox 的宿主配置，以及镜像来源、资源配额和凭据生命周期。
