import type { RunId } from '@agentcorps/domain';
import type { Session, Task, TaskEvent } from '../api.js';

export const connection = { apiBase: 'http://127.0.0.1:43210', token: 'test-token' };
export const session: Session = { id: 'session-1', workspaceId: 'workspace-1', title: 'Release thread', mode: 'code', createdAt: '2026-10-25T00:00:00Z', updatedAt: '2026-10-25T00:00:00Z' };
export const task: Task = { id: 'task-1' as Task['id'], sessionId: session.id, workspaceId: session.workspaceId, title: 'Review release', objective: 'Check the release plan', status: 'queued', mode: 'code', createdAt: session.createdAt, updatedAt: session.updatedAt };
export function event(id = 'event-1', type: 'run.output' | 'task.created' | 'task.status_changed' = 'run.output'): TaskEvent {
  const envelope = { id: id as TaskEvent['id'], aggregateId: task.id, aggregateType: 'task' as const, correlationId: task.id, version: 1 as const, occurredAt: session.createdAt };
  if (type === 'task.created') return { ...envelope, type, payload: { task } };
  if (type === 'task.status_changed') return { ...envelope, type, payload: { from: 'queued', to: 'running' } };
  return { ...envelope, type, payload: { runId: 'run-1' as RunId, stream: 'assistant', text: 'Review complete' } };
}

export class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((message: { data: string }) => void) | null = null;
  closed = false;
  readonly url: string;
  constructor(url: string | URL, readonly protocols: string[]) { this.url = String(url); FakeWebSocket.instances.push(this); }
  open() { this.onopen?.(); }
  message(value: unknown) { this.onmessage?.({ data: JSON.stringify(value) }); }
  close() { this.closed = true; this.onclose?.(); }
}
