import { spawn } from 'node:child_process';

export type SandboxBackend = 'macos' | 'container';
export type SandboxNetwork = 'none' | 'full';

export interface SandboxInvocationOptions {
  readonly backend: SandboxBackend;
  readonly executable: string;
  readonly args?: readonly string[];
  readonly workspaceRoot: string;
  readonly writableRoots?: readonly string[];
  readonly network?: SandboxNetwork;
  readonly containerImage?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly inheritEnvironment?: boolean;
}

export interface SandboxInvocation {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
}

export function buildSandboxInvocation(options: SandboxInvocationOptions, platform = process.platform): SandboxInvocation {
  const env = { ...options.env };
  if (options.backend === 'macos') {
    if (platform !== 'darwin') throw new Error('macOS sandbox is only available on darwin');
    const profile = macosProfile(options);
    return { command: 'sandbox-exec', args: ['-p', profile, options.executable, ...(options.args ?? [])], env };
  }
  if (!options.containerImage?.trim()) throw new Error('Container sandbox requires containerImage');
  const networkArgs = options.network === 'full' ? [] : ['--network', 'none'];
  const envArgs = Object.entries(env).flatMap(([name, value]) => ['--env', `${name}=${value}`]);
  return {
    command: 'docker',
    args: ['run', '--rm', '--init', ...networkArgs, '-v', `${options.workspaceRoot}:/workspace:rw`, '-w', '/workspace', ...envArgs, options.containerImage, options.executable, ...(options.args ?? [])],
    env: {},
  };
}

function macosProfile(options: SandboxInvocationOptions): string {
  const readable = [options.workspaceRoot, ...(options.writableRoots ?? [])].map((path) => `(subpath ${profileString(path)})`).join(' ');
  const writable = (options.writableRoots ?? [options.workspaceRoot]).map((path) => `(subpath ${profileString(path)})`).join(' ');
  const network = options.network === 'full' ? '(allow network-outbound)' : '(deny network*)';
  return `(version 1) (deny default) (allow process*) (allow file-read* ${readable}) (allow file-write* ${writable}) ${network}`;
}

function profileString(value: string): string {
  return `\"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}\"`;
}

export interface CredentialStore {
  get(name: string): Promise<string | undefined>;
}

export class EnvironmentCredentialStore implements CredentialStore {
  constructor(private readonly environment: NodeJS.ProcessEnv = process.env) {}
  async get(name: string): Promise<string | undefined> { return this.environment[name]; }
}

export class CredentialProxy {
  private readonly values = new Map<string, string>();

  constructor(private readonly store: CredentialStore, private readonly allowedNames: ReadonlySet<string>) {}

  async issue(names: readonly string[]): Promise<Readonly<Record<string, string>>> {
    const result: Record<string, string> = {};
    for (const name of names) {
      if (!this.allowedNames.has(name)) throw new Error(`Credential is not allowed: ${name}`);
      const value = await this.store.get(name);
      if (value === undefined) throw new Error(`Credential is unavailable: ${name}`);
      this.values.set(name, value);
      result[name] = value;
    }
    return result;
  }

  redact(text: string): string {
    return [...this.values.values()].sort((left, right) => right.length - left.length).reduce((result, value) => value ? result.replaceAll(value, '[REDACTED]') : result, text);
  }
}

export interface SandboxedCommandOptions extends SandboxInvocationOptions {
  readonly credentialProxy?: CredentialProxy;
  readonly credentialNames?: readonly string[];
  readonly cwd?: string;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
}

export interface SandboxedCommandResult {
  readonly exitCode: number;
  readonly signal?: string;
  readonly stdout: string;
  readonly stderr: string;
}

export class SandboxedCommandRunner {
  async run(options: SandboxedCommandOptions): Promise<SandboxedCommandResult> {
    const credentials = options.credentialProxy && options.credentialNames?.length ? await options.credentialProxy.issue(options.credentialNames) : {};
    const invocation = buildSandboxInvocation({ ...options, env: { ...options.env, ...credentials } });
    const timeoutMs = positiveInteger(options.timeoutMs, 120_000);
    const maxOutputBytes = positiveInteger(options.maxOutputBytes, 4 * 1024 * 1024);
    return await new Promise((resolve, reject) => {
      const child = spawn(invocation.command, [...invocation.args], { cwd: options.cwd ?? options.workspaceRoot, env: executionEnvironment(invocation.env, options.inheritEnvironment ?? false), stdio: ['ignore', 'pipe', 'pipe'] });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let outputBytes = 0;
      let settled = false;
      let timer: NodeJS.Timeout | undefined;
      const finishError = (error: Error): void => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        child.kill('SIGTERM');
        reject(error);
      };
      timer = setTimeout(() => finishError(new Error(`Sandboxed command timed out after ${timeoutMs}ms`)), timeoutMs);
      const collect = (target: Buffer[]) => (chunk: Buffer) => {
        if (settled) return;
        outputBytes += chunk.byteLength;
        if (outputBytes > maxOutputBytes) {
          finishError(new Error(`Sandboxed command output exceeds ${maxOutputBytes} bytes`));
          return;
        }
        target.push(chunk);
      };
      child.stdout.on('data', collect(stdout));
      child.stderr.on('data', collect(stderr));
      child.once('error', (error) => finishError(error));
      child.once('close', (code, signal) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        const redact = options.credentialProxy ? (value: string) => options.credentialProxy!.redact(value) : (value: string) => value;
        resolve({ exitCode: code ?? -1, ...(signal ? { signal } : {}), stdout: redact(Buffer.concat(stdout).toString('utf8')), stderr: redact(Buffer.concat(stderr).toString('utf8')) });
      });
    });
  }
}

function executionEnvironment(invocationEnv: Readonly<Record<string, string>>, inheritEnvironment: boolean): NodeJS.ProcessEnv {
  if (inheritEnvironment) return { ...process.env, ...invocationEnv };
  const path = process.env.PATH;
  return { ...(path ? { PATH: path } : {}), ...invocationEnv };
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && value! > 0 ? value! : fallback;
}
