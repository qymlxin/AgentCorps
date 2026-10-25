import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { JsonlSessionStore, migrateSessionStore, SessionService, SqliteSessionStore } from './index.js';

describe('sessions', () => {
  it('shares session messages after reopening the JSONL store', () => {
    const directory = mkdtempSync(join(tmpdir(), 'agentcorps-session-'));
    const path = join(directory, 'sessions.jsonl');
    try {
      let sequence = 0;
      const first = new SessionService(new JsonlSessionStore(path), () => '2026-10-24T00:00:00.000Z', (prefix) => `${prefix}-${++sequence}`);
      const session = first.create({ workspaceId: 'ws', title: 'Shared thread', mode: 'code' });
      first.appendMessage({ sessionId: session.id, role: 'user', content: 'Continue this from the CLI' });
      first.appendMessage({ sessionId: session.id, role: 'agent', content: 'I found the previous context' });

      const second = new SessionService(new JsonlSessionStore(path));
      expect(second.get(session.id)?.title).toBe('Shared thread');
      expect(second.messages(session.id).map((message) => message.content)).toEqual(['Continue this from the CLI', 'I found the previous context']);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('migrates sessions and messages into SQLite and reopens them', () => {
    const directory = mkdtempSync(join(tmpdir(), 'agentcorps-session-sqlite-'));
    const sourcePath = join(directory, 'sessions.jsonl');
    const databasePath = join(directory, 'agentcorps.db');
    try {
      const sourceService = new SessionService(new JsonlSessionStore(sourcePath), () => '2026-10-24T00:00:00.000Z', (prefix) => `${prefix}-1`);
      const session = sourceService.create({ workspaceId: 'ws', title: 'Migrated session', mode: 'code' });
      sourceService.appendMessage({ sessionId: session.id, role: 'user', content: 'migrated message' });
      const target = new SqliteSessionStore(databasePath);
      expect(migrateSessionStore(new JsonlSessionStore(sourcePath), target)).toBe(2);
      expect(new SessionService(target).messages(session.id)[0]?.content).toBe('migrated message');
      target.close();
      const reopened = new SqliteSessionStore(databasePath);
      expect(new SessionService(reopened).get(session.id)?.title).toBe('Migrated session');
      reopened.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('does not return archived sessions and rejects new messages after archive', () => {
    const service = new SessionService(new JsonlSessionStore(join(mkdtempSync(join(tmpdir(), 'agentcorps-session-')), 'sessions.jsonl')), () => '2026-10-24T00:00:00.000Z', (prefix) => `${prefix}-1`);
    const session = service.create({ workspaceId: 'ws', title: 'Archive me', mode: 'work' });
    expect(service.archive(session.id)?.archivedAt).toBe('2026-10-24T00:00:00.000Z');
    expect(service.list()).toHaveLength(0);
    expect(() => service.appendMessage({ sessionId: session.id, role: 'user', content: 'too late' })).toThrow('archived');
  });
});
