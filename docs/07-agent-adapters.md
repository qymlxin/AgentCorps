# Agent 适配器

> 版本：0.1.0

## 可移植的角色预设

所有适配器可通过 `withRole(adapter, { role, instructions })` 注入角色和附加提示词。内置角色为 `developer`、`reviewer`、`planner`、`tester`、`security`、`writer`。

```bash
agentcorps roles
agentcorps task run TASK_ID --agent codex --role reviewer --instructions "用中文报告已确认的问题"
agentcorps task run TASK_ID --agent command --agent-command ./my-agent --role-file ./roles/release.md
```

`--role-file` 是显式指定的 UTF-8 提示词文件（最多 64 KiB），与 `--role` 互斥；不会自动执行文件内容或发现仓库中的配置。相同参数也可用于 `serve`，作为该网关启动的任务的默认角色。角色提示只影响本次执行，不修改已存储的任务目标，不授予工具权限，也不能替代只读沙箱、策略或审批。厂商 CLI 自己的系统提示仍然存在，此机制不声称可覆盖它。

## 可扩展的工具注册

`AgentToolRegistry` 统一管理默认命令、参数、输出格式、提示词位置、模型选项、版本探测和默认角色。CLI 的执行、探测和工具列表共享注册表，新增工具不再需要修改 CLI 的条件分支。

```bash
agentcorps agents
agentcorps task run TASK_ID --agent codex --model YOUR_MODEL --role developer
agentcorps agents --agents-config /absolute/path/tools.json
```

自定义配置仅在显式传入 `--agents-config` 后加载（最多 1 MiB）；格式为 `{"version":1,"tools":[...]}`。工具项包含 `id`、`displayName`、`command`、字符串数组 `args`、`outputFormat`（`text`/`jsonl`），可选 `transport`（`command`/`acp`）、`promptPlacement`（`argument`/`stdin`）、`promptFlag`、`modelFlag`、`versionArgs`、`documentationUrl` 和 `defaultRole`。`transport: "acp"` 会让 AgentCorps 以 ACP Client 启动该进程，完成 `initialize`、`session/new`、`session/prompt` 和 `session/cancel`，而不是把 prompt 拼接成普通命令行参数。ACP 工具不使用 `outputProtocol`、`promptPlacement`、`promptFlag` 或 `modelFlag`；`args` 只用于启动 ACP Agent 本身。`promptFlag` 会紧挨提示词插入；`modelFlag` 在选择 `--model` 时使用。配置定义可执行程序，属于可信的本地管理员配置，不能接受模型输出或远端请求上传的定义。不会自动安装工具、修改厂商全局配置、执行 shell 字符串，重复 ID 和未知字段会被拒绝。

`--acp-config` 还可以直接读取 JetBrains 风格的 `{ "agent_servers": { ... } }` 文件；支持每个 server 的 `command`、`args` 和 `env`，并接受 JetBrains 配置中的 `default_mcp_settings` 元数据。server 名称会转换为小写短 ID，例如 `External ACP Agent` 对应 `external-acp-agent`。环境变量只用于启动对应的 ACP Agent，不会出现在 `agentcorps agents` 的列表输出中：

```json
{
  "default_mcp_settings": { "use_custom_mcp": true },
  "agent_servers": {
    "External ACP Agent": {
      "command": "/absolute/path/node",
      "args": ["/absolute/path/external-agent.js"],
      "env": { "AGENT_API_KEY": "configured-locally" }
    }
  }
}
```

```bash
agentcorps agents --acp-config /absolute/path/acp.json
agentcorps task run TASK_ID --acp-config /absolute/path/acp.json --agent external-acp-agent
```

`kimi-messages`、`qwen-messages`、`zcode-result`、`opencode-events`、`gemini-events`。它只能与 `outputFormat: "jsonl"` 一起使用；未知协议会拒绝加载。未指定时使用兼容性的通用 JSON 文本提取，不应假定它适用于任意厂商格式。

例如，接入一个按 stdin 接收提示词、输出纯文本的本地工具，无需改动源码：

```json
{
  "version": 1,
  "tools": [{
    "id": "local-coder",
    "displayName": "Local coding tool",
    "command": "/absolute/path/to/local-coder",
    "args": ["--headless"],
    "outputFormat": "text",
    "promptPlacement": "stdin",
    "defaultRole": "developer"
  }]
}
```

```bash
agentcorps task run TASK_ID --agents-config /absolute/path/tools.json --agent local-coder --role tester
```

ACP Agent 配置示例。这里的 `command` 和 `args` 是 JetBrains ACP 配置中的 Agent 进程启动命令；AgentCorps 会负责 ACP 握手和会话，而不是把任务文本追加到命令行：

```json
{
  "version": 1,
  "tools": [{
    "id": "external-acp-agent",
    "displayName": "External ACP Agent",
    "command": "/absolute/path/node",
    "args": ["/absolute/path/external-agent.js"],
    "transport": "acp",
    "outputFormat": "text"
  }]
}
```

```bash
agentcorps task run TASK_ID \
  --agents-config /absolute/path/tools.json \
  --agent external-acp-agent
```

`session/new` 使用任务的工作目录，ACP `session/update` 中的文本增量会转为 AgentCorps 的 `run.output` 事件；同一个 AgentCorps Session 会复用对应的 ACP Session。对于声明宿主能力的 ACP Agent，AgentCorps 还会声明并处理 `fs/read_text_file`、`fs/write_text_file`、`terminal/create`、`terminal/output`、`terminal/wait_for_exit`、`terminal/kill`、`terminal/release` 和 `session/request_permission`。这些请求由 `AcpHost` 先交给 `PolicyEngine`（安全策略引擎）和 `ApprovalService`（审批服务），再执行文件或进程操作；文件必须位于工作区，终端 cwd（工作目录）必须位于工作区，终端环境不会继承 AgentCorps 的凭据变量。待审批请求会在 TUI 的审批面板出现，支持 `/approve ID`、`/deny ID`、`a`、`d` 和 `Ctrl+O`。

ACP `session/update` 的结构化 payload（结构化负载）会保存在 `run.protocol` 事件中。TUI 会投影文本增量、tool call（工具调用）生命周期、plan（计划）、current mode（当前模式）、config option（配置选项）、usage（用量）、terminal output（终端输出）和 permission 状态；`Ctrl+V` 或 `/raw` 可查看原始事件。`AcpAgentAdapter` 还通过可选的 `AgentControl` 接口暴露 `setMode`、`setConfigOption`、`loadSession` 和 `closeSession`；`withRole` 与 CLI 审批包装器会透传该接口，因此 TUI 控制命令不是只读投影，而是实际发送 ACP JSON-RPC 请求。


`--agent-command` 覆盖可执行文件，重复的 `--agent-arg` 完整替换默认参数（此时调用方负责把消费提示词的选项放在参数末尾）。`--agent-arg` 的值是原样传给厂商工具的单个参数，即使值是 `--model` 或 `--role`，也不会被 AgentCorps 当成自己的选项读取。角色提示仍生效。沙箱参数适用于注册表中的工具和自定义命令，但当前沙箱执行器不支持 stdin 提示词；该组合会明确拒绝，而不是静默丢失输入。模型与凭据仍需在各工具的官方配置中设置。

内置新增工具和各自的验证范围见 [外部工具接入与验证](24-agent-tools.md)。当前工具/模型/角色通过 `task run` 逐次指定，或通过 `serve` 配置该网关启动的所有任务；浏览器控制台尚未提供每任务工具与角色选择器。

## JSONL/stdio 适配器

`packages/adapters` 提供 `JsonlAgentAdapter`。它将一个本地子进程视为 Agent，并使用一行一个 JSON frame 的最小协议：

```json
{"type":"run","runId":"run-1","task":{"id":"task-1","objective":"...","mode":"code","workspaceId":"ws-1"}}
{"type":"output","text":"planning","stream":"assistant"}
{"type":"completed"}
```

错误使用：

```json
{"type":"error","message":"why the run failed"}
```

适配器同时处理：

- 进程启动失败和非零退出
- 超时和用户取消（发送 `SIGTERM`）
- 单行输出大小限制
- stderr 事件
- 非 JSON 诊断行
- 完成前进程退出

## 供应商工厂

当前提供三个配置工厂：

- `createCodexAdapter()`：默认命令 `codex`
- `createClaudeCodeAdapter()`：默认命令 `claude`
- `createCursorAdapter()`：默认命令 `agent`

这些旧工厂继续保留兼容；推荐通过 `createAgentToolRegistry().create(toolId, options)` 创建包含角色和厂商输出协议的适配器，调用 `list()` 获取完整工具清单。

这些工厂只表达默认命令和显示名称，不声明所有版本都支持相同的 JSONL 协议。真正接入前需要通过本机探测确认命令、参数、版本、输出帧、取消行为和工作区权限。

## 可运行的命令型适配器

`CommandAgentAdapter` 将外部 Agent 的非交互 CLI 当作本地进程运行，支持：

- prompt 作为命令参数或 stdin 传入
- text 和 JSONL 输出解析
- Codex `codex exec --json`
- Claude Code `claude -p --output-format stream-json --verbose --include-partial-messages`
- Cursor CLI `agent -p --output-format stream-json --stream-partial-output`
- 超时、取消、stderr、单行大小限制和非零退出处理

这些默认参数来自各工具的公开非交互 CLI 文档，但仍需要在用户机器上通过版本探测和 fixture 验证。CLI 可使用 `--agent-command` 和重复的 `--agent-arg` 覆盖默认命令与参数：

```bash
agentcorps task run TASK_ID --agent codex
agentcorps task run TASK_ID --agent claude-code
agentcorps task run TASK_ID --agent cursor
agentcorps task run TASK_ID --agent command --agent-command ./my-agent --agent-arg --headless
```

`probeAgent` 在执行版本命令后返回可用性、版本首行、退出状态和完整输出，并生成带有能力映射的 `AgentDescriptor`。能力映射由调用方显式提供，不会因为“命令可执行”就自动授予文件、进程、网络或秘密权限：

```ts
const result = await probeAgent({
  id: 'local-agent',
  displayName: 'Local Agent',
  command: 'agent',
  capabilities: [{
    name: 'workspace.read',
    description: 'Read workspace files',
    risk: 'low',
    scopes: ['workspace'],
  }],
});
```

CLI 可直接探测配置命令：

```bash
agentcorps task probe --command agent
agentcorps task probe --agent codex
```

探测结果只描述本机命令状态；真正执行任务时仍需经过运行时策略、审批和后续沙箱执行器。

`JsonlAgentAdapter` 会把任务的 `sessionId` 同时放入 legacy frame。所有本地进程适配器默认设置 `AGENTCORPS_SESSION_ID` 环境变量，也可以通过 `sessionIdEnv` 改名。这样厂商包装器可以用稳定的 AgentCorps session 标识选择自己的恢复参数；适配器不会假设 Codex、Claude Code、Cursor 的恢复 CLI 参数完全一致。

## A2A 和 ACP 适配器

`A2AAgentAdapter` 和 `AcpAgentAdapter` 也实现同一个 `AgentAdapter` 接口，因此可以直接传给 `TaskRuntime.runTask`：

- A2A 适配器把任务 prompt 和稳定的 `Task.sessionId` 作为 A2A context 发送，并把远程任务响应作为 assistant 输出事件。
- ACP 适配器维护进程内 ACP client，并按 AgentCorps `sessionId` 复用 ACP session；`session/update` 会转成 assistant 输出，取消会发送 `session/cancel`。
- 两者的 `descriptor.transport` 分别为 `a2a` 和 `acp`，能力仍需调用方显式映射，不能从协议连接成功推断权限。

这两个适配器只负责协议边界和输出转换，工具审批、审计和沙箱权限仍由运行时安全层负责。

适配器不负责授予权限，也不把凭据写入子进程输入。运行时必须先通过策略判断，再传入明确的工作区、环境变量和能力范围；后续沙箱执行器会在适配器之外提供更强的文件系统和网络隔离。
