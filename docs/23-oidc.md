# OIDC 协议边界

> 版本：0.1.0
> 状态：无状态协议客户端和本地 fixture 已验证；真实身份提供商联调仍需在集成环境完成。

`packages/security` 的 `OidcClient` 只负责 OIDC 协议边界，不替代 Gateway 的认证注入。它提供：

- discovery 文档请求和 issuer、端点 URL 校验
- authorization code URL 构建，包含 state、nonce 和可选 PKCE
- 一次性 PKCE 登录会话、state/nonce 生命周期和 code challenge 生成
- authorization code 到 token 的表单交换，以及 refresh token 轮换请求
- Bearer userinfo 请求，并可校验 userinfo 的 `sub` 与已验证 ID token 一致
- RS256、PS256、ES256 ID token 签名验证
- issuer、audience、azp、nonce、exp 和 iat 校验
- JWKS 缓存；发现未知 `kid` 时强制刷新一次，支持密钥轮换

Gateway 仍只接受 `tokenVerifier` 这一认证注入点。接入具体 OIDC 提供商时，调用方必须决定 access token 的验证方式：本地 JWT/JWKS、userinfo 或提供商的 introspection endpoint。只有能返回可信验证结果的 verifier 才能接入 Gateway。

本地 fixture 证明的是协议实现和拒绝条件，不证明任何供应商租户、客户端注册、redirect URI、密钥轮换策略或生产网络配置已经可用。真实接入还必须验证：

1. provider discovery 与 issuer 完全一致。
2. 注册的 redirect URI、PKCE 策略和 client authentication 与部署配置一致。
3. 真实 JWKS 轮换、未知 `kid`、撤销和过期行为。
4. access token 与 ID token 的用途边界，不能把未经签名校验的 ID token 当作 Gateway bearer token。
5. Gateway verifier 的超时、缓存、撤销和失败关闭策略。
