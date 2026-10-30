import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createRequire } from 'node:module';

export type UsageKind = 'model' | 'tool' | 'protocol';
export type UsageStatus = 'succeeded' | 'failed' | 'approval_required' | 'cancelled';
export type TokenSource = 'provider' | 'estimated' | 'unknown';

export interface UsageStart {
  readonly kind: UsageKind;
  readonly toolId: string;
  readonly model?: string;
  readonly operation?: string;
  readonly metadata?: Readonly<Record<string, string | number | boolean>>;
}

export interface UsageRecord {
  readonly id: string;
  readonly kind: UsageKind;
  readonly taskId: string;
  readonly runId: string;
  readonly toolId: string;
  readonly model?: string;
  readonly operation?: string;
  readonly status: UsageStatus;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly durationMs: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly totalTokens?: number;
  readonly tokenSource: TokenSource;
  readonly error?: string;
  readonly metadata?: Readonly<Record<string, string | number | boolean>>;
}

export interface UsageFilter {
  readonly from?: string;
  readonly to?: string;
  readonly taskId?: string;
  readonly runId?: string;
  readonly toolId?: string;
  readonly model?: string;
  readonly kind?: UsageKind;
  readonly status?: UsageStatus;
  readonly limit?: number;
}

export interface UsageSummary {
  readonly kind: UsageKind;
  readonly toolId: string;
  readonly model?: string;
  readonly calls: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly approvalRequired: number;
  readonly cancelled: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly estimatedCalls: number;
}

export interface UsageStore {
  append(record: UsageRecord): void;
  list(filter?: UsageFilter): readonly UsageRecord[];
  summary(filter?: UsageFilter): readonly UsageSummary[];
  close?(): void;
}

export interface UsageSpan {
  inputText(text: string): void;
  outputText(text: string): void;
  setTokenUsage(inputTokens: number, outputTokens: number): void;
  finish(status: UsageStatus, error?: string): UsageRecord;
}

export interface UsageRecorder {
  start(input: UsageStart): UsageSpan;
}

export class UsageService implements UsageRecorder {
  constructor(
    private readonly store: UsageStore,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly id: (prefix: string) => string = (prefix) => `${prefix}-${crypto.randomUUID()}`,
  ) {}

  start(input: UsageStart & { readonly taskId?: string; readonly runId?: string }): UsageSpan {
    return new UsageSpanImpl(this.store, this.now, this.id, {
      ...input,
      taskId: input.taskId ?? 'unknown-task',
      runId: input.runId ?? 'unknown-run',
    });
  }

  forRun(taskId: string, runId: string): UsageRecorder {
    return { start: (input) => this.start({ ...input, taskId, runId }) };
  }

  list(filter?: UsageFilter): readonly UsageRecord[] { return this.store.list(filter); }
  summary(filter?: UsageFilter): readonly UsageSummary[] { return this.store.summary(filter); }
  close(): void { this.store.close?.(); }
}

class UsageSpanImpl implements UsageSpan {
  private inputBytes = 0;
  private outputBytes = 0;
  private providerInputTokens: number | undefined;
  private providerOutputTokens: number | undefined;
  private finished = false;
  private completedRecord: UsageRecord | undefined;
  private readonly startedAt: string;

  constructor(
    private readonly store: UsageStore,
    private readonly now: () => string,
    private readonly id: (prefix: string) => string,
    private readonly input: UsageStart & { readonly taskId: string; readonly runId: string },
  ) {
    this.startedAt = now();
  }

  inputText(text: string): void { if (!this.finished) this.inputBytes += Buffer.byteLength(text, 'utf8'); }
  outputText(text: string): void { if (!this.finished) this.outputBytes += Buffer.byteLength(text, 'utf8'); }

  setTokenUsage(inputTokens: number, outputTokens: number): void {
    if (this.finished || !Number.isInteger(inputTokens) || inputTokens < 0 || !Number.isInteger(outputTokens) || outputTokens < 0) return;
    this.providerInputTokens = inputTokens;
    this.providerOutputTokens = outputTokens;
  }

  finish(status: UsageStatus, error?: string): UsageRecord {
    if (this.finished) return this.completedRecord!;
    this.finished = true;
    const endedAt = this.now();
    const startedMs = Date.parse(this.startedAt);
    const endedMs = Date.parse(endedAt);
    const inputTokens = this.providerInputTokens ?? estimatedTokens(this.inputBytes);
    const outputTokens = this.providerOutputTokens ?? estimatedTokens(this.outputBytes);
    const tokenSource: TokenSource = this.providerInputTokens !== undefined || this.providerOutputTokens !== undefined ? 'provider'
      : inputTokens !== undefined || outputTokens !== undefined ? 'estimated' : 'unknown';
    const record: UsageRecord = {
      id: this.id('usage'), kind: this.input.kind, taskId: this.input.taskId, runId: this.input.runId, toolId: this.input.toolId,
      ...(this.input.model ? { model: this.input.model } : {}), ...(this.input.operation ? { operation: this.input.operation } : {}),
      status, startedAt: this.startedAt, endedAt, durationMs: Number.isFinite(startedMs) && Number.isFinite(endedMs) ? Math.max(0, endedMs - startedMs) : 0,
      ...(inputTokens === undefined ? {} : { inputTokens }), ...(outputTokens === undefined ? {} : { outputTokens }),
      ...(inputTokens === undefined && outputTokens === undefined ? {} : { totalTokens: (inputTokens ?? 0) + (outputTokens ?? 0) }),
      tokenSource, ...(error ? { error: error.slice(0, 2_000) } : {}), ...(this.input.metadata ? { metadata: this.input.metadata } : {}),
    };
    this.completedRecord = record;
    this.store.append(record);
    return record;
  }
}

function estimatedTokens(bytes: number): number | undefined { return bytes > 0 ? Math.ceil(bytes / 4) : undefined; }

export class InMemoryUsageStore implements UsageStore {
  private readonly records: UsageRecord[] = [];
  append(record: UsageRecord): void { this.records.push(record); }
  list(filter: UsageFilter = {}): readonly UsageRecord[] { return applyFilter(this.records, filter).sort((left, right) => right.startedAt.localeCompare(left.startedAt)); }
  summary(filter: UsageFilter = {}): readonly UsageSummary[] { return summarize(applyFilter(this.records, filter)); }
}

interface SqliteStatement { run(...parameters: unknown[]): unknown; all(...parameters: unknown[]): unknown[]; }
interface SqliteDatabase { exec(sql: string): void; prepare(sql: string): SqliteStatement; close(): void; }
function databaseSync(): new (filePath: string) => SqliteDatabase {
  return (createRequire(import.meta.url)('node:sqlite') as { DatabaseSync: new (filePath: string) => SqliteDatabase }).DatabaseSync;
}

export class SqliteUsageStore implements UsageStore {
  private readonly db: SqliteDatabase;
  constructor(filePath: string) {
    mkdirSync(dirname(filePath), { recursive: true });
    this.db = new (databaseSync())(filePath);
    this.db.exec(`CREATE TABLE IF NOT EXISTS usage_records (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, task_id TEXT NOT NULL, run_id TEXT NOT NULL, tool_id TEXT NOT NULL,
      model TEXT, operation TEXT, status TEXT NOT NULL, started_at TEXT NOT NULL, ended_at TEXT NOT NULL,
      duration_ms INTEGER NOT NULL, input_tokens INTEGER, output_tokens INTEGER, total_tokens INTEGER,
      token_source TEXT NOT NULL, error TEXT, metadata TEXT
    ); CREATE INDEX IF NOT EXISTS usage_records_started_idx ON usage_records (started_at DESC);
    CREATE INDEX IF NOT EXISTS usage_records_dimensions_idx ON usage_records (kind, tool_id, model, status);`);
  }
  append(record: UsageRecord): void {
    this.db.prepare(`INSERT INTO usage_records (id, kind, task_id, run_id, tool_id, model, operation, status, started_at, ended_at, duration_ms, input_tokens, output_tokens, total_tokens, token_source, error, metadata) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(record.id, record.kind, record.taskId, record.runId, record.toolId, record.model ?? null, record.operation ?? null, record.status, record.startedAt, record.endedAt, record.durationMs, record.inputTokens ?? null, record.outputTokens ?? null, record.totalTokens ?? null, record.tokenSource, record.error ?? null, record.metadata ? JSON.stringify(record.metadata) : null);
  }
  list(filter: UsageFilter = {}): readonly UsageRecord[] {
    const { where, values } = sqlFilter(filter);
    const limit = boundedLimit(filter.limit);
    return this.db.prepare(`SELECT * FROM usage_records${where} ORDER BY started_at DESC, id DESC LIMIT ?`).all(...values, limit).map((row) => usageFromRow(row as Record<string, unknown>));
  }
  summary(filter: UsageFilter = {}): readonly UsageSummary[] {
    const { where, values } = sqlFilter(filter);
    return this.db.prepare(`SELECT kind, tool_id, model, COUNT(*) AS calls,
      SUM(CASE WHEN status = 'succeeded' THEN 1 ELSE 0 END) AS succeeded,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
      SUM(CASE WHEN status = 'approval_required' THEN 1 ELSE 0 END) AS approval_required,
      SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) AS cancelled,
      COALESCE(SUM(input_tokens), 0) AS input_tokens, COALESCE(SUM(output_tokens), 0) AS output_tokens,
      COALESCE(SUM(total_tokens), 0) AS total_tokens,
      SUM(CASE WHEN token_source = 'estimated' THEN 1 ELSE 0 END) AS estimated_calls
      FROM usage_records${where} GROUP BY kind, tool_id, model ORDER BY calls DESC, tool_id`).all(...values).map((row) => summaryFromRow(row as Record<string, unknown>));
  }
  close(): void { this.db.close(); }
}

export class JsonlUsageStore implements UsageStore {
  private readonly records: UsageRecord[];
  constructor(private readonly filePath: string) {
    mkdirSync(dirname(filePath), { recursive: true });
    this.records = existsSync(filePath) ? readFileSync(filePath, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as UsageRecord) : [];
  }
  append(record: UsageRecord): void { appendFileSync(this.filePath, `${JSON.stringify(record)}\n`, 'utf8'); this.records.push(record); }
  list(filter: UsageFilter = {}): readonly UsageRecord[] { return applyFilter(this.records, filter).sort((left, right) => right.startedAt.localeCompare(left.startedAt)); }
  summary(filter: UsageFilter = {}): readonly UsageSummary[] { return summarize(applyFilter(this.records, filter)); }
}

function boundedLimit(value: number | undefined): number { return value === undefined ? 100 : Number.isInteger(value) && value > 0 ? Math.min(value, 500) : 100; }
function applyFilter(records: readonly UsageRecord[], filter: UsageFilter): UsageRecord[] {
  return records.filter((record) => (!filter.from || record.startedAt >= filter.from) && (!filter.to || record.startedAt <= filter.to) && (!filter.taskId || record.taskId === filter.taskId) && (!filter.runId || record.runId === filter.runId) && (!filter.toolId || record.toolId === filter.toolId) && (!filter.model || record.model === filter.model) && (!filter.kind || record.kind === filter.kind) && (!filter.status || record.status === filter.status)).slice(0, boundedLimit(filter.limit));
}
function sqlFilter(filter: UsageFilter): { where: string; values: unknown[] } {
  const clauses: string[] = []; const values: unknown[] = [];
  if (filter.from !== undefined) { clauses.push('started_at >= ?'); values.push(filter.from); }
  if (filter.to !== undefined) { clauses.push('started_at <= ?'); values.push(filter.to); }
  for (const [field, value] of [['task_id', filter.taskId], ['run_id', filter.runId], ['tool_id', filter.toolId], ['model', filter.model], ['kind', filter.kind], ['status', filter.status]] as const) if (value !== undefined) { clauses.push(`${field} = ?`); values.push(value); }
  return { where: clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '', values };
}
function usageFromRow(row: Record<string, unknown>): UsageRecord {
  return {
    id: String(row.id), kind: row.kind as UsageKind, taskId: String(row.task_id), runId: String(row.run_id), toolId: String(row.tool_id),
    ...(row.model ? { model: String(row.model) } : {}), ...(row.operation ? { operation: String(row.operation) } : {}), status: row.status as UsageStatus,
    startedAt: String(row.started_at), endedAt: String(row.ended_at), durationMs: Number(row.duration_ms),
    ...(row.input_tokens === null ? {} : { inputTokens: Number(row.input_tokens) }), ...(row.output_tokens === null ? {} : { outputTokens: Number(row.output_tokens) }),
    ...(row.total_tokens === null ? {} : { totalTokens: Number(row.total_tokens) }), tokenSource: row.token_source as TokenSource,
    ...(row.error ? { error: String(row.error) } : {}), ...(row.metadata ? { metadata: JSON.parse(String(row.metadata)) as Readonly<Record<string, string | number | boolean>> } : {}),
  };
}
function summaryFromRow(row: Record<string, unknown>): UsageSummary {
  return { kind: row.kind as UsageKind, toolId: String(row.tool_id), ...(row.model ? { model: String(row.model) } : {}), calls: Number(row.calls), succeeded: Number(row.succeeded), failed: Number(row.failed), approvalRequired: Number(row.approval_required), cancelled: Number(row.cancelled), inputTokens: Number(row.input_tokens), outputTokens: Number(row.output_tokens), totalTokens: Number(row.total_tokens), estimatedCalls: Number(row.estimated_calls) };
}
function summarize(records: readonly UsageRecord[]): readonly UsageSummary[] {
  const groups = new Map<string, UsageSummary>();
  for (const record of records) {
    const key = `${record.kind}\u0000${record.toolId}\u0000${record.model ?? ''}`;
    const current = groups.get(key) ?? { kind: record.kind, toolId: record.toolId, ...(record.model ? { model: record.model } : {}), calls: 0, succeeded: 0, failed: 0, approvalRequired: 0, cancelled: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, estimatedCalls: 0 };
    groups.set(key, { ...current, calls: current.calls + 1, succeeded: current.succeeded + (record.status === 'succeeded' ? 1 : 0), failed: current.failed + (record.status === 'failed' ? 1 : 0), approvalRequired: current.approvalRequired + (record.status === 'approval_required' ? 1 : 0), cancelled: current.cancelled + (record.status === 'cancelled' ? 1 : 0), inputTokens: current.inputTokens + (record.inputTokens ?? 0), outputTokens: current.outputTokens + (record.outputTokens ?? 0), totalTokens: current.totalTokens + (record.totalTokens ?? 0), estimatedCalls: current.estimatedCalls + (record.tokenSource === 'estimated' ? 1 : 0) });
  }
  return [...groups.values()].sort((left, right) => right.calls - left.calls || left.toolId.localeCompare(right.toolId));
}
