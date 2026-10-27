import type { Task, TaskEvent } from '@agentcorps/domain';
import type { MemoryRecord } from '@agentcorps/memory';
import type { Approval } from '@agentcorps/security';
import type { Session, SessionMessage } from '@agentcorps/session';

export interface ClientConnection {
  readonly apiBase: string;
  readonly token?: string;
  readonly fetch?: typeof globalThis.fetch;
}

export interface AgentRunInput {
  readonly prompt: string;
  readonly title?: string;
  readonly workspaceId?: string;
  readonly sessionId?: string;
  readonly mode?: 'code' | 'work';
  readonly agent?: string;
  readonly model?: string;
  readonly role?: string;
  readonly instructions?: string;
}

export interface AgentRunAccepted { readonly task: Task; readonly session: Session; readonly status: 'accepted'; }
export interface AgentRunSnapshot { readonly task: Task; readonly events: readonly TaskEvent[]; }
export interface AgentRunResult extends AgentRunSnapshot { readonly output: string; }
export interface RunEventHandlers {
  readonly onEvent?: (event: TaskEvent) => void;
  readonly onOutput?: (text: string, event: Extract<TaskEvent, { type: 'run.output' }>) => void;
  readonly signal?: AbortSignal;
  readonly pollMs?: number;
}
export interface AgentCorpsClientOptions extends ClientConnection { readonly defaultPollMs?: number; }
export interface CreateSessionInput { readonly workspaceId?: string; readonly title: string; readonly mode?: 'code' | 'work'; }
export interface CreateTaskInput { readonly workspaceId?: string; readonly sessionId?: string; readonly title: string; readonly objective: string; readonly mode?: 'code' | 'work'; }
export interface FileEntry { readonly name: string; readonly path: string; readonly kind: 'file' | 'directory'; readonly size?: number; readonly modifiedAt: string; }
export interface FileListing { readonly root: string; readonly path: string; readonly truncated: boolean; readonly entries: FileEntry[]; }
export interface FileContent { readonly path: string; readonly content: string; readonly size: number; readonly modifiedAt: string; }
export interface GitStatusEntry { readonly index: string; readonly worktree: string; readonly path: string; }
export interface GitStatus { readonly branch: string; readonly upstream?: string; readonly entries: GitStatusEntry[]; }
export interface GitCommit { readonly hash: string; readonly author: string; readonly committedAt: string; readonly subject: string; }
export interface GitCommitResult { readonly hash: string; readonly status: GitStatus; }
export interface ApprovalRequiredResult { readonly decision: 'approval_required'; readonly approval: Approval; }
export type GitMutationResult = GitStatus | GitCommitResult | ApprovalRequiredResult;
export interface TerminalResult { readonly command: string; readonly args: string[]; readonly cwd: string; readonly stdout: string; readonly stderr: string; readonly exitCode: number | null; readonly signal?: string; readonly timedOut: boolean; }
export interface BrowserTab { readonly id: string; readonly title: string; readonly url: string; readonly type: string; }
export interface BrowserSnapshot { readonly tabId: string; readonly title: string; readonly url: string; readonly text: string; }
export interface BrowserScreenshot { readonly tabId: string; readonly mimeType: 'image/png'; readonly data: string; }
export interface UsageRecord { readonly id: string; readonly kind: 'model' | 'tool' | 'protocol'; readonly taskId: string; readonly runId: string; readonly toolId: string; readonly model?: string; readonly operation?: string; readonly status: 'succeeded' | 'failed' | 'approval_required' | 'cancelled'; readonly startedAt: string; readonly endedAt: string; readonly durationMs: number; readonly inputTokens?: number; readonly outputTokens?: number; readonly totalTokens?: number; readonly tokenSource: 'provider' | 'estimated' | 'unknown'; readonly error?: string; readonly metadata?: Readonly<Record<string, string | number | boolean>>; }
export interface UsageSummary { readonly kind: UsageRecord['kind']; readonly toolId: string; readonly model?: string; readonly calls: number; readonly succeeded: number; readonly failed: number; readonly approvalRequired: number; readonly cancelled: number; readonly inputTokens: number; readonly outputTokens: number; readonly totalTokens: number; readonly estimatedCalls: number; }
export interface ChannelInfo { readonly kind: string; readonly configured: boolean; }
export interface EventStreamOptions { readonly lastEventId?: string; readonly signal?: AbortSignal; }
export interface SessionSearchResult { readonly session: Session; readonly message: SessionMessage; }
export interface ApprovalRequestInput { readonly taskId: string; readonly capability: 'fs.read' | 'fs.write' | 'process.exec' | 'network.connect' | 'secret.read'; readonly requestId?: string; readonly path?: string; readonly command?: string; readonly host?: string; readonly ttlMs?: number; }
export interface ApiErrorBody { readonly error?: string; }

export class AgentCorpsApiError extends Error {
  constructor(readonly status: number, message: string, readonly body?: unknown) {
    super(message);
    this.name = 'AgentCorpsApiError';
  }
}

export function normalizeApiBase(value: string): string {
  const url = new URL(value.trim());
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('Use an HTTP or HTTPS URL without credentials, query parameters, or a fragment.');
  }
  return url.toString().replace(/\/+$/, '');
}

export class AgentCorpsClient {
  readonly apiBase: string;
  readonly token: string;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly defaultPollMs: number;

  constructor(options: AgentCorpsClientOptions) {
    this.apiBase = normalizeApiBase(options.apiBase);
    this.token = options.token ?? '';
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    if (!this.fetchImpl) throw new Error('A fetch implementation is required');
    this.defaultPollMs = options.defaultPollMs ?? 250;
    if (!Number.isInteger(this.defaultPollMs) || this.defaultPollMs < 25) throw new Error('defaultPollMs must be an integer of at least 25ms');
  }

  health(signal?: AbortSignal): Promise<{ status: 'ok'; service: string; version: string }> { return this.request('/health', { signal: signal ?? null }); }
  tasks(signal?: AbortSignal): Promise<{ tasks: Task[] }> { return this.request('/tasks', { signal: signal ?? null }); }
  task(id: string, signal?: AbortSignal): Promise<AgentRunSnapshot> { return this.request(`/tasks/${encodeURIComponent(id)}`, { signal: signal ?? null }); }
  taskAction(id: string, action: 'run' | 'cancel' | 'retry', signal?: AbortSignal): Promise<{ task: Task } | { taskId: string; status: 'accepted' }> { return this.request(`/tasks/${encodeURIComponent(id)}/${action}`, { method: 'POST', signal: signal ?? null }); }
  createTask(input: CreateTaskInput, signal?: AbortSignal): Promise<Task> {
    return this.request<{ task: Task }>('/tasks', { method: 'POST', body: JSON.stringify({ ...input, workspaceId: input.workspaceId ?? 'local-workspace', sessionId: input.sessionId ?? 'local-session', mode: input.mode ?? 'code' }), signal: signal ?? null }).then((result) => result.task);
  }
  run(input: AgentRunInput, signal?: AbortSignal): Promise<AgentRunAccepted> {
    const prompt = input.prompt.trim();
    if (!prompt) throw new Error('Run prompt cannot be empty');
    return this.request('/runs', { method: 'POST', body: JSON.stringify(input), signal: signal ?? null });
  }
  runAction(id: string, action: 'cancel' | 'retry', signal?: AbortSignal): Promise<{ task: Task }> {
    return this.request(`/runs/${encodeURIComponent(id)}/${action}`, { method: 'POST', signal: signal ?? null });
  }
  runEvents(id: string, signal?: AbortSignal): Promise<{ events: TaskEvent[] }> {
    return this.request(`/runs/${encodeURIComponent(id)}/events`, { signal: signal ?? null });
  }
  sessions(signal?: AbortSignal): Promise<{ sessions: Session[] }> { return this.request('/sessions', { signal: signal ?? null }); }
  session(id: string, signal?: AbortSignal): Promise<{ session: Session; messages: SessionMessage[] }> { return this.request(`/sessions/${encodeURIComponent(id)}`, { signal: signal ?? null }); }
  createSession(input: CreateSessionInput, signal?: AbortSignal): Promise<Session> {
    return this.request<{ session: Session }>('/sessions', { method: 'POST', body: JSON.stringify({ ...input, workspaceId: input.workspaceId ?? 'local-workspace', mode: input.mode ?? 'code' }), signal: signal ?? null }).then((result) => result.session);
  }
  sessionMessage(id: string, content: string, signal?: AbortSignal): Promise<SessionMessage> {
    if (!content.trim()) throw new Error('Session message cannot be empty');
    return this.request<{ message: SessionMessage }>(`/sessions/${encodeURIComponent(id)}/messages`, { method: 'POST', body: JSON.stringify({ role: 'user', content }), signal: signal ?? null }).then((result) => result.message);
  }
  archiveSession(id: string, signal?: AbortSignal): Promise<{ session: Session }> { return this.request(`/sessions/${encodeURIComponent(id)}/archive`, { method: 'POST', signal: signal ?? null }); }
  searchSessions(query: string, workspaceId?: string, signal?: AbortSignal): Promise<{ results: SessionSearchResult[] }> {
    const params = new URLSearchParams({ query });
    if (workspaceId) params.set('workspaceId', workspaceId);
    return this.request(`/sessions/search?${params.toString()}`, { signal: signal ?? null });
  }
  approvals(signal?: AbortSignal): Promise<{ approvals: Approval[] }> { return this.request('/approvals', { signal: signal ?? null }); }
  approvalRequest(input: ApprovalRequestInput, signal?: AbortSignal): Promise<{ decision: string; approval?: Approval }> {
    return this.request('/approvals', { method: 'POST', body: JSON.stringify(removeUndefined({ ...input })), signal: signal ?? null });
  }
  approve(id: string, decidedBy = 'client-user', reason?: string, signal?: AbortSignal): Promise<{ approval: Approval }> {
    return this.decide(id, 'approve', decidedBy, reason, signal);
  }
  deny(id: string, decidedBy = 'client-user', reason?: string, signal?: AbortSignal): Promise<{ approval: Approval }> {
    return this.decide(id, 'deny', decidedBy, reason, signal);
  }
  memorySearch(query: string, options: { workspaceId?: string; sessionId?: string; includeSensitive?: boolean; limit?: number; signal?: AbortSignal } = {}): Promise<{ memories: MemoryRecord[] }> {
    const params = new URLSearchParams({ query });
    if (options.workspaceId) params.set('workspaceId', options.workspaceId);
    if (options.sessionId) params.set('sessionId', options.sessionId);
    if (options.includeSensitive) params.set('includeSensitive', 'true');
    if (options.limit !== undefined) params.set('limit', String(options.limit));
    return this.request(`/memory?${params.toString()}`, { signal: options.signal ?? null });
  }
  saveMemory(record: { scope: 'global' | 'workspace' | 'session'; content: string; workspaceId?: string; sessionId?: string; sensitivity?: 'public' | 'private' | 'secret'; signal?: AbortSignal }): Promise<{ memory: MemoryRecord }> {
    const { signal, ...body } = record;
    return this.request('/memory', { method: 'POST', body: JSON.stringify(body), signal: signal ?? null });
  }
  files(path = '', signal?: AbortSignal): Promise<FileListing> {
    const query = path ? `?path=${encodeURIComponent(path)}` : '';
    return this.request(`/files${query}`, { signal: signal ?? null });
  }
  fileContent(path: string, signal?: AbortSignal): Promise<FileContent> {
    return this.request(`/files/content?path=${encodeURIComponent(path)}`, { signal: signal ?? null });
  }
  channels(signal?: AbortSignal): Promise<{ channels: ChannelInfo[] }> { return this.request('/channels', { signal: signal ?? null }); }
  usageSummary(params: { from?: string; to?: string; taskId?: string; runId?: string; toolId?: string; model?: string; kind?: UsageRecord['kind'] } = {}, signal?: AbortSignal): Promise<{ summary: UsageSummary[] }> {
    return this.request(`/usage/summary?${queryString(params)}`, { signal: signal ?? null });
  }
  usageCalls(params: { from?: string; to?: string; taskId?: string; runId?: string; toolId?: string; model?: string; kind?: UsageRecord['kind']; status?: UsageRecord['status']; limit?: number } = {}, signal?: AbortSignal): Promise<{ calls: UsageRecord[] }> {
    return this.request(`/usage/calls?${queryString(params)}`, { signal: signal ?? null });
  }
  gitStatus(signal?: AbortSignal): Promise<GitStatus> { return this.request('/git/status', { signal: signal ?? null }); }
  gitLog(limit = 20, signal?: AbortSignal): Promise<{ commits: GitCommit[] }> { return this.request(`/git/log?limit=${encodeURIComponent(String(limit))}`, { signal: signal ?? null }); }
  gitDiff(path?: string, signal?: AbortSignal): Promise<{ path?: string; diff: string }> { return this.request(`/git/diff${path ? `?path=${encodeURIComponent(path)}` : ''}`, { signal: signal ?? null }); }
  gitStage(paths: string[], taskId = 'client-git', approvalId?: string, signal?: AbortSignal): Promise<GitMutationResult> { return this.gitMutation('/git/stage', { paths, taskId, approvalId }, signal); }
  gitUnstage(paths: string[], taskId = 'client-git', approvalId?: string, signal?: AbortSignal): Promise<GitMutationResult> { return this.gitMutation('/git/unstage', { paths, taskId, approvalId }, signal); }
  gitCommit(message: string, taskId = 'client-git', approvalId?: string, signal?: AbortSignal): Promise<GitMutationResult> { return this.gitMutation('/git/commit', { message, taskId, approvalId }, signal); }
  terminalExec(command: string, args: string[] = [], taskId = 'client-terminal', approvalId?: string, signal?: AbortSignal): Promise<TerminalResult | ApprovalRequiredResult> {
    return this.request('/terminal/exec', { method: 'POST', body: JSON.stringify({ command, args, taskId, ...(approvalId ? { approvalId } : {}) }), signal: signal ?? null });
  }
  browserTabs(signal?: AbortSignal): Promise<{ tabs: BrowserTab[] }> { return this.request('/browser/tabs', { signal: signal ?? null }); }
  browserSnapshot(tabId: string, signal?: AbortSignal): Promise<{ snapshot: BrowserSnapshot }> { return this.request(`/browser/snapshot?tabId=${encodeURIComponent(tabId)}`, { signal: signal ?? null }); }
  browserScreenshot(tabId: string, signal?: AbortSignal): Promise<{ screenshot: BrowserScreenshot }> { return this.request(`/browser/screenshot?tabId=${encodeURIComponent(tabId)}`, { signal: signal ?? null }); }
  browserNavigate(tabId: string, url: string, taskId = 'client-browser', approvalId?: string, signal?: AbortSignal): Promise<{ result: { tabId: string; url: string } } | ApprovalRequiredResult> { return this.browserMutation('/browser/navigate', { tabId, url, taskId, approvalId }, signal); }
  browserClick(tabId: string, selector: string, taskId = 'client-browser', approvalId?: string, signal?: AbortSignal): Promise<{ result: { tabId: string; selector: string } } | ApprovalRequiredResult> { return this.browserMutation('/browser/click', { tabId, selector, taskId, approvalId }, signal); }
  browserFill(tabId: string, selector: string, text: string, taskId = 'client-browser', approvalId?: string, signal?: AbortSignal): Promise<{ result: { tabId: string; selector: string } } | ApprovalRequiredResult> { return this.browserMutation('/browser/fill', { tabId, selector, text, taskId, approvalId }, signal); }
  async *events(options: EventStreamOptions = {}): AsyncGenerator<TaskEvent, void, void> {
    const headers = new Headers();
    headers.set('accept', 'text/event-stream');
    if (this.token) headers.set('authorization', `Bearer ${this.token}`);
    if (options.lastEventId) headers.set('last-event-id', options.lastEventId);
    const response = await this.fetchImpl(`${this.apiBase}/events`, { headers, cache: 'no-store', signal: options.signal ?? null });
    if (!response.ok) throw new AgentCorpsApiError(response.status, `${response.status} ${response.statusText}`);
    if (!response.body) throw new Error('Gateway returned an empty event stream');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      while (true) {
        const chunk = await reader.read();
        buffer += decoder.decode(chunk.value ?? new Uint8Array(), { stream: !chunk.done });
        const records = buffer.split(/\r?\n\r?\n/);
        buffer = records.pop() ?? '';
        for (const record of records) {
          const data = record.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
          if (!data) continue;
          const event = JSON.parse(data) as TaskEvent;
          if (event.type) yield event;
        }
        if (chunk.done) break;
      }
    } finally { await reader.cancel(); }
  }
  private gitMutation(path: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<GitMutationResult> { return this.request(path, { method: 'POST', body: JSON.stringify(removeUndefined(body)), signal: signal ?? null }); }
  private browserMutation<T>(path: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<T> { return this.request(path, { method: 'POST', body: JSON.stringify(removeUndefined(body)), signal: signal ?? null }); }
  async runAndWait(input: AgentRunInput, handlers: RunEventHandlers = {}): Promise<AgentRunResult> {
    const accepted = await this.run(input, handlers.signal);
    return this.waitForRun(accepted.task.id, handlers);
  }
  async waitForRun(id: string, handlers: RunEventHandlers = {}): Promise<AgentRunResult> {
    const seen = new Set<string>();
    let snapshot = await this.task(id, handlers.signal);
    for (const event of snapshot.events) this.dispatch(event, seen, handlers);
    while (!['succeeded', 'failed', 'cancelled', 'waiting_approval'].includes(snapshot.task.status)) {
      await delay(handlers.pollMs ?? this.defaultPollMs, handlers.signal);
      snapshot = await this.task(id, handlers.signal);
      for (const event of snapshot.events) this.dispatch(event, seen, handlers);
    }
    return { ...snapshot, output: snapshot.events.filter((event): event is Extract<TaskEvent, { type: 'run.output' }> => event.type === 'run.output').map((event) => event.payload.text).join('') };
  }
  private dispatch(event: TaskEvent, seen: Set<string>, handlers: RunEventHandlers): void {
    if (seen.has(event.id)) return;
    seen.add(event.id);
    handlers.onEvent?.(event);
    if (event.type === 'run.output') handlers.onOutput?.(event.payload.text, event);
  }
  private decide(id: string, action: 'approve' | 'deny', decidedBy: string, reason?: string, signal?: AbortSignal): Promise<{ approval: Approval }> {
    if (!decidedBy.trim()) throw new Error('decidedBy cannot be empty');
    return this.request(`/approvals/${encodeURIComponent(id)}/${action}`, { method: 'POST', body: JSON.stringify({ decidedBy, ...(reason ? { reason } : {}) }), signal: signal ?? null });
  }
  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set('accept', 'application/json');
    if (this.token) headers.set('authorization', `Bearer ${this.token}`);
    if (init.body) headers.set('content-type', 'application/json');
    const response = await this.fetchImpl(`${this.apiBase}${path}`, { ...init, headers, cache: 'no-store' });
    const text = await response.text();
    let body: unknown = undefined;
    if (text) { try { body = JSON.parse(text) as unknown; } catch { body = text; } }
    if (!response.ok) {
      const message = typeof body === 'object' && body !== null && 'error' in body ? String((body as ApiErrorBody).error) : response.statusText;
      throw new AgentCorpsApiError(response.status, `${response.status} ${message}`, body);
    }
    return body as T;
  }
}

function queryString(values: Record<string, string | number | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) if (value !== undefined) params.set(key, String(value));
  return params.toString();
}

function removeUndefined(values: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined));
}

function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason ?? new DOMException('The operation was aborted', 'AbortError')); return; }
    const timer = setTimeout(resolve, milliseconds);
    signal?.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason ?? new DOMException('The operation was aborted', 'AbortError')); }, { once: true });
  });
}

export type { Approval, MemoryRecord, Session, SessionMessage, Task, TaskEvent };
