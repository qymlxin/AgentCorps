import { describe, expect, it, vi } from 'vitest';
import type { Task, TaskEvent } from '@agentcorps/domain';
import { AgentCorpsApiError, AgentCorpsClient, normalizeApiBase } from './index.js';

const task: Task = {
  id: 'task-1' as Task['id'], workspaceId: 'workspace', sessionId: 'session', title: 'Demo', objective: 'Do the work', mode: 'code', status: 'queued', createdAt: '2026-10-27T00:00:00.000Z', updatedAt: '2026-10-27T00:00:00.000Z',
};

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('AgentCorpsClient', () => {
  it('normalizes safe gateway URLs and rejects credentials or query state', () => {
    expect(normalizeApiBase(' http://127.0.0.1:43210/// ')).toBe('http://127.0.0.1:43210');
    expect(() => normalizeApiBase('file:///tmp/agentcorps')).toThrow('HTTP or HTTPS');
    expect(() => normalizeApiBase('https://user@example.test')).toThrow('credentials');
    expect(() => normalizeApiBase('https://example.test?token=secret')).toThrow('query');
  });

  it('sends bearer auth and runs a task through completion with output callbacks', async () => {
    const events: TaskEvent[] = [
      { id: 'event-1' as TaskEvent['id'], type: 'task.created', version: 1, aggregateType: 'task', aggregateId: task.id, correlationId: task.id, occurredAt: task.createdAt, payload: { task } },
      { id: 'event-2' as TaskEvent['id'], type: 'run.output', version: 1, aggregateType: 'run', aggregateId: task.id, correlationId: task.id, occurredAt: task.createdAt, payload: { runId: 'run-1' as never, text: 'done\n', stream: 'assistant' } },
      { id: 'event-3' as TaskEvent['id'], type: 'task.status_changed', version: 1, aggregateType: 'task', aggregateId: task.id, correlationId: task.id, occurredAt: task.createdAt, payload: { from: 'running', to: 'succeeded' } },
    ];
    let taskReads = 0;
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      expect(input).toBe('https://gateway.example/runs');
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer test-token');
      return response({ task: { ...task, status: 'running' }, session: { id: 'session-1' }, status: 'accepted' }, 202);
    });
    const client = new AgentCorpsClient({ apiBase: 'https://gateway.example/', token: 'test-token', fetch: async (input, init) => {
      const url = String(input);
      if (url.endsWith('/runs')) return response({ task: { ...task, status: 'running' }, session: { id: 'session-1' }, status: 'accepted' }, 202);
      taskReads += 1;
      return response({ task: { ...task, status: taskReads === 1 ? 'running' : 'succeeded' }, events });
    }});
    const output: string[] = [];
    const result = await client.runAndWait({ prompt: 'Do the work' }, { pollMs: 25, onOutput: (text) => output.push(text) });
    expect(result.task.status).toBe('succeeded');
    expect(result.output).toBe('done\n');
    expect(output).toEqual(['done\n']);
    expect(taskReads).toBe(2);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('provides a resumable run handle and wraps approval, memory, and search routes', async () => {
    const calls: string[] = [];
    let snapshotReads = 0;
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      calls.push(`${init?.method ?? 'GET'} ${url}`);
      if (url.endsWith('/runs')) return response({ task: { ...task, status: 'running' }, session: { id: 'session-1' }, status: 'accepted' }, 202);
      if (url.endsWith('/runs/task-1') || url.endsWith('/tasks/task-1')) {
        snapshotReads += 1;
        return response({ task: { ...task, status: snapshotReads > 1 ? 'succeeded' : 'running' }, events: [] });
      }
      if (url.endsWith('/approvals/approval-1')) return response({ approval: { id: 'approval-1', request: { capability: 'process.exec' }, reason: 'Review', status: 'pending' } });
      if (url.endsWith('/approvals/approval-1/consume')) return response({ approval: { id: 'approval-1', request: { capability: 'process.exec' }, reason: 'Review', status: 'consumed' } });
      if (url.endsWith('/memory/memory-1')) return response({ memory: { id: 'memory-1' } });
      if (url.includes('/sessions/search')) return response({ results: [] });
      return response({ task: { ...task, status: 'cancelled' } });
    });
    const client = new AgentCorpsClient({ apiBase: 'http://localhost:43210', fetch: fetcher });
    const handle = await client.startRun({ prompt: '  Do the work  ' });
    expect(handle.id).toBe('task-1');
    expect((await handle.wait({ pollMs: 25 })).task.status).toBe('succeeded');
    await handle.cancel();
    await client.approval('approval-1');
    await client.consumeApproval('approval-1');
    await client.deleteMemory('memory-1');
    await client.searchSessions('release', { role: 'agent', limit: 5 });
    expect(calls).toContain('POST http://localhost:43210/runs');
    expect(calls).toContain('POST http://localhost:43210/runs/task-1/cancel');
    expect(calls).toContain('GET http://localhost:43210/sessions/search?query=release&role=agent&limit=5');
  });
});
