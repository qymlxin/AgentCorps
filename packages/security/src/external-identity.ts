import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
export type ChannelKind = 'feishu' | 'dingtalk' | 'wecom' | 'custom';
export type ExternalIdentityRole = 'user' | 'operator' | 'admin';

export interface ExternalIdentityBinding {
  readonly channel: ChannelKind;
  readonly externalUserId: string;
  readonly deviceId: string;
  readonly roles: readonly ExternalIdentityRole[];
  readonly createdAt: string;
  readonly revokedAt?: string;
}

export interface ExternalIdentityBindingStore {
  save(binding: ExternalIdentityBinding): void;
  get(channel: ChannelKind, externalUserId: string): ExternalIdentityBinding | undefined;
  list(): readonly ExternalIdentityBinding[];
}

export class InMemoryExternalIdentityBindingStore implements ExternalIdentityBindingStore {
  private readonly bindings = new Map<string, ExternalIdentityBinding>();
  save(binding: ExternalIdentityBinding): void { this.bindings.set(key(binding.channel, binding.externalUserId), binding); }
  get(channel: ChannelKind, externalUserId: string): ExternalIdentityBinding | undefined { return this.bindings.get(key(channel, externalUserId)); }
  list(): readonly ExternalIdentityBinding[] { return [...this.bindings.values()]; }
}

interface SqliteStatement { run(...parameters: unknown[]): unknown; all(...parameters: unknown[]): unknown[]; }
interface SqliteDatabase { exec(sql: string): void; prepare(sql: string): SqliteStatement; close(): void; }
const DatabaseSync = (createRequire(import.meta.url)('node:sqlite') as { DatabaseSync: new (filePath: string) => SqliteDatabase }).DatabaseSync;

export class SqliteExternalIdentityBindingStore implements ExternalIdentityBindingStore {
  private readonly db: SqliteDatabase;
  constructor(filePath: string) {
    mkdirSync(dirname(filePath), { recursive: true });
    this.db = new DatabaseSync(filePath);
    this.db.exec('CREATE TABLE IF NOT EXISTS external_identity_bindings (channel TEXT NOT NULL, external_user_id TEXT NOT NULL, device_id TEXT NOT NULL, roles_json TEXT NOT NULL, created_at TEXT NOT NULL, revoked_at TEXT, PRIMARY KEY (channel, external_user_id))');
  }
  save(binding: ExternalIdentityBinding): void {
    this.db.prepare('INSERT INTO external_identity_bindings (channel, external_user_id, device_id, roles_json, created_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(channel, external_user_id) DO UPDATE SET device_id = excluded.device_id, roles_json = excluded.roles_json, created_at = excluded.created_at, revoked_at = excluded.revoked_at').run(binding.channel, binding.externalUserId, binding.deviceId, JSON.stringify(binding.roles), binding.createdAt, binding.revokedAt ?? null);
  }
  get(channel: ChannelKind, externalUserId: string): ExternalIdentityBinding | undefined {
    const row = this.db.prepare('SELECT * FROM external_identity_bindings WHERE channel = ? AND external_user_id = ?').all(channel, externalUserId)[0] as Record<string, unknown> | undefined;
    return row ? fromRow(row) : undefined;
  }
  list(): readonly ExternalIdentityBinding[] { return this.db.prepare('SELECT * FROM external_identity_bindings ORDER BY created_at, channel, external_user_id').all().map((row) => fromRow(row as Record<string, unknown>)); }
  close(): void { this.db.close(); }
}

export class ExternalIdentityResolver {
  constructor(private readonly store: ExternalIdentityBindingStore, private readonly now: () => string = () => new Date().toISOString()) {}

  bind(channel: ChannelKind, externalUserId: string, deviceId: string, roles: readonly ExternalIdentityRole[] = ['user']): ExternalIdentityBinding {
    if (!externalUserId.trim() || !deviceId.trim()) throw new Error('External identity and device identity are required');
    if (!roles.length || roles.some((role) => !['user', 'operator', 'admin'].includes(role))) throw new Error('External identity roles are invalid');
    const binding: ExternalIdentityBinding = { channel, externalUserId: externalUserId.trim(), deviceId: deviceId.trim(), roles: [...new Set(roles)], createdAt: this.now() };
    this.store.save(binding);
    return binding;
  }

  revoke(channel: ChannelKind, externalUserId: string): ExternalIdentityBinding {
    const current = this.store.get(channel, externalUserId);
    if (!current) throw new Error(`External identity not found: ${channel}:${externalUserId}`);
    const revoked = { ...current, revokedAt: this.now() };
    this.store.save(revoked);
    return revoked;
  }

  resolve(channel: ChannelKind, externalUserId: string): ExternalIdentityBinding | undefined {
    const binding = this.store.get(channel, externalUserId);
    return binding && !binding.revokedAt ? binding : undefined;
  }

  require(channel: ChannelKind, externalUserId: string, role: ExternalIdentityRole = 'user'): ExternalIdentityBinding {
    const binding = this.resolve(channel, externalUserId);
    if (!binding) throw new Error(`External identity is not mapped: ${channel}:${externalUserId}`);
    if (!binding.roles.includes(role) && !binding.roles.includes('admin')) throw new Error(`External identity lacks required role: ${role}`);
    return binding;
  }

  list(): readonly ExternalIdentityBinding[] { return this.store.list(); }
}

function key(channel: ChannelKind, externalUserId: string): string { return `${channel}:${externalUserId}`; }
function fromRow(row: Record<string, unknown>): ExternalIdentityBinding {
  return { channel: row.channel as ChannelKind, externalUserId: String(row.external_user_id), deviceId: String(row.device_id), roles: JSON.parse(String(row.roles_json)) as ExternalIdentityRole[], createdAt: String(row.created_at), ...(row.revoked_at ? { revokedAt: String(row.revoked_at) } : {}) };
}
