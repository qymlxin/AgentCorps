# Gateway 审批接口

> 版本：0.1.0  
> 状态：已实现显式安全上下文下的策略申请、审批查询、批准、拒绝和一次性消费；审批存储当前默认是进程内存。  
> 更新日期：2026-10-24

## 1. 启用条件

审批路由只有在创建 Gateway 时提供 `GatewayOptions.security.context` 才会启用。策略引擎和审批服务可以由调用方注入；未注入时，Gateway 使用内存审计日志和内存审批存储。

如果没有显式安全上下文，访问 `/approvals` 返回 `503`。这避免了 Gateway 在不知道 workspace 根目录、运行模式和沙箱等级时接受外部安全申请。

## 2. 接口

### 创建策略申请

```text
POST /approvals
```

请求体示例：

```json
{
  "taskId": "task-123",
  "capability": "process.exec",
  "command": "pnpm test",
  "requestId": "optional-id",
  "ttlMs": 300000
}
```

`capability` 只能是安全包已声明的能力：`fs.read`、`fs.write`、`process.exec`、`network.connect` 或 `secret.read`。Gateway 使用配置的 `PolicyEngine` 和 `SecurityContext` 重新计算策略：

- `allow` 返回 `200`，不创建审批。
- `deny` 返回 `403`，不创建审批。
- `approval_required` 返回 `202`，并创建 `pending` Approval。

调用方提交的请求不会覆盖服务端的 workspace、模式或沙箱配置。

### 查询

```text
GET /approvals
GET /approvals/:approvalId
```

### 决策

```text
POST /approvals/:approvalId/approve
POST /approvals/:approvalId/deny
```

请求体需要 `decidedBy`，可以附带 `reason`。如果配置 `allowApprovalDecisions: false`，批准和拒绝会被禁用；这适合把 Gateway 设为只读状态查看端。

### 消费

```text
POST /approvals/:approvalId/consume
```

只有未过期的 `approved` 审批可以消费一次。消费接口只改变审批状态，不执行工具本身；真实工具执行器仍必须校验请求快照并在消费成功后执行一次副作用。

## 3. 安全要求

- Gateway 的 Bearer token 保护仍然适用于审批路由。
- 远程客户端不能提交自己的 `SecurityContext`，包括 workspace 根目录、网络 allowlist 和 sandbox level。
- Approval 绑定原始 `ToolRequest`、task ID、request ID 和过期时间，执行器不能用它扩大到另一个命令、路径、主机或任务。
- 默认内存审批服务适合 fixture 和单进程控制台；长期运行需要 SQLite 持久化、并发更新和设备身份。
- 当前接口提供控制平面状态，不代表已经实现 macOS sandbox、容器隔离或凭据代理。
