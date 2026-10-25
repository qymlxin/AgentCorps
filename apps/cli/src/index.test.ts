import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);

describe('CLI', () => {
  it('lists role presets and injects custom role prompts into command runs', async () => {
    const roles = JSON.parse((await execFileAsync('node', ['dist/index.js', 'roles'])).stdout) as Array<{ id: string }>;
    expect(roles.map((role) => role.id)).toContain('reviewer');
    const directory = mkdtempSync(join(tmpdir(), 'agentcorps-cli-role-'));
    try {
      const roleFile = join(directory, 'role.md');
      writeFileSync(roleFile, 'You are a release specialist.');
      const created = JSON.parse((await execFileAsync('node', ['dist/index.js', 'task', 'create', '--title', 'Role', '--objective', 'inspect release', '--data-dir', directory])).stdout) as { id: string };
      const script = "const prompt=process.argv[1]; process.exit(prompt.includes('release specialist') && prompt.includes('Reply in Chinese') && prompt.includes('inspect release') ? 0 : 1)";
      const result = JSON.parse((await execFileAsync('node', ['dist/index.js', 'task', 'run', created.id, '--data-dir', directory, '--agent', 'command', '--agent-command', process.execPath, '--agent-arg', '-e', '--agent-arg', script, '--role-file', roleFile, '--instructions', 'Reply in Chinese'])).stdout) as { status: string };
      expect(result.status).toBe('succeeded');
      const detail = JSON.parse((await execFileAsync('node', ['dist/index.js', 'task', 'show', created.id, '--data-dir', directory])).stdout) as { task: { objective: string } };
      expect(detail.task.objective).toBe('inspect release');
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it('has a runnable demo command after build', async () => {
    const { stdout } = await execFileAsync('node', ['dist/index.js', 'demo']);
    expect(stdout).toContain('task.created');
    expect(stdout).toContain('task.status_changed');
    expect(stdout).toContain('run.output');
  });

  it('runs a task with a configured command agent', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'agentcorps-cli-command-'));
    try {
      const created = JSON.parse((await execFileAsync('node', ['dist/index.js', 'task', 'create', '--title', 'Command', '--objective', 'run external command', '--data-dir', directory])).stdout) as { id: string };
      const script = "process.stdin.on('data',()=>console.log('external agent completed'))";
      const result = JSON.parse((await execFileAsync('node', ['dist/index.js', 'task', 'run', created.id, '--data-dir', directory, '--agent', 'command', '--agent-command', process.execPath, '--agent-arg', '-e', '--agent-arg', script])).stdout) as { status: string };
      expect(result.status).toBe('succeeded');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('injects persisted memory into a CLI command agent run', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'agentcorps-cli-memory-'));
    try {
      await execFileAsync('node', ['dist/index.js', 'memory', 'save', '--scope', 'global', '--content', 'release checklist uses staged verification', '--data-dir', directory]);
      const created = JSON.parse((await execFileAsync('node', ['dist/index.js', 'task', 'create', '--title', 'Memory', '--objective', 'prepare release verification', '--data-dir', directory])).stdout) as { id: string };
      const script = "process.exit(process.argv[1].includes('release checklist uses staged verification') ? 0 : 1)";
      const result = JSON.parse((await execFileAsync('node', ['dist/index.js', 'task', 'run', created.id, '--data-dir', directory, '--agent', 'command', '--agent-command', process.execPath, '--agent-arg', '-e', '--agent-arg', script])).stdout) as { status: string };
      expect(result.status).toBe('succeeded');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('probes a configured command and reports its version and descriptor', async () => {
    const result = JSON.parse((await execFileAsync('node', ['dist/index.js', 'task', 'probe', '--command', process.execPath])).stdout) as { available: boolean; descriptor: { transport: string; version: string } };
    expect(result.available).toBe(true);
    expect(result.descriptor.transport).toBe('stdio-jsonl');
    expect(result.descriptor.version).not.toBe('unavailable');
  });

  it('migrates legacy memory and restores a SQLite backup', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'agentcorps-cli-storage-'));
    const restored = mkdtempSync(join(tmpdir(), 'agentcorps-cli-restored-'));
    const backup = join(directory, 'backup', 'agentcorps.db');
    try {
      writeFileSync(join(directory, 'memory.jsonl'), JSON.stringify({ op: 'upsert', record: { id: 'memory-legacy', scope: 'global', content: 'legacy memory', source: 'user', confidence: 1, sensitivity: 'private', createdAt: '2026-10-24T00:00:00.000Z', updatedAt: '2026-10-24T00:00:00.000Z' } }) + '\n');
      const migrated = JSON.parse((await execFileAsync('node', ['dist/index.js', 'data', 'migrate', '--data-dir', directory])).stdout) as { memoryRecords: number };
      expect(migrated.memoryRecords).toBe(1);
      await execFileAsync('node', ['dist/index.js', 'data', 'backup', '--data-dir', directory, '--output', backup]);
      await execFileAsync('node', ['dist/index.js', 'data', 'restore', '--data-dir', restored, '--input', backup]);
      const memories = JSON.parse((await execFileAsync('node', ['dist/index.js', 'memory', 'list', '--data-dir', restored])).stdout) as Array<{ id: string }>;
      expect(memories.map((memory) => memory.id)).toContain('memory-legacy');
    } finally {
      rmSync(directory, { recursive: true, force: true });
      rmSync(restored, { recursive: true, force: true });
    }
  });

  it('binds, lists, and revokes external channel identities', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'agentcorps-cli-identity-'));
    try {
      const provisioned = JSON.parse((await execFileAsync('node', ['dist/index.js', 'device', 'provision', '--label', 'channel-device', '--data-dir', directory])).stdout) as { device: { id: string } };
      const deviceId = provisioned.device.id;
      const binding = JSON.parse((await execFileAsync('node', ['dist/index.js', 'identity', 'bind', '--channel', 'feishu', '--external-user-id', 'external-user', '--device-id', deviceId, '--role', 'operator', '--data-dir', directory])).stdout) as { deviceId: string; roles: string[] };
      expect(binding).toMatchObject({ deviceId, roles: ['operator'] });
      const listed = JSON.parse((await execFileAsync('node', ['dist/index.js', 'identity', 'list', '--data-dir', directory])).stdout) as Array<{ externalUserId: string }>;
      expect(listed.map((item) => item.externalUserId)).toContain('external-user');
      await execFileAsync('node', ['dist/index.js', 'identity', 'revoke', '--channel', 'feishu', '--external-user-id', 'external-user', '--data-dir', directory]);
      expect(JSON.parse((await execFileAsync('node', ['dist/index.js', 'identity', 'list', '--data-dir', directory])).stdout)).toEqual([]);
      expect(JSON.parse((await execFileAsync('node', ['dist/index.js', 'identity', 'list', '--include-revoked', '--data-dir', directory])).stdout)).toHaveLength(1);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it('shares persistent tasks between CLI invocations', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'agentcorps-cli-'));
    try {
      const args = ['dist/index.js', 'task', 'create', '--title', 'Persistent', '--objective', 'share across processes', '--data-dir', directory];
      const created = JSON.parse((await execFileAsync('node', args)).stdout) as { id: string };
      const listed = JSON.parse((await execFileAsync('node', ['dist/index.js', 'task', 'list', '--data-dir', directory])).stdout) as Array<{ id: string }>;
      expect(listed.map((task) => task.id)).toContain(created.id);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
