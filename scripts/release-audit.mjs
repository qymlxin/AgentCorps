import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const run = (command, args) => execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const status = run('git', ['status', '--porcelain']);
if (status.trim()) throw new Error('Release audit requires a clean working tree');
const tracked = run('git', ['ls-files']).split('\n').filter(Boolean);
const suspicious = /(?:api[_-]?key|client[_-]?secret|access[_-]?token|password)\s*[:=]\s*['"][^'"\n]{8,}/i;
for (const file of tracked) {
  if (!/\.(?:ts|js|json|md|yml|yaml)$/.test(file)) continue;
  const content = readFileSync(file, 'utf8');
  if (suspicious.test(content) && !file.endsWith('.test.ts')) throw new Error(`Possible hard-coded credential in ${file}`);
}
const packageJson = JSON.parse(readFileSync('package.json', 'utf8'));
if (!packageJson.scripts?.typecheck || !packageJson.scripts?.test) throw new Error('Root typecheck and test scripts are required');
if (!readFileSync('pnpm-lock.yaml', 'utf8').trim()) throw new Error('pnpm-lock.yaml is empty');
console.log(JSON.stringify({ trackedFiles: tracked.length, cleanTree: true, lockfile: true, requiredScripts: ['typecheck', 'test'] }));
