import { describe, expect, it } from 'vitest';
import { createDefaultProfile, InMemoryAuditLog, PolicyEngine } from './index.js';

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
