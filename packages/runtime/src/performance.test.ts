import { describe, expect, it } from 'vitest';
import { InMemoryEventStore, MockAgent, TaskRuntime, type AgentAdapter } from './index.js';

describe('runtime performance', () => {
  it('rejects concurrent duplicate runs for one task', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const agent: AgentAdapter = { descriptor: new MockAgent().descriptor, execute: async () => { await gate; } };
    const runtime = new TaskRuntime();
    const task = runtime.createTask({ workspaceId: 'ws', sessionId: 'session', title: 'single run', objective: 'run once', mode: 'code' });
    const first = runtime.runTask(task.id, agent);
    await Promise.resolve();
    await expect(runtime.runTask(task.id, agent)).rejects.toThrow('already running');
    release();
    await first;
  });

  it('appends and lists 10,000 events within the local control-plane budget', () => {
    const store = new InMemoryEventStore();
    const started = performance.now();
    for (let index = 0; index < 10_000; index += 1) {
      store.append({
        id: `event-${index}` as never,
        type: 'run.output',
        version: 1,
        aggregateType: 'run',
        aggregateId: `task-${index % 100}`,
        correlationId: `task-${index % 100}`,
        occurredAt: new Date(index).toISOString(),
        payload: { runId: `run-${index % 100}` as never, text: `event-${index}`, stream: 'assistant' },
      });
    }
    const elapsed = performance.now() - started;
    expect(store.list()).toHaveLength(10_000);
    expect(elapsed).toBeLessThan(1_000);
  });
});
