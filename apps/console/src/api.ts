import type { CreateTaskInput, Task, TaskEvent } from '@agentcorps/domain';
import type { Session, SessionMessage } from '@agentcorps/session';

export type { Task, TaskEvent, Session, SessionMessage };
export type TaskAction = 'run' | 'cancel' | 'retry';
export type ApprovalAction = 'approve' | 'deny';
export interface Approval {
  readonly id: string;
  readonly request: { readonly capability: string; readonly taskId?: string; readonly command?: string };
  readonly reason: string;
  readonly status: 'pending' | 'approved' | 'denied' | 'expired' | 'consumed';
}
export interface FileEntry {
  readonly name: string;
  readonly path: string;
  readonly kind: 'file' | 'directory';
  readonly size?: number;
  readonly modifiedAt: string;
}
export interface FileListing { readonly root: string; readonly path: string; readonly truncated: boolean; readonly entries: FileEntry[]; }
export interface FileContent { readonly path: string; readonly content: string; readonly size: number; readonly modifiedAt: string; }
export interface GitStatusEntry { readonly index: string; readonly worktree: string; readonly path: string; }
export interface GitStatus { readonly branch: string; readonly upstream?: string; readonly entries: GitStatusEntry[]; }
export interface GitCommit { readonly hash: string; readonly author: string; readonly committedAt: string; readonly subject: string; }
export interface GitCommitResult { readonly hash: string; readonly status: GitStatus; }
export interface GitApprovalResult { readonly decision: 'approval_required'; readonly approval: Approval; }
export type GitMutationResult = GitStatus | GitCommitResult | GitApprovalResult;
export interface TerminalResult { readonly command: string; readonly args: string[]; readonly cwd: string; readonly stdout: string; readonly stderr: string; readonly exitCode: number | null; readonly signal?: string; readonly timedOut: boolean; }
export interface Connection {
  readonly apiBase: string;
  readonly token: string;
}
export interface NewTask {
  readonly title: string;
  readonly objective: string;
  readonly mode: 'code' | 'work';
  readonly sessionId: string;
}
export class ApiError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
export const DEFAULT_CONNECTION: Connection = { apiBase: 'http://127.0.0.1:43210', token: '' };

export function normalizeApiBase(value: string): string {
  const url = new URL(value.trim());
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('Use an HTTP or HTTPS URL without credentials, query parameters, or a fragment.');
  }
  return url.toString().replace(/\/+$/, '');
}

export function loadConnection(): Connection {
  try {
    return {
      apiBase: normalizeApiBase(localStorage.getItem('agentcorps.apiBase') || DEFAULT_CONNECTION.apiBase),
      token: localStorage.getItem('agentcorps.token') || '',
    };
  } catch { return DEFAULT_CONNECTION; }
}

export function saveConnection(connection: Connection): void {
  localStorage.setItem('agentcorps.apiBase', connection.apiBase);
  localStorage.setItem('agentcorps.token', connection.token);
}

export class GatewayClient {
  constructor(readonly connection: Connection) {}

  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set('accept', 'application/json');
    if (this.connection.token) headers.set('authorization', `Bearer ${this.connection.token}`);
    if (init.body) headers.set('content-type', 'application/json');
    const response = await fetch(`${this.connection.apiBase}${path}`, { ...init, headers, cache: 'no-store' });
    if (!response.ok) {
      const text = await response.text();
      let detail = text;
      try { detail = (JSON.parse(text) as { error?: string }).error || text; } catch { /* plain HTTP error */ }
      throw new ApiError(response.status, `${response.status} ${detail || response.statusText}`);
    }
    return response.json() as Promise<T>;
  }

  tasks(signal?: AbortSignal): Promise<{ tasks: Task[] }> {
    return this.request('/tasks', signal ? { signal } : {});
  }
  sessions(signal?: AbortSignal): Promise<{ sessions: Session[] }> {
    return this.request('/sessions', signal ? { signal } : {});
  }
  approvals(signal?: AbortSignal): Promise<{ approvals: Approval[] }> {
    return this.request('/approvals', signal ? { signal } : {});
  }
  files(path = '', signal?: AbortSignal): Promise<FileListing> {
    const query = path ? `?path=${encodeURIComponent(path)}` : '';
    return this.request(`/files${query}`, signal ? { signal } : {});
  }
  fileContent(path: string, signal?: AbortSignal): Promise<FileContent> {
    return this.request(`/files/content?path=${encodeURIComponent(path)}`, signal ? { signal } : {});
  }
  gitStatus(signal?: AbortSignal): Promise<GitStatus> {
    return this.request('/git/status', signal ? { signal } : {});
  }
  gitLog(limit = 20, signal?: AbortSignal): Promise<{ commits: GitCommit[] }> {
    return this.request(`/git/log?limit=${limit}`, signal ? { signal } : {});
  }
  gitDiff(path?: string, signal?: AbortSignal): Promise<{ path?: string; diff: string }> {
    const query = path ? `?path=${encodeURIComponent(path)}` : '';
    return this.request(`/git/diff${query}`, signal ? { signal } : {});
  }
  gitStage(paths: string[], taskId = 'console-git', approvalId?: string): Promise<GitMutationResult> {
    return this.request('/git/stage', { method: 'POST', body: JSON.stringify({ paths, taskId, ...(approvalId ? { approvalId } : {}) }) });
  }
  gitUnstage(paths: string[], taskId = 'console-git', approvalId?: string): Promise<GitMutationResult> {
    return this.request('/git/unstage', { method: 'POST', body: JSON.stringify({ paths, taskId, ...(approvalId ? { approvalId } : {}) }) });
  }
  gitCommit(message: string, taskId = 'console-git', approvalId?: string): Promise<GitMutationResult> {
    return this.request('/git/commit', { method: 'POST', body: JSON.stringify({ message, taskId, ...(approvalId ? { approvalId } : {}) }) });
  }
  terminalExec(command: string, args: string[] = [], taskId = 'console-terminal', approvalId?: string): Promise<TerminalResult | GitApprovalResult> {
    return this.request('/terminal/exec', { method: 'POST', body: JSON.stringify({ command, args, taskId, ...(approvalId ? { approvalId } : {}) }) });
  }
  session(id: string, signal?: AbortSignal): Promise<{ session: Session; messages: SessionMessage[] }> {
    return this.request(`/sessions/${encodeURIComponent(id)}`, signal ? { signal } : {});
  }
  taskAction(id: string, action: TaskAction): Promise<unknown> {
    return this.request(`/tasks/${encodeURIComponent(id)}/${action}`, { method: 'POST' });
  }
  decide(id: string, action: ApprovalAction): Promise<unknown> {
    return this.request(`/approvals/${encodeURIComponent(id)}/${action}`, { method: 'POST', body: JSON.stringify({ decidedBy: 'console-user' }) });
  }
  async createTask(input: NewTask, sessions: readonly Session[]): Promise<Task> {
    let sessionId = input.sessionId;
    const selected = sessionId ? sessions.find((session) => session.id === sessionId) : undefined;
    if (sessionId && !selected) throw new Error('The selected session is no longer available. Refresh and try again.');
    const workspaceId = selected?.workspaceId ?? 'local-workspace';
    if (!sessionId) {
      const result = await this.request<{ session: Session }>('/sessions', {
        method: 'POST', body: JSON.stringify({ workspaceId, title: input.title, mode: input.mode }),
      });
      sessionId = result.session.id;
    }
    const payload: CreateTaskInput = { workspaceId, sessionId, title: input.title, objective: input.objective, mode: input.mode };
    return (await this.request<{ task: Task }>('/tasks', { method: 'POST', body: JSON.stringify(payload) })).task;
  }
}
