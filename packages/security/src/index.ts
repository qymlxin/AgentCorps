import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { dirname, resolve, relative, isAbsolute } from 'node:path';

interface SqliteStatement {
  run(...parameters: unknown[]): unknown;
  all(...parameters: unknown[]): unknown[];
}

interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}

const DatabaseSync = (createRequire(import.meta.url)('node:sqlite') as { DatabaseSync: new (filePath: string) => SqliteDatabase }).DatabaseSync;

export type SandboxLevel = 'S0' | 'S1' | 'S2' | 'S3' | 'S4';
export type SecurityDecision = 'allow' | 'approval_required' | 'deny';
export type SecurityCapability = 'fs.read' | 'fs.write' | 'process.exec' | 'network.connect' | 'secret.read';

export interface SandboxProfile {
  readonly level: SandboxLevel;
  readonly workspaceRoot: string;
  readonly writableRoots: readonly string[];
  readonly network: 'none' | 'allowlist' | 'full';
  readonly allowedHosts: readonly string[];
  readonly allowProcessExec: boolean;
}

export interface ToolRequest {
  readonly requestId: string;
  readonly taskId: string;
  readonly capability: SecurityCapability;
  readonly path?: string;
  readonly command?: string;
  readonly host?: string;
  readonly metadata?: Readonly<Record<string, string>>;
}

export interface SecurityContext {
  readonly mode: 'code' | 'work';
  readonly profile: SandboxProfile;
}

export interface PolicyResult {
  readonly decision: SecurityDecision;
  readonly reason: string;
  readonly requestId: string;
  readonly taskId: string;
}

export interface AuditRecord extends PolicyResult {
  readonly capability: SecurityCapability;
  readonly occurredAt: string;
}

export interface AuditLog {
  append(record: AuditRecord): void;
  list(): readonly AuditRecord[];
}

export class InMemoryAuditLog implements AuditLog {
  private readonly records: AuditRecord[] = [];
  append(record: AuditRecord): void { this.records.push(record); }
  list(): readonly AuditRecord[] { return [...this.records]; }
}

export class SqliteAuditLog implements AuditLog {
  private readonly db: SqliteDatabase;

  constructor(filePath: string) {
    mkdirSync(dirname(filePath), { recursive: true });
    this.db = new DatabaseSync(filePath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS audit_records (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        request_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        decision TEXT NOT NULL,
        reason TEXT NOT NULL,
        capability TEXT NOT NULL,
        occurred_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS audit_records_occurred_idx ON audit_records (occurred_at, id);
    `);
  }

  append(record: AuditRecord): void {
    this.db.prepare('INSERT INTO audit_records (request_id, task_id, decision, reason, capability, occurred_at) VALUES (?, ?, ?, ?, ?, ?)').run(
      record.requestId, record.taskId, record.decision, record.reason, record.capability, record.occurredAt,
    );
  }

  list(): readonly AuditRecord[] {
    return this.db.prepare('SELECT request_id, task_id, decision, reason, capability, occurred_at FROM audit_records ORDER BY occurred_at, id').all().map((row) => {
      const value = row as Record<string, unknown>;
      return { requestId: String(value.request_id), taskId: String(value.task_id), decision: value.decision as SecurityDecision, reason: String(value.reason), capability: value.capability as SecurityCapability, occurredAt: String(value.occurred_at) };
    });
  }

  close(): void { this.db.close(); }
}

export class PolicyEngine {
  constructor(private readonly audit: AuditLog, private readonly now: () => string = () => new Date().toISOString()) {}

  evaluate(request: ToolRequest, context: SecurityContext): PolicyResult {
    const result = this.decide(request, context);
    this.audit.append({ ...result, capability: request.capability, occurredAt: this.now() });
    return result;
  }

  private decide(request: ToolRequest, context: SecurityContext): PolicyResult {
    const { profile } = context;
    if (request.capability === 'fs.read') {
      return this.pathDecision(request, profile.workspaceRoot, false, 'Read access is limited to the workspace');
    }
    if (request.capability === 'fs.write') {
      const root = profile.writableRoots.find((candidate) => isWithin(candidate, request.path));
      if (!root || !isWithin(profile.workspaceRoot, request.path)) return this.result(request, 'deny', 'Write path is outside the workspace writable roots');
      if (profile.level === 'S0' || profile.level === 'S1') return this.result(request, 'deny', `${profile.level} does not permit writes`);
      if (context.mode === 'work') return this.result(request, 'approval_required', 'Work-mode writes require user approval');
      return this.result(request, 'allow', 'Code-mode write is inside an approved workspace root');
    }
    if (request.capability === 'process.exec') {
      if (!profile.allowProcessExec || profile.level === 'S0' || profile.level === 'S1') return this.result(request, 'deny', `${profile.level} does not permit process execution`);
      return this.result(request, 'approval_required', 'Process execution requires an explicit approval');
    }
    if (request.capability === 'network.connect') {
      if (profile.network === 'none') return this.result(request, 'deny', 'Network access is disabled by the sandbox profile');
      if (profile.network === 'allowlist' && !profile.allowedHosts.includes(request.host ?? '')) return this.result(request, 'deny', 'Host is not in the network allowlist');
      return this.result(request, 'approval_required', 'Network access requires an explicit approval');
    }
    return this.result(request, 'approval_required', 'Reading secrets always requires an explicit approval');
  }

  private pathDecision(request: ToolRequest, workspaceRoot: string, requiresApproval: boolean, reason: string): PolicyResult {
    if (!isWithin(workspaceRoot, request.path)) return this.result(request, 'deny', reason);
    return this.result(request, requiresApproval ? 'approval_required' : 'allow', 'Path is inside the workspace read boundary');
  }

  private result(request: ToolRequest, decision: SecurityDecision, reason: string): PolicyResult {
    return { decision, reason, requestId: request.requestId, taskId: request.taskId };
  }
}

export function isWithin(root: string, candidate: string | undefined): boolean {
  if (!candidate) return false;
  const rootPath = resolve(root);
  const candidatePath = resolve(candidate);
  const path = relative(rootPath, candidatePath);
  return path === '' || (!path.startsWith('..') && !isAbsolute(path));
}

export function createDefaultProfile(workspaceRoot: string, level: SandboxLevel = 'S1'): SandboxProfile {
  return {
    level,
    workspaceRoot: resolve(workspaceRoot),
    writableRoots: [resolve(workspaceRoot)],
    network: 'none',
    allowedHosts: [],
    allowProcessExec: level === 'S2' || level === 'S3' || level === 'S4',
  };
}

export * from './sandbox.js';
export * from './identity.js';
export * from './risk.js';
export * from './supply-chain.js';
export * from './external-identity.js';


export type ApprovalStatus = 'pending' | 'approved' | 'denied' | 'expired' | 'consumed';

export interface Approval {
  readonly id: string;
  readonly request: ToolRequest;
  readonly reason: string;
  readonly status: ApprovalStatus;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly decidedAt?: string;
  readonly decidedBy?: string;
  readonly decisionReason?: string;
}

export interface ApprovalStore {
  save(approval: Approval): void;
  get(id: string): Approval | undefined;
  list(): readonly Approval[];
  /** Atomically persists a state transition when the current status still matches. */
  updateIfStatus?(id: string, expected: ApprovalStatus, next: Approval): boolean;
}

export class InMemoryApprovalStore implements ApprovalStore {
  private readonly approvals = new Map<string, Approval>();
  save(approval: Approval): void { this.approvals.set(approval.id, approval); }
  updateIfStatus(id: string, expected: ApprovalStatus, next: Approval): boolean {
    const current = this.approvals.get(id);
    if (!current || current.status !== expected) return false;
    this.approvals.set(id, next);
    return true;
  }
  get(id: string): Approval | undefined { return this.approvals.get(id); }
  list(): readonly Approval[] { return [...this.approvals.values()]; }
}

export class SqliteApprovalStore implements ApprovalStore {
  private readonly db: SqliteDatabase;

  constructor(filePath: string) {
    mkdirSync(dirname(filePath), { recursive: true });
    this.db = new DatabaseSync(filePath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS approvals (
        id TEXT PRIMARY KEY,
        request_json TEXT NOT NULL,
        reason TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        decided_at TEXT,
        decided_by TEXT,
        decision_reason TEXT
      );
      CREATE INDEX IF NOT EXISTS approvals_status_idx ON approvals (status, expires_at);
    `);
  }

  save(approval: Approval): void {
    this.db.prepare(`
      INSERT INTO approvals (id, request_json, reason, status, created_at, expires_at, decided_at, decided_by, decision_reason)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET request_json = excluded.request_json, reason = excluded.reason,
        status = excluded.status, created_at = excluded.created_at, expires_at = excluded.expires_at,
        decided_at = excluded.decided_at, decided_by = excluded.decided_by, decision_reason = excluded.decision_reason
    `).run(
      approval.id, JSON.stringify(approval.request), approval.reason, approval.status, approval.createdAt, approval.expiresAt,
      approval.decidedAt ?? null, approval.decidedBy ?? null, approval.decisionReason ?? null,
    );
  }

  updateIfStatus(id: string, expected: ApprovalStatus, next: Approval): boolean {
    const result = this.db.prepare(`UPDATE approvals SET request_json = ?, reason = ?, status = ?, created_at = ?, expires_at = ?, decided_at = ?, decided_by = ?, decision_reason = ? WHERE id = ? AND status = ?`).run(
      JSON.stringify(next.request), next.reason, next.status, next.createdAt, next.expiresAt, next.decidedAt ?? null, next.decidedBy ?? null, next.decisionReason ?? null, id, expected,
    ) as { changes?: number };
    return Number(result?.changes ?? 0) === 1;
  }

  get(id: string): Approval | undefined {
    const row = this.db.prepare('SELECT * FROM approvals WHERE id = ?').all(id)[0];
    return row ? approvalFromRow(row as Record<string, unknown>) : undefined;
  }

  list(): readonly Approval[] {
    return this.db.prepare('SELECT * FROM approvals ORDER BY created_at, id').all().map((row) => approvalFromRow(row as Record<string, unknown>));
  }

  close(): void { this.db.close(); }
}

function approvalFromRow(row: Record<string, unknown>): Approval {
  return {
    id: String(row.id), request: JSON.parse(String(row.request_json)) as ToolRequest, reason: String(row.reason), status: row.status as ApprovalStatus,
    createdAt: String(row.created_at), expiresAt: String(row.expires_at),
    ...(row.decided_at ? { decidedAt: String(row.decided_at) } : {}), ...(row.decided_by ? { decidedBy: String(row.decided_by) } : {}),
    ...(row.decision_reason ? { decisionReason: String(row.decision_reason) } : {}),
  };
}

export class ApprovalService {
  constructor(
    private readonly store: ApprovalStore,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly id: () => string = () => `approval-${crypto.randomUUID()}`,
  ) {}

  create(request: ToolRequest, policy: PolicyResult, ttlMs = 5 * 60 * 1000): Approval {
    if (policy.decision !== 'approval_required') throw new Error('Only approval_required policy results can create approvals');
    if (!Number.isInteger(ttlMs) || ttlMs <= 0) throw new Error('Approval TTL must be a positive integer');
    const createdAt = this.now();
    const expiresAt = new Date(Date.parse(createdAt) + ttlMs).toISOString();
    const approval: Approval = { id: this.id(), request, reason: policy.reason, status: 'pending', createdAt, expiresAt };
    this.store.save(approval);
    return approval;
  }

  get(id: string): Approval | undefined {
    const approval = this.store.get(id);
    return approval ? this.expireIfNeeded(approval) : undefined;
  }

  list(): readonly Approval[] {
    return this.store.list().map((approval) => this.expireIfNeeded(approval));
  }

  approve(id: string, decidedBy: string, decisionReason?: string): Approval {
    return this.decide(id, 'approved', decidedBy, decisionReason);
  }

  deny(id: string, decidedBy: string, decisionReason?: string): Approval {
    return this.decide(id, 'denied', decidedBy, decisionReason);
  }

  consume(id: string): Approval | undefined {
    const current = this.get(id);
    if (!current || current.status !== 'approved') return undefined;
    const consumed = { ...current, status: 'consumed' as const, decidedAt: current.decidedAt ?? this.now() };
    if (!this.store.updateIfStatus?.(id, 'approved', consumed)) {
      if (this.store.updateIfStatus) return undefined;
      this.store.save(consumed);
    }
    return this.store.get(id) ?? consumed;
  }

  private decide(id: string, status: 'approved' | 'denied', decidedBy: string, decisionReason?: string): Approval {
    if (!decidedBy.trim()) throw new Error('Approval decision requires decidedBy');
    const current = this.get(id);
    if (!current) throw new Error(`Approval not found: ${id}`);
    if (current.status !== 'pending') throw new Error(`Approval is not pending: ${current.status}`);
    const decidedAt = this.now();
    const decided = { ...current, status, decidedAt, decidedBy: decidedBy.trim(), ...(decisionReason?.trim() ? { decisionReason: decisionReason.trim() } : {}) };
    if (!this.store.updateIfStatus?.(id, 'pending', decided)) {
      if (this.store.updateIfStatus) {
        const latest = this.get(id);
        if (latest && latest.status !== 'pending') throw new Error(`Approval is not pending: ${latest.status}`);
        throw new Error(`Approval transition failed: ${id}`);
      }
      this.store.save(decided);
    }
    return this.store.get(id) ?? decided;
  }

  private expireIfNeeded(approval: Approval): Approval {
    if ((approval.status === 'pending' || approval.status === 'approved') && Date.parse(approval.expiresAt) <= Date.parse(this.now())) {
      const expired = { ...approval, status: 'expired' as const, decidedAt: approval.decidedAt ?? this.now(), decisionReason: 'Approval expired' };
      if (!this.store.updateIfStatus?.(approval.id, approval.status, expired)) {
        if (this.store.updateIfStatus) return this.store.get(approval.id) ?? approval;
        this.store.save(expired);
      }
      return this.store.get(approval.id) ?? expired;
    }
    return approval;
  }
}
