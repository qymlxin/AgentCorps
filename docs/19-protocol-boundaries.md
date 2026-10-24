# Agent 协议边界与适配策略

> 版本：0.1.0  
> 状态：A2A 实验性客户端和 ACP 实验性 stdio 客户端已实现并通过本地 fixture 验证；A2A 现在有 Agent Card 基础校验、可取消请求、幂等键和结构化协议错误；MCP 已采用。真实流式取消、断线恢复、完整能力协商和厂商兼容矩阵仍未完成。
> 更新日期：2026-10-24

本文记录 AgentCorps 对 MCP、A2A、ACP 及相关传输机制的职责划分。协议适配器只负责外部协议的发现、编码、解码和错误映射；任务、会话、记忆、能力、审批、沙箱和审计仍由 AgentCorps 内部领域模型负责。

## 1. 总体边界

| 协议或机制 | 连接方向 | AgentCorps 状态 | 适配器职责 | 不承担的职责 |
| --- | --- | --- | --- | --- |
| MCP（Model Context Protocol，模型上下文协议） | Agent/模型应用 → 工具、资源、提示词 | 已采用 | 初始化、能力发现、工具调用、JSON-RPC 错误和超时 | 不绕过能力策略，不把外部工具直接写入领域模型 |
| A2A（Agent2Agent） | Agent → Agent | 实验性 | Agent Card 发现、JSON-RPC `message/send`、Bearer 认证头、结果和协议错误映射 | 不替代内部任务委派、身份信任、审批、重试和审计 |
| ACP（Agent Client Protocol） | 编辑器/客户端 → coding Agent | 实验性 | stdio JSON-RPC 初始化、session/new、session/prompt、session/update、session/cancel 和请求回调 | 不把 ACP 会话当作内部任务或记忆的唯一模型 |
| JSON-RPC | 请求/响应消息格式 | 已局部采用 | 编码请求、关联 request id、解码错误 | 不定义 Agent 能力和生命周期 |
| stdio/JSONL | 本地进程传输 | 已采用 | 启动、读写、超时、取消和退出处理 | 不授予子进程额外文件、命令或网络权限 |
| SSE、WebSocket | 流式控制面传输 | 适配预留 | 后续提供增量事件和远程控制 | 不替代事件存储与权限校验 |
| Webhook | 聊天渠道入站传输 | 基础适配器已实现 | 签名校验、去重、身份映射和消息转换 | 不直接创建越权任务或改变策略 |

## 2. A2A 当前实现

实现位置：`packages/protocols`。

### 2.1 已验证流程

`A2AClient` 接收远端 Agent 的基础 URL，并完成以下流程：

1. 请求 `/.well-known/agent-card.json`。
2. 将 Agent Card 解码为最小内部描述：名称、说明、服务地址、版本和能力字段。
3. 使用 JSON-RPC 2.0 调用 `message/send`。
4. 将用户文本编码为 A2A message，包含 `messageId`、`role: user` 和文本 part。
5. 可选地携带 `contextId`，并支持 Bearer token 请求头。
6. 将 HTTP 错误、JSON-RPC error 和超时转换为可观测的客户端错误。
7. 返回远端任务的 id、状态、artifacts 和 history 字段（未知字段保持在协议边界外）。

本地测试 fixture 已验证 Agent Card 发现和 `message/send` 请求/响应闭环。测试同时断言 A2A 的成熟度仍为 `experimental`，避免调用方误以为这是稳定兼容承诺。

### 2.2 有意保持的限制

当前实现只覆盖最小同步请求路径，以下能力尚未声明支持：

- 流式任务状态和订阅
- 推送通知、长轮询和断线恢复
- 多租户远端身份、签名凭据轮换和信任列表
- 远程任务取消、幂等键和重试策略
- Agent Card 的完整 schema 校验与版本协商
- 远程 artifacts 的下载隔离、大小限制和内容扫描

这些能力必须先映射到 AgentCorps 的任务状态、权限策略、事件日志和沙箱，再扩展 A2A 适配器。不能因为远端协议提供了字段，就直接把字段当作内部可信状态。

## 3. MCP 与 A2A 的分工

MCP 与 A2A 不做统一抽象：

- MCP 表示一个 Agent 使用外部工具、资源或提示词。
- A2A 表示一个 Agent 向另一个独立 Agent 发送任务或消息。
- MCP 的调用结果通常是能力执行结果；A2A 的结果通常是远端任务状态或交接结果。
- MCP 服务和 A2A 远端 Agent 都是不可信边界，均必须经过本地认证、能力策略、超时、输出限制和审计。
- 内部的 `Task`、`Run`、`Session`、`Message` 和 `Memory` 不暴露为某个外部协议的直接别名。

内部适配器通过 `AgentRequest.emitProtocol` 将安全的协议元数据（协议名、方向、方法、会话/工具标识和结果状态）写入运行时的 `run.protocol` 事件；不会把 prompt、工具参数或远端原始内容直接写入事件。MCP guarded executor 还会记录工具请求、审批创建、审批拒绝、审批消费和工具结果。Gateway 的 `/events` 会按普通任务事件顺序转发这些事件。

## 4. ACP 当前实现

`AcpStdioClient` 位于 `packages/protocols`，面向本地 coding Agent 子进程，遵循 ACP v1 的最小客户端流程：

1. 通过 stdio 传输 JSON-RPC `initialize`，协商 `protocolVersion: 1`。
2. 调用 `session/new` 创建绝对路径工作区会话。
3. 调用 `session/prompt` 发送文本 prompt。
4. 接收 `session/update` 通知，并通过回调转交给内部事件层。
5. 提供 `session/cancel` 通知和可选的 Agent 请求回调，用于后续接入权限请求。
6. 处理请求超时、JSON-RPC 错误、进程退出和关闭时的 pending 请求。

本地 fixture 已验证初始化、会话创建、prompt 响应和增量 update。该适配器仍标记为 `experimental`，因为文件系统代理、终端代理、权限请求持久化、版本/能力完整协商和 coding-agent 结果映射尚未接入 AgentCorps 的安全与任务层。

## 5. ACP 适配边界

ACP 当前适配器用于对接编辑器或客户端与 coding Agent 的最小会话能力。要进入稳定路径，还需要处理：

- ACP 版本和能力完整探测
- 工作区、会话和 coding-agent 身份映射
- 文件系统代理、终端代理、工具请求和权限批准
- 本地沙箱、审批、diff 审阅和事件审计
- ACP 会话结束后的结构化交接结果

当前不把厂商 CLI 的私有输出格式命名为 ACP；只有符合 ACP JSON-RPC 方法和 schema 的消息才在适配器中解析。

## 6. 传输与领域模型的隔离规则

1. **协议字段只在适配器边界解析。** 领域层使用版本化的内部命令、事件和结果对象。
2. **外部能力默认不可信。** 发现工具、Agent Card、插件清单和 webhook 消息都要经过来源、权限和输入校验。
3. **超时和取消必须可见。** 适配器不能吞掉请求超时、进程退出或远端取消；这些状态要映射到运行事件。
4. **重试必须有幂等依据。** 没有幂等键或明确的请求语义时，不自动重放可能产生副作用的调用。
5. **远程内容不能直接写入记忆。** 只有经过来源、敏感度、置信度和作用域处理的内容才可以进入记忆系统。
6. **协议成熟度影响默认开关。** `adopted` 可进入显式配置的稳定路径，`experimental` 默认保持关闭或需要明确启用，`adapter-planned` 不得被调用。

## 7. 验证与兼容性记录

每个外部协议的兼容性记录至少包含：

- 适配器版本和协议版本
- 远端工具或 Agent 版本
- 发现地址、传输类型和认证方式
- 支持的请求、响应、取消和增量能力
- 超时、错误、断线和重复请求行为
- 测试 fixture、最后验证时间和已知限制

官方文档或搜索结果只能证明协议值得适配，不能证明某个安装版本兼容。正式兼容性必须来自可重复的 fixture、集成测试或用户本机探测结果。

## 8. 后续实现顺序

1. 为 A2A 增加严格 Agent Card 校验、请求超时注入、结构化错误类型和可选取消语义。
2. 将 A2A 调用接入内部任务委派和事件存储，而不是让调用方直接依赖 `A2AClient` 返回值。
3. 将 ACP session/update、权限请求和会话结果接入内部任务事件、审批和 coding-agent 适配器。
4. 为 MCP、A2A、ACP 建立统一的能力审批、凭据管理、审计和兼容性 fixture。
5. 在真实渠道 webhook、远程访问和桌面端接入前，补齐设备身份、配对、断线恢复和数据导出策略。
