# Agent 适配器

> 版本：0.1.0

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
- `createCursorAdapter()`：默认命令 `cursor-agent`

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

`probeCommand` 只执行配置的版本参数并返回可用性、版本首行和退出状态，不会启动 Agent 任务。真实 Agent 的文件修改、命令执行、网络和秘密权限仍必须由 AgentCorps 安全策略与隔离执行器控制。


适配器不负责授予权限，也不把凭据写入子进程输入。运行时必须先通过策略判断，再传入明确的工作区、环境变量和能力范围；后续沙箱执行器会在适配器之外提供更强的文件系统和网络隔离。
