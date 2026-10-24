import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { InMemoryWorkflowStore, JsonlWorkflowStore, WorkflowEngine, type WorkflowDefinition } from './index.js';

const definition: WorkflowDefinition = {
  id: 'release', workspaceId: 'ws', sessionId: 'session',
  nodes: [
    { id: 'prepare', title: 'Prepare', objective: 'prepare release' },
    { id: 'publish', title: 'Publish', objective: 'publish release', dependsOn: ['prepare'] },
    { id: 'notify', title: 'Notify', objective: 'notify team', dependsOn: ['publish'] },
  ],
};

describe('WorkflowEngine', () => {
  it('validates dependencies and rejects cycles', () => {
    const engine = new WorkflowEngine();
    expect(() => engine.validate({ ...definition, nodes: [{ ...definition.nodes[0]!, dependsOn: ['missing'] }] })).toThrow('Unknown dependency');
    expect(() => engine.validate({ ...definition, nodes: [{ id: 'a', title: 'A', objective: 'A', dependsOn: ['b'] }, { id: 'b', title: 'B', objective: 'B', dependsOn: ['a'] }] })).toThrow('dependency cycle');
  });

  it('executes dependencies in order and persists the completed run', async () => {
    const store = new InMemoryWorkflowStore();
    const engine = new WorkflowEngine({ store, id: () => 'run-1', now: () => '2026-10-24T00:00:00.000Z' });
    const order: string[] = [];
    const run = await engine.run(definition, { execute: async ({ node }) => { order.push(node.id); } });
    expect(run.status).toBe('succeeded');
    expect(order).toEqual(['prepare', 'publish', 'notify']);
    expect(store.get('run-1')?.nodeStates.notify?.status).toBe('succeeded');
  });

  it('retries failed nodes, skips dependents, and compensates completed nodes', async () => {
    const compensated: string[] = [];
    const store = new InMemoryWorkflowStore();
    const engine = new WorkflowEngine({ store, id: () => 'run-2', now: () => '2026-10-24T00:00:00.000Z' });
    let attempts = 0;
    const run = await engine.run({ ...definition, nodes: [
      { ...definition.nodes[0]!, compensate: () => { compensated.push('prepare'); } },
      { ...definition.nodes[1]!, maxAttempts: 2 },
      definition.nodes[2]!,
    ] }, { execute: async ({ node }) => {
      if (node.id === 'publish') { attempts += 1; throw new Error('publish failed'); }
    } });
    expect(run.status).toBe('failed');
    expect(run.nodeStates.publish).toMatchObject({ status: 'failed', attempts: 2 });
    expect(run.nodeStates.notify?.status).toBe('skipped');
    expect(compensated).toEqual(['prepare']);
  });

  it('recovers running nodes from JSONL and resumes them', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'agentcorps-workflow-'));
    const path = join(directory, 'workflows.jsonl');
    try {
      const store = new JsonlWorkflowStore(path);
      const engine = new WorkflowEngine({ store, id: () => 'run-3', now: () => '2026-10-24T00:00:00.000Z' });
      const first = await engine.run({ ...definition, nodes: [definition.nodes[0]!] }, { execute: async () => {} });
      const interrupted = { ...first, status: 'running' as const, nodeStates: { prepare: { status: 'running' as const, attempts: 1, updatedAt: first.updatedAt } } };
      store.save(interrupted);
      const reopened = new WorkflowEngine({ store: new JsonlWorkflowStore(path), now: () => '2026-10-24T00:00:00.000Z' });
      const resumed = await reopened.resume({ ...definition, nodes: [definition.nodes[0]!] }, { execute: async () => {} }, 'run-3');
      expect(resumed.status).toBe('succeeded');
      expect(resumed.nodeStates.prepare?.attempts).toBe(2);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
