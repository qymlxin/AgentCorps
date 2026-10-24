import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { JsonlSessionStore, SessionService } from './index.js';

describe('SessionService', () => {
  it('shares session messages after reopening the JSONL store', () => {
    const directory = mkdtempSync(join(tmpdir(), 'agentcorps-session-'));
    const path = join(directory, 'sessions.jsonl');
    try {
      const first = new SessionService(new JsonlSessionStore(path), () => '2026-10-24T00:00:00.000Z', (prefix) => `${prefix}-1`);
      const session = first.create({ workspaceId: 'ws', title: 'Shared thread', mode: 'code' });
      first.appendMessage({ sessionId: session.id, role: 'user', content: 'Continue this from the CLI' });
      const second = new SessionService(new JsonlSessionStore(path), () => '2026-10-24T00:00:00.000Z');
      expect(second.get(session.id)?.title).toBe('Shared thread');
      expect(second.messages(session.id)[0]?.content).toBe('Continue this from the CLI');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
