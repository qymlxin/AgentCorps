import { constants, createHash, createPublicKey, createVerify, randomBytes } from 'node:crypto';

export interface OidcDiscoveryDocument {
  readonly issuer: string;
  readonly authorization_endpoint: string;
  readonly token_endpoint: string;
  readonly userinfo_endpoint?: string;
  readonly jwks_uri: string;
  readonly response_types_supported?: readonly string[];
  readonly id_token_signing_alg_values_supported?: readonly string[];
}

export interface OidcClientOptions {
  readonly issuer: string;
  readonly clientId: string;
  readonly clientSecret?: string;
  readonly fetchImpl?: typeof fetch;
  readonly clockSkewSeconds?: number;
  readonly jwksCacheTtlMs?: number;
}

export function createPkceChallenge(codeVerifier: string): string {
  if (!codeVerifier.trim()) throw new Error('OIDC code verifier is required');
  return createHash('sha256').update(codeVerifier, 'utf8').digest('base64url');
}

export interface OidcAuthorizationSession {
  readonly state: string;
  readonly nonce: string;
  readonly codeVerifier: string;
  readonly createdAt: number;
  readonly expiresAt: number;
}

export function createPkceAuthorizationSession(ttlMs = 10 * 60 * 1000, now = Date.now()): OidcAuthorizationSession {
  if (!Number.isInteger(ttlMs) || ttlMs <= 0) throw new Error('OIDC session TTL must be positive');
  const codeVerifier = randomBytes(32).toString('base64url');
  return { state: randomBytes(24).toString('base64url'), nonce: randomBytes(24).toString('base64url'), codeVerifier, createdAt: now, expiresAt: now + ttlMs };
}

export class OidcAuthorizationSessionStore {
  private readonly sessions = new Map<string, OidcAuthorizationSession>();
  constructor(private readonly now: () => number = Date.now) {}
  save(session: OidcAuthorizationSession): void { this.sessions.set(session.state, session); }
  consume(state: string): OidcAuthorizationSession {
    const session = this.sessions.get(state);
    this.sessions.delete(state);
    if (!session || session.expiresAt <= this.now()) throw new OidcProtocolError('callback', 'state is invalid or expired');
    return session;
  }
}

export interface OidcAuthorizationParams {
  readonly redirectUri: string;
  readonly state: string;
  readonly nonce: string;
  readonly scope?: string;
  readonly codeChallenge?: string;
  readonly codeChallengeMethod?: 'S256' | 'plain';
  readonly extra?: Readonly<Record<string, string>>;
}

export interface OidcTokenResponse {
  readonly access_token: string;
  readonly token_type: string;
  readonly expires_in?: number;
  readonly refresh_token?: string;
  readonly id_token?: string;
  readonly scope?: string;
  readonly [key: string]: unknown;
}

export interface OidcIdTokenClaims {
  readonly iss: string;
  readonly sub: string;
  readonly aud: string | readonly string[];
  readonly exp: number;
  readonly iat: number;
  readonly nonce?: string;
  readonly azp?: string;
  readonly [key: string]: unknown;
}

interface JsonRecord { [key: string]: unknown; }
interface JsonWebKey { readonly kty: string; readonly kid?: string; readonly alg?: string; readonly use?: string; readonly [key: string]: unknown; }

export class OidcProtocolError extends Error {
  constructor(readonly operation: string, message: string, readonly status?: number, readonly details?: unknown) {
    super(`OIDC ${operation} failed: ${message}`);
    this.name = 'OidcProtocolError';
  }
}

export class OidcClient {
  private readonly fetchImpl: typeof fetch;
  private discovery?: OidcDiscoveryDocument;
  private jwks?: { expiresAt: number; keys: readonly JsonWebKey[] };

  constructor(private readonly options: OidcClientOptions) {
    assertHttpUrl(options.issuer, 'issuer');
    if (!options.clientId.trim()) throw new Error('OIDC clientId is required');
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async discover(forceRefresh = false): Promise<OidcDiscoveryDocument> {
    if (this.discovery && !forceRefresh) return this.discovery;
    const response = await this.fetchImpl(discoveryUrl(this.options.issuer), { headers: { accept: 'application/json' } });
    const body = await jsonBody(response, 'discovery');
    if (!response.ok) throw new OidcProtocolError('discovery', `HTTP ${response.status}`, response.status, body);
    const document = parseDiscovery(body);
    if (normalizeIssuer(document.issuer) !== normalizeIssuer(this.options.issuer)) throw new OidcProtocolError('discovery', 'issuer does not match the configured issuer');
    this.discovery = document;
    return document;
  }

  async buildAuthorizationUrl(params: OidcAuthorizationParams): Promise<URL> {
    const discovery = await this.discover();
    if (!params.state.trim() || !params.nonce.trim()) throw new Error('OIDC authorization state and nonce are required');
    assertHttpUrl(params.redirectUri, 'redirectUri');
    const url = new URL(discovery.authorization_endpoint);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', this.options.clientId);
    url.searchParams.set('redirect_uri', params.redirectUri);
    url.searchParams.set('scope', params.scope ?? 'openid');
    url.searchParams.set('state', params.state);
    url.searchParams.set('nonce', params.nonce);
    if (params.codeChallenge) {
      url.searchParams.set('code_challenge', params.codeChallenge);
      url.searchParams.set('code_challenge_method', params.codeChallengeMethod ?? 'S256');
    }
    for (const [key, value] of Object.entries(params.extra ?? {})) url.searchParams.set(key, value);
    return url;
  }

  async exchangeAuthorizationCode(code: string, redirectUri: string, codeVerifier?: string): Promise<OidcTokenResponse> {
    if (!code.trim()) throw new Error('OIDC authorization code is required');
    assertHttpUrl(redirectUri, 'redirectUri');
    const discovery = await this.discover();
    const form = new URLSearchParams({ grant_type: 'authorization_code', code, client_id: this.options.clientId, redirect_uri: redirectUri });
    if (codeVerifier) form.set('code_verifier', codeVerifier);
    const headers: Record<string, string> = { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' };
    if (this.options.clientSecret) headers.authorization = `Basic ${Buffer.from(`${this.options.clientId}:${this.options.clientSecret}`).toString('base64')}`;
    const response = await this.fetchImpl(discovery.token_endpoint, { method: 'POST', headers, body: form.toString() });
    const body = await jsonBody(response, 'token');
    if (!response.ok) throw new OidcProtocolError('token', `HTTP ${response.status}`, response.status, body);
    return parseTokenResponse(body);
  }

  async refreshToken(refreshToken: string): Promise<OidcTokenResponse> {
    if (!refreshToken.trim()) throw new Error('OIDC refresh token is required');
    const discovery = await this.discover();
    const form = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: this.options.clientId });
    const headers: Record<string, string> = { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' };
    if (this.options.clientSecret) headers.authorization = `Basic ${Buffer.from(`${this.options.clientId}:${this.options.clientSecret}`).toString('base64')}`;
    const response = await this.fetchImpl(discovery.token_endpoint, { method: 'POST', headers, body: form.toString() });
    const body = await jsonBody(response, 'refresh-token');
    if (!response.ok) throw new OidcProtocolError('refresh-token', `HTTP ${response.status}`, response.status, body);
    return parseTokenResponse(body);
  }

  async userInfo(accessToken: string, expectedSubject?: string): Promise<JsonRecord> {
    if (!accessToken.trim()) throw new Error('OIDC access token is required');
    const discovery = await this.discover();
    if (!discovery.userinfo_endpoint) throw new OidcProtocolError('userinfo', 'discovery document has no userinfo_endpoint');
    const response = await this.fetchImpl(discovery.userinfo_endpoint, { headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' } });
    const body = await jsonBody(response, 'userinfo');
    if (!response.ok) throw new OidcProtocolError('userinfo', `HTTP ${response.status}`, response.status, body);
    if (!isRecord(body)) throw new OidcProtocolError('userinfo', 'response must be a JSON object');
    if (expectedSubject !== undefined && body.sub !== expectedSubject) throw new OidcProtocolError('userinfo', 'sub claim does not match the validated ID token');
    return body;
  }

  async validateIdToken(idToken: string, expectedNonce: string): Promise<OidcIdTokenClaims> {
    if (!idToken.trim()) throw new Error('OIDC ID token is required');
    if (!expectedNonce.trim()) throw new Error('OIDC nonce is required');
    const parsed = parseJwt(idToken);
    const discovery = await this.discover();
    const keys = await this.getJwks(discovery.jwks_uri, false);
    const key = selectKey(keys, parsed.header);
    if (!key) {
      const refreshed = await this.getJwks(discovery.jwks_uri, true);
      const refreshedKey = selectKey(refreshed, parsed.header);
      if (!refreshedKey) throw new OidcProtocolError('id-token', `no JWKS key matches kid ${parsed.header.kid ?? '<missing>'}`);
      verifyJwtSignature(parsed, refreshedKey);
    } else {
      verifyJwtSignature(parsed, key);
    }
    const claims = parsed.payload;
    const audience = claims.aud;
    const audienceValues = typeof audience === 'string' ? [audience] : Array.isArray(audience) && audience.every((value) => typeof value === 'string') ? audience : [];
    const now = Math.floor(Date.now() / 1000);
    const skew = this.options.clockSkewSeconds ?? 60;
    if (normalizeIssuer(String(claims.iss ?? '')) !== normalizeIssuer(discovery.issuer)) throw new OidcProtocolError('id-token', 'issuer claim does not match discovery issuer');
    if (!audienceValues.includes(this.options.clientId)) throw new OidcProtocolError('id-token', 'audience does not include this client');
    if (audienceValues.length > 1 && claims.azp !== this.options.clientId) throw new OidcProtocolError('id-token', 'azp is required for a multi-valued audience');
    if (typeof claims.sub !== 'string' || !claims.sub) throw new OidcProtocolError('id-token', 'subject claim is required');
    if (typeof claims.exp !== 'number' || !Number.isSafeInteger(claims.exp) || claims.exp + skew < now) throw new OidcProtocolError('id-token', 'token is expired');
    if (typeof claims.iat !== 'number' || !Number.isSafeInteger(claims.iat) || claims.iat - skew > now) throw new OidcProtocolError('id-token', 'issued-at claim is invalid');
    if (claims.nonce !== expectedNonce) throw new OidcProtocolError('id-token', 'nonce does not match the authorization request');
    return claims as unknown as OidcIdTokenClaims;
  }

  private async getJwks(uri: string, forceRefresh: boolean): Promise<readonly JsonWebKey[]> {
    const now = Date.now();
    if (!forceRefresh && this.jwks && this.jwks.expiresAt > now) return this.jwks.keys;
    const response = await this.fetchImpl(uri, { headers: { accept: 'application/json' } });
    const body = await jsonBody(response, 'jwks');
    if (!response.ok) throw new OidcProtocolError('jwks', `HTTP ${response.status}`, response.status, body);
    if (!isRecord(body) || !Array.isArray(body.keys) || !body.keys.every(isJsonWebKey)) throw new OidcProtocolError('jwks', 'response must contain a keys array');
    const keys = body.keys;
    this.jwks = { keys, expiresAt: now + (this.options.jwksCacheTtlMs ?? 5 * 60 * 1000) };
    return keys;
  }
}

function parseDiscovery(value: unknown): OidcDiscoveryDocument {
  if (!isRecord(value)) throw new OidcProtocolError('discovery', 'response must be a JSON object');
  const required = ['issuer', 'authorization_endpoint', 'token_endpoint', 'jwks_uri'] as const;
  for (const field of required) if (typeof value[field] !== 'string' || !value[field]) throw new OidcProtocolError('discovery', `missing ${field}`);
  assertHttpUrl(value.issuer as string, 'discovery issuer');
  assertHttpUrl(value.authorization_endpoint as string, 'authorization endpoint');
  assertHttpUrl(value.token_endpoint as string, 'token endpoint');
  assertHttpUrl(value.jwks_uri as string, 'JWKS URI');
  if (value.userinfo_endpoint !== undefined) assertHttpUrl(String(value.userinfo_endpoint), 'userinfo endpoint');
  return value as unknown as OidcDiscoveryDocument;
}

function parseTokenResponse(value: unknown): OidcTokenResponse {
  if (!isRecord(value) || typeof value.access_token !== 'string' || !value.access_token || typeof value.token_type !== 'string' || !value.token_type) throw new OidcProtocolError('token', 'response must contain access_token and token_type');
  return value as unknown as OidcTokenResponse;
}

async function jsonBody(response: Response, operation: string): Promise<unknown> {
  const text = await response.text();
  if (!text) return {};
  try { return JSON.parse(text) as unknown; } catch { throw new OidcProtocolError(operation, 'response is not valid JSON', response.status, text.slice(0, 512)); }
}

function parseJwt(value: string): { header: JsonRecord; payload: JsonRecord; signingInput: string; signature: Buffer } {
  const parts = value.split('.');
  if (parts.length !== 3) throw new OidcProtocolError('id-token', 'JWT must contain three segments');
  const [encodedHeader, encodedPayload, encodedSignature] = parts as [string, string, string];
  let header: unknown; let payload: unknown;
  try { header = JSON.parse(Buffer.from(encodedHeader, 'base64url').toString('utf8')); payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8')); } catch { throw new OidcProtocolError('id-token', 'JWT contains invalid JSON'); }
  if (!isRecord(header) || !isRecord(payload) || typeof header.alg !== 'string') throw new OidcProtocolError('id-token', 'JWT header and claims must be objects');
  return { header, payload, signingInput: `${encodedHeader}.${encodedPayload}`, signature: Buffer.from(encodedSignature, 'base64url') };
}

function selectKey(keys: readonly JsonWebKey[], header: JsonRecord): JsonWebKey | undefined {
  if (typeof header.kid !== 'string') return keys.length === 1 ? keys[0] : undefined;
  return keys.find((key) => key.kid === header.kid);
}

function verifyJwtSignature(parsed: ReturnType<typeof parseJwt>, jwk: JsonWebKey): void {
  const alg = parsed.header.alg;
  if (alg !== 'RS256' && alg !== 'PS256' && alg !== 'ES256') throw new OidcProtocolError('id-token', `unsupported signing algorithm: ${String(alg)}`);
  if (jwk.use && jwk.use !== 'sig') throw new OidcProtocolError('id-token', 'selected JWKS key is not a signing key');
  if (jwk.alg && jwk.alg !== alg) throw new OidcProtocolError('id-token', 'JWKS key algorithm does not match JWT algorithm');
  let key: ReturnType<typeof createPublicKey>;
  try { key = createPublicKey({ key: jwk, format: 'jwk' }); } catch (error) { throw new OidcProtocolError('id-token', 'JWKS key is invalid', undefined, error); }
  const verifier = createVerify(alg === 'ES256' ? 'SHA256' : 'RSA-SHA256');
  verifier.update(parsed.signingInput);
  verifier.end();
  const signature = alg === 'ES256' ? joseToDer(parsed.signature) : parsed.signature;
  const valid = alg === 'PS256'
    ? verifier.verify({ key, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 }, signature)
    : alg === 'RS256'
      ? verifier.verify({ key, padding: constants.RSA_PKCS1_PADDING }, signature)
      : verifier.verify(key, signature);
  if (!valid) throw new OidcProtocolError('id-token', 'JWT signature is invalid');
}

function joseToDer(signature: Buffer): Buffer {
  if (signature.length !== 64) throw new OidcProtocolError('id-token', 'ES256 signature must contain 64 bytes');
  const integer = (value: Buffer) => { const trimmed = value[0] && (value[0] & 0x80) ? Buffer.concat([Buffer.from([0]), value]) : value; return Buffer.concat([Buffer.from([0x02, trimmed.length]), trimmed]); };
  const body = Buffer.concat([integer(signature.subarray(0, 32)), integer(signature.subarray(32))]);
  return Buffer.concat([Buffer.from([0x30, body.length]), body]);
}

function isRecord(value: unknown): value is JsonRecord { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
function isJsonWebKey(value: unknown): value is JsonWebKey { return isRecord(value) && typeof value.kty === 'string'; }
function assertHttpUrl(value: string, field: string): void { try { const url = new URL(value); if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error(); } catch { throw new Error(`OIDC ${field} must be an HTTP(S) URL`); } }
function normalizeIssuer(value: string): string { return value.replace(/\/$/, ''); }
function discoveryUrl(issuer: string): string { const url = new URL(issuer); const path = url.pathname.replace(/\/$/, ''); url.pathname = `${path}/.well-known/openid-configuration`; url.search = ''; url.hash = ''; return url.toString(); }
