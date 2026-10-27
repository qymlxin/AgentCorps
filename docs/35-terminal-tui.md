# TUI 终端客户端

AgentCorps 提供一个交互式终端客户端，适合在 SSH、终端窗口或没有桌面环境时使用。

## 启动

```bash
node apps/cli/dist/index.js tui --agent mock --data-dir ~/.agentcorps
```

真实 Agent：

```bash
node apps/cli/dist/index.js tui \\
  --agent codex \\
  --model YOUR_MODEL \\
  --role developer \\
  --data-dir ~/.agentcorps
```

启动后直接输入任务描述并回车：

```text
Prompt › 分析当前项目的测试风险
```

TUI 会复用同一个 SQLite 数据库，自动创建 Session 和任务，显示 Agent 输出，并保存消息、事件和 Usage。

## 内置命令

- `/help`：显示命令帮助；
- `/new`：开始新的 Session；
- `/tasks`：列出当前会话的持久化任务；
- `/status`：显示当前会话和任务状态；
- `/history`：查看当前 Session 的消息；
- `/approvals`：列出当前 Session 的待处理审批；
- `/approve ID`：批准审批，并自动恢复对应的等待中任务；
- `/deny ID`：拒绝审批；
- `/resume TASK_ID`：恢复一个 queued 或 waiting_approval 任务；
- `/cancel`：取消当前 Session 的活动任务；
- `/quit` 或 `/exit`：退出 TUI。

## 配置

如果不传 `--agent`、`--model` 或 `--role`，TUI 会使用 `~/.agentcorps/config.json` 中的默认配置。也可以通过 `--config` 指定其他配置文件。

TUI 和一次性 `run` 命令使用同一套 Agent 注册表和运行时，因此真实 Agent 的安装、登录和模型配置方式一致。
