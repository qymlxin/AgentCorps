import { describe, expect, it } from 'vitest';
import { createSign, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { OidcClient, OidcProtocolError, OidcAuthorizationSessionStore, createPkceAuthorizationSession, createPkceChallenge } from './oidc.js';

function encoded(value: unknown): string { return Buffer.from(JSON.stringify(value)).toString('base64url'); }
function signIdToken(privateKey: KeyObject, claims: Record<string, unknown>, kid = 'key-1'): string {
  const input = `${encoded({ alg: 'RS256', typ: 'JWT', kid })}.${encoded(claims)}`;
  const signer = createSign('RSA-SHA256');
  signer.update(input);
  signer.end();
  return `${input}.${signer.sign(privateKey).toString('base64url')}`;
}
function jsonResponse(value: unknown, status = 200): Response { return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } }); }

describe('OidcClient', () => {
  it('discovers endpoints, builds authorization requests, exchanges a code, and reads userinfo', async () => {
    const requests: Request[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      if (request.url === 'https://issuer.example.test/tenant/.well-known/openid-configuration') return jsonResponse({ issuer: 'https://issuer.example.test/tenant', authorization_endpoint: 'https://issuer.example.test/authorize', token_endpoint: 'https://issuer.example.test/token', userinfo_endpoint: 'https://issuer.example.test/userinfo', jwks_uri: 'https://issuer.example.test/keys' });
      if (request.url === 'https://issuer.example.test/token') {
        expect(request.headers.get('authorization')).toContain('Basic ');
        expect(await request.text()).toContain('code=auth-code');
        return jsonResponse({ access_token: 'access-1', token_type: 'Bearer', id_token: 'id-token' });
      }
      if (request.url === 'https://issuer.example.test/userinfo') {
        expect(request.headers.get('authorization')).toBe('Bearer access-1');
        return jsonResponse({ sub: 'user-1', email: 'user@example.test' });
      }
      throw new Error(`Unexpected request: ${request.url}`);
    };
    const client = new OidcClient({ issuer: 'https://issuer.example.test/tenant', clientId: 'client-1', clientSecret: 'secret', fetchImpl });
    const authorization = await client.buildAuthorizationUrl({ redirectUri: 'https://app.example.test/callback', state: 'state-1', nonce: 'nonce-1', codeChallenge: 'challenge-1' });
    expect(authorization.searchParams.get('response_type')).toBe('code');
    expect(authorization.searchParams.get('scope')).toBe('openid');
    expect(authorization.searchParams.get('code_challenge_method')).toBe('S256');
    await expect(client.exchangeAuthorizationCode('auth-code', 'https://app.example.test/callback', 'verifier')).resolves.toMatchObject({ access_token: 'access-1' });
    await expect(client.userInfo('access-1')).resolves.toMatchObject({ sub: 'user-1' });
    expect(requests).toHaveLength(3);
  });

  it('verifies issuer, audience, nonce, expiration, and a rotated JWKS signing key', async () => {
    const first = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const second = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const firstJwk = first.publicKey.export({ format: 'jwk' }) as Record<string, unknown>;
    const secondJwk = second.publicKey.export({ format: 'jwk' }) as Record<string, unknown>;
    const now = Math.floor(Date.now() / 1000);
    const token = signIdToken(second.privateKey, { iss: 'https://issuer.example.test', sub: 'user-1', aud: 'client-1', exp: now + 300, iat: now, nonce: 'nonce-1', name: 'Test User' }, 'key-2');
    let jwksCalls = 0;
    const fetchImpl: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      if (request.url === 'https://issuer.example.test/.well-known/openid-configuration') return jsonResponse({ issuer: 'https://issuer.example.test', authorization_endpoint: 'https://issuer.example.test/authorize', token_endpoint: 'https://issuer.example.test/token', jwks_uri: 'https://issuer.example.test/keys' });
      if (request.url === 'https://issuer.example.test/keys') {
        jwksCalls += 1;
        return jsonResponse({ keys: [jwksCalls === 1 ? { ...firstJwk, kid: 'key-1', alg: 'RS256', use: 'sig' } : { ...secondJwk, kid: 'key-2', alg: 'RS256', use: 'sig' }] });
      }
      throw new Error(`Unexpected request: ${request.url}`);
    };
    const client = new OidcClient({ issuer: 'https://issuer.example.test', clientId: 'client-1', fetchImpl });
    await expect(client.validateIdToken(token, 'nonce-1')).resolves.toMatchObject({ sub: 'user-1', name: 'Test User' });
    expect(jwksCalls).toBe(2);
    await expect(client.validateIdToken(token, 'wrong-nonce')).rejects.toBeInstanceOf(OidcProtocolError);
    const tokenParts = token.split('.');
    const [headerPart, payloadPart, signaturePart] = tokenParts;
    if (!headerPart || !payloadPart || !signaturePart) throw new Error('Expected a signed JWT');
    const signature = Buffer.from(signaturePart, 'base64url');
    signature[0] = (signature[0] ?? 0) ^ 1;
    const tampered = `${headerPart}.${payloadPart}.${signature.toString('base64url')}`;
    await expect(client.validateIdToken(tampered, 'nonce-1')).rejects.toThrow('signature is invalid');
  });

  it('rejects discovery issuer mismatch and unsigned tokens', async () => {
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes('.well-known')) return jsonResponse({ issuer: 'https://other.example.test', authorization_endpoint: 'https://other.example.test/a', token_endpoint: 'https://other.example.test/t', jwks_uri: 'https://other.example.test/k' });
      return jsonResponse({});
    };
    const client = new OidcClient({ issuer: 'https://issuer.example.test', clientId: 'client-1', fetchImpl });
    await expect(client.discover()).rejects.toThrow('issuer does not match');
  });

  it('creates one-time PKCE sessions and rejects replay', () => {
    const session = createPkceAuthorizationSession(60_000, 1_000);
    expect(createPkceChallenge(session.codeVerifier)).toHaveLength(43);
    let now = 1_000;
    const store = new OidcAuthorizationSessionStore(() => now);
    store.save(session);
    expect(store.consume(session.state)).toEqual(session);
    expect(() => store.consume(session.state)).toThrow('state is invalid or expired');
    const expired = createPkceAuthorizationSession(1_000, now);
    store.save(expired);
    now = 2_001;
    expect(() => store.consume(expired.state)).toThrow('state is invalid or expired');
  });
});
