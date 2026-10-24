# 审批生命周期

> 版本：0.1.0  
> 状态：本地审批实体、过期、批准、拒绝、一次性消费、SQLite 持久化、Gateway 控制面和 MCP/Agent 工具执行接线已实现；SQLite 条件更新已覆盖多实例批准/消费竞争，生产设备 UI 和宿主机锁重试仍需部署级验证。
> 更新日期：2026-10-24

## 1. 为什么需要独立审批实体

`PolicyEngine` 的 `approval_required` 只是一次策略判断，不能直接代表用户已经批准。AgentCorps 使用 `ApprovalService` 将该判断转换为可追踪实体，保留原始 `ToolRequest`、任务 ID、能力、原因、创建时间和过期时间。

审批与策略分开：

- `deny` 不创建审批，调用方必须停止执行。
- `allow` 不创建审批，但仍然写入策略审计。
- `approval_required` 才能创建 `pending` 审批。
- 只有 `pending` 审批可以被批准或拒绝。
- 只有未过期的 `approved` 审批可以被消费一次。

## 2. 状态机

```text
pending ── approve ──> approved ── consume ──> consumed
   │                       │
   ├── deny ───────────────> denied
   │
   └── expiry ─────────────> expired
```

`approved` 在超过 `expiresAt` 后也会变为 `expired`，因此执行器不能只检查批准状态而忽略有效期。`consume` 成功后再次消费返回空结果，避免同一个审批被重放到多个副作用调用。

## 3. 当前实现

实现位置：`packages/security`。

- `Approval`：审批快照和生命周期字段。
- `ApprovalStore`：可替换存储端口。
- `InMemoryApprovalStore`：测试和短生命周期进程的默认实现。
- `ApprovalService.create`：仅接受 `approval_required` 策略结果，并要求正数 TTL。
- `approve`/`deny`：要求非空的审批人，拒绝重复决策。
- `get`/`list`：读取时检查过期。
- `consume`：把已批准审批标记为已消费。

安全审计仍由 `PolicyEngine.evaluate` 负责；审批实体记录决策生命周期，二者通过 `requestId` 和 `taskId` 关联。

## 4. 当前接入与剩余边界

当前 Gateway 暴露审批创建、查询、批准、拒绝和消费路由；CLI 运行路径把审批和审计存入 SQLite。MCP `GuardedMcpToolExecutor` 和 `McpAgentAdapter` 在 `approval_required` 时创建审批，任务运行时进入 `waiting_approval`，恢复执行时校验原始 request ID、任务、工具和参数。

仍需在生产部署中验证：

1. 目标宿主机上的数据库锁等待、进程崩溃恢复和重试策略。
2. 真实控制面设备身份、管理员角色和最小权限映射。
3. 所有厂商 Agent 的工具调用是否都使用该执行器，而不是绕过它启动进程。
4. 容器、macOS sandbox、凭据代理和资源配额在目标宿主机上的实际行为。
