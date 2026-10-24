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

## 当前限制

- 当前是静态 Bearer 令牌，不是完整的用户身份系统、OAuth/OIDC 或设备配对流程。
- 令牌需要由用户安全生成和保存，不能写入仓库、事件、日志或聊天消息。
- 目前没有细粒度的手机只读角色；在下一阶段会把远程访问限制为任务进度、事件历史和审批视图，并把执行操作保留在本机。
- 公网部署还需要 TLS、反向代理、限流、设备撤销和审计；当前实现不应直接暴露到公网。
