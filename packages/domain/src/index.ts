export type Mode = 'code' | 'work';

export type TaskStatus =
  | 'queued'
  | 'running'
  | 'waiting_approval'
  | 'succeeded'
  | 'failed'
  | 'cancelled';

export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';

export type TaskId = string & { readonly __brand: 'TaskId' };
export type RunId = string & { readonly __brand: 'RunId' };
export type EventId = string & { readonly __brand: 'EventId' };

export interface Task {
  readonly id: TaskId;
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly title: string;
  readonly objective: string;
  readonly mode: Mode;
  readonly status: TaskStatus;
  readonly parentTaskId?: TaskId;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface Capability {
  readonly name: string;
  readonly description: string;
  readonly risk: RiskLevel;
  readonly scopes: readonly string[];
}

export interface AgentDescriptor {
  readonly id: string;
  readonly displayName: string;
  readonly version: string;
  readonly model?: string;
  readonly transport: 'mock' | 'stdio-jsonl' | 'http' | 'acp' | 'a2a';
  readonly capabilities: readonly Capability[];
}

export interface EventEnvelope<TType extends string = string, TPayload = unknown> {
  readonly id: EventId;
  readonly type: TType;
  readonly version: 1;
  readonly aggregateType: 'task' | 'run' | 'session' | 'approval' | 'memory';
  readonly aggregateId: string;
  readonly correlationId: string;
  readonly causationId?: EventId;
  readonly occurredAt: string;
  readonly payload: TPayload;
}

export interface TaskCreatedPayload {
  readonly task: Task;
}

export interface RunStartedPayload {
  readonly runId: RunId;
  readonly agentId: string;
  readonly model?: string;
}

export interface RunOutputPayload {
  readonly runId: RunId;
  readonly text: string;
  readonly stream: 'stdout' | 'stderr' | 'assistant';
}

export type ProtocolName = 'stdio-jsonl' | 'a2a' | 'acp' | 'mcp';
export type ProtocolDirection = 'request' | 'response' | 'update';

export interface RunProtocolPayload {
  readonly runId: RunId;
  readonly protocol: ProtocolName;
  readonly direction: ProtocolDirection;
  readonly method: string;
  readonly metadata?: Readonly<Record<string, string | number | boolean>>;
}

export interface TaskStatusChangedPayload {
  readonly from: TaskStatus;
  readonly to: TaskStatus;
  readonly reason?: string;
}

export type TaskEvent =
  | EventEnvelope<'task.created', TaskCreatedPayload>
  | EventEnvelope<'run.started', RunStartedPayload>
  | EventEnvelope<'run.output', RunOutputPayload>
  | EventEnvelope<'run.protocol', RunProtocolPayload>
  | EventEnvelope<'task.status_changed', TaskStatusChangedPayload>;

export interface CreateTaskInput {
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly title: string;
  readonly objective: string;
  readonly mode: Mode;
  readonly parentTaskId?: TaskId;
}

const transitions: Record<TaskStatus, readonly TaskStatus[]> = {
  queued: ['running', 'cancelled'],
  running: ['waiting_approval', 'succeeded', 'failed', 'cancelled'],
  waiting_approval: ['running', 'cancelled', 'failed'],
  succeeded: [],
  failed: ['queued', 'cancelled'],
  cancelled: ['queued'],
};

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return transitions[from].includes(to);
}

export function assertTransition(from: TaskStatus, to: TaskStatus): void {
  if (!canTransition(from, to)) {
    throw new Error(`Invalid task transition: ${from} -> ${to}`);
  }
}

export function createTask(input: CreateTaskInput, id: TaskId, now: string): Task {
  if (!input.title.trim()) throw new Error('Task title cannot be empty');
  if (!input.objective.trim()) throw new Error('Task objective cannot be empty');
  return {
    id,
    workspaceId: input.workspaceId,
    sessionId: input.sessionId,
    title: input.title.trim(),
    objective: input.objective.trim(),
    mode: input.mode,
    status: 'queued',
    ...(input.parentTaskId ? { parentTaskId: input.parentTaskId } : {}),
    createdAt: now,
    updatedAt: now,
  };
}
