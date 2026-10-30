# TUI 终端客户端

AgentCorps 提供一个交互式终端客户端，适合在 SSH、终端窗口或没有桌面环境时使用。

## 启动

```bash
node apps/cli/dist/index.js tui --agent mock --data-dir ~/.agentcorps
```

真实 Agent：

```bash
node apps/cli/dist/index.js tui \
  --agent codex \
  --model YOUR_MODEL \
  --role developer \
  --data-dir ~/.agentcorps
```

也可以显式指定已经存在的会话 ID：

```bash
node apps/cli/dist/index.js tui --agent codex --session-id session-实际ID --data-dir ~/.agentcorps
```

`SESSION_ID` 只是文档中的占位写法，不能直接作为参数传入；如果指定的 ID 不存在，TUI 会提示一次并以新会话状态继续，输入第一条消息后自动创建会话。
在真实终端（标准输入和标准输出都是 TTY）中，`tui` 使用 **Ink**（基于 React 的终端 UI 框架）渲染全屏界面：终端进入 alternate screen buffer，界面包含任务与审批面板、结构化输出区域和输入区域。窗口尺寸变化会触发 Ink 重绘；窄窗口会切换为单栏布局。退出后会恢复原来的终端内容。

如果标准输入或标准输出不是 TTY，例如管道、自动化脚本或现有测试，命令会自动使用兼容的 readline 行模式。这样可以继续使用逐行输入、原有标准输出和退出码行为。

启动后直接输入任务描述并回车：

```text
> 分析当前项目的测试风险
```

TUI 会复用同一个 SQLite 数据库，自动创建 Session 和任务，显示 Agent 输出，并保存消息、事件和 Usage。每次回车会创建一个可审计的任务执行单元，但同一 Session 的前序用户消息和 Agent 回复会作为参考上下文传给下一轮，因此可以连续追问，不是只能执行一次性的独立任务。

这是一种“交互式会话 + 任务化执行”的组合：输入体验是连续对话，但每一轮仍然有独立的任务 ID、状态、审批、事件和 Usage，便于暂停、取消、重试和审计。默认会继续数据目录中最近的 Session；也可以显式指定 `--session-id SESSION_ID`，或使用 `/new` 开始全新的上下文。`/history` 可以检查当前 Session 已保存的消息。

Codex 使用 `codex exec --json`，Claude Code 使用 `claude -p --output-format stream-json --verbose --include-partial-messages`。TUI 会把它们公开的生命周期、工具调用、命令/文件操作、开始/完成状态和文本增量转换为过程摘要；隐藏的 chain-of-thought（内部思维链）不会显示。`Ctrl+V` 可查看对应结构化事件的原始 JSON。

没有公共中间事件的 Agent 仍只能显示其文本输出和运行状态；工具参数只显示经过摘要和截断的公开字段。

在全屏 Ink 模式中，在输入框键入 `/` 即可打开命令候选列表：

- `↑` / `↓`：选择候选命令；
- `Enter`：先补全当前候选，再按一次执行；带参数的命令会自动补上空格；
- `Esc`：关闭候选提示；
- 输入 `/his`、`/sta` 等前缀会过滤候选项。

readline 行模式支持按 `Tab` 触发同一组命令补全。


全屏模式支持以下输入操作：

- `Enter`：提交当前输入；
- `Shift+Enter`：插入换行，支持多行任务描述；
- `Left` / `Right`：按光标移动；
- `Home` / `End`：移动到输入开头或滚动到输出末尾；
- `Up` / `Down`：浏览最近提交的输入历史；
- `PageUp` / `PageDown`：滚动输出区域；
- `Tab`：切换当前任务；
- `Ctrl+P`：暂停当前任务，或恢复已暂停任务；
- `Ctrl+X`：取消当前任务；
- `Ctrl+R`：重试当前选中的失败/取消任务；
- `Ctrl+F`：搜索输出；
- `Ctrl+G`：折叠/展开长输出；
- `Ctrl+V`：切换结构化事件的原始 JSON 查看；
- `Ctrl+C` 或 `Ctrl+D`：退出 TUI；
- `/help`：打开完整快捷键帮助面板；
- `/approve ID`、`/deny ID`：处理审批；
- `/resume TASK_ID`、`/switch TASK_ID`：恢复或切换任务。

输出内容会按 Markdown 标题、列表、代码块、错误和 diff 使用不同颜色和层级显示。未知结构化事件默认显示摘要，需要时使用 `Ctrl+V` 查看保留的原始事件。

输出区域会保留最近的事件和 Agent 文本，重绘时从内存状态重新生成界面，不会重复订阅或重复显示已经接收的事件。任务仍会写入持久化事件存储，因此可以通过 `/history`、`/tasks` 或其他 CLI 命令查看历史。

## 内置命令

- `/help`：显示命令帮助；
- `/new`：开始新的 Session；
- `/tasks`：列出当前会话的持久化任务；
- `/status`：显示当前会话和任务状态；
- `/history`：查看当前 Session 的消息；
- `/approvals`：列出待处理审批；
- `/approve ID`：批准审批，并自动恢复对应的等待中任务；
- `/deny ID`：拒绝审批；
- `/resume TASK_ID`：恢复一个 queued 或 waiting_approval 任务；
- `/mode MODE_ID`：调用当前 ACP Session 的 `session/set_mode`；
- `/config ID VALUE`：调用当前 ACP Session 的 `session/set_config_option`；
- `/session-load ACP_SESSION_ID`：把指定的 ACP Session 加载到当前 AgentCorps Session；
- `/session-close`：调用当前 ACP Session 的 `session/close`；
- `/cancel`：取消当前 Session 的活动任务；
- `/quit` 或 `/exit`：退出 TUI。

## 配置

如果不传 `--agent`、`--model` 或 `--role`，TUI 会使用 `~/.agentcorps/config.json` 中的默认配置。也可以通过 `--config` 指定其他配置文件。

TUI 和一次性 `run` 命令使用同一套 Agent 注册表和运行时，因此真实 Agent 的安装、登录和模型配置方式一致。

## JetBrains IDE / ACP Agent 接入

AgentCorps 的正确角色是 ACP Client，和 JetBrains IDE 处于同一侧：它负责启动并操控外部 ACP Agent，而不是把自己暴露成一个需要 JetBrains 启动的 ACP Agent。现有 `AcpStdioClient` 和 `AcpAgentAdapter` 会处理 `initialize`、`session/new`、`session/prompt`、`session/update` 和 `session/cancel`。

如果某个外部 Agent 的启动配置是 JetBrains 风格：

```json
{
  "command": "/绝对路径/node",
  "args": ["/绝对路径/external-agent.js"]
}
```

可以把它注册到 AgentCorps 的 `toolDefinitions`：

```json
{
  "version": 1,
  "defaults": { "agent": "external-acp-agent" },
  "toolDefinitions": [
    {
      "id": "external-acp-agent",
      "displayName": "External ACP Agent",
      "command": "/绝对路径/node",
      "args": ["/绝对路径/external-agent.js"],
      "transport": "acp",
      "outputFormat": "text"
    }
  ]
}
```

也可以直接读取 JetBrains 风格的配置文件：

```bash
agentcorps agents --acp-config /absolute/path/acp.json
agentcorps task run TASK_ID --acp-config /absolute/path/acp.json --agent external-acp-agent
```


```bash
agentcorps task create \
  --title "ACP task" \
  --objective "分析当前项目并给出修改建议" \
  --data-dir ~/.agentcorps

agentcorps task run TASK_ID \
  --agent external-acp-agent \
  --data-dir ~/.agentcorps
```

任务的工作目录来自 AgentCorps 的 `--workspace-root` 或工具配置中的 `cwd`。ACP Agent 的文本增量会变成 AgentCorps 的 `run.output` 事件；同一个 AgentCorps Session 会复用对应的 ACP Session。多个 ACP Agent 可以作为多个 `transport: "acp"` 工具注册，再由每个任务的 `--agent` 选择。

AgentCorps 还把可选的 ACP 控制接口暴露给 TUI：`/mode MODE_ID`、`/config ID VALUE`、`/session-load ACP_SESSION_ID` 和 `/session-close` 会直接路由到当前 ACP 子进程的 JSON-RPC 请求；角色包装器和 CLI 的审批包装器会保留该控制接口。控制命令需要当前 Agent 已经创建过 ACP Session；先输入一条任务提示即可建立本地到 ACP Session 的映射。

构建和检查：

```bash
pnpm --filter @agentcorps/adapters build
pnpm --filter @agentcorps/cli build
pnpm --filter @agentcorps/adapters test
```
