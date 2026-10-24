import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

export type WorkflowStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
export type WorkflowNodeStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'skipped';

export interface WorkflowNode {
  readonly id: string;
  readonly title: string;
  readonly objective: string;
  readonly dependsOn?: readonly string[];
  readonly maxAttempts?: number;
  readonly timeoutMs?: number;
  readonly compensate?: (context: WorkflowCompensationContext) => Promise<void> | void;
}

export interface WorkflowDefinition {
  readonly id: string;
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly nodes: readonly WorkflowNode[];
}

export interface WorkflowNodeState {
  readonly status: WorkflowNodeStatus;
  readonly attempts: number;
  readonly updatedAt: string;
  readonly error?: string;
}

export interface WorkflowRun {
  readonly id: string;
  readonly definitionId: string;
  readonly status: WorkflowStatus;
  readonly nodeStates: Readonly<Record<string, WorkflowNodeState>>;
  readonly completedOrder: readonly string[];
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly finishedAt?: string;
  readonly error?: string;
}

export interface WorkflowExecutionContext {
  readonly run: WorkflowRun;
  readonly node: WorkflowNode;
  readonly attempt: number;
  readonly signal: AbortSignal;
}

export interface WorkflowCompensationContext {
  readonly run: WorkflowRun;
  readonly node: WorkflowNode;
  readonly signal: AbortSignal;
}

export interface WorkflowExecutor {
  execute(context: WorkflowExecutionContext): Promise<void>;
}

export interface WorkflowStore {
  save(run: WorkflowRun): void;
  get(id: string): WorkflowRun | undefined;
  list(): readonly WorkflowRun[];
}

export class InMemoryWorkflowStore implements WorkflowStore {
  private readonly runs = new Map<string, WorkflowRun>();
  save(run: WorkflowRun): void { this.runs.set(run.id, run); }
  get(id: string): WorkflowRun | undefined { return this.runs.get(id); }
  list(): readonly WorkflowRun[] { return [...this.runs.values()]; }
}

export class JsonlWorkflowStore implements WorkflowStore {
  private readonly runs = new Map<string, WorkflowRun>();

  constructor(private readonly filePath: string) {
    mkdirSync(dirname(filePath), { recursive: true });
    if (!existsSync(filePath)) return;
    for (const line of readFileSync(filePath, 'utf8').split('\n').filter(Boolean)) {
      const run = JSON.parse(line) as WorkflowRun;
      this.runs.set(run.id, run);
    }
  }

  save(run: WorkflowRun): void {
    appendFileSync(this.filePath, `${JSON.stringify(run)}\n`, 'utf8');
    this.runs.set(run.id, run);
  }

  get(id: string): WorkflowRun | undefined { return this.runs.get(id); }
  list(): readonly WorkflowRun[] { return [...this.runs.values()]; }
}

export interface WorkflowEngineOptions {
  readonly store?: WorkflowStore;
  readonly now?: () => string;
  readonly id?: (prefix: string) => string;
  readonly maxConcurrent?: number;
  readonly stopOnFailure?: boolean;
}

export class WorkflowEngine {
  private readonly store: WorkflowStore;
  private readonly now: () => string;
  private readonly id: (prefix: string) => string;
  private readonly defaultMaxConcurrent: number;
  private readonly stopOnFailure: boolean;

  constructor(options: WorkflowEngineOptions = {}) {
    this.store = options.store ?? new InMemoryWorkflowStore();
    this.now = options.now ?? (() => new Date().toISOString());
    this.id = options.id ?? ((prefix) => `${prefix}-${crypto.randomUUID()}`);
    this.defaultMaxConcurrent = positiveInteger(options.maxConcurrent, 4);
    this.stopOnFailure = options.stopOnFailure ?? true;
  }

  validate(definition: WorkflowDefinition): void {
    if (!definition.id.trim()) throw new Error('Workflow id is required');
    if (!definition.workspaceId.trim() || !definition.sessionId.trim()) throw new Error('Workflow workspaceId and sessionId are required');
    if (!definition.nodes.length) throw new Error('Workflow must contain at least one node');
    const ids = new Set<string>();
    for (const node of definition.nodes) {
      if (!node.id.trim() || !node.title.trim() || !node.objective.trim()) throw new Error('Workflow nodes require id, title, and objective');
      if (ids.has(node.id)) throw new Error(`Duplicate workflow node: ${node.id}`);
      ids.add(node.id);
      const attempts = node.maxAttempts ?? 1;
      if (!Number.isInteger(attempts) || attempts < 1) throw new Error(`Invalid maxAttempts for node: ${node.id}`);
      if (node.timeoutMs !== undefined && (!Number.isInteger(node.timeoutMs) || node.timeoutMs <= 0)) throw new Error(`Invalid timeoutMs for node: ${node.id}`);
    }
    for (const node of definition.nodes) for (const dependency of node.dependsOn ?? []) {
      if (!ids.has(dependency)) throw new Error(`Unknown dependency ${dependency} for node ${node.id}`);
      if (dependency === node.id) throw new Error(`Workflow node cannot depend on itself: ${node.id}`);
    }
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const byId = new Map(definition.nodes.map((node) => [node.id, node]));
    const visit = (id: string): void => {
      if (visiting.has(id)) throw new Error(`Workflow contains a dependency cycle at node: ${id}`);
      if (visited.has(id)) return;
      visiting.add(id);
      for (const dependency of byId.get(id)?.dependsOn ?? []) visit(dependency);
      visiting.delete(id);
      visited.add(id);
    };
    for (const node of definition.nodes) visit(node.id);
  }

  getRun(id: string): WorkflowRun | undefined { return this.store.get(id); }
  listRuns(): readonly WorkflowRun[] { return this.store.list(); }

  async run(definition: WorkflowDefinition, executor: WorkflowExecutor, signal?: AbortSignal, maxConcurrent = this.defaultMaxConcurrent): Promise<WorkflowRun> {
    this.validate(definition);
    if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1) throw new Error('maxConcurrent must be a positive integer');
    const now = this.now();
    const nodeStates: Record<string, WorkflowNodeState> = {};
    for (const node of definition.nodes) nodeStates[node.id] = { status: 'pending', attempts: 0, updatedAt: now };
    const run: WorkflowRun = { id: this.id('workflow-run'), definitionId: definition.id, status: 'queued', nodeStates, completedOrder: [], createdAt: now, updatedAt: now };
    this.store.save(run);
    return await this.execute(definition, executor, run, signal, maxConcurrent);
  }

  async resume(definition: WorkflowDefinition, executor: WorkflowExecutor, runId: string, signal?: AbortSignal, maxConcurrent = this.defaultMaxConcurrent): Promise<WorkflowRun> {
    this.validate(definition);
    if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1) throw new Error('maxConcurrent must be a positive integer');
    const existing = this.store.get(runId);
    if (!existing) throw new Error(`Workflow run not found: ${runId}`);
    if (existing.definitionId !== definition.id) throw new Error('Workflow definition does not match persisted run');
    if (existing.status === 'succeeded' || existing.status === 'cancelled') return existing;
    const recoveredStates: Record<string, WorkflowNodeState> = { ...existing.nodeStates };
    for (const node of definition.nodes) if (recoveredStates[node.id]?.status === 'running') recoveredStates[node.id] = { ...recoveredStates[node.id]!, status: 'pending', updatedAt: this.now(), error: 'Recovered after interrupted process' };
    const recoveredBase = { ...existing };
    delete (recoveredBase as { finishedAt?: string }).finishedAt;
    delete (recoveredBase as { error?: string }).error;
    const recovered: WorkflowRun = { ...recoveredBase, status: 'queued', nodeStates: recoveredStates, updatedAt: this.now() };
    this.store.save(recovered);
    return await this.execute(definition, executor, recovered, signal, maxConcurrent);
  }

  private async execute(definition: WorkflowDefinition, executor: WorkflowExecutor, initial: WorkflowRun, signal: AbortSignal | undefined, maxConcurrent: number): Promise<WorkflowRun> {
    let run = this.updateRun(initial, { status: 'running' });
    const nodes = new Map(definition.nodes.map((node) => [node.id, node]));
    const active = new Map<string, Promise<void>>();
    const controllers = new Map<string, AbortController>();
    const completedOrder = [...run.completedOrder];
    let stopScheduling = false;
    const abortListener = () => { for (const controller of controllers.values()) controller.abort(signal?.reason); };
    if (signal?.aborted) abortListener();
    else signal?.addEventListener('abort', abortListener, { once: true });

    const persist = (changes: Partial<WorkflowRun>): void => { run = this.updateRun(run, changes); };
    const setNode = (nodeId: string, state: WorkflowNodeState): void => {
      run = this.updateRun(run, { nodeStates: { ...run.nodeStates, [nodeId]: state } });
    };
    const start = (node: WorkflowNode): void => {
      const controller = new AbortController();
      controllers.set(node.id, controller);
      const promise = this.runNode(run, node, executor, controller, signal, setNode, (attempt) => {
        if (attempt === 1) persist({});
      }).then((status) => {
        if (status === 'succeeded') completedOrder.push(node.id);
        if (status === 'failed' && this.stopOnFailure) stopScheduling = true;
      }).finally(() => {
        controllers.delete(node.id);
        active.delete(node.id);
      });
      active.set(node.id, promise);
    };

    try {
      while (true) {
        if (signal?.aborted) {
          stopScheduling = true;
          for (const node of definition.nodes) if (run.nodeStates[node.id]?.status === 'pending') setNode(node.id, { ...run.nodeStates[node.id]!, status: 'cancelled', updatedAt: this.now(), error: 'Workflow cancelled' });
        }
        for (const node of definition.nodes) {
          const state = run.nodeStates[node.id];
          if (!state || state.status !== 'pending' || active.has(node.id) || stopScheduling) continue;
          const dependencies = (node.dependsOn ?? []).map((id) => run.nodeStates[id]?.status);
          if (dependencies.some((status) => status === 'failed' || status === 'cancelled' || status === 'skipped')) {
            setNode(node.id, { ...state, status: 'skipped', updatedAt: this.now(), error: 'Dependency did not succeed' });
            continue;
          }
          if (dependencies.every((status) => status === 'succeeded') && active.size < maxConcurrent) start(node);
        }
        if (!active.size) {
          const pending = definition.nodes.some((node) => run.nodeStates[node.id]?.status === 'pending');
          if (pending && !stopScheduling) {
            stopScheduling = true;
            for (const node of definition.nodes) if (run.nodeStates[node.id]?.status === 'pending') setNode(node.id, { ...run.nodeStates[node.id]!, status: 'failed', updatedAt: this.now(), error: 'Workflow cannot make progress' });
            continue;
          }
          if (pending && stopScheduling) for (const node of definition.nodes) if (run.nodeStates[node.id]?.status === 'pending') setNode(node.id, { ...run.nodeStates[node.id]!, status: 'skipped', updatedAt: this.now(), error: 'Workflow stopped after a node failure' });
          break;
        }
        await Promise.race(active.values());
      }
      if (active.size) await Promise.allSettled(active.values());
      const failed = definition.nodes.some((node) => ['failed', 'cancelled'].includes(run.nodeStates[node.id]?.status ?? ''));
      const skipped = definition.nodes.some((node) => run.nodeStates[node.id]?.status === 'skipped');
      const status: WorkflowStatus = signal?.aborted ? 'cancelled' : failed || skipped ? 'failed' : 'succeeded';
      persist({ status, completedOrder, finishedAt: this.now(), ...(status === 'failed' ? { error: failed ? 'One or more workflow nodes failed' : 'Workflow did not complete' } : {}) });
      if (status === 'failed' && !signal?.aborted) await this.compensate(definition, run, executor, completedOrder);
      return run;
    } finally {
      if (signal && !signal.aborted) signal.removeEventListener('abort', abortListener);
    }
  }

  private async runNode(
    run: WorkflowRun,
    node: WorkflowNode,
    executor: WorkflowExecutor,
    controller: AbortController,
    parentSignal: AbortSignal | undefined,
    setNode: (nodeId: string, state: WorkflowNodeState) => void,
    onAttempt: (attempt: number) => void,
  ): Promise<WorkflowNodeStatus> {
    const maxAttempts = positiveInteger(node.maxAttempts, 1);
    const initialAttempts = run.nodeStates[node.id]?.attempts ?? 0;
    for (let attempt = initialAttempts + 1; attempt <= initialAttempts + maxAttempts; attempt += 1) {
      onAttempt(attempt);
      const startedAt = this.now();
      setNode(node.id, { status: 'running', attempts: attempt, updatedAt: startedAt });
      let timer: NodeJS.Timeout | undefined;
      const abort = () => controller.abort(parentSignal?.reason);
      if (parentSignal?.aborted) abort();
      else parentSignal?.addEventListener('abort', abort, { once: true });
      if (node.timeoutMs) timer = setTimeout(() => controller.abort(new Error(`Workflow node timed out after ${node.timeoutMs}ms`)), node.timeoutMs);
      try {
        await executor.execute({ run, node, attempt, signal: controller.signal });
        if (controller.signal.aborted) throw new Error('Workflow node cancelled');
        setNode(node.id, { status: 'succeeded', attempts: attempt, updatedAt: this.now() });
        return 'succeeded';
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (parentSignal?.aborted) {
          setNode(node.id, { status: 'cancelled', attempts: attempt, updatedAt: this.now(), error: message });
          return 'cancelled';
        }
        if (attempt === maxAttempts) {
          setNode(node.id, { status: 'failed', attempts: attempt, updatedAt: this.now(), error: message });
          return 'failed';
        }
      } finally {
        if (timer) clearTimeout(timer);
        parentSignal?.removeEventListener('abort', abort);
      }
    }
    return 'failed';
  }

  private async compensate(definition: WorkflowDefinition, run: WorkflowRun, executor: WorkflowExecutor, completedOrder: readonly string[]): Promise<void> {
    const controller = new AbortController();
    for (const nodeId of [...completedOrder].reverse()) {
      const node = definition.nodes.find((candidate) => candidate.id === nodeId);
      if (!node?.compensate) continue;
      try {
        await node.compensate({ run, node, signal: controller.signal });
      } catch (error) {
        run = this.updateRun(run, { error: `${run.error ?? 'Workflow failed'}; compensation for ${nodeId} failed: ${error instanceof Error ? error.message : String(error)}` });
      }
    }
    void executor;
  }

  private updateRun(run: WorkflowRun, changes: Partial<WorkflowRun>): WorkflowRun {
    const updated = { ...run, ...changes, updatedAt: this.now() };
    this.store.save(updated);
    return updated;
  }
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && value! > 0 ? value! : fallback;
}
