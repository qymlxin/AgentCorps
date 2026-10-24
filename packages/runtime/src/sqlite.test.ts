import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { TaskId } from '@agentcorps/domain';
import { SqliteEventStore, TaskRuntime } from './index.js';

describe('SqliteEventStore', () => {
  it('persists and replays task events across runtime instances', () => {
    const directory = mkdtempSync(join(tmpdir(), 'agentcorps-sqlite-'));
    const path = join(directory, 'agentcorps.db');
    try {
      const store = new SqliteEventStore(path);
      const first = new TaskRuntime({ store, id: (prefix) => `${prefix}-1`, now: () => '2026-10-24T00:00:00.000Z' });
      const task = first.createTask({ workspaceId: 'ws', sessionId: 's', title: 'SQLite', objective: 'persist', mode: 'code' });
      store.close();
      const secondStore = new SqliteEventStore(path);
      const second = new TaskRuntime({ store: secondStore });
      expect(second.getTask(task.id as TaskId)?.title).toBe('SQLite');
      expect(second.store.list(task.id)).toHaveLength(1);
      secondStore.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
