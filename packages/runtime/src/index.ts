import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  assertTransition,
  createTask,
  type AgentDescriptor,
  type CreateTaskInput,
  type EventEnvelope,
  type EventId,
  type RunId,
  type Task,
  type TaskEvent,
  type TaskId,
  type TaskStatus,
} from '@agentcorps/domain';

export interface EventStore {
  append(event: TaskEvent): void;
  list(aggregateId?: string): readonly TaskEvent[];
  subscribe(listener: (event: TaskEvent) => void): () => void;
}

export class InMemoryEventStore implements EventStore {
  private readonly events: TaskEvent[] = [];
  private readonly listeners = new Set<(event: TaskEvent) => void>();

  append(event: TaskEvent): void {
    this.events.push(event);
    for (const listener of this.listeners) listener(event);
  }

  list(aggregateId?: string): readonly TaskEvent[] {
    return aggregateId ? this.events.filter((event) => event.aggregateId === aggregateId) : [...this.events];
  }

  subscribe(listener: (event: TaskEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

export class JsonlEventStore implements EventStore {
  private readonly events: TaskEvent[];
  private readonly listeners = new Set<(event: TaskEvent) => void>();

  constructor(private readonly filePath: string) {
    mkdirSync(dirname(filePath), { recursive: true });
    this.events = existsSync(filePath)
      ? readFileSync(filePath, 'utf8')
          .split('\\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line) as TaskEvent)
      : [];
  }

  append(event: TaskEvent): void {
    appendFileSync(this.filePath, `${JSON.stringify(event)}\\n`, 'utf8');
    this.events.push(event);
    for (const listener of this.listeners) listener(event);
  }

  list(aggregateId?: string): readonly TaskEvent[] {
    return aggregateId ? this.events.filter((event) => event.aggregateId === aggregateId) : [...this.events];
  }

  subscribe(listener: (event: TaskEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

export interface AgentRequest {
  readonly task: Task;
  readonly runId: RunId;
  readonly signal: AbortSignal;
  readonly emit: (text: string, stream?: 'stdout' | 'stderr' | 'assistant') => void;
}

export interface AgentAdapter {
  readonly descriptor: AgentDescriptor;
  execute(request: AgentRequest): Promise<void>;
}

export interface PolicyDecision {
  readonly allowed: boolean;
  readonly reason: string;
}

export interface Policy {
  decide(task: Task, agent: AgentDescriptor): PolicyDecision;
}

export class DefaultPolicy implements Policy {
  decide(task: Task, agent: AgentDescriptor): PolicyDecision {
    if (task.mode === 'work' && agent.capabilities.some((capability) => capability.risk === 'critical')) {
      return { allowed: false, reason: 'Critical capabilities require an explicit work-mode approval' };
    }
    return { allowed: true, reason: 'Agent has no blocked capability for this mode' };
  }
}

export class MockAgent implements AgentAdapter {
  readonly descriptor: AgentDescriptor = {
    id: 'mock-agent',
    displayName: 'Mock Agent',
    version: '0.1.0',
    transport: 'mock',
    capabilities: [{ name: 'task.echo', description: 'Echo the task objective', risk: 'low', scopes: ['task'] }],
  };

  async execute(request: AgentRequest): Promise<void> {
    if (request.signal.aborted) throw new Error('Run cancelled before execution');
    request.emit(`Planning: ${request.task.objective}`);
    await Promise.resolve();
    if (request.signal.aborted) throw new Error('Run cancelled during execution');
    request.emit('Completed by mock agent');
  }
}

export interface TaskRuntimeOptions {
  readonly now?: () => string;
  readonly id?: (prefix: string) => string;
  readonly store?: EventStore;
  readonly policy?: Policy;
}

export class TaskRuntime {
  readonly store: EventStore;
  readonly policy: Policy;
  private readonly now: () => string;
  private readonly id: (prefix: string) => string;
  private readonly tasks = new Map<TaskId, Task>();
  private readonly activeRuns = new Map<TaskId, AbortController>();

  constructor(options: TaskRuntimeOptions = {}) {
    this.store = options.store ?? new InMemoryEventStore();
    this.policy = options.policy ?? new DefaultPolicy();
    this.now = options.now ?? (() => new Date().toISOString());
    this.id = options.id ?? ((prefix) => `${prefix}-${crypto.randomUUID()}`);
    this.store.subscribe((event) => this.project(event));
    for (const event of this.store.list()) this.project(event);
  }

  createTask(input: CreateTaskInput): Task {
    const task = createTask(input, this.id('task') as TaskId, this.now());
    this.store.append(this.event('task.created', task.id, { task }));
    return task;
  }

  delegateTask(parentTaskId: TaskId, input: Omit<CreateTaskInput, 'parentTaskId'>): Task {
    if (!this.tasks.has(parentTaskId)) throw new Error(`Parent task not found: ${parentTaskId}`);
    return this.createTask({ ...input, parentTaskId });
  }

  getChildren(parentTaskId: TaskId): readonly Task[] {
    return this.listTasks().filter((task) => task.parentTaskId === parentTaskId);
  }

  async runDelegatedTasks(
    parentTaskId: TaskId,
    assignments: readonly { input: Omit<CreateTaskInput, 'parentTaskId'>; agent: AgentAdapter }[],
    maxConcurrent = 2,
  ): Promise<readonly Task[]> {
    if (!this.tasks.has(parentTaskId)) throw new Error(`Parent task not found: ${parentTaskId}`);
    if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1) throw new Error('maxConcurrent must be a positive integer');
    const children = assignments.map(({ input }) => this.delegateTask(parentTaskId, input));
    let next = 0;
    const results: Task[] = new Array(children.length);
    const worker = async (): Promise<void> => {
      while (next < children.length) {
        const index = next++;
        const assignment = assignments[index];
        const child = children[index];
        if (!assignment || !child) continue;
        results[index] = await this.runTask(child.id, assignment.agent);
      }
    };
    await Promise.all(Array.from({ length: Math.min(maxConcurrent, children.length) }, () => worker()));
    return results;
  }

  getTask(taskId: TaskId): Task | undefined {
    return this.tasks.get(taskId);
  }

  listTasks(): readonly Task[] {
    return [...this.tasks.values()];
  }

  async runTask(taskId: TaskId, agent: AgentAdapter): Promise<Task> {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    const decision = this.policy.decide(task, agent.descriptor);
    if (!decision.allowed) throw new Error(`Policy denied task: ${decision.reason}`);

    this.changeStatus(task, 'running');
    const runId = this.id('run') as RunId;
    this.store.append(this.event('run.started', task.id, { runId, agentId: agent.descriptor.id }));
    const controller = new AbortController();
    this.activeRuns.set(taskId, controller);
    try {
      await agent.execute({ task: this.tasks.get(taskId)!, runId, signal: controller.signal, emit: (text, stream = 'assistant') => {
        this.store.append(this.event('run.output', task.id, { runId, text, stream }));
      }});
      if (this.tasks.get(taskId)?.status !== 'cancelled') this.changeStatus(this.tasks.get(taskId)!, 'succeeded');
    } catch (error) {
      if (this.tasks.get(taskId)?.status !== 'cancelled') {
        this.changeStatus(this.tasks.get(taskId)!, 'failed', error instanceof Error ? error.message : String(error));
      }
    } finally {
      this.activeRuns.delete(taskId);
    }
    return this.tasks.get(taskId)!;
  }

  cancelTask(taskId: TaskId, reason = 'Cancelled by user'): Task {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    if (task.status === 'queued' || task.status === 'running' || task.status === 'waiting_approval') {
      this.activeRuns.get(taskId)?.abort(reason);
      this.changeStatus(task, 'cancelled', reason);
    }
    return this.tasks.get(taskId)!;
  }

  retryTask(taskId: TaskId): Task {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    if (task.status !== 'failed' && task.status !== 'cancelled') {
      throw new Error(`Only failed or cancelled tasks can be retried: ${task.status}`);
    }
    this.changeStatus(task, 'queued', 'Retry requested');
    return this.tasks.get(taskId)!;
  }

  private changeStatus(task: Task, to: TaskStatus, reason?: string): void {
    assertTransition(task.status, to);
    this.store.append(this.event('task.status_changed', task.id, {
      from: task.status,
      to,
      ...(reason ? { reason } : {}),
    }));
  }

  private project(event: TaskEvent): void {
    if (event.type === 'task.created') this.tasks.set(event.payload.task.id, event.payload.task);
    if (event.type === 'task.status_changed') {
      const current = this.tasks.get(event.aggregateId as TaskId);
      if (current) this.tasks.set(current.id, { ...current, status: event.payload.to, updatedAt: event.occurredAt });
    }
  }

  private event<TType extends TaskEvent['type'], TPayload>(type: TType, aggregateId: string, payload: TPayload): TaskEvent {
    return {
      id: this.id('event') as EventId,
      type,
      version: 1,
      aggregateType: type.startsWith('run.') ? 'run' : 'task',
      aggregateId,
      correlationId: aggregateId,
      occurredAt: this.now(),
      payload,
    } as TaskEvent;
  }
}

export function formatEvent(event: EventEnvelope): string {
  return `${event.occurredAt} ${event.type} ${event.aggregateId}`;
}
