import { describe, expect, it } from 'vitest';
import { InMemoryMemoryStore, MemoryService } from '@agentcorps/memory';
import type { TaskId } from '@agentcorps/domain';
import type { AgentRequest } from './index.js';
import { TaskRuntime } from './index.js';

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

  it('injects global, matching workspace, and matching session memory while excluding other scopes and secrets', async () => {
    let sequence = 0;
    const memory = new MemoryService(new InMemoryMemoryStore(), () => '2026-10-24T00:00:00.000Z', () => `memory-${++sequence}`);
    memory.save({ scope: 'global', content: 'global release preference', source: 'user' });
    memory.save({ scope: 'workspace', workspaceId: 'ws-1', content: 'workspace release convention', source: 'user' });
    memory.save({ scope: 'session', workspaceId: 'ws-1', sessionId: 's-1', content: 'session release decision', source: 'user' });
    memory.save({ scope: 'workspace', workspaceId: 'other-workspace', content: 'other workspace release leak', source: 'user' });
    memory.save({ scope: 'session', workspaceId: 'ws-1', sessionId: 'other-session', content: 'other session release leak', source: 'user' });
    memory.save({ scope: 'global', content: 'secret release token', source: 'user', sensitivity: 'secret' });

    const runtime = new TaskRuntime({ memory, id: (prefix) => `${prefix}-${++sequence}`, now: () => '2026-10-24T00:00:00.000Z' });
    const received: string[][] = [];
    const agent = {
      descriptor: { id: 'memory-agent', displayName: 'Memory Agent', version: '1', transport: 'mock' as const, capabilities: [] },
      async execute(request: AgentRequest): Promise<void> {
        received.push((request.memory ?? []).map((record) => record.content));
      },
    };

    const first = runtime.createTask({ workspaceId: 'ws-1', sessionId: 's-1', title: 'First', objective: 'prepare release', mode: 'code' });
    await runtime.runTask(first.id, agent);
    const second = runtime.createTask({ workspaceId: 'ws-1', sessionId: 's-2', title: 'Second', objective: 'prepare release', mode: 'code' });
    await runtime.runTask(second.id, agent);

    expect(received[0]).toEqual(expect.arrayContaining(['global release preference', 'workspace release convention', 'session release decision']));
    expect(received[0]).toHaveLength(3);
    expect(received[0]?.join('\n')).not.toContain('leak');
    expect(received[0]?.join('\n')).not.toContain('secret release token');
    expect(received[1]).toEqual(expect.arrayContaining(['global release preference', 'workspace release convention']));
    expect(received[1]).toHaveLength(2);
    expect(received[1]?.join('\n')).not.toContain('session release decision');
  });
});
