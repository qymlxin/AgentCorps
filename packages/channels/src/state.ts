import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ChannelDeliveryResult, ChannelKind } from './index.js';

export interface ChannelStateStore {
  claimInbound(channel: ChannelKind, externalMessageId: string): boolean;
  getSessionId(key: string): string | undefined;
  setSessionId(key: string, sessionId: string): void;
  recordDelivery(key: string, message: { channel: ChannelKind; externalConversationId: string }, result: ChannelDeliveryResult): void;
}

export class InMemoryChannelStateStore implements ChannelStateStore {
  private readonly inbound = new Set<string>();
  private readonly sessions = new Map<string, string>();
  private readonly deliveries = new Map<string, ChannelDeliveryResult>();

  claimInbound(channel: ChannelKind, externalMessageId: string): boolean {
    const key = `${channel}:${externalMessageId}`;
    if (this.inbound.has(key)) return false;
    this.inbound.add(key);
    return true;
  }

  getSessionId(key: string): string | undefined { return this.sessions.get(key); }
  setSessionId(key: string, sessionId: string): void { this.sessions.set(key, sessionId); }
  recordDelivery(key: string, _message: { channel: ChannelKind; externalConversationId: string }, result: ChannelDeliveryResult): void { this.deliveries.set(key, result); }
}

interface SqliteStatement {
  run(...parameters: unknown[]): unknown;
  all(...parameters: unknown[]): unknown[];
}

interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}

const DatabaseSync = (createRequire(import.meta.url)('node:sqlite') as { DatabaseSync: new (filePath: string) => SqliteDatabase }).DatabaseSync;

export class SqliteChannelStateStore implements ChannelStateStore {
  private readonly db: SqliteDatabase;

  constructor(filePath: string) {
    mkdirSync(dirname(filePath), { recursive: true });
    this.db = new DatabaseSync(filePath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS channel_inbound_messages (
        channel TEXT NOT NULL,
        external_message_id TEXT NOT NULL,
        claimed_at TEXT NOT NULL,
        PRIMARY KEY (channel, external_message_id)
      );
      CREATE TABLE IF NOT EXISTS channel_sessions (
        session_key TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS channel_deliveries (
        delivery_key TEXT PRIMARY KEY,
        channel TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        status_code INTEGER NOT NULL,
        attempts INTEGER NOT NULL,
        recorded_at TEXT NOT NULL
      );
    `);
  }

  claimInbound(channel: ChannelKind, externalMessageId: string): boolean {
    const existing = this.db.prepare('SELECT 1 FROM channel_inbound_messages WHERE channel = ? AND external_message_id = ?').all(channel, externalMessageId);
    if (existing.length) return false;
    try {
      this.db.prepare('INSERT INTO channel_inbound_messages (channel, external_message_id, claimed_at) VALUES (?, ?, ?)').run(channel, externalMessageId, new Date().toISOString());
      return true;
    } catch (error) {
      if (String(error).toLowerCase().includes('constraint')) return false;
      throw error;
    }
  }

  getSessionId(key: string): string | undefined {
    const row = this.db.prepare('SELECT session_id FROM channel_sessions WHERE session_key = ?').all(key)[0] as Record<string, unknown> | undefined;
    return row ? String(row.session_id) : undefined;
  }

  setSessionId(key: string, sessionId: string): void {
    this.db.prepare(`
      INSERT INTO channel_sessions (session_key, session_id, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(session_key) DO UPDATE SET session_id = excluded.session_id, updated_at = excluded.updated_at
    `).run(key, sessionId, new Date().toISOString());
  }

  recordDelivery(key: string, message: { channel: ChannelKind; externalConversationId: string }, result: ChannelDeliveryResult): void {
    this.db.prepare(`
      INSERT INTO channel_deliveries (delivery_key, channel, conversation_id, status_code, attempts, recorded_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(delivery_key) DO UPDATE SET status_code = excluded.status_code, attempts = excluded.attempts, recorded_at = excluded.recorded_at
    `).run(key, message.channel, message.externalConversationId, result.statusCode, result.attempts, new Date().toISOString());
  }

  close(): void { this.db.close(); }
}
