# 远程访问与手机查看

> 版本：0.1.0

## 默认状态

网关默认绑定 `127.0.0.1`，本机请求无需令牌。这个默认值降低了个人电脑长期运行时的暴露面。

## 显式开启远程访问

只有在同时指定非回环监听地址和 Bearer 令牌时，CLI 才允许启动远程网关：

```bash
agentcorps serve \
  --host 0.0.0.0 \
  --port 43210 \
  --token 'use-a-long-random-token' \
  --cors-origin 'https://phone.example.com' \
  --data-dir ~/.agentcorps
```

远程请求必须带：

```http
Authorization: Bearer use-a-long-random-token
```

`/health` 可用于健康检查；任务、事件、会话和消息路由仍需要令牌。CORS 只有显式指定来源时才打开。

## 远程权限与部署边界

- CLI 支持完整控制令牌 `--token` 和只读令牌 `--read-only-token`。只读角色可以查看任务、事件、会话、记忆和审批状态，不能创建或运行任务、写入消息、修改记忆、发送渠道消息或批准操作。
- 浏览器控制台使用 WebSocket 事件流并支持断线后的事件历史补发；访问令牌保存在浏览器本地存储，部署方应使用短期令牌并在设备撤销后重新签发。
- OIDC 客户端和设备身份存储可以通过 `tokenVerifier` 接入，但具体提供商的租户注册、撤销查询、密钥轮换和 redirect URI 仍需部署级验证。
- 公网部署仍需要 TLS、反向代理、限流和审计；本地网关不会替代这些边界设施。
