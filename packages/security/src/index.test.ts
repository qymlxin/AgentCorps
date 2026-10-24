import { describe, expect, it } from 'vitest';
import { ApprovalService, createDefaultProfile, InMemoryApprovalStore, InMemoryAuditLog, PolicyEngine } from './index.js';

describe('PolicyEngine', () => {
  const request = (capability: 'fs.read' | 'fs.write' | 'process.exec' | 'network.connect' | 'secret.read', extra: Record<string, string> = {}) => ({ requestId: `${capability}-1`, taskId: 'task-1', capability, ...extra });

  it('enforces workspace boundaries and records decisions', () => {
    const audit = new InMemoryAuditLog();
    const engine = new PolicyEngine(audit, () => '2026-10-24T00:00:00.000Z');
    const context = { mode: 'code' as const, profile: createDefaultProfile('/workspace', 'S2') };
    expect(engine.evaluate(request('fs.read', { path: '/workspace/src/index.ts' }), context).decision).toBe('allow');
    expect(engine.evaluate(request('fs.read', { path: '/tmp/secret' }), context).decision).toBe('deny');
    expect(engine.evaluate(request('fs.write', { path: '/workspace/src/index.ts' }), context).decision).toBe('allow');
    expect(audit.list()).toHaveLength(3);
  });

  it('tracks approval lifecycle, expiry, and one-time consumption', () => {
    let now = '2026-10-24T00:00:00.000Z';
    let sequence = 0;
    const approvals = new ApprovalService(new InMemoryApprovalStore(), () => now, () => `approval-${++sequence}`);
    const request = { requestId: 'request-1', taskId: 'task-1', capability: 'process.exec' as const, command: 'pnpm test' };
    const policy = { decision: 'approval_required' as const, reason: 'Execution needs approval', requestId: request.requestId, taskId: request.taskId };
    const pending = approvals.create(request, policy, 1_000);
    expect(approvals.get(pending.id)?.status).toBe('pending');
    expect(approvals.approve(pending.id, 'user-1').status).toBe('approved');
    expect(approvals.consume(pending.id)?.status).toBe('consumed');
    expect(approvals.consume(pending.id)).toBeUndefined();

    const expiring = approvals.create(request, policy, 1_000);
    now = '2026-10-24T00:00:02.000Z';
    expect(approvals.get(expiring.id)?.status).toBe('expired');
    expect(() => approvals.deny(expiring.id, 'user-1')).toThrow('Approval is not pending: expired');
  });
  it('requires approval for execution, network, secrets, and work-mode writes', () => {
    const engine = new PolicyEngine(new InMemoryAuditLog());
    const code = { mode: 'code' as const, profile: { ...createDefaultProfile('/workspace', 'S2'), network: 'allowlist' as const, allowedHosts: ['api.example.com'] } };
    expect(engine.evaluate(request('process.exec', { command: 'npm test' }), code).decision).toBe('approval_required');
    expect(engine.evaluate(request('network.connect', { host: 'api.example.com' }), code).decision).toBe('approval_required');
    expect(engine.evaluate(request('secret.read'), code).decision).toBe('approval_required');
    const work = { mode: 'work' as const, profile: createDefaultProfile('/workspace', 'S2') };
    expect(engine.evaluate(request('fs.write', { path: '/workspace/report.docx' }), work).decision).toBe('approval_required');
  });
});
