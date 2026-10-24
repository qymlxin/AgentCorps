# 多 Agent 协同与委派

> 版本：0.1.0

## 任务关系

AgentCorps 不把子 Agent 建模成同一个会话里的匿名消息，而是为每次委派创建独立的子任务：

- 子任务有自己的 `taskId`、运行、Agent、能力和状态
- `parentTaskId` 连接父任务与子任务
- 子任务的输出仍进入统一事件流，可以从父任务或子任务重放
- 失败、取消和重试只改变对应子任务，不静默覆盖其他 Agent 的结果

## 当前编排接口

`TaskRuntime.delegateTask(parentTaskId, input)` 创建一个带父子关系的任务。

`TaskRuntime.runDelegatedTasks(parentTaskId, assignments, maxConcurrent)`：

1. 先创建全部子任务，保证计划和委派关系可见
2. 以 `maxConcurrent` 为上限执行子任务
3. 每个子任务使用自己的 `AgentAdapter`
4. 返回按委派顺序排列的最终任务状态

并发限制是本地运行时的保护措施，不代表 Agent 之间自动共享所有上下文。需要共享的内容应通过事件、记忆或明确的交接结果传递。

## DAG 工作流

`packages/workflows` 提供独立的 `WorkflowEngine`。它在执行前校验重复节点、未知依赖和循环；运行时按依赖就绪状态调度节点，支持 `maxConcurrent`、节点 `maxAttempts`、节点超时、外部取消、失败后跳过未执行节点，以及按完成逆序调用节点补偿函数。`JsonlWorkflowStore` 保存每次运行快照，进程重启后可使用相同定义和执行器调用 `resume`，运行中的节点会被恢复为下一次尝试。

工作流节点仍需由上层把执行动作绑定到 `TaskRuntime` 或具体 Agent；引擎本身不绕过 AgentCorps 的策略、审批和沙箱。

## 后续协同能力

- 结构化交接包：目标、发现、文件、证据、未决问题和建议
- 父任务聚合状态和部分失败策略
- DAG 工作流、条件分支、人工审批、超时和补偿
- A2A 网络适配器：只在远程身份、信任和幂等语义验证后开放
- 子 Agent 预算、模型路由和工作区隔离
