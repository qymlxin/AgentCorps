import { describe, expect, it } from 'vitest';
import { InMemoryEventStore } from './index.js';

describe('runtime performance smoke', () => {
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
