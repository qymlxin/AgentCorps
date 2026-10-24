import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { JsonlSessionStore, SessionService } from './index.js';

describe('sessions', () => {
  it('shares session messages after reopening the JSONL store', () => {
    const directory = mkdtempSync(join(tmpdir(), 'agentcorps-session-'));
    const path = join(directory, 'sessions.jsonl');
    try {
      const first = new SessionService(new JsonlSessionStore(path), () => '2026-10-24T00:00:00.000Z', (prefix) => `${prefix}-1`);
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

  it('does not return archived sessions and rejects new messages after archive', () => {
    const service = new SessionService(new JsonlSessionStore(join(mkdtempSync(join(tmpdir(), 'agentcorps-session-')), 'sessions.jsonl')), () => '2026-10-24T00:00:00.000Z', (prefix) => `${prefix}-1`);
    const session = service.create({ workspaceId: 'ws', title: 'Archive me', mode: 'work' });
    expect(service.archive(session.id)?.archivedAt).toBe('2026-10-24T00:00:00.000Z');
    expect(service.list()).toHaveLength(0);
    expect(() => service.appendMessage({ sessionId: session.id, role: 'user', content: 'too late' })).toThrow('archived');
  });
});
