import { execFile } from 'node:child_process';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);

describe('CLI', () => {
  it('lists all registered tools and generates help from the registry', async () => {
    const tools = JSON.parse((await execFileAsync('node', ['dist/index.js', 'agents'])).stdout) as Array<{ id: string }>;
    expect(tools.map((tool) => tool.id)).toEqual(['codex', 'claude-code', 'cursor', 'kimi', 'qwen', 'zcode', 'deepseek-harness', 'opencode', 'gemini', 'aider']);
    await expect(execFileAsync('node', ['dist/index.js', 'help'])).rejects.toMatchObject({ stderr: expect.stringContaining('deepseek-harness, opencode, gemini, aider') });
  });

  it.each([
    ['kimi', { role: 'assistant', content: 'Fixture completed' }],
    ['qwen', { type: 'assistant', message: { content: [{ type: 'text', text: 'Fixture completed' }] } }],
    ['zcode', { type: 'result', response: 'Fixture completed', projection: { status: 'idle' } }],
    ['deepseek-harness', 'Fixture completed'],
    ['opencode', { type: 'text', part: { type: 'text', text: 'Fixture completed' } }],
    ['gemini', { type: 'message', role: 'assistant', content: 'Fixture completed' }],
    ['aider', 'Fixture completed'],
  ] as const)('runs registered %s through the persistent task CLI with role guidance', async (id, frame) => {
    const directory = mkdtempSync(join(tmpdir(), `agentcorps-cli-${id}-`));
    try {
      const fixture = join(directory, 'tool.cjs');
      const output = typeof frame === 'string' ? frame : JSON.stringify(frame);
      writeFileSync(fixture, `const prompt=process.argv.at(-1); if(!prompt.includes('code reviewer') || !prompt.includes('Reply in Chinese') || !prompt.includes('Inspect release')) process.exit(7); console.log(${JSON.stringify(output)});`);
      const created = JSON.parse((await execFileAsync('node', ['dist/index.js', 'task', 'create', '--title', 'Provider', '--objective', 'Inspect release', '--data-dir', directory])).stdout) as { id: string };
      const result = JSON.parse((await execFileAsync('node', ['dist/index.js', 'task', 'run', created.id, '--data-dir', directory, '--agent', id, '--agent-command', process.execPath, '--agent-arg', fixture, '--role', 'reviewer', '--instructions', 'Reply in Chinese'])).stdout) as { status: string };
      expect(result.status).toBe('succeeded');
      const detail = (await execFileAsync('node', ['dist/index.js', 'task', 'show', created.id, '--data-dir', directory])).stdout;
      expect(detail).toContain('Fixture completed');
      expect(JSON.parse(detail).task.objective).toBe('Inspect release');
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

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

  it('loads a custom tool manifest and passes model, prompt flag and role to a real process', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'agentcorps-cli-registry-'));
    try {
      const fixture = join(directory, 'tool.cjs');
      const config = join(directory, 'tools.json');
      writeFileSync(fixture, "const args=process.argv.slice(2); const prompt=args[args.indexOf('--prompt')+1]; console.log(prompt); process.exit(args[0]==='--model' && args[1]==='fixture-model' && prompt.includes('code reviewer') ? 0 : 1)");
      writeFileSync(config, JSON.stringify({ version: 1, tools: [{ id: 'fixture-tool', displayName: 'Fixture tool', command: process.execPath, args: [fixture], outputFormat: 'text', promptFlag: '--prompt', modelFlag: '--model' }] }));
      const tools = JSON.parse((await execFileAsync('node', ['dist/index.js', 'agents', '--agents-config', config])).stdout) as Array<{ id: string }>;
      expect(tools.map((tool) => tool.id)).toContain('fixture-tool');
      const created = JSON.parse((await execFileAsync('node', ['dist/index.js', 'task', 'create', '--title', 'Registry', '--objective', 'verify registration', '--data-dir', directory])).stdout) as { id: string };
      const result = JSON.parse((await execFileAsync('node', ['dist/index.js', 'task', 'run', created.id, '--data-dir', directory, '--agent', 'fixture-tool', '--agents-config', config, '--model', 'fixture-model', '--role', 'reviewer'])).stdout) as { status: string };
      expect(result.status).toBe('succeeded');
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it('keeps native model arguments separate from AgentCorps model selection', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'agentcorps-cli-native-args-'));
    try {
      const fixture = join(directory, 'tool.cjs');
      writeFileSync(fixture, `const args=process.argv.slice(2); if(args[0]!=='--model' || args[1]!=='native-model' || !args.at(-1).includes('code reviewer')) process.exit(7); console.log(JSON.stringify({type:'result',response:'Native arguments preserved'}));`);
      const created = JSON.parse((await execFileAsync('node', ['dist/index.js', 'task', 'create', '--title', 'Arguments', '--objective', 'Inspect release', '--data-dir', directory])).stdout) as { id: string };
      const result = JSON.parse((await execFileAsync('node', ['dist/index.js', 'task', 'run', created.id, '--data-dir', directory, '--agent', 'zcode', '--agent-command', process.execPath, '--agent-arg', fixture, '--agent-arg', '--model', '--agent-arg', 'native-model', '--role', 'reviewer'])).stdout) as { status: string };
      expect(result.status).toBe('succeeded');
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

  it('auto-loads the home configuration without --agents-config and honors CLI overrides', async () => {
    const home = mkdtempSync(join(tmpdir(), 'agentcorps-home-'));
    const dataDir = mkdtempSync(join(tmpdir(), 'agentcorps-config-data-'));
    const workspace = mkdtempSync(join(tmpdir(), 'agentcorps-config-workspace-'));
    try {
      const fixture = join(workspace, 'configured-tool.cjs');
      mkdirSync(join(home, '.agentcorps'), { recursive: true });
      writeFileSync(fixture, "const args=process.argv.slice(2); const model=args[args.indexOf('--model')+1]; const prompt=args.at(-1); if(model!==(process.env.EXPECTED_MODEL||'config-model') || process.cwd()!==process.env.EXPECTED_CWD || !prompt.includes('Configured reviewer') || !prompt.includes('Configured instructions') || !prompt.includes('auto config')) process.exit(7); console.log('auto config works')");
      writeFileSync(join(home, '.agentcorps', 'config.json'), JSON.stringify({
        version: 1,
        paths: { dataDir },
        defaults: { agent: 'fixture-tool', model: 'config-model', role: 'configured-reviewer', instructions: 'Configured instructions' },
        tools: { 'fixture-tool': { cwd: workspace } },
        toolDefinitions: [{ id: 'fixture-tool', displayName: 'Fixture tool', command: process.execPath, args: [fixture], outputFormat: 'text', promptPlacement: 'argument', modelFlag: '--model' }],
        roles: { 'configured-reviewer': { displayName: 'Configured reviewer', description: 'Fixture role', prompt: 'Configured reviewer' } },
      }, null, 2));
      const env = { ...process.env, HOME: home, EXPECTED_CWD: realpathSync(workspace), EXPECTED_MODEL: 'config-model' };
      const created = JSON.parse((await execFileAsync('node', ['dist/index.js', 'task', 'create', '--title', 'Auto config', '--objective', 'auto config'], { env })).stdout) as { id: string };
      const configuredRun = JSON.parse((await execFileAsync('node', ['dist/index.js', 'task', 'run', created.id], { env })).stdout) as { status: string };
      expect(configuredRun.status).toBe('succeeded');
      const overrideTask = JSON.parse((await execFileAsync('node', ['dist/index.js', 'task', 'create', '--title', 'CLI override', '--objective', 'auto config'], { env })).stdout) as { id: string };
      const cliOverride = JSON.parse((await execFileAsync('node', ['dist/index.js', 'task', 'run', overrideTask.id, '--model', 'cli-model'], { env: { ...env, EXPECTED_MODEL: 'cli-model' } })).stdout) as { status: string };
      expect(cliOverride.status).toBe('succeeded');
      const roles = JSON.parse((await execFileAsync('node', ['dist/index.js', 'roles'], { env })).stdout) as Array<{ id: string }>;
      expect(roles.map((role) => role.id)).toContain('configured-reviewer');
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(dataDir, { recursive: true, force: true });
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('pauses configured agents for approval and resumes after a one-time decision', async () => {
    const home = mkdtempSync(join(tmpdir(), 'agentcorps-approval-home-'));
    const dataDir = mkdtempSync(join(tmpdir(), 'agentcorps-approval-data-'));
    const workspace = mkdtempSync(join(tmpdir(), 'agentcorps-approval-workspace-'));
    try {
      const fixture = join(workspace, 'approved-tool.cjs');
      mkdirSync(join(home, '.agentcorps'), { recursive: true });
      writeFileSync(fixture, "console.log('approved run')");
      writeFileSync(join(home, '.agentcorps', 'config.json'), JSON.stringify({
        version: 1,
        paths: { dataDir },
        defaults: { agent: 'approved-tool' },
        tools: { 'approved-tool': { workspaceRoot: workspace, cwd: workspace } },
        toolDefinitions: [{ id: 'approved-tool', displayName: 'Approved tool', command: process.execPath, args: [fixture], outputFormat: 'text', promptPlacement: 'argument' }],
      }));
      const env = { ...process.env, HOME: home };
      const created = JSON.parse((await execFileAsync('node', ['dist/index.js', 'task', 'create', '--title', 'Approval', '--objective', 'run with approval'], { env })).stdout) as { id: string };
      const waiting = JSON.parse((await execFileAsync('node', ['dist/index.js', 'task', 'run', created.id, '--approval-mode', 'always'], { env })).stdout) as { status: string };
      expect(waiting.status).toBe('waiting_approval');
      const approvals = JSON.parse((await execFileAsync('node', ['dist/index.js', 'approval', 'list'], { env })).stdout) as Array<{ id: string; status: string }>;
      expect(approvals).toHaveLength(1);
      expect(approvals[0]).toMatchObject({ status: 'pending' });
      await execFileAsync('node', ['dist/index.js', 'approval', 'approve', approvals[0]!.id, '--decided-by', 'test-user'], { env });
      const resumed = JSON.parse((await execFileAsync('node', ['dist/index.js', 'task', 'run', created.id, '--approval-mode', 'always'], { env })).stdout) as { status: string };
      expect(resumed.status).toBe('succeeded');
      const consumed = JSON.parse((await execFileAsync('node', ['dist/index.js', 'approval', 'list'], { env })).stdout) as Array<{ status: string }>;
      expect(consumed[0]?.status).toBe('consumed');
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(dataDir, { recursive: true, force: true });
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
