import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface GitGatewayOptions {
  readonly root: string;
  readonly allowWrite?: boolean;
  readonly requireApproval?: boolean;
  readonly maxOutputBytes?: number;
}

export interface GitStatusEntry {
  readonly index: string;
  readonly worktree: string;
  readonly path: string;
}

export interface GitStatus {
  readonly branch: string;
  readonly upstream?: string;
  readonly entries: readonly GitStatusEntry[];
}

export interface GitCommit {
  readonly hash: string;
  readonly author: string;
  readonly committedAt: string;
  readonly subject: string;
}

function commandLimit(options: GitGatewayOptions): number {
  const limit = options.maxOutputBytes ?? 2 * 1024 * 1024;
  if (!Number.isInteger(limit) || limit < 1 || limit > 16 * 1024 * 1024) throw new Error('Invalid Git output limit');
  return limit;
}

async function repositoryRoot(options: GitGatewayOptions): Promise<string> {
  return realpath(resolve(options.root));
}

function relativePath(root: string, value: string): string {
  if (!value || value.includes('\0') || isAbsolute(value)) throw new Error('Git paths must be relative to the repository root');
  const normalized = resolve(root, value);
  const candidate = relative(root, normalized);
  if (candidate === '..' || candidate.startsWith(`..${value.includes('\\') ? '\\' : '/'}`) || isAbsolute(candidate)) throw new Error('Git path is outside the repository root');
  return candidate;
}

async function runGit(options: GitGatewayOptions, args: readonly string[]): Promise<string> {
  const root = await repositoryRoot(options);
  const result = await execFileAsync('git', [...args], { cwd: root, maxBuffer: commandLimit(options) });
  return result.stdout;
}

export async function gitStatus(options: GitGatewayOptions): Promise<GitStatus> {
  const output = await runGit(options, ['status', '--short', '--branch']);
  const lines = output.split('\n').filter(Boolean);
  const header = lines.shift() ?? '## HEAD';
  const branchText = header.replace(/^##\s*/, '');
  const [branch, upstream] = branchText.split('...');
  const entries = lines.map((line) => ({ index: line[0] ?? ' ', worktree: line[1] ?? ' ', path: line.slice(3) }));
  return upstream
    ? { branch: branch || 'HEAD', upstream: upstream.split(' ')[0] ?? '', entries }
    : { branch: branch || 'HEAD', entries };
}

export async function gitLog(options: GitGatewayOptions, limit = 30): Promise<readonly GitCommit[]> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Git log limit must be between 1 and 100');
  const output = await runGit(options, ['log', `-${limit}`, '--format=%H%x00%an%x00%aI%x00%s']);
  return output.split('\n').filter(Boolean).map((line) => {
    const [hash, author, committedAt, ...subject] = line.split('\0');
    return { hash: hash ?? '', author: author ?? '', committedAt: committedAt ?? '', subject: subject.join('\0') };
  });
}

export async function gitDiff(options: GitGatewayOptions, path?: string): Promise<{ path?: string; diff: string }> {
  const args = ['diff', '--no-ext-diff', '--'];
  const normalized = path === undefined ? undefined : relativePath(await repositoryRoot(options), path);
  if (normalized) args.push(normalized);
  return { ...(normalized ? { path: normalized } : {}), diff: await runGit(options, args) };
}

export async function gitAdd(options: GitGatewayOptions, paths: readonly string[]): Promise<GitStatus> {
  if (!paths.length) throw new Error('At least one Git path is required');
  const root = await repositoryRoot(options);
  const normalized = paths.map((path) => relativePath(root, path));
  await runGit(options, ['add', '--', ...normalized]);
  return gitStatus(options);
}

export async function gitRestoreStaged(options: GitGatewayOptions, paths: readonly string[]): Promise<GitStatus> {
  if (!paths.length) throw new Error('At least one Git path is required');
  const root = await repositoryRoot(options);
  const normalized = paths.map((path) => relativePath(root, path));
  await runGit(options, ['restore', '--staged', '--', ...normalized]);
  return gitStatus(options);
}

export async function gitCommit(options: GitGatewayOptions, message: string): Promise<{ hash: string; status: GitStatus }> {
  const normalized = message.trim();
  if (!normalized || normalized.length > 500 || normalized.includes('\0')) throw new Error('Git commit message must contain 1 to 500 characters');
  await runGit(options, ['commit', '-m', normalized]);
  const hash = (await runGit(options, ['rev-parse', 'HEAD'])).trim();
  return { hash, status: await gitStatus(options) };
}
