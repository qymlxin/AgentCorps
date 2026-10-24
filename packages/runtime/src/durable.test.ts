import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { TaskId } from '@agentcorps/domain';
import { JsonlEventStore, TaskRuntime } from './index.js';

describe('durable task runtime', () => {
  it('replays JSONL events into a new runtime', () => {
    const directory = mkdtempSync(join(tmpdir(), 'agentcorps-'));
    const path = join(directory, 'events.jsonl');
    try {
      const first = new TaskRuntime({ store: new JsonlEventStore(path), id: (prefix) => `${prefix}-1`, now: () => '2026-10-24T00:00:00.000Z' });
      const created = first.createTask({ workspaceId: 'ws', sessionId: 'session', title: 'Persist', objective: 'replay me', mode: 'code' });
      const second = new TaskRuntime({ store: new JsonlEventStore(path), now: () => '2026-10-24T00:00:00.000Z' });
      expect(second.getTask(created.id)?.objective).toBe('replay me');
      expect(second.store.list(created.id)).toHaveLength(1);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('cancels an active run and supports retry', async () => {
    const runtime = new TaskRuntime({ id: (prefix) => `${prefix}-${Math.random()}`, now: () => '2026-10-24T00:00:00.000Z' });
    const task = runtime.createTask({ workspaceId: 'ws', sessionId: 'session', title: 'Cancel', objective: 'cancel me', mode: 'code' });
    const running = runtime.runTask(task.id as TaskId, {
      descriptor: { id: 'blocking', displayName: 'Blocking', version: '1', transport: 'mock', capabilities: [] },
      async execute(request) {
        await new Promise<never>((_, reject) => request.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
      },
    });
    runtime.cancelTask(task.id as TaskId);
    expect((await running).status).toBe('cancelled');
    expect(runtime.retryTask(task.id as TaskId).status).toBe('queued');
  });
});
