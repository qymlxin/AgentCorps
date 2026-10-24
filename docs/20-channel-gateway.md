# 渠道网关与共享会话

> 状态：已实现官方消息 fixture 适配器、回调签名校验、企微 AES-256-CBC 加密 XML 解密/接收方校验/被动回复、持久化去重/会话/投递状态、OAuth/查询参数 token provider、平台业务错误码验证和可注入的官方 outbound connector；外部平台账号、完整业务错误码矩阵和生产回调重放防护仍需部署级验证。
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

入站 webhook 支持飞书事件挑战响应、飞书请求头签名、钉钉时间戳/签名参数，以及企业微信 `msg_signature`、加密 XML、EncodingAESKey 解密和接收方校验配置。企业微信回调需要在 `ChannelGatewayOptions` 中同时配置 `webhookSecrets` 和 `webhookEncryptionKeys`；部署方还应配置 `webhookReceiveIds` 做接收方校验。加密企业微信回调成功后返回官方 XML 被动回复，而不是 JSON 调试响应。

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

请求至少包含 `conversationId` 和 `text`。没有配置 connector 时，接口返回适配器生成的 payload，状态码为 `200`，表示只完成格式化；配置 `ChannelConnector` 后，gateway 将通过 connector 实际发送，成功返回 `202` 和 `{ "delivered": { "statusCode": 200, "attempts": 1 } }` 形式的投递结果。内置 `HttpChannelConnector` 支持自定义 endpoint、headers、超时、网络错误重试，以及 `408`、`429` 和 `5xx` 的退避重试，并遵守 `Retry-After`。它不负责平台 OAuth token 获取，也不把 HTTP 成功伪装成平台业务成功。

### 渠道状态

```text
GET /channels
```

返回支持的渠道种类以及是否提供了自定义适配器或 webhook 密钥。该接口只表达本地配置状态，不代表远程平台凭据已经验证成功。

## 3. 安全边界

- 网关全局 Bearer token 仍可保护渠道路由；渠道 HMAC 是第二层入站来源校验。
- HMAC 验证使用固定时间比较，签名以原始请求体为输入，避免解析后重编码造成歧义。
- 渠道文本默认是不可信输入，创建 Task 前不会获得工具权限；Task 运行仍经过 AgentCorps 策略和沙箱。
- 如果配置了 `ExternalIdentityResolver`，每个外部用户必须先绑定本地 device ID 和角色；未映射、已撤销或角色不足的身份不会创建 Task。管理员角色只在显式绑定后生效。
- 出站 payload 只做格式化，不代表已发送。凭据、重试、回调校验和审计需要具体平台 connector。

## 4. 已验证行为

Gateway fixture 已覆盖：

- 飞书样式 webhook 的签名验证和消息归一化
- 首条消息创建共享 Session、Message 和 Task
- 相同外部消息 ID 的幂等去重
- 出站 payload 格式化
- 企业微信官方风格加密 XML 的 AES-256-CBC 解密、receive id 校验、签名校验和被动回复 XML
- 原有健康检查、任务路由、会话路由和 Bearer 认证回归

## 5. 部署级验证与后续工作

1. 为每个平台配置真实租户凭据，验证 token 轮换、业务错误码和官方回调重放边界。
2. CLI `serve` 已使用 SQLite 保存渠道去重、会话和投递状态；其他自定义 Gateway 部署必须显式注入 `SqliteChannelStateStore`，不能依赖默认内存存储。
3. 为群聊增加按角色和会话范围的细粒度授权，并把管理员绑定变更写入审计日志。
4. 将 Task 状态和增量输出安全地转换为渠道回复，增加限流、分片和失败重试。
5. 在手机远程查看场景中复用同一 Session 与事件流，而不是为渠道创建第二套状态模型。
