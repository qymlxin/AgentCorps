# 审批生命周期

> 版本：0.1.0  
> 状态：本地审批实体、过期、批准、拒绝和一次性消费已实现；尚未接入 Gateway UI、SQLite 持久化和实际工具执行器。  
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

## 4. 尚未完成的接入

当前实现是安全领域基础功能，不宣称已经保护所有真实工具调用。后续执行器必须：

1. 调用策略引擎并在 `approval_required` 时创建审批。
2. 通过本地控制台、CLI 或远程设备展示待审批请求的最小必要信息。
3. 用户批准后校验 `requestId`、`taskId`、能力参数、workspace 和过期时间。
4. 消费审批后才执行一次副作用操作，并把结果写入审计事件。
5. 将审批存储迁移到 SQLite，支持进程重启恢复、设备身份和并发决策。
6. 对路径、命令、主机和秘密范围做不可扩大权限的绑定，不能用一个宽泛批准覆盖后续任意请求。

在这些接入完成前，`ApprovalService` 不能被视为操作系统级沙箱；它只是策略和人工决策之间的可验证状态边界。
