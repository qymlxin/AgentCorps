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

  it('marks a persisted running task as failed when a new runtime recovers after restart', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'agentcorps-runtime-recovery-'));
    const path = join(directory, 'events.jsonl');
    const first = new TaskRuntime({ store: new JsonlEventStore(path), id: (prefix) => `${prefix}-first`, now: () => '2026-10-24T00:00:00.000Z' });
    const task = first.createTask({ workspaceId: 'ws', sessionId: 'session', title: 'Interrupted', objective: 'recover this run', mode: 'code' });
    const running = first.runTask(task.id, {
      descriptor: { id: 'blocking', displayName: 'Blocking', version: '1', transport: 'mock', capabilities: [] },
      async execute(request) {
        await new Promise<void>((resolve) => request.signal.addEventListener('abort', () => resolve(), { once: true }));
      },
    });
    try {
      while (first.getTask(task.id)?.status !== 'running') await new Promise((resolve) => setImmediate(resolve));
      const recovered = new TaskRuntime({ store: new JsonlEventStore(path), now: () => '2026-10-24T00:00:01.000Z' });
      expect(recovered.getTask(task.id)?.status).toBe('failed');
      expect(recovered.store.list(task.id).at(-1)?.payload).toMatchObject({ to: 'failed', reason: 'Run interrupted by process restart' });
    } finally {
      first.cancelTask(task.id);
      await running;
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
