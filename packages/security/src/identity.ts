import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export interface DeviceIdentity {
  readonly id: string;
  readonly label: string;
  readonly createdAt: string;
  readonly revokedAt?: string;
}

export interface DeviceIdentityStore {
  save(device: DeviceIdentity): void;
  get(id: string): DeviceIdentity | undefined;
  list(): readonly DeviceIdentity[];
}

export class InMemoryDeviceIdentityStore implements DeviceIdentityStore {
  private readonly devices = new Map<string, DeviceIdentity>();
  save(device: DeviceIdentity): void { this.devices.set(device.id, device); }
  get(id: string): DeviceIdentity | undefined { return this.devices.get(id); }
  list(): readonly DeviceIdentity[] { return [...this.devices.values()]; }
}

interface SqliteStatement { run(...parameters: unknown[]): unknown; all(...parameters: unknown[]): unknown[]; }
interface SqliteDatabase { exec(sql: string): void; prepare(sql: string): SqliteStatement; close(): void; }
const DatabaseSync = (createRequire(import.meta.url)('node:sqlite') as { DatabaseSync: new (filePath: string) => SqliteDatabase }).DatabaseSync;

export class SqliteDeviceIdentityStore implements DeviceIdentityStore {
  private readonly db: SqliteDatabase;
  constructor(filePath: string) {
    mkdirSync(dirname(filePath), { recursive: true });
    this.db = new DatabaseSync(filePath);
    this.db.exec('CREATE TABLE IF NOT EXISTS device_identities (id TEXT PRIMARY KEY, label TEXT NOT NULL, created_at TEXT NOT NULL, revoked_at TEXT)');
  }
  save(device: DeviceIdentity): void {
    this.db.prepare(`INSERT INTO device_identities (id, label, created_at, revoked_at) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET label = excluded.label, created_at = excluded.created_at, revoked_at = excluded.revoked_at`).run(device.id, device.label, device.createdAt, device.revokedAt ?? null);
  }
  get(id: string): DeviceIdentity | undefined {
    const row = this.db.prepare('SELECT * FROM device_identities WHERE id = ?').all(id)[0] as Record<string, unknown> | undefined;
    return row ? deviceFromRow(row) : undefined;
  }
  list(): readonly DeviceIdentity[] { return this.db.prepare('SELECT * FROM device_identities ORDER BY created_at, id').all().map((row) => deviceFromRow(row as Record<string, unknown>)); }
  close(): void { this.db.close(); }
}

export interface AccessTokenClaims {
  readonly subject: string;
  readonly deviceId: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
}

export class SignedAccessTokenService {
  constructor(private readonly secret: string, private readonly issuer = 'agentcorps') {
    if (secret.length < 32) throw new Error('Access token signing secret must contain at least 32 characters');
  }
  issue(device: DeviceIdentity, ttlSeconds = 3600, nowSeconds = Math.floor(Date.now() / 1000)): string {
    if (device.revokedAt) throw new Error('Cannot issue a token for a revoked device');
    if (!Number.isSafeInteger(nowSeconds)) throw new Error('Access token issue time must be a safe integer');
    if (!Number.isInteger(ttlSeconds) || ttlSeconds <= 0) throw new Error('Access token TTL must be positive');
    const header = encode({ alg: 'HS256', typ: 'JWT' });
    const payload = encode({ iss: this.issuer, sub: device.id, device_id: device.id, iat: nowSeconds, exp: nowSeconds + ttlSeconds });
    const signingInput = `${header}.${payload}`;
    return `${signingInput}.${this.sign(signingInput)}`;
  }
  verify(token: string, nowSeconds = Math.floor(Date.now() / 1000)): AccessTokenClaims {
    const parts = token.split('.');
    if (parts.length !== 3) throw new Error('Invalid access token');
    const [header, payload, signature] = parts as [string, string, string];
    const expected = this.sign(`${header}.${payload}`);
    const left = Buffer.from(expected); const right = Buffer.from(signature);
    if (left.length !== right.length || !timingSafeEqual(left, right)) throw new Error('Invalid access token signature');
    const parsedHeader = decode(header);
    const claims = decode(payload);
    if (!isRecord(parsedHeader) || !isRecord(claims)) throw new Error('Invalid access token claims');
    const issuedAt = claims.iat;
    const expiresAt = claims.exp;
    if (parsedHeader.alg !== 'HS256' || parsedHeader.typ !== 'JWT' || claims.iss !== this.issuer || typeof claims.sub !== 'string' || !claims.sub || claims.device_id !== claims.sub || typeof issuedAt !== 'number' || typeof expiresAt !== 'number' || !Number.isSafeInteger(issuedAt) || !Number.isSafeInteger(expiresAt) || expiresAt <= issuedAt || expiresAt <= nowSeconds || issuedAt > nowSeconds + 60) throw new Error('Invalid or expired access token claims');
    return { subject: claims.sub, deviceId: claims.sub, issuedAt, expiresAt };
  }
  private sign(value: string): string { return createHmac('sha256', this.secret).update(value).digest('base64url'); }
}

export interface DeviceTokenPrincipal extends AccessTokenClaims {
  readonly device: DeviceIdentity;
}

/** Verifies both the token signature and the current device lifecycle state. */
export class DeviceTokenVerifier {
  constructor(
    private readonly tokens: SignedAccessTokenService,
    private readonly devices: DeviceIdentityStore,
    private readonly nowSeconds: () => number = () => Math.floor(Date.now() / 1000),
  ) {}

  verify(token: string): DeviceTokenPrincipal | false {
    try {
      const claims = this.tokens.verify(token, this.nowSeconds());
      const device = this.devices.get(claims.deviceId);
      if (!device || device.revokedAt) return false;
      return { ...claims, device };
    } catch {
      return false;
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export interface PairingRequest { readonly code: string; readonly expiresAt: string; readonly deviceLabel: string; }

export class DevicePairingService {
  private readonly pending = new Map<string, { label: string; expiresAt: number }>();
  constructor(private readonly store: DeviceIdentityStore, private readonly now: () => number = () => Date.now()) {}
  create(label: string, ttlMs = 5 * 60 * 1000): PairingRequest {
    if (!label.trim()) throw new Error('Device label is required');
    if (!Number.isInteger(ttlMs) || ttlMs <= 0) throw new Error('Pairing TTL must be positive');
    const code = randomBytes(5).toString('hex').toUpperCase();
    const expiresAt = this.now() + ttlMs;
    this.pending.set(code, { label: label.trim(), expiresAt });
    return { code, deviceLabel: label.trim(), expiresAt: new Date(expiresAt).toISOString() };
  }
  redeem(code: string, id = `device-${randomBytes(12).toString('hex')}`): DeviceIdentity {
    const normalized = code.trim().toUpperCase();
    const pending = this.pending.get(normalized);
    if (!pending || pending.expiresAt <= this.now()) { this.pending.delete(normalized); throw new Error('Pairing code is invalid or expired'); }
    this.pending.delete(normalized);
    const device = { id, label: pending.label, createdAt: new Date(this.now()).toISOString() };
    this.store.save(device);
    return device;
  }
  revoke(id: string): DeviceIdentity {
    const device = this.store.get(id);
    if (!device) throw new Error(`Device not found: ${id}`);
    const revoked = { ...device, revokedAt: new Date(this.now()).toISOString() };
    this.store.save(revoked);
    return revoked;
  }
}

function deviceFromRow(row: Record<string, unknown>): DeviceIdentity {
  return { id: String(row.id), label: String(row.label), createdAt: String(row.created_at), ...(row.revoked_at ? { revokedAt: String(row.revoked_at) } : {}) };
}
function encode(value: unknown): string { return Buffer.from(JSON.stringify(value)).toString('base64url'); }
function decode(value: string): unknown { try { return JSON.parse(Buffer.from(value, 'base64url').toString('utf8')); } catch { throw new Error('Invalid access token encoding'); } }
