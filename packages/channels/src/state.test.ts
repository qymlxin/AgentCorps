import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemoryChannelStateStore, SqliteChannelStateStore } from './state.js';

describe('channel state stores', () => {
  it('claims inbound messages only once', () => {
    const store = new InMemoryChannelStateStore();
    expect(store.claimInbound('feishu', 'message-1')).toBe(true);
    expect(store.claimInbound('feishu', 'message-1')).toBe(false);
  });

  it('persists inbound claims and sessions across store instances', () => {
    const directory = mkdtempSync(join(tmpdir(), 'agentcorps-channels-'));
    const filePath = join(directory, 'channels.db');
    try {
      const first = new SqliteChannelStateStore(filePath);
      expect(first.claimInbound('wecom', 'message-1')).toBe(true);
      first.setSessionId('wecom:conversation-1', 'session-1');
      first.close();
      const second = new SqliteChannelStateStore(filePath);
      expect(second.claimInbound('wecom', 'message-1')).toBe(false);
      expect(second.getSessionId('wecom:conversation-1')).toBe('session-1');
      second.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
