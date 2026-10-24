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

export interface SessionStore {
  saveSession(session: Session): void;
  saveMessage(message: SessionMessage): void;
  archiveSession(id: string, archivedAt: string): Session | undefined;
  getSession(id: string): Session | undefined;
  listSessions(): readonly Session[];
  listMessages(sessionId: string): readonly SessionMessage[];
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

  private append(operation: Operation): void { appendFileSync(this.filePath, `${JSON.stringify(operation)}\n`, 'utf8'); }
  private apply(operation: Operation): void {
    if (operation.session) this.sessions.set(operation.session.id, operation.session);
    if (operation.message) this.messages.set(operation.message.sessionId, [...(this.messages.get(operation.message.sessionId) ?? []), operation.message]);
  }
}

export class InMemorySessionStore implements SessionStore {
  private readonly sessions = new Map<string, Session>();
  private readonly messages = new Map<string, SessionMessage[]>();
  saveSession(session: Session): void { this.sessions.set(session.id, session); }
  saveMessage(message: SessionMessage): void { this.messages.set(message.sessionId, [...(this.messages.get(message.sessionId) ?? []), message]); }
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
