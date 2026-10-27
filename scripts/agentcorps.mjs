#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cli = resolve(root, 'apps/cli/dist/index.js');
const packageManager = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';

if (!existsSync(cli)) {
  const build = spawnSync(packageManager, ['--filter', '@agentcorps/cli', 'build'], { cwd: root, stdio: 'inherit' });
  if (build.status !== 0) process.exit(build.status ?? 1);
}

const args = process.argv.slice(2);
if (args[0] === '--') args.shift();
const result = spawnSync(process.execPath, [cli, ...args], { cwd: root, stdio: 'inherit', env: process.env });
if (result.error) {
  console.error(`Unable to start AgentCorps CLI: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
