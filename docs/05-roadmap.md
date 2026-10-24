# 实施路线图

> 版本：0.1.0

## Phase 0：基线与纵向切片

- pnpm workspace、严格 TypeScript、测试和 lint 基线
- Domain：ID、Task、Run、Event、Capability、Approval
- 内存事件存储与 SQLite 存储端口
- 本地 runtime 健康检查和一个可测试的 mock Agent
- CLI 创建/查看/跟随任务

**完成证据**：从 CLI 创建任务，任务事件可实时跟随，进程重启后可读取已提交事件；单测和集成测试通过。

## Phase 1：真实 Agent 与策略

- JSONL/stdio 进程适配器
- Codex、Claude Code、Cursor 的探测和配置接口
- 工具调用策略、审计、审批和取消
- code/work 模式
- workspace/session/task/run 数据持久化

## Phase 2：记忆与协同

- 三层记忆范围和导出/删除
- 子任务、委派、交接和父子运行图
- 基础工作流 DAG、重试、超时、补偿
- 事件回放和任务恢复

## Phase 3：生态接入

- MCP 客户端能力
- 插件、技能、规则、命令和钩子清单
- 飞书、钉钉、企业微信和自研 App 网关
- OpenAPI、OAuth/OIDC、webhook 和连接器权限

## Phase 4：桌面、远程和沙箱

- Tauri 桌面端
- 手机只读进度和审批界面
- macOS/容器隔离执行器
- 密钥链、备份、迁移和升级

## Phase 5：优化与自进化

- 混合记忆检索、多模型路由、成本和延迟策略
- 可回放评测、质量门和改进提案
- 实验性 A2A 网关和远程执行器
- 性能、故障注入和长期运行稳定性测试

每个 Phase 必须在实现、测试和文档均有证据后才能标记完成；路线图不是对未实现能力的兼容承诺。
