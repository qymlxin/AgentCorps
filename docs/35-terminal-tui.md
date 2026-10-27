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

在真实终端（标准输入和标准输出都是 TTY）中，`tui` 使用全屏界面：终端进入 alternate screen buffer，界面包含左侧会话、任务和审批信息，右侧实时输出，底部是输入区。退出后会恢复原来的终端内容。窗口尺寸变化会触发重绘；窄窗口会切换为单栏布局。

如果标准输入或标准输出不是 TTY，例如管道、自动化脚本或现有测试，命令会自动使用兼容的 readline 行模式。这样可以继续使用逐行输入、原有标准输出和退出码行为。

启动后直接输入任务描述并回车：

```text
> 分析当前项目的测试风险
```

TUI 会复用同一个 SQLite 数据库，自动创建 Session 和任务，显示 Agent 输出，并保存消息、事件和 Usage。

## 输入和快捷键

全屏模式支持以下输入操作：

- `Enter`：提交当前输入；
- `Left` / `Right`：按光标移动；
- `Home` / `End`：移动到输入开头或结尾；
- `Up` / `Down`：浏览最近提交的输入历史；
- `Backspace`：删除光标左侧字符；
- `Ctrl-U`：清空当前输入；
- `Ctrl-C` 或 `Ctrl-D`：退出 TUI。

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
- `/cancel`：取消当前 Session 的活动任务；
- `/quit` 或 `/exit`：退出 TUI。

## 配置

如果不传 `--agent`、`--model` 或 `--role`，TUI 会使用 `~/.agentcorps/config.json` 中的默认配置。也可以通过 `--config` 指定其他配置文件。

TUI 和一次性 `run` 命令使用同一套 Agent 注册表和运行时，因此真实 Agent 的安装、登录和模型配置方式一致。

## 验证

CLI 包的构建和测试：

```bash
pnpm --filter @agentcorps/cli build
pnpm --filter @agentcorps/cli test
```

测试覆盖全屏布局的文本清理、换行、输入光标编辑和历史导航；现有的非 TTY 测试继续覆盖任务创建、实时输出、审批和恢复。
