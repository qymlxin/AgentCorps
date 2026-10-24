import { describe, expect, it } from 'vitest';
import { listenGateway } from './index.js';
import { TaskRuntime } from '@agentcorps/runtime';

describe('gateway', () => {
  it('exposes health, task creation, and task event history', async () => {
    const server = await listenGateway(new TaskRuntime(), 0);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected TCP address');
    const base = `http://127.0.0.1:${address.port}`;
    try {
      expect((await fetch(`${base}/health`)).status).toBe(200);
      const created = await fetch(`${base}/tasks`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'API task', objective: 'test API' }) });
      expect(created.status).toBe(201);
      const body = await created.json() as { task: { id: string } };
      const detail = await fetch(`${base}/tasks/${body.task.id}`);
      expect(detail.status).toBe(200);
      expect((await detail.json() as { events: unknown[] }).events).toHaveLength(1);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});
