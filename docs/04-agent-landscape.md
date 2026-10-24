# Agent 生态与协议调研

> 版本：0.1.0
> 调研日期：2026-10-24
> 原则：以下结论区分“已采用”“适配预留”“实验性”和“暂不采用”，不把搜索结果当成兼容性证明。

## 1. 协议与标准

### MCP（Model Context Protocol，模型上下文协议）

MCP 定义服务器如何向模型应用暴露工具、资源和提示词，也定义初始化、能力协商、JSON-RPC 传输等基础交互。AgentCorps 采用 MCP 客户端适配器，把工具、资源、提示词转换为内部能力对象；每次发现、调用、错误和权限判断都写入事件。MCP 服务不能直接绕过 AgentCorps 策略引擎。

参考：

- [MCP 官方规范](https://modelcontextprotocol.io/specification/2026-07-28)
- [MCP TypeScript SDK](https://www.npmjs.com/package/@modelcontextprotocol/sdk)

### A2A（Agent2Agent）

A2A 面向独立 Agent 系统之间的发现、任务交付、状态更新和结果回传。它与 MCP 的边界不同：MCP 连接 Agent 与工具/上下文，A2A 连接 Agent 与 Agent。AgentCorps 将 A2A 放到实验性网络适配器，先通过内部 Task/Run/Message 模型承接，待身份、信任、重试和远程任务语义验证后再开放。

参考：

- [A2A 官方规范](https://a2a-protocol.org/latest/specification)
- [Google 发布 A2A](https://developers.googleblog.com/en/a2a-a-new-era-of-agent-interoperability)

### ACP（Agent Client Protocol）

ACP 主要解决编辑器/客户端与 coding Agent 的标准化连接，定位类似编辑器与语言服务器之间的连接协议。它对接入 Codex、Claude Agent、Gemini 等 coding Agent 有价值，但不替代 AgentCorps 内部的任务、记忆、审批和审计模型。AgentCorps 计划实现 ACP client/provider 适配器，并保留版本探测。

参考：[ACP 官方项目](https://github.com/agentclientprotocol/agent-client-protocol)

### JSON-RPC、stdio、SSE、WebSocket、Webhooks

这些是传输或接口机制，不是 Agent 编排模型。内部统一事件模型，外部按适配器分别处理：stdio/JSONL 用于本地子进程，SSE/WebSocket 用于流式控制面，webhook 用于飞书、钉钉、企业微信等入站事件。

## 2. Agent 扩展概念

| 概念 | 作用 | AgentCorps 处理 |
| --- | --- | --- |
| Agent | 能规划和执行任务的外部或内置执行者 | 统一 `AgentAdapter` 端口 |
| Subagent | 具有独立上下文和职责的子任务执行者 | 映射为父子 Task/Run，独立能力和预算 |
| Plugin | 一组可安装的功能与资源 | 版本化清单、签名/来源、能力声明 |
| Skill | 可复用的领域指令、流程和资源 | 加载为有来源的 Prompt/Workflow 包 |
| Rule | 持续适用的约束和项目指导 | 分层作用域与优先级，不直接获得工具权限 |
| Command | 用户可显式触发的命令模板 | 参数校验后转成领域 Command |
| Hook | 生命周期事件触发器 | 只监听版本化事件；执行仍需策略判断 |
| Memory | 可持久检索的知识 | 三层作用域、来源、敏感度、过期和删除 |
| Workflow | 多步任务编排 | 内部 DAG/状态机，外接协议只做映射 |

这些概念名称在不同产品中含义不完全相同，因此核心只定义语义和生命周期，适配器记录来源与原始配置。

## 3. 供应商接入策略

### Codex

优先支持官方 CLI 或 app-server/JSONL 能力（以实际安装版本的探测结果为准），通过进程适配器接入。`AGENTS.md`、skills、MCP 和 sandbox 等能力作为工作区配置/能力信息导入，但不把 Codex 的目录布局硬编码到领域层。

参考：[OpenAI Codex skills 文档](https://developers.openai.com/codex/skills)

### Claude Code

优先支持官方 CLI/SDK 的可验证进程或 SDK 接口；将 `CLAUDE.md`、skills、subagents、MCP、commands、hooks 映射为外部配置能力。hooks 只视为外部事件处理器，必须经过本地审计和权限边界。

参考：[Claude Code 扩展总览](https://code.claude.com/docs/en/features-overview)、[hooks](https://code.claude.com/docs/en/hooks)、[subagents](https://code.claude.com/docs/en/agent-sdk/subagents)

### Cursor

Cursor 目前以桌面/CLI 产品和其配置生态为主。AgentCorps 优先实现兼容 MCP、规则、技能、命令、hooks 的导入/导出和协议适配；对于没有稳定公开运行协议的桌面内部能力，不声明深度控制兼容。

参考：[Cursor 文档](https://cursor.com/docs)、[Cursor hooks](https://cursor.com/docs/hooks)、[Cursor MCP](https://cursor.com/help/customization/mcp)

## 4. 渠道接入

飞书、钉钉、企业微信和自研 App 都作为 `ChannelAdapter`，不直接写入任务表。适配器负责签名校验、消息去重、身份映射、会话绑定、消息格式限制和出站重试；运行时负责权限、任务状态和事件。

## 5. 有选择地不采用的内容

- 不把单个厂商的 prompt 文件名当成通用标准。
- 不把 A2A、MCP、ACP 强行统一成一个协议；它们的连接方向不同。
- 不在核心运行时直接嵌入第三方插件代码；先用独立进程/能力代理。
- 不把“自进化”实现为无审批的自动修改策略、权限或生产配置。
- 不以屏幕自动化作为核心集成方式；桌面自动化只作为隔离且可选的实验能力。
- 不采用未经版本锁定、没有官方规范或无法建立安全边界的协议作为 P0 依赖。

## 6. 需要实际验证的兼容性

兼容性矩阵必须由 CI fixture 和用户本机探测填充，至少记录：工具版本、启动命令、协议/输出版本、是否支持取消、是否支持增量输出、能力列表、错误行为和最后验证时间。搜索到的文档只能证明“值得适配”，不能证明“当前机器可用”。
