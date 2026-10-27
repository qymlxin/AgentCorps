import { describe, expect, it, vi } from 'vitest';
import { GatewayClient, loadConnection, normalizeApiBase, saveConnection, type Session } from './api.js';

const connection = { apiBase: 'http://127.0.0.1:43210', token: 'test-token' };

describe('gateway client', () => {
  it('normalizes connection URLs and rejects unsafe or ambiguous endpoints', () => {
    expect(normalizeApiBase(' https://example.org/prefix/ ')).toBe('https://example.org/prefix');
    for (const url of ['file:///tmp/gateway', 'javascript:alert(1)', 'https://u:p@example.org', 'https://example.org?token=x']) {
      expect(() => normalizeApiBase(url)).toThrow();
    }
  });

  it('keeps the existing browser connection settings across reloads', () => {
    saveConnection(connection);
    expect(loadConnection()).toEqual(connection);
    localStorage.setItem('agentcorps.apiBase', 'invalid-url');
    expect(loadConnection().apiBase).toBe('http://127.0.0.1:43210');
  });

  it('sends bearer credentials without adding content-type to GET requests', async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ tasks: [] }));
    vi.stubGlobal('fetch', fetcher);
    await new GatewayClient(connection).tasks();
    const [url, options] = fetcher.mock.calls[0]!;
    expect(url).toBe(`${connection.apiBase}/tasks`);
    expect(options.headers.get('authorization')).toBe('Bearer test-token');
    expect(options.headers.has('content-type')).toBe(false);
    expect(options.cache).toBe('no-store');
  });

  it('preserves the selected session workspace when creating a task', async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ task: { id: 'task-1' } }));
    vi.stubGlobal('fetch', fetcher);
    await new GatewayClient(connection).createTask({ title: 'Review', objective: 'Review release', sessionId: 'session-1', mode: 'work' }, [{ id: 'session-1', workspaceId: 'workspace-2' } as Session]);
    expect(JSON.parse(fetcher.mock.calls[0]![1].body)).toMatchObject({ sessionId: 'session-1', workspaceId: 'workspace-2' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('creates a shared session before creating a new task', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ session: { id: 'session-new' } })).mockResolvedValueOnce(Response.json({ task: { id: 'task-new' } }));
    vi.stubGlobal('fetch', fetcher);
    await new GatewayClient(connection).createTask({ title: 'Review', objective: 'Review release', sessionId: '', mode: 'code' }, []);
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([`${connection.apiBase}/sessions`, `${connection.apiBase}/tasks`]);
    expect(JSON.parse(fetcher.mock.calls[1]![1].body).sessionId).toBe('session-new');
  });

  it('starts a high-level run with one gateway request and exposes run controls', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ task: { id: 'task-1' }, session: { id: 'session-1' }, status: 'accepted' })).mockResolvedValueOnce(Response.json({ task: { id: 'task-1' }, events: [] }));
    vi.stubGlobal('fetch', fetcher);
    const client = new GatewayClient(connection);
    await client.run({ prompt: 'Review this repository', agent: 'codex', model: 'gpt-5', role: 'reviewer' });
    expect(fetcher.mock.calls[0]?.[0]).toBe(`${connection.apiBase}/runs`);
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toMatchObject({ prompt: 'Review this repository', agent: 'codex', model: 'gpt-5', role: 'reviewer' });
    await client.runStatus('task-1');
    expect(fetcher.mock.calls[1]?.[0]).toBe(`${connection.apiBase}/runs/task-1`);
  });

  it('sends Git paths and commit messages as structured JSON', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ decision: 'approval_required', approval: { id: 'approval-git' } }, { status: 202 })).mockResolvedValueOnce(Response.json({ decision: 'approval_required', approval: { id: 'approval-git-2' } }, { status: 202 })).mockResolvedValueOnce(Response.json({ branch: 'main', entries: [] }));
    vi.stubGlobal('fetch', fetcher);
    const client = new GatewayClient(connection);
    await client.gitStage(['src/main.ts']);
    expect(fetcher.mock.calls[0]?.[0]).toBe(`${connection.apiBase}/git/stage`);
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual({ paths: ['src/main.ts'], taskId: 'console-git' });
    await client.gitCommit('release notes');
    expect(JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body))).toEqual({ message: 'release notes', taskId: 'console-git' });
    await client.gitStage(['src/main.ts'], 'console-git', 'approval-git-3');
    expect(JSON.parse(String(fetcher.mock.calls[2]?.[1]?.body))).toEqual({ paths: ['src/main.ts'], taskId: 'console-git', approvalId: 'approval-git-3' });
  });

  it('surfaces gateway permission errors to the caller', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ error: 'Insufficient gateway role' }, { status: 403 })));
    await expect(new GatewayClient(connection).taskAction('task-1', 'run')).rejects.toThrow('403 Insufficient gateway role');
  });
});
