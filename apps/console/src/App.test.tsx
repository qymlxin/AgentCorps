import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App.js';
import { connection, event, FakeWebSocket, session, task } from './test/fixtures.js';

beforeEach(() => {
  FakeWebSocket.instances = [];
  vi.stubGlobal('WebSocket', FakeWebSocket);
  localStorage.setItem('agentcorps.apiBase', connection.apiBase);
  localStorage.setItem('agentcorps.token', connection.token);
});

function gateway() {
  const fetcher = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/run')) return Response.json({ error: 'Insufficient gateway role' }, { status: 403 });
    if (url.pathname === '/tasks') return Response.json(init?.method === 'POST' ? { task } : { tasks: [task] });
    if (url.pathname === '/sessions') return Response.json(init?.method === 'POST' ? { session } : { sessions: [session] });
    if (url.pathname === `/sessions/${session.id}`) return Response.json({ session, messages: [{ id: 'message-1', sessionId: session.id, role: 'agent', content: '<script>unsafe</script> Review complete.', createdAt: session.createdAt }] });
    if (url.pathname === '/files') return Response.json({ root: '/workspace', path: url.searchParams.get('path') || '', truncated: false, entries: [{ name: 'README.md', path: 'README.md', kind: 'file', size: 12, modifiedAt: session.createdAt }] });
    if (url.pathname === '/files/content') return Response.json({ path: 'README.md', content: '# workspace', size: 11, modifiedAt: session.createdAt });
    if (url.pathname === '/git/status') return Response.json({ branch: 'main', entries: [{ index: ' ', worktree: 'M', path: 'README.md' }] });
    if (url.pathname === '/git/log') return Response.json({ commits: [{ hash: 'abcdef1234567890', author: 'AgentCorps', committedAt: session.createdAt, subject: 'initial' }] });
    if (url.pathname === '/git/diff') return Response.json({ path: 'README.md', diff: '-hello\\n+changed' });
    if (url.pathname === '/terminal/exec') return Response.json({ command: 'node', args: [], cwd: '/workspace', stdout: 'v22', stderr: '', exitCode: 0, timedOut: false });
    if (url.pathname === '/approvals') return Response.json({ approvals: [{ id: 'approval-1', request: { capability: 'shell.execute', command: 'git status' }, reason: 'Review command', status: 'pending' }] });
    return Response.json({ ok: true });
  });
  vi.stubGlobal('fetch', fetcher);
  return fetcher;
}

describe('React management console', () => {
  it('shows snapshots, session messages, event history, and accessible navigation', async () => {
    gateway();
    const user = userEvent.setup();
    render(<App />);
    await screen.findByText(task.title);
    act(() => { FakeWebSocket.instances[0]!.open(); FakeWebSocket.instances[0]!.message({ event: event() }); });
    await screen.findByText('run.output');
    expect(screen.getByRole('status').textContent).toContain('live');
    await user.click(screen.getByRole('button', { name: 'Sessions' }));
    await screen.findByText('<script>unsafe</script> Review complete.');
    expect(document.querySelector('script')).toBeNull();
    expect(screen.getByRole('button', { name: 'Sessions' }).getAttribute('aria-current')).toBe('page');
    await user.click(screen.getByRole('button', { name: 'Event stream' }));
    expect(screen.getByText('run.output')).toBeTruthy();
  });

  it('browses workspace files and previews a selected text file', async () => {
    gateway();
    const user = userEvent.setup();
    render(<App />);
    await screen.findByText(task.title);
    await user.click(screen.getByRole('button', { name: 'Files' }));
    await screen.findByText('README.md');
    await user.click(screen.getByRole('button', { name: /README\.md/ }));
    expect(await screen.findByText('# workspace')).toBeTruthy();
  });

  it('browses Git changes and exposes approval-gated write actions', async () => {
    const fetcher = gateway();
    const user = userEvent.setup();
    render(<App />);
    await screen.findByText(task.title);
    await user.click(screen.getByRole('button', { name: 'Git' }));
    expect(await screen.findByRole('heading', { name: 'Git' })).toBeTruthy();
    expect((await screen.findByText(/-hello/)).textContent).toContain('-hello');
    expect(screen.getByText('initial')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Stage selected' }));
    await waitFor(() => expect(fetcher.mock.calls.some(([url]) => String(url).endsWith('/git/stage'))).toBe(true));
    expect(JSON.parse(String(fetcher.mock.calls.find(([url]) => String(url).endsWith('/git/stage'))?.[1]?.body))).toMatchObject({ paths: ['README.md'], taskId: 'console-git' });
  });


  it('runs a workspace terminal command through the approval-aware client', async () => {
    const fetcher = gateway();
    const user = userEvent.setup();
    render(<App />);
    await screen.findByText(task.title);
    await user.click(screen.getByRole('button', { name: 'Terminal' }));
    await user.type(screen.getByLabelText('COMMAND'), 'node');
    await user.click(screen.getByRole('button', { name: 'Run command →' }));
    expect(await screen.findByText('v22')).toBeTruthy();
    expect(fetcher.mock.calls.some(([url]) => String(url).endsWith('/terminal/exec'))).toBe(true);
  });

  it('opens the task dialog, command palette, and views from keyboard shortcuts', async () => {
    gateway();
    const user = userEvent.setup();
    render(<App />);
    await screen.findByText(task.title);
    await user.keyboard('n');
    expect(screen.getByRole('dialog')).toBeTruthy();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    await user.keyboard('?');
    expect(screen.getByRole('heading', { name: 'Shortcuts' })).toBeTruthy();
    await user.keyboard('{Escape}');
    await user.keyboard('{Control>}k{/Control}');
    expect(screen.getByRole('heading', { name: 'Jump to action' })).toBeTruthy();
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: /Sessions/ }));
    expect(screen.getByRole('button', { name: 'Sessions' }).getAttribute('aria-current')).toBe('page');
    await user.keyboard('3');
    expect(screen.getByRole('button', { name: 'Event stream' }).getAttribute('aria-current')).toBe('page');
    await user.keyboard('5');
    expect(screen.getByRole('button', { name: 'Git' }).getAttribute('aria-current')).toBe('page');
  });

  it('does not trigger letter shortcuts while editing form fields', async () => {
    gateway();
    const user = userEvent.setup();
    render(<App />);
    await screen.findByText(task.title);
    await user.click(screen.getByRole('button', { name: 'New task' }));
    await user.type(screen.getByLabelText('Title', { exact: true }), 'n');
    expect(screen.queryByRole('heading', { name: 'Shortcuts' })).toBeNull();
    expect(screen.getByDisplayValue('n')).toBeTruthy();
  });
  it.each(['Cancel', 'Close'])('%s on task dialog never submits a task', async (name) => {
    const fetcher = gateway();
    const user = userEvent.setup();
    render(<App />);
    await screen.findByText(task.title);
    await user.click(screen.getByRole('button', { name: 'New task' }));
    await user.type(screen.getByLabelText('Title', { exact: true }), 'New release');
    await user.type(screen.getByLabelText('Objective'), 'Review it');
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(fetcher.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
  });

  it('creates a task in an existing session and refreshes the snapshot', async () => {
    const fetcher = gateway();
    const user = userEvent.setup();
    render(<App />);
    await screen.findByText(task.title);
    await user.click(screen.getByRole('button', { name: 'New task' }));
    await user.type(screen.getByLabelText('Title', { exact: true }), '  Release review  ');
    await user.type(screen.getByLabelText('Objective'), '  Check changes  ');
    await user.selectOptions(screen.getByLabelText('Session', { exact: true }), session.id);
    await user.click(screen.getByRole('button', { name: 'Create task →' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const writes = fetcher.mock.calls.filter(([, init]) => init?.method === 'POST');
    expect(writes).toHaveLength(1);
    expect(JSON.parse(String(writes[0]![1]!.body))).toMatchObject({ title: 'Release review', objective: 'Check changes', sessionId: session.id, workspaceId: session.workspaceId });
    expect(fetcher.mock.calls.filter(([url]) => String(url).endsWith('/tasks'))).toHaveLength(3);
  });

  it('reports permission failures and submits approval decisions', async () => {
    const fetcher = gateway();
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole('button', { name: `run ${task.title}` }));
    expect((await screen.findByRole('alert')).textContent).toContain('403 Insufficient gateway role');
    await user.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(fetcher.mock.calls.some(([url]) => String(url).endsWith('/approval-1/approve'))).toBe(true));
  });

  it('saves connection settings and closes the old socket before reconnecting', async () => {
    const fetcher = gateway();
    const user = userEvent.setup();
    const { unmount } = render(<App />);
    await screen.findByText(task.title);
    const first = FakeWebSocket.instances[0]!;
    await user.click(screen.getByRole('button', { name: 'Connection settings' }));
    await user.clear(screen.getByLabelText('API base URL'));
    await user.type(screen.getByLabelText('API base URL'), 'http://127.0.0.1:43211/');
    await user.clear(screen.getByLabelText('Bearer token'));
    await user.type(screen.getByLabelText('Bearer token'), 'new-token');
    await user.click(screen.getByRole('button', { name: 'Save connection →' }));
    await waitFor(() => expect(fetcher.mock.calls.some(([url]) => String(url).startsWith('http://127.0.0.1:43211/'))).toBe(true));
    expect(localStorage.getItem('agentcorps.token')).toBe('new-token');
    expect(first.closed).toBe(true);
    expect(FakeWebSocket.instances).toHaveLength(2);
    unmount();
    expect(FakeWebSocket.instances[1]!.closed).toBe(true);
  });

  it('keeps approval-service errors visible without hiding task data', async () => {
    const fetcher = gateway();
    const normal = fetcher.getMockImplementation()!;
    fetcher.mockImplementation((url, init) => String(url).endsWith('/approvals') ? Promise.resolve(Response.json({ error: 'disabled' }, { status: 503 })) : normal(url, init));
    render(<App />);
    await screen.findByText(task.title);
    expect(screen.getByText('Approvals are not enabled on this gateway.')).toBeTruthy();
  });
});
