import { createRequire } from 'node:module';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

export type SessionMode = 'code' | 'work';
export type MessageRole = 'user' | 'agent' | 'system' | 'tool';

export interface Session {
  readonly id: string;
  readonly workspaceId: string;
  readonly title: string;
  readonly mode: SessionMode;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly archivedAt?: string;
}

export interface SessionMessage {
  readonly id: string;
  readonly sessionId: string;
  readonly role: MessageRole;
  readonly content: string;
  readonly agentId?: string;
  readonly taskId?: string;
  readonly createdAt: string;
}

export interface SessionSearchOptions {
  readonly workspaceId?: string;
  readonly role?: MessageRole;
}

export interface SessionSearchResult {
  readonly session: Session;
  readonly message: SessionMessage;
}

export interface SessionStore {
  saveSession(session: Session): void;
  saveMessage(message: SessionMessage): void;
  archiveSession(id: string, archivedAt: string): Session | undefined;
  getSession(id: string): Session | undefined;
  listSessions(): readonly Session[];
  listMessages(sessionId: string): readonly SessionMessage[];
  searchMessages(query: string, options?: SessionSearchOptions, limit?: number): readonly SessionSearchResult[];
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

export class SqliteSessionStore implements SessionStore {
  private readonly db: SqliteDatabase;

  constructor(filePath: string) {
    mkdirSync(dirname(filePath), { recursive: true });
    this.db = new DatabaseSync(filePath);
    this.db.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        title TEXT NOT NULL,
        mode TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        archived_at TEXT
      );
      CREATE TABLE IF NOT EXISTS session_messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id),
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        agent_id TEXT,
        task_id TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS session_messages_session_idx ON session_messages (session_id, created_at, id);
      CREATE VIRTUAL TABLE IF NOT EXISTS session_messages_fts USING fts5(message_id UNINDEXED, session_id UNINDEXED, role UNINDEXED, content, tokenize = 'unicode61');
    `);
    this.db.prepare('DELETE FROM session_messages_fts').run();
    this.db.prepare('INSERT INTO session_messages_fts (message_id, session_id, role, content) SELECT id, session_id, role, content FROM session_messages').run();
  }

  saveSession(session: Session): void {
    this.db.prepare(`
      INSERT INTO sessions (id, workspace_id, title, mode, created_at, updated_at, archived_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET workspace_id = excluded.workspace_id, title = excluded.title,
        mode = excluded.mode, created_at = excluded.created_at, updated_at = excluded.updated_at,
        archived_at = excluded.archived_at
    `).run(session.id, session.workspaceId, session.title, session.mode, session.createdAt, session.updatedAt, session.archivedAt ?? null);
  }

  saveMessage(message: SessionMessage): void {
    this.db.prepare(`
      INSERT INTO session_messages (id, session_id, role, content, agent_id, task_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET session_id = excluded.session_id, role = excluded.role,
        content = excluded.content, agent_id = excluded.agent_id, task_id = excluded.task_id,
        created_at = excluded.created_at
    `).run(message.id, message.sessionId, message.role, message.content, message.agentId ?? null, message.taskId ?? null, message.createdAt);
    this.db.prepare('DELETE FROM session_messages_fts WHERE message_id = ?').run(message.id);
    this.db.prepare('INSERT INTO session_messages_fts (message_id, session_id, role, content) VALUES (?, ?, ?, ?)').run(message.id, message.sessionId, message.role, message.content);
  }

  archiveSession(id: string, archivedAt: string): Session | undefined {
    const current = this.getSession(id);
    if (!current || current.archivedAt) return undefined;
    const session = { ...current, archivedAt, updatedAt: archivedAt };
    this.saveSession(session);
    return session;
  }

  getSession(id: string): Session | undefined {
    const row = this.db.prepare('SELECT * FROM sessions WHERE id = ?').all(id)[0];
    return row ? sessionFromRow(row as Record<string, unknown>) : undefined;
  }

  listSessions(): readonly Session[] {
    return this.db.prepare('SELECT * FROM sessions ORDER BY created_at, id').all().map((row) => sessionFromRow(row as Record<string, unknown>));
  }

  listMessages(sessionId: string): readonly SessionMessage[] {
    return this.db.prepare('SELECT * FROM session_messages WHERE session_id = ? ORDER BY created_at, id').all(sessionId).map((row) => messageFromRow(row as Record<string, unknown>));
  }

  searchMessages(query: string, options: SessionSearchOptions = {}, limit = 50): readonly SessionSearchResult[] {
    const terms = ftsTerms(query);
    if (!terms) return [];
    const boundedLimit = searchLimit(limit);
    return this.db.prepare(`
      SELECT s.*, m.id AS message_id, m.session_id AS message_session_id, m.role AS message_role,
        m.content AS message_content, m.agent_id AS message_agent_id, m.task_id AS message_task_id,
        m.created_at AS message_created_at
      FROM session_messages_fts f
      JOIN session_messages m ON m.id = f.message_id
      JOIN sessions s ON s.id = m.session_id
      WHERE session_messages_fts MATCH ?
        AND (? IS NULL OR s.workspace_id = ?)
        AND (? IS NULL OR m.role = ?)
      ORDER BY bm25(session_messages_fts), m.created_at DESC, m.id DESC
      LIMIT ?
    `).all(terms, options.workspaceId ?? null, options.workspaceId ?? null, options.role ?? null, options.role ?? null, boundedLimit).map((row) => {
      const value = row as Record<string, unknown>;
      return { session: sessionFromRow(value), message: messageFromJoinedRow(value) };
    });
  }

  close(): void { this.db.close(); }
}

function sessionFromRow(row: Record<string, unknown>): Session {
  return {
    id: String(row.id), workspaceId: String(row.workspace_id), title: String(row.title), mode: row.mode as SessionMode,
    createdAt: String(row.created_at), updatedAt: String(row.updated_at),
    ...(row.archived_at ? { archivedAt: String(row.archived_at) } : {}),
  };
}

function messageFromRow(row: Record<string, unknown>): SessionMessage {
  return {
    id: String(row.id), sessionId: String(row.session_id), role: row.role as MessageRole, content: String(row.content),
    ...(row.agent_id ? { agentId: String(row.agent_id) } : {}), ...(row.task_id ? { taskId: String(row.task_id) } : {}),
    createdAt: String(row.created_at),
  };
}

function messageFromJoinedRow(row: Record<string, unknown>): SessionMessage {
  return {
    id: String(row.message_id), sessionId: String(row.message_session_id), role: row.message_role as MessageRole, content: String(row.message_content),
    ...(row.message_agent_id ? { agentId: String(row.message_agent_id) } : {}), ...(row.message_task_id ? { taskId: String(row.message_task_id) } : {}),
    createdAt: String(row.message_created_at),
  };
}

function ftsTerms(query: string): string {
  return query.trim().split(/\s+/).filter(Boolean).map((term) => `"${term.replaceAll('"', '""')}"*`).join(' OR ');
}

function searchLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit < 1) throw new Error('Session search limit must be a positive integer');
  return Math.min(limit, 100);
}

function sessionSearchMatches(session: Session, message: SessionMessage, query: string, options: SessionSearchOptions): boolean {
  if (session.archivedAt || (options.workspaceId && session.workspaceId !== options.workspaceId) || (options.role && message.role !== options.role)) return false;
  const terms = query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const content = message.content.toLocaleLowerCase();
  return terms.every((term) => content.includes(term));
}

export function migrateSessionStore(source: SessionStore, target: SessionStore): number {
  const sessions = source.listSessions();
  for (const session of sessions) target.saveSession(session);
  let count = sessions.length;
  for (const session of sessions) for (const message of source.listMessages(session.id)) { target.saveMessage(message); count += 1; }
  return count;
}

interface Operation {
  readonly op: 'session' | 'message' | 'archive';
  readonly session?: Session;
  readonly message?: SessionMessage;
}

export class JsonlSessionStore implements SessionStore {
  private readonly sessions = new Map<string, Session>();
  private readonly messages = new Map<string, SessionMessage[]>();

  constructor(private readonly filePath: string) {
    mkdirSync(dirname(filePath), { recursive: true });
    if (!existsSync(filePath)) return;
    for (const line of readFileSync(filePath, 'utf8').split('\n').filter(Boolean)) this.apply(JSON.parse(line) as Operation);
  }

  saveSession(session: Session): void { this.append({ op: 'session', session }); this.apply({ op: 'session', session }); }
  saveMessage(message: SessionMessage): void { this.append({ op: 'message', message }); this.apply({ op: 'message', message }); }
  archiveSession(id: string, archivedAt: string): Session | undefined {
    const current = this.sessions.get(id);
    if (!current || current.archivedAt) return undefined;
    const session = { ...current, archivedAt, updatedAt: archivedAt };
    this.append({ op: 'archive', session });
    this.apply({ op: 'archive', session });
    return session;
  }
  getSession(id: string): Session | undefined { return this.sessions.get(id); }
  listSessions(): readonly Session[] { return [...this.sessions.values()]; }
  listMessages(sessionId: string): readonly SessionMessage[] { return [...(this.messages.get(sessionId) ?? [])]; }
  searchMessages(query: string, options: SessionSearchOptions = {}, limit = 50): readonly SessionSearchResult[] {
    const results: SessionSearchResult[] = [];
    for (const session of this.listSessions()) for (const message of this.listMessages(session.id)) if (sessionSearchMatches(session, message, query, options)) results.push({ session, message });
    return results.slice(0, searchLimit(limit));
  }

  private append(operation: Operation): void { appendFileSync(this.filePath, `${JSON.stringify(operation)}\n`, 'utf8'); }
  private apply(operation: Operation): void {
    if (operation.session) this.sessions.set(operation.session.id, operation.session);
    if (operation.message) {
      const current = this.messages.get(operation.message.sessionId) ?? [];
      const index = current.findIndex((message) => message.id === operation.message!.id);
      if (index >= 0) current[index] = operation.message;
      else current.push(operation.message);
      this.messages.set(operation.message.sessionId, current);
    }
  }
}

export class InMemorySessionStore implements SessionStore {
  private readonly sessions = new Map<string, Session>();
  private readonly messages = new Map<string, SessionMessage[]>();
  saveSession(session: Session): void { this.sessions.set(session.id, session); }
  saveMessage(message: SessionMessage): void {
    const current = this.messages.get(message.sessionId) ?? [];
    const index = current.findIndex((entry) => entry.id === message.id);
    if (index >= 0) current[index] = message;
    else current.push(message);
    this.messages.set(message.sessionId, current);
  }
  archiveSession(id: string, archivedAt: string): Session | undefined {
    const current = this.sessions.get(id);
    if (!current || current.archivedAt) return undefined;
    const session = { ...current, archivedAt, updatedAt: archivedAt };
    this.sessions.set(id, session);
    return session;
  }
  getSession(id: string): Session | undefined { return this.sessions.get(id); }
  listSessions(): readonly Session[] { return [...this.sessions.values()]; }
  listMessages(sessionId: string): readonly SessionMessage[] { return [...(this.messages.get(sessionId) ?? [])]; }
  searchMessages(query: string, options: SessionSearchOptions = {}, limit = 50): readonly SessionSearchResult[] {
    const results: SessionSearchResult[] = [];
    for (const session of this.listSessions()) for (const message of this.listMessages(session.id)) if (sessionSearchMatches(session, message, query, options)) results.push({ session, message });
    return results.slice(0, searchLimit(limit));
  }
}

export class SessionService {
  constructor(
    private readonly store: SessionStore,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly id: (prefix: string) => string = (prefix) => `${prefix}-${crypto.randomUUID()}`,
  ) {}

  create(input: { workspaceId: string; title: string; mode: SessionMode }): Session {
    if (!input.workspaceId.trim() || !input.title.trim()) throw new Error('Session workspaceId and title are required');
    const now = this.now();
    const session: Session = { id: this.id('session'), workspaceId: input.workspaceId, title: input.title.trim(), mode: input.mode, createdAt: now, updatedAt: now };
    this.store.saveSession(session);
    return session;
  }

  get(id: string): Session | undefined { return this.store.getSession(id); }
  list(): readonly Session[] { return this.store.listSessions().filter((session) => !session.archivedAt); }
  messages(sessionId: string): readonly SessionMessage[] { return this.store.listMessages(sessionId); }
  search(query: string, options: SessionSearchOptions = {}, limit = 50): readonly SessionSearchResult[] {
    if (!query.trim()) throw new Error('Session search query cannot be empty');
    return this.store.searchMessages(query, options, limit).filter((result) => !result.session.archivedAt);
  }

  appendMessage(input: { sessionId: string; role: MessageRole; content: string; agentId?: string; taskId?: string }): SessionMessage {
    const session = this.store.getSession(input.sessionId);
    if (!session || session.archivedAt) throw new Error(`Session not found or archived: ${input.sessionId}`);
    if (!input.content.trim()) throw new Error('Message content cannot be empty');
    const message: SessionMessage = { id: this.id('message'), sessionId: input.sessionId, role: input.role, content: input.content, ...(input.agentId ? { agentId: input.agentId } : {}), ...(input.taskId ? { taskId: input.taskId } : {}), createdAt: this.now() };
    this.store.saveMessage(message);
    this.store.saveSession({ ...session, updatedAt: message.createdAt });
    return message;
  }

  archive(id: string): Session | undefined { return this.store.archiveSession(id, this.now()); }
}
