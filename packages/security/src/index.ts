import { resolve, relative, isAbsolute } from 'node:path';

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
