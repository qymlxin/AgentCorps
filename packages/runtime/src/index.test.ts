import { describe, expect, it } from 'vitest';
import { TaskRuntime } from './index.js';
import type { TaskId } from '@agentcorps/domain';

describe('TaskRuntime', () => {
  it('creates, executes, projects, and streams a task', async () => {
    let sequence = 0;
    const runtime = new TaskRuntime({
      now: () => '2026-10-24T00:00:00.000Z',
      id: (prefix) => `${prefix}-${++sequence}`,
    });
    const events: string[] = [];
    runtime.store.subscribe((event) => events.push(event.type));

    const task = runtime.createTask({ workspaceId: 'ws-1', sessionId: 's-1', title: 'Echo', objective: 'verify runtime', mode: 'code' });
    const result = await runtime.runTask(task.id as TaskId, {
      descriptor: { id: 'test-agent', displayName: 'Test Agent', version: '1', transport: 'mock', capabilities: [] },
      async execute(request) { request.emit('hello'); },
    });

    expect(result.status).toBe('succeeded');
    expect(events).toEqual(['task.created', 'task.status_changed', 'run.started', 'run.output', 'task.status_changed']);
    expect(runtime.getTask(task.id)?.status).toBe('succeeded');
  });
});
