import type { ChannelConnector, ChannelDeliveryResult, HttpChannelConnectorOptions, OutboundMessage } from './index.js';
import { HttpChannelConnector } from './index.js';

export interface AccessTokenProvider {
  getToken(): Promise<string>;
  invalidate(): void;
}

export interface OAuthClientCredentialsOptions {
  readonly tokenEndpoint: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly scope?: string;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
}

interface OAuthTokenResponse {
  readonly access_token?: string;
  readonly expires_in?: number;
  readonly token_type?: string;
}

export class OAuthClientCredentialsTokenProvider implements AccessTokenProvider {
  private readonly fetchImpl: typeof fetch;
  private cached: { token: string; expiresAt: number } | undefined;

  constructor(private readonly options: OAuthClientCredentialsOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async getToken(): Promise<string> {
    if (this.cached && this.cached.expiresAt > Date.now()) return this.cached.token;
    const response = await this.fetchImpl(this.options.tokenEndpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: this.options.clientId, client_secret: this.options.clientSecret, ...(this.options.scope ? { scope: this.options.scope } : {}) }).toString(),
      signal: AbortSignal.timeout(positiveInteger(this.options.timeoutMs, 10_000)),
    });
    if (!response.ok) throw new Error(`OAuth token request failed: HTTP ${response.status}`);
    const body = await response.json() as OAuthTokenResponse;
    if (!body.access_token) throw new Error('OAuth token response is missing access_token');
    const lifetime = positiveInteger(body.expires_in, 300);
    this.cached = { token: body.access_token, expiresAt: Date.now() + Math.max(1_000, (lifetime - 30) * 1_000) };
    return body.access_token;
  }

  invalidate(): void { this.cached = undefined; }
}

export interface FeishuTenantTokenOptions {
  readonly appId: string;
  readonly appSecret: string;
  readonly endpoint?: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

export class FeishuTenantTokenProvider implements AccessTokenProvider {
  private readonly fetchImpl: typeof fetch;
  private cached: { token: string; expiresAt: number } | undefined;
  constructor(private readonly options: FeishuTenantTokenOptions) { this.fetchImpl = options.fetchImpl ?? fetch; }
  async getToken(): Promise<string> {
    if (this.cached && this.cached.expiresAt > Date.now()) return this.cached.token;
    const response = await this.fetchImpl(this.options.endpoint ?? 'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ app_id: this.options.appId, app_secret: this.options.appSecret }), signal: AbortSignal.timeout(positiveInteger(this.options.timeoutMs, 10_000)),
    });
    if (!response.ok) throw new Error(`Feishu token request failed: HTTP ${response.status}`);
    const body = await response.json() as { tenant_access_token?: string; expire?: number; code?: number; msg?: string };
    if (!body.tenant_access_token) throw new Error(`Feishu token response is invalid: ${body.msg ?? 'missing tenant_access_token'}`);
    this.cached = { token: body.tenant_access_token, expiresAt: Date.now() + Math.max(1_000, (positiveInteger(body.expire, 7_200) - 60) * 1_000) };
    return body.tenant_access_token;
  }
  invalidate(): void { this.cached = undefined; }
}

export interface QueryTokenProviderOptions {
  readonly endpoint: string;
  readonly query: Readonly<Record<string, string>>;
  readonly providerName: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

export class QueryTokenProvider implements AccessTokenProvider {
  private readonly fetchImpl: typeof fetch;
  private cached: { token: string; expiresAt: number } | undefined;
  constructor(private readonly options: QueryTokenProviderOptions) { this.fetchImpl = options.fetchImpl ?? fetch; }
  async getToken(): Promise<string> {
    if (this.cached && this.cached.expiresAt > Date.now()) return this.cached.token;
    const url = new URL(this.options.endpoint);
    for (const [key, value] of Object.entries(this.options.query)) url.searchParams.set(key, value);
    const response = await this.fetchImpl(url, { signal: AbortSignal.timeout(positiveInteger(this.options.timeoutMs, 10_000)) });
    if (!response.ok) throw new Error(`${this.options.providerName} token request failed: HTTP ${response.status}`);
    const body = await response.json() as { access_token?: string; expires_in?: number; errcode?: number; errmsg?: string };
    if (!body.access_token) throw new Error(`${this.options.providerName} token response is invalid: ${body.errmsg ?? 'missing access_token'}`);
    this.cached = { token: body.access_token, expiresAt: Date.now() + Math.max(1_000, (positiveInteger(body.expires_in, 7_200) - 60) * 1_000) };
    return body.access_token;
  }
  invalidate(): void { this.cached = undefined; }
}

export function createDingTalkTokenProvider(appKey: string, appSecret: string, fetchImpl?: typeof fetch): QueryTokenProvider {
  return new QueryTokenProvider({ endpoint: 'https://oapi.dingtalk.com/gettoken', query: { appkey: appKey, appsecret: appSecret }, providerName: 'DingTalk', ...(fetchImpl ? { fetchImpl } : {}) });
}

export function createWecomTokenProvider(corpId: string, corpSecret: string, fetchImpl?: typeof fetch): QueryTokenProvider {
  return new QueryTokenProvider({ endpoint: 'https://qyapi.weixin.qq.com/cgi-bin/gettoken', query: { corpid: corpId, corpsecret: corpSecret }, providerName: 'WeCom', ...(fetchImpl ? { fetchImpl } : {}) });
}
export class SpacedRateLimiter {
  private nextAvailableAt = 0;
  private queue = Promise.resolve();

  constructor(private readonly requestsPerSecond: number, private readonly burst = 1) {
    if (!Number.isFinite(requestsPerSecond) || requestsPerSecond <= 0) throw new Error('requestsPerSecond must be positive');
    if (!Number.isInteger(burst) || burst < 1) throw new Error('burst must be a positive integer');
  }

  acquire(): Promise<void> {
    const operation = this.queue.then(async () => {
      const interval = 1_000 / this.requestsPerSecond;
      const now = Date.now();
      const firstAvailable = this.nextAvailableAt === 0 ? now : this.nextAvailableAt - interval * Math.max(0, this.burst - 1);
      const waitUntil = Math.max(now, firstAvailable);
      if (waitUntil > now) await delay(waitUntil - now);
      this.nextAvailableAt = Math.max(this.nextAvailableAt, waitUntil) + interval;
    });
    this.queue = operation.catch(() => undefined);
    return operation;
  }
}

export interface OAuthHttpChannelConnectorOptions extends Omit<HttpChannelConnectorOptions, 'headers' | 'fetchImpl'> {
  readonly tokenProvider: AccessTokenProvider;
  readonly headers?: Readonly<Record<string, string>>;
  readonly rateLimiter?: SpacedRateLimiter;
  readonly fetchImpl?: typeof fetch;
}

export class OAuthHttpChannelConnector implements ChannelConnector {
  constructor(private readonly options: OAuthHttpChannelConnectorOptions) {}

  async send(message: OutboundMessage, payload: unknown): Promise<ChannelDeliveryResult> {
    const fetchImpl = this.options.fetchImpl ?? fetch;
    let refreshed = false;
    const delegate = new HttpChannelConnector({
      endpoint: this.options.endpoint,
      ...(this.options.timeoutMs !== undefined ? { timeoutMs: this.options.timeoutMs } : {}),
      ...(this.options.maxAttempts !== undefined ? { maxAttempts: this.options.maxAttempts } : {}),
      ...(this.options.backoffMs !== undefined ? { backoffMs: this.options.backoffMs } : {}),
      ...(this.options.headers ? { headers: this.options.headers } : {}),
      fetchImpl: async (input, init) => {
        const call = async (): Promise<Response> => {
          await this.options.rateLimiter?.acquire();
          const token = await this.options.tokenProvider.getToken();
          return await fetchImpl(input, { ...init, headers: { ...(init?.headers ?? {}), authorization: `Bearer ${token}` } });
        };
        let response = await call();
        if (response.status === 401 && !refreshed) {
          refreshed = true;
          this.options.tokenProvider.invalidate();
          response = await call();
        }
        return response;
      },
    });
    return await delegate.send(message, payload);
  }
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && value! > 0 ? value! : fallback;
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}
