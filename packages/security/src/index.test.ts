import { describe, expect, it } from 'vitest';
import { sign, createHash, generateKeyPairSync } from 'node:crypto';
import { auditDependencySpecs, assessCommandRisk, ExternalIdentityResolver, InMemoryExternalIdentityBindingStore, verifySignedArtifact } from './index.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApprovalService, buildSandboxInvocation, createDefaultProfile, CredentialProxy, DevicePairingService, DeviceTokenVerifier, InMemoryApprovalStore, InMemoryAuditLog, InMemoryDeviceIdentityStore, PolicyEngine, SandboxedCommandRunner, SecureCommandExecutor, SignedAccessTokenService, SqliteApprovalStore, SqliteAuditLog } from './index.js';

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
  it('persists approvals and audit records in SQLite', () => {
    const directory = mkdtempSync(join(tmpdir(), 'agentcorps-security-sqlite-'));
    const databasePath = join(directory, 'agentcorps.db');
    try {
      const audit = new SqliteAuditLog(databasePath);
      const engine = new PolicyEngine(audit, () => '2026-10-24T00:00:00.000Z');
      const context = { mode: 'code' as const, profile: createDefaultProfile('/workspace', 'S2') };
      const requestValue = request('process.exec', { command: 'pnpm test' });
      const policy = engine.evaluate(requestValue, context);
      const approvalStore = new SqliteApprovalStore(databasePath);
      const approvals = new ApprovalService(approvalStore, () => '2026-10-24T00:00:00.000Z', () => 'approval-sqlite');
      const created = approvals.create(requestValue, policy, 1_000);
      expect(approvals.approve(created.id, 'user-1').status).toBe('approved');
      const reopenedStore = new SqliteApprovalStore(databasePath);
      expect(new ApprovalService(reopenedStore, () => '2026-10-24T00:00:00.000Z').get(created.id)?.status).toBe('approved');
      expect(audit.list()).toHaveLength(1);
      reopenedStore.close();
      approvalStore.close();
      audit.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('builds constrained macOS and container invocations and redacts proxied credentials', async () => {
    const macos = buildSandboxInvocation({ backend: 'macos', executable: 'node', args: ['-e', 'console.log(1)'], workspaceRoot: '/workspace', writableRoots: ['/workspace/tmp'], network: 'none' }, 'darwin');
    expect(macos.command).toBe('sandbox-exec');
    expect(macos.args[0]).toBe('-p');
    expect(macos.args.join(' ')).toContain('deny network');
    const container = buildSandboxInvocation({ backend: 'container', containerImage: 'node:22', executable: 'node', workspaceRoot: '/workspace', network: 'none', maxMemoryMb: 256, maxCpu: 1.5, maxPids: 64, env: { API_TOKEN: 'secret' } });
    expect(container).toMatchObject({ command: 'docker', args: expect.arrayContaining(['--network', 'none', '--memory', '256m', '--cpus', '1.5', '--pids-limit', '64', '--env', 'API_TOKEN=secret', 'node:22']) });
    const proxy = new CredentialProxy({ get: async () => 'token-value' }, new Set(['API_TOKEN']));
    await expect(proxy.issue(['NOT_ALLOWED'])).rejects.toThrow('not allowed');
    await proxy.issue(['API_TOKEN']);
    expect(proxy.redact('authorization token-value')).toBe('authorization [REDACTED]');
    expect(SandboxedCommandRunner).toBeDefined();
  });


  it('requires a matching one-time approval before privileged execution', async () => {
    const engine = new PolicyEngine(new InMemoryAuditLog());
    const approvals = new ApprovalService(new InMemoryApprovalStore(), () => '2026-10-24T00:00:00.000Z', () => 'approval-1');
    const request = { requestId: 'exec-1', taskId: 'task-1', capability: 'process.exec' as const, command: 'node' };
    const policy = engine.evaluate(request, { mode: 'code', profile: createDefaultProfile('/workspace', 'S2') });
    const approval = approvals.create(request, policy);
    approvals.approve(approval.id, 'user-1');
    class FakeRunner extends SandboxedCommandRunner {
      override async run(): Promise<{ exitCode: number; stdout: string; stderr: string }> { return { exitCode: 0, stdout: 'ok', stderr: '' }; }
    }
    const executor = new SecureCommandExecutor(engine, approvals, new FakeRunner());
    await expect(executor.run({ backend: 'container', containerImage: 'node:22', executable: 'node', workspaceRoot: '/workspace', request, context: { mode: 'code', profile: createDefaultProfile('/workspace', 'S2') }, approvalId: approval.id })).resolves.toMatchObject({ exitCode: 0 });
    await expect(executor.run({ backend: 'container', containerImage: 'node:22', executable: 'node', workspaceRoot: '/workspace', request, context: { mode: 'code', profile: createDefaultProfile('/workspace', 'S2') }, approvalId: approval.id })).rejects.toThrow('Approval is missing');
  });


  it('pairs devices, issues signed tokens, and rejects expiry or revocation', () => {
    let now = 1_700_000_000_000;
    const store = new InMemoryDeviceIdentityStore();
    const pairing = new DevicePairingService(store, () => now);
    const request = pairing.create('phone', 1_000);
    const device = pairing.redeem(request.code, 'device-1');
    const tokens = new SignedAccessTokenService('12345678901234567890123456789012');
    const token = tokens.issue(device, 60, 1_700_000_000);
    expect(tokens.verify(token, 1_700_000_010).deviceId).toBe('device-1');
    expect(() => tokens.verify(token, 1_700_000_061)).toThrow('expired');
    const revoked = pairing.revoke(device.id);
    expect(() => tokens.issue(revoked, 60, 1_700_000_000)).toThrow('revoked');
    const verifier = new DeviceTokenVerifier(tokens, store, () => 1_700_000_010);
    expect(verifier.verify(token)).toBe(false);
    const secondPairing = pairing.create('laptop');
    const secondDevice = pairing.redeem(secondPairing.code, 'device-2');
    const secondToken = tokens.issue(secondDevice, 60, 1_700_000_000);
    expect(verifier.verify(secondToken)).toMatchObject({ deviceId: 'device-2', device: { label: 'laptop' } });
    now += 2_000;
    expect(() => pairing.redeem(request.code)).toThrow('invalid or expired');
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

  it.skipIf(process.env.AGENTCORPS_DOCKER_E2E !== '1')('executes a constrained Docker sandbox with resource limits', async () => {
    const result = await new SandboxedCommandRunner().run({ backend: 'container', containerImage: 'node:22-alpine', executable: 'node', args: ['-e', "process.stdout.write('sandbox-ok')"], workspaceRoot: process.cwd(), network: 'none', maxMemoryMb: 256, maxCpu: 1, maxPids: 64, timeoutMs: 120_000 });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('sandbox-ok');
  });

  it.skipIf(process.platform !== 'darwin' || process.env.AGENTCORPS_MACOS_SANDBOX_E2E !== '1')('executes a constrained macOS sandbox', async () => {
    const result = await new SandboxedCommandRunner().run({ backend: 'macos', executable: process.execPath, args: ['-e', "process.stdout.write('sandbox-ok')"], workspaceRoot: process.cwd(), network: 'none', timeoutMs: 30_000 });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('sandbox-ok');
  });

  it('classifies dangerous commands and audits dependency provenance', () => {
    expect(assessCommandRisk('rm -rf /workspace').risk).toBe('critical');
    expect(assessCommandRisk('pnpm install').risk).toBe('medium');
    expect(auditDependencySpecs({ dependencies: { safe: '^1.2.3', remote: 'github:user/repo' } })[0]).toMatchObject({ name: 'remote', source: 'git' });
  });

  it('verifies signed extension or MCP artifacts and maps external identities', () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const content = 'signed source';
    const digest = createHash('sha256').update(content).digest('hex');
    const signature = sign(null, Buffer.from(content), privateKey).toString('base64url');
    expect(verifySignedArtifact({ name: 'fixture', version: '1.0.0', content, sha256: digest, signature, publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString() })).toMatchObject({ name: 'fixture', sha256: digest });
    const resolver = new ExternalIdentityResolver(new InMemoryExternalIdentityBindingStore(), () => '2026-10-24T00:00:00.000Z');
    resolver.bind('feishu', 'external-user', 'device-1', ['admin']);
    expect(resolver.require('feishu', 'external-user', 'operator').deviceId).toBe('device-1');
    resolver.revoke('feishu', 'external-user');
    expect(resolver.resolve('feishu', 'external-user')).toBeUndefined();
  });

  it('atomically coordinates approval transitions across SQLite store instances', () => {
    const directory = mkdtempSync(join(tmpdir(), 'agentcorps-security-approval-race-'));
    const databasePath = join(directory, 'agentcorps.db');
    const firstStore = new SqliteApprovalStore(databasePath);
    const secondStore = new SqliteApprovalStore(databasePath);
    try {
      const first = new ApprovalService(firstStore, () => '2026-10-24T00:00:00.000Z', () => 'approval-sqlite-race');
      const second = new ApprovalService(secondStore, () => '2026-10-24T00:00:00.000Z');
      const request = { requestId: 'sqlite-race-1', taskId: 'task-1', capability: 'process.exec' as const, command: 'node' };
      const policy = { decision: 'approval_required' as const, reason: 'needs approval', requestId: request.requestId, taskId: request.taskId };
      const approval = first.create(request, policy);
      expect(first.approve(approval.id, 'operator').status).toBe('approved');
      expect(() => second.approve(approval.id, 'another-operator')).toThrow('Approval is not pending: approved');
      expect(first.consume(approval.id)?.status).toBe('consumed');
      expect(second.consume(approval.id)).toBeUndefined();
    } finally {
      firstStore.close();
      secondStore.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it('atomically consumes one approval across concurrent approval services', () => {
    const store = new InMemoryApprovalStore();
    const first = new ApprovalService(store, () => '2026-10-24T00:00:00.000Z', () => 'approval-race');
    const second = new ApprovalService(store, () => '2026-10-24T00:00:00.000Z');
    const request = { requestId: 'race-1', taskId: 'task-1', capability: 'process.exec' as const, command: 'node' };
    const policy = { decision: 'approval_required' as const, reason: 'needs approval', requestId: request.requestId, taskId: request.taskId };
    const approval = first.create(request, policy);
    first.approve(approval.id, 'operator');
    expect(first.consume(approval.id)).toMatchObject({ status: 'consumed' });
    expect(second.consume(approval.id)).toBeUndefined();
  });
});
