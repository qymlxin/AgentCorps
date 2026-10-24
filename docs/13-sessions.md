# 会话互通

> 版本：0.1.0

## 统一模型

`packages/session` 将持续交互拆成会话和消息：

- 会话关联工作区和工作模式
- 消息有 `user`、`agent`、`system`、`tool` 角色
- 消息可以关联 Agent 和任务
- 会话与消息使用 SQLite 持久化；旧版 JSONL 存储仍用于迁移和 fixture
- 会话可以归档；归档后不再接受新消息

## API 路由

- `GET /sessions`
- `POST /sessions`：`workspaceId`、`title`、`mode`
- `GET /sessions/:id`
- `POST /sessions/:id/messages`：`role`、`content`，可选 `agentId`、`taskId`
- `POST /sessions/:id/archive`

CLI 启动网关时会在 `--data-dir` 下使用同一个 `agentcorps.db` 保存任务事件、会话和消息。桌面端、手机页面、飞书/钉钉/企业微信适配器应只调用这些控制面，不直接写文件。

## 后续工作

- 将会话事件统一纳入事件溯源和 SQLite 索引
- 将用户消息创建任务/运行绑定到策略和 Agent 选择
- 增加消息编辑、引用、附件和多模态内容
- 对跨渠道身份和会话绑定增加认证、租户隔离和幂等键
