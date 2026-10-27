# 一键运行 Agent

AgentCorps 提供统一的高层运行入口，CLI、控制台和桌面端都可以围绕同一个 `run` 模型工作。一次运行会自动创建或复用 Session、创建 Task、启动 Agent，并将输出、状态、审批和调用统计写入同一个数据目录。

## CLI

构建项目后，可以直接运行一次 Agent：

```bash
node apps/cli/dist/index.js run "分析当前项目的测试风险" \\
  --agent mock \\
  --data-dir ~/.agentcorps
```

真实工具示例：

```bash
node apps/cli/dist/index.js run "检查当前项目的安全问题" \\
  --agent codex \\
  --model YOUR_MODEL \\
  --role security \\
  --data-dir ~/.agentcorps
```

`run` 会自动完成以下步骤：

1. 创建本地 Session；
2. 创建任务；
3. 选择 Agent、模型和角色；
4. 启动一次执行；
5. 实时输出 Agent 的文本；
6. 保存任务事件、Session 消息、审批状态和 Usage 记录。

可选参数包括：

- `--title TITLE`：设置 Session 和任务标题；
- `--workspace-id ID`：设置工作区标识；
- `--session-id ID`：继续已有 Session；
- `--mode code|work`：选择任务模式；
- `--agent TOOL`：选择 Agent；
- `--model MODEL`：选择模型；
- `--role ROLE`：选择开发、审查、规划、测试、安全或写作角色；
- `--instructions TEXT`：添加本次运行的补充指令。

## Gateway API

高层运行 API 是：

```http
POST /runs
Content-Type: application/json

{
  "prompt": "分析当前项目的测试风险",
  "title": "测试风险分析",
  "agent": "codex",
  "model": "YOUR_MODEL",
  "role": "reviewer",
  "mode": "code"
}
```

返回 `202 Accepted`，包含自动创建的任务和 Session：

```json
{
  "status": "accepted",
  "task": { "id": "task-..." },
  "session": { "id": "session-..." }
}
```

查询运行：

```http
GET /runs/task-...
GET /runs/task-.../events
POST /runs/task-.../cancel
POST /runs/task-.../retry
```

这些接口复用现有的事件流：

```http
GET /events
GET /ws
```

控制台和桌面端不需要自己组合“创建 Session、创建 Task、启动 Task”三个底层请求，可以直接使用 `POST /runs`。

## 数据位置

默认数据仍然保存在：

```text
~/.agentcorps/agentcorps.db
```

其中包括任务、事件、Session、消息、审批和调用统计。使用 `--data-dir` 可以为测试或不同工作区隔离数据。
