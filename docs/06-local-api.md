# 本地控制面 API

> 版本：0.1.0
> 适用范围：当前仅绑定 `127.0.0.1`，未开放远程认证；移动端/聊天渠道安全接入属于后续阶段。

## 启动与边界

`@agentcorps/gateway` 提供本地 HTTP 和 SSE 控制面。它共享 `TaskRuntime` 的事件流，因此 CLI、桌面端和未来渠道不会建立彼此割裂的会话。

当前路由：

- `GET /health`：健康检查
- `GET /tasks`：列出当前运行时中的任务
- `POST /tasks`：创建任务，JSON 字段为 `workspaceId`、`sessionId`、`title`、`objective`、`mode`
- `GET /tasks/:id`：任务详情和该任务事件历史
- `POST /tasks/:id/run`：使用 mock Agent 启动一次演示运行
- `POST /tasks/:id/cancel`：取消任务
- `POST /tasks/:id/retry`：将失败或取消的任务重新排队
- `GET /events`：SSE 实时事件流

## 例子

```bash
curl http://127.0.0.1:43210/health
curl -X POST http://127.0.0.1:43210/tasks \
  -H 'content-type: application/json' \
  -d '{"title":"Review","objective":"review the workspace","mode":"code"}'
```

## 当前限制

- 任务和事件由调用方传入的 `TaskRuntime` 决定；CLI 默认注入 SQLite 存储，库也保留 JSONL 存储用于导出和调试。
- 当前网关没有远程认证、用户身份、渠道签名校验和细粒度 API 授权，因此不能直接暴露到局域网或公网。
- `/tasks/:id/run` 仅用于验证控制面闭环，正式版本必须由 Agent 选择策略和人工审批决定。
`GET /events` 使用标准 SSE `event`/`data` 字段和空行分隔；客户端断线后需要重新请求任务详情来补齐历史，再从新的事件流继续接收。
