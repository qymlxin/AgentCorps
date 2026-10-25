# 本地控制面 API

> 版本：0.1.0
> 适用范围：默认绑定 `127.0.0.1`；通过 `--token` 可在明确配置 Bearer 认证后绑定其他地址。移动端和聊天渠道使用同一网关，但仍需按部署配置身份绑定。

## 启动与边界

`@agentcorps/gateway` 提供本地 HTTP、SSE 和 WebSocket 控制面。它共享 `TaskRuntime` 的事件流，因此 CLI、桌面端、PWA 和渠道不会建立彼此割裂的任务状态。

当前路由：

- `GET /health`：健康检查
- `GET /tasks`：列出当前运行时中的任务
- `POST /tasks`：创建任务，JSON 字段为 `workspaceId`、`sessionId`、`title`、`objective`、`mode`
- `GET /tasks/:id`：任务详情和该任务事件历史
- `POST /tasks/:id/run`：使用 mock Agent 启动一次演示运行
- `POST /tasks/:id/cancel`：取消任务
- `POST /tasks/:id/retry`：将失败或取消的任务重新排队
- `GET /events`：SSE 实时事件流，支持 `Last-Event-ID` 或 `lastEventId` 补发历史事件
- `GET /ws`：WebSocket 事件流，使用 `agentcorps.v1` 子协议；支持 `Last-Event-ID` 或 `lastEventId` 补发历史事件

## 例子

```bash
curl http://127.0.0.1:43210/health
curl -X POST http://127.0.0.1:43210/tasks \
  -H 'content-type: application/json' \
  -d '{"title":"Review","objective":"review the workspace","mode":"code"}'
```

## 认证与权限

没有配置认证时，网关只适合本机回环使用。Bearer 验证器可以返回完整权限，或返回 `read`、`write`、`approve`、`admin` 角色；只读远程设备只能读取任务、会话、记忆和事件，不能创建、运行、取消、重试或批准操作。健康检查仍然公开。浏览器控制台通过 WebSocket 子协议传递短期访问令牌，避免把令牌写入普通事件内容。

## 可靠性边界

事件流在连接建立时先发送历史，再订阅新增事件；客户端断线后使用最后一个事件 ID 补齐，不需要依赖单次连接不丢包。事件追加和渠道、会话、记忆、审批存储默认使用 SQLite WAL、外键和五秒锁等待。CLI 提供 `data export`、原子备份和恢复命令。

## 当前限制

- 任务和事件由调用方传入的 `TaskRuntime` 决定；CLI 默认注入 SQLite 存储，库也保留 JSONL 存储用于导出和调试。
- 当前网关支持 Bearer token 认证、只读/写入/审批角色、渠道签名校验和外部身份绑定；远程绑定必须配置令牌，生产部署还应配置 CORS、TLS、反向代理和限流。
- `/tasks/:id/run` 默认使用 mock Agent 只验证控制面闭环；CLI 的持久化任务运行可以选择命令型 Agent、MCP、A2A 或 ACP 适配器，正式工具调用仍由策略、审批和沙箱决定。
