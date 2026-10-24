# 渠道网关与共享会话

> 版本：0.1.0  
> 状态：已实现 webhook 入站、签名校验、消息去重、共享会话和任务创建；真实平台出站 HTTP 发送仍由具体渠道连接器负责。  
> 更新日期：2026-10-24

## 1. 功能范围

`packages/channels` 负责把飞书、钉钉、企业微信和自研渠道的 webhook payload 归一化为 `InboundMessage`，并提供 HMAC-SHA256 校验、消息去重和出站 payload 格式化。

`packages/gateway` 现在负责把归一化消息接入共享运行时：

1. 接收 `POST /channels/:kind/webhook`。
2. 按配置验证 `x-agentcorps-signature` 或 `x-signature`。
3. 使用渠道适配器解析消息身份、会话和文本。
4. 以 `channel:externalConversationId` 为键复用共享 Session。
5. 将入站文本写入 Session 的 user Message。
6. 创建同一 Session 下的 Task，保留 `work`/`code` 模式和事件流关联。
7. 对已处理的外部消息返回 duplicate，而不重复创建消息或任务。

默认情况下，渠道 Session 使用 `work` 模式和 `channel:<kind>` workspace。部署方可以通过 `GatewayOptions.channels` 配置默认模式、workspace、签名密钥和适配器实例。

## 2. HTTP 接口

### 入站 webhook

```text
POST /channels/feishu/webhook
POST /channels/dingtalk/webhook
POST /channels/wecom/webhook
POST /channels/custom/webhook
```

请求体是渠道原始 JSON。配置密钥时，请求必须携带使用原始 UTF-8 请求体计算的十六进制 HMAC-SHA256：

```text
x-agentcorps-signature: <hex digest>
```

首次接收返回 `202`，包含 `session`、`message` 和 `task`。重复的外部消息返回 `200` 与 `{ "accepted": false, "duplicate": true }`。

### 出站 payload 格式化

```text
POST /channels/:kind/outbound
```

请求至少包含 `conversationId` 和 `text`。接口返回适配器生成的渠道 payload，供具体的飞书、钉钉、企业微信或自研 App HTTP connector 发送。当前 gateway 不直接持有各平台的 access token，也不把平台 API 的发送重试伪装成已完成；发送、限流和平台错误应由后续的 provider connector 实现并写入事件。

### 渠道状态

```text
GET /channels
```

返回支持的渠道种类以及是否提供了自定义适配器或 webhook 密钥。该接口只表达本地配置状态，不代表远程平台凭据已经验证成功。

## 3. 安全边界

- 网关全局 Bearer token 仍可保护渠道路由；渠道 HMAC 是第二层入站来源校验。
- HMAC 验证使用固定时间比较，签名以原始请求体为输入，避免解析后重编码造成歧义。
- 渠道文本默认是不可信输入，创建 Task 前不会获得工具权限；Task 运行仍经过 AgentCorps 策略和沙箱。
- 外部用户 ID 当前保留在规范化消息和原始 payload 边界，尚未自动映射为本地设备身份或管理员权限。
- 出站 payload 只做格式化，不代表已发送。凭据、重试、回调校验和审计需要具体平台 connector。

## 4. 已验证行为

Gateway fixture 已覆盖：

- 飞书样式 webhook 的签名验证和消息归一化
- 首条消息创建共享 Session、Message 和 Task
- 相同外部消息 ID 的幂等去重
- 出站 payload 格式化
- 原有健康检查、任务路由、会话路由和 Bearer 认证回归

## 5. 后续工作

1. 为每个平台实现独立 payload schema、时间戳/nonce 校验和官方出站 API connector。
2. 将渠道会话映射、去重记录和发送状态持久化到 SQLite，而不是仅保存在进程内存。
3. 增加设备配对、用户身份映射、群聊权限和管理员审批。
4. 将 Task 状态和增量输出安全地转换为渠道回复，增加限流、分片和失败重试。
5. 在手机远程查看场景中复用同一 Session 与事件流，而不是为渠道创建第二套状态模型。
