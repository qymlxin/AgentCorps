import { describe, expect, it } from 'vitest';
import type { TaskId } from '@agentcorps/domain';
import { TaskRuntime } from './index.js';

describe('delegated tasks', () => {
  it('creates parent-child tasks and runs them with a concurrency limit', async () => {
    let sequence = 0;
    let active = 0;
    let peak = 0;
    const runtime = new TaskRuntime({ id: (prefix) => `${prefix}-${++sequence}`, now: () => '2026-10-24T00:00:00.000Z' });
    const parent = runtime.createTask({ workspaceId: 'ws', sessionId: 's', title: 'Parent', objective: 'coordinate work', mode: 'code' });
    const agent = {
      descriptor: { id: 'worker', displayName: 'Worker', version: '1', transport: 'mock' as const, capabilities: [] },
      async execute(request: { emit: (text: string) => void }): Promise<void> {
        active += 1;
        peak = Math.max(peak, active);
        request.emit('started');
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
      },
    };
    const results = await runtime.runDelegatedTasks(parent.id as TaskId, [
      { input: { workspaceId: 'ws', sessionId: 's', title: 'One', objective: 'one', mode: 'code' }, agent },
      { input: { workspaceId: 'ws', sessionId: 's', title: 'Two', objective: 'two', mode: 'code' }, agent },
      { input: { workspaceId: 'ws', sessionId: 's', title: 'Three', objective: 'three', mode: 'code' }, agent },
    ], 2);
    expect(results).toHaveLength(3);
    expect(results.every((task) => task.status === 'succeeded')).toBe(true);
    expect(runtime.getChildren(parent.id as TaskId)).toHaveLength(3);
    expect(peak).toBe(2);
  });
});
