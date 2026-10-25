import { execFile } from 'node:child_process';
import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface TerminalGatewayOptions {
  readonly root: string;
  readonly allowExec?: boolean;
  readonly requireApproval?: boolean;
  readonly maxOutputBytes?: number;
  readonly defaultTimeoutMs?: number;
}

export interface TerminalResult {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly signal?: string;
  readonly timedOut: boolean;
}

function outputLimit(options: TerminalGatewayOptions): number {
  const limit = options.maxOutputBytes ?? 2 * 1024 * 1024;
  if (!Number.isInteger(limit) || limit < 1 || limit > 16 * 1024 * 1024) throw new Error('Invalid terminal output limit');
  return limit;
}

function timeout(options: TerminalGatewayOptions, value?: number): number {
  const limit = value ?? options.defaultTimeoutMs ?? 30_000;
  if (!Number.isInteger(limit) || limit < 1 || limit > 10 * 60 * 1000) throw new Error('Terminal timeout must be between 1 and 600000 milliseconds');
  return limit;
}

async function rootPath(options: TerminalGatewayOptions): Promise<string> {
  return realpath(resolve(options.root));
}

async function workingDirectory(options: TerminalGatewayOptions, requested?: string): Promise<string> {
  const root = await rootPath(options);
  const value = requested ?? '';
  if (value.includes('\0') || isAbsolute(value)) throw new Error('Terminal cwd must be relative to the workspace root');
  const path = await realpath(resolve(root, value));
  const boundary = relative(root, path);
  if (boundary !== '' && (boundary === '..' || boundary.startsWith(`..${path.includes('\\') ? '\\' : '/'}`) || isAbsolute(boundary))) throw new Error('Terminal cwd is outside the workspace root');
  if (!(await stat(path)).isDirectory()) throw new Error('Terminal cwd must be a directory');
  return path;
}

export async function validateTerminalCwd(options: TerminalGatewayOptions, cwd?: string): Promise<void> {
  await workingDirectory(options, cwd);
}

export async function terminalExec(options: TerminalGatewayOptions, command: string, args: readonly string[] = [], cwd?: string, timeoutMs?: number): Promise<TerminalResult> {
  if (!command.trim() || command.includes('\0')) throw new Error('Terminal command is required');
  if (args.some((arg) => arg.includes('\0'))) throw new Error('Terminal arguments cannot contain null bytes');
  const directory = await workingDirectory(options, cwd);
  const limit = outputLimit(options);
  const runTimeout = timeout(options, timeoutMs);
  try {
    const result = await execFileAsync(command, [...args], { cwd: directory, shell: false, timeout: runTimeout, maxBuffer: limit, windowsHide: true });
    return { command, args, cwd: directory, stdout: result.stdout, stderr: result.stderr, exitCode: 0, timedOut: false };
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string; signal?: string; killed?: boolean };
    const exitCode = typeof failure.code === 'number' ? failure.code : null;
    return { command, args, cwd: directory, stdout: failure.stdout ?? '', stderr: failure.stderr ?? failure.message ?? String(error), exitCode, ...(failure.signal ? { signal: failure.signal } : {}), timedOut: Boolean(failure.killed) };
  }
}
