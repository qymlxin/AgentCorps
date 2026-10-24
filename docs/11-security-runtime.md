# 安全策略与沙箱边界

> 版本：0.1.0

## 策略层

`packages/security` 的 `PolicyEngine` 对以下能力返回三种明确结果：

- `allow`：当前策略允许执行
- `approval_required`：需要用户明确批准，策略本身不自动放行
- `deny`：当前上下文禁止执行

第一版覆盖文件读取、文件写入、进程执行、网络连接和秘密读取，并把每次决定写入 `AuditLog`。路径判断使用规范化后的相对路径，防止 `..` 越界；网络在 allowlist 模式下按主机名匹配。

## 模式与默认策略

- code 模式可以在 S2 及以上允许工作区内写入，但进程执行、联网和秘密读取仍需审批。
- work 模式的文件写入也需要审批，避免办公自动化静默修改或外发资料。
- S0/S1 不允许写入或进程执行；默认网络关闭。

## 执行与凭据

`packages/security` 提供 `SandboxedCommandRunner`：macOS 后端生成 `sandbox-exec` profile，容器后端生成 Docker `--network none`、工作区挂载和固定工作目录参数。`CredentialProxy` 只向白名单变量发放凭据，并在 stdout/stderr 返回前做脱敏。调用方仍必须先通过 `PolicyEngine` 和 `ApprovalService`，这些执行器不会自行提升权限。

人工审批实体支持过期、批准、拒绝、一次性消费以及 SQLite 持久化；审批必须绑定完整工具请求，不能用宽泛批准覆盖不同参数。

## 当前边界

策略、沙箱命令生成和凭据脱敏已经具备可测试实现，但当前 Gateway 和 Agent 适配器尚未自动把每个外部工具调用切换到 `SandboxedCommandRunner`。macOS profile 的网络能力只有 none/full 两档，容器后端依赖宿主 Docker，生产环境仍需要对 workspace 挂载、镜像来源、进程资源配额和凭据生命周期做部署级验证。

后续仍需要：

- 将实际工具执行器统一接入策略、审批、沙箱和审计事件
- 命令解析与风险分类，不依赖字符串黑名单
- 插件/MCP/Agent 来源签名和供应链扫描
- macOS/container 的真实安装环境、资源限制和故障注入测试
