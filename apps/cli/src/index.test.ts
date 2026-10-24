import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);

describe('CLI', () => {
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
