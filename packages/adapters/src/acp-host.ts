import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, basename } from 'node:path';
import type { AgentRequest } from '@agentcorps/runtime';
import type {
  AcpFileReadParams,
  AcpPermissionRequest,
  AcpPermissionResponse,
  AcpTerminalCreateParams,
  AcpTerminalOutputResponse,
  AcpTerminalRef,
  AcpToolCall,
} from '@agentcorps/protocols';
import {
  ApprovalService,
  type PolicyEngine,
  type SecurityContext,
  type SecurityCapability,
  type ToolRequest,
  isWithin,
} from '@agentcorps/security';

interface TerminalRecord {
  readonly id: string;
  readonly sessionId: string;
  readonly child: ChildProcessWithoutNullStreams;
  readonly cwd: string;
  readonly command: string;
  readonly args: readonly string[];
  stdout: string;
  stderr: string;
  outputBytes: number;
  exitCode: number | undefined;
  signal: string | undefined;
  settled: boolean;
  readonly exit: Promise<void>;
}

export interface AcpHostOptions {
  readonly workspaceRoot: string;
  readonly policy: PolicyEngine;
  readonly approvals: ApprovalService;
  readonly context: SecurityContext | ((request: AgentRequest) => SecurityContext);
  readonly approvalTimeoutMs?: number;
  readonly approvalPollMs?: number;
  readonly maxFileBytes?: number;
  readonly maxTerminalOutputBytes?: number;
  readonly id?: () => string;
  readonly onProtocol?: (event: { readonly method: string; readonly direction: 'request' | 'response'; readonly data?: unknown }) => void;
}

/**
 * ACP client-side host capabilities. Every agent-originated operation is checked
 * against the existing policy and approval services before touching the machine.
 */
export class AcpHost {
  private readonly root: string;
  private readonly terminals = new Map<string, TerminalRecord>();
  private readonly maxFileBytes: number;
  private readonly maxTerminalOutputBytes: number;
  private readonly approvalTimeoutMs: number;
  private readonly approvalPollMs: number;
  private readonly id: () => string;

  constructor(private readonly options: AcpHostOptions) {
    this.root = realpathSync(resolve(options.workspaceRoot));
    this.maxFileBytes = bounded(options.maxFileBytes ?? 8 * 1024 * 1024, 1, 64 * 1024 * 1024, 'maxFileBytes');
    this.maxTerminalOutputBytes = bounded(options.maxTerminalOutputBytes ?? 2 * 1024 * 1024, 1, 16 * 1024 * 1024, 'maxTerminalOutputBytes');
    this.approvalTimeoutMs = bounded(options.approvalTimeoutMs ?? 5 * 60 * 1000, 1, 60 * 60 * 1000, 'approvalTimeoutMs');
    this.approvalPollMs = bounded(options.approvalPollMs ?? 100, 10, 10_000, 'approvalPollMs');
    this.id = options.id ?? (() => `acp-${crypto.randomUUID()}`);
  }

  async handle(method: string, params: unknown, request: AgentRequest): Promise<unknown> {
    this.options.onProtocol?.({ method, direction: 'request', data: params });
    let result: unknown;
    switch (method) {
      case 'fs/read_text_file': result = await this.readTextFile(params, request); break;
      case 'fs/write_text_file': result = await this.writeTextFile(params, request); break;
      case 'terminal/create': result = await this.createTerminal(params, request); break;
      case 'terminal/output': result = await this.terminalOutput(params, request); break;
      case 'terminal/wait_for_exit': result = await this.waitForExit(params, request); break;
      case 'terminal/kill': result = await this.killTerminal(params, request); break;
      case 'terminal/release': result = await this.releaseTerminal(params, request); break;
      case 'session/request_permission': result = await this.requestPermission(params, request); break;
      default: throw new Error(`ACP client method not supported: ${method}`);
    }
    this.options.onProtocol?.({ method, direction: 'response', data: result });
    return result;
  }

  close(): void {
    for (const terminal of this.terminals.values()) {
      if (!terminal.settled) terminal.child.kill('SIGTERM');
    }
    this.terminals.clear();
  }

  private context(request: AgentRequest): SecurityContext {
    return typeof this.options.context === 'function' ? this.options.context(request) : this.options.context;
  }

  private async readTextFile(value: unknown, request: AgentRequest): Promise<{ content: string }> {
    const params = asRecord(value) as Partial<AcpFileReadParams>;
    const path = await this.safePath(params.path, false);
    await this.authorize({ request, capability: 'fs.read', path, suffix: 'read' });
    const bytes = await readFile(path);
    if (bytes.byteLength > this.maxFileBytes) throw new Error(`ACP file exceeds ${this.maxFileBytes} bytes`);
    let content = bytes.toString('utf8');
    const line = positiveInteger(params.line);
    const limit = positiveInteger(params.limit);
    if (line !== undefined || limit !== undefined) {
      const lines = content.split(/\r?\n/);
      const start = (line ?? 1) - 1;
      content = lines.slice(start, limit === undefined ? undefined : start + limit).join('\n');
    }
    return { content };
  }

  private async writeTextFile(value: unknown, request: AgentRequest): Promise<Record<string, never>> {
    const params = asRecord(value) as Partial<{ path: string; content: string }>;
    if (typeof params.content !== 'string') throw new Error('ACP file content must be a string');
    if (Buffer.byteLength(params.content, 'utf8') > this.maxFileBytes) throw new Error(`ACP file exceeds ${this.maxFileBytes} bytes`);
    const path = await this.safePath(params.path, true);
    await this.authorize({ request, capability: 'fs.write', path, suffix: 'write' });
    await writeFile(path, params.content, { encoding: 'utf8' });
    return {};
  }

  private async createTerminal(value: unknown, request: AgentRequest): Promise<AcpTerminalRef> {
    const params = asRecord(value) as Partial<AcpTerminalCreateParams>;
    if (typeof params.command !== 'string' || !params.command.trim() || params.command.includes('\0')) throw new Error('ACP terminal command is required');
    const args = Array.isArray(params.args) ? params.args.map(String) : [];
    if (args.some((arg) => arg.includes('\0'))) throw new Error('ACP terminal arguments cannot contain NUL bytes');
    const cwd = await this.terminalCwd(params.cwd);
    const command = [params.command, ...args].join(' ');
    await this.authorize({ request, capability: 'process.exec', command, path: cwd, suffix: 'terminal' });
    const env = Object.fromEntries(Object.entries(params.env ?? {}).map(([key, envValue]) => {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof envValue !== 'string' || envValue.includes('\0')) throw new Error('Invalid ACP terminal environment');
      return [key, envValue];
    }));
    const safeEnvironment = { ...(process.env.PATH ? { PATH: process.env.PATH } : {}), ...env };
    const child = spawn(params.command, args, { cwd, env: safeEnvironment, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    const id = this.id();
    let resolveExit!: () => void;
    const exit = new Promise<void>((resolvePromise) => { resolveExit = resolvePromise; });
    const terminal: TerminalRecord = { id, sessionId: request.task.sessionId, child, cwd, command: params.command, args, stdout: '', stderr: '', outputBytes: 0, exitCode: undefined, signal: undefined, settled: false, exit };
    const collect = (stream: 'stdout' | 'stderr') => (chunk: Buffer): void => {
      if (terminal.settled) return;
      const text = chunk.toString('utf8');
      terminal.outputBytes += chunk.byteLength;
      if (terminal.outputBytes <= this.maxTerminalOutputBytes) terminal[stream] += text;
      else if (terminal.outputBytes - chunk.byteLength < this.maxTerminalOutputBytes) terminal[stream] += text.slice(0, this.maxTerminalOutputBytes - (terminal.outputBytes - chunk.byteLength));
    };
    child.stdout.on('data', collect('stdout'));
    child.stderr.on('data', collect('stderr'));
    child.once('error', (error) => { terminal.stderr += `${error.message}\n`; terminal.exitCode = -1; terminal.settled = true; resolveExit(); });
    child.once('close', (code, signal) => { terminal.exitCode = code ?? -1; terminal.signal = signal ?? undefined; terminal.settled = true; resolveExit(); });
    this.terminals.set(id, terminal);
    if (params.timeout && Number.isInteger(params.timeout) && params.timeout > 0) setTimeout(() => { if (!terminal.settled) child.kill('SIGTERM'); }, params.timeout).unref();
    return { terminalId: id };
  }

  private async terminalOutput(value: unknown, request: AgentRequest): Promise<AcpTerminalOutputResponse> {
    const params = asRecord(value);
    const terminal = this.getTerminal(params.terminalId, request);
    const maxChars = positiveInteger(params.maxChars) ?? this.maxTerminalOutputBytes;
    const output = `${terminal.stdout}${terminal.stderr}`;
    return { output: output.slice(0, maxChars), truncated: output.length > maxChars || terminal.outputBytes > this.maxTerminalOutputBytes, ...(terminal.settled ? { exitStatus: { exitCode: terminal.exitCode ?? -1, ...(terminal.signal ? { signal: terminal.signal } : {}) } } : {}) };
  }

  private async waitForExit(value: unknown, request: AgentRequest): Promise<{ exitCode: number }> {
    const terminal = this.getTerminal(asRecord(value).terminalId, request);
    await terminal.exit;
    return { exitCode: terminal.exitCode ?? -1 };
  }

  private async killTerminal(value: unknown, request: AgentRequest): Promise<Record<string, never>> {
    const terminal = this.getTerminal(asRecord(value).terminalId, request);
    if (!terminal.settled) terminal.child.kill('SIGTERM');
    return {};
  }

  private async releaseTerminal(value: unknown, request: AgentRequest): Promise<Record<string, never>> {
    const terminal = this.getTerminal(asRecord(value).terminalId, request);
    if (!terminal.settled) terminal.child.kill('SIGTERM');
    this.terminals.delete(terminal.id);
    return {};
  }

  private async requestPermission(value: unknown, request: AgentRequest): Promise<AcpPermissionResponse> {
    const params = asRecord(value) as Partial<AcpPermissionRequest>;
    const options = Array.isArray(params.options) ? params.options : [];
    if (!options.length || !params.toolCall || typeof params.toolCall !== 'object') return { outcome: { outcome: 'cancelled' } };
    const toolCall = params.toolCall as AcpToolCall;
    const classification = classifyToolCall(toolCall);
    const target = classification.path ?? classification.command ?? toolCall.title;
    const authorization = await this.authorize({ request, capability: classification.capability, ...(classification.path ? { path: classification.path } : {}), ...(classification.command ? { command: classification.command } : {}), suffix: `permission:${target}` }, true);
    if (!authorization) return { outcome: { outcome: 'cancelled' } };
    const selected = options.find((option) => /allow|approve|once|always/i.test(`${option.kind ?? ''} ${option.name}`) && !/reject|deny|cancel/i.test(`${option.kind ?? ''} ${option.name}`)) ?? options[0];
    if (!selected) return { outcome: { outcome: 'cancelled' } };
    return { outcome: { outcome: 'selected', optionId: selected.optionId } };
  }

  private async authorize(input: { readonly request: AgentRequest; readonly capability: SecurityCapability; readonly path?: string; readonly command?: string; readonly suffix: string }, permissionOnly = false): Promise<boolean> {
    const toolRequest: ToolRequest = {
      requestId: `acp:${input.request.task.id}:${input.suffix}`,
      taskId: input.request.task.id,
      capability: input.capability,
      ...(input.path ? { path: input.path } : {}),
      ...(input.command ? { command: input.command } : {}),
      metadata: { protocol: 'acp', method: input.suffix },
    };
    const policy = this.options.policy.evaluate(toolRequest, this.context(input.request));
    if (policy.decision === 'deny') {
      if (permissionOnly) return false;
      throw new Error(`Security policy denied ACP ${input.suffix}: ${policy.reason}`);
    }
    if (policy.decision === 'allow') return true;
    const existing = this.options.approvals.list().find((approval) => approval.request.requestId === toolRequest.requestId && ['pending', 'approved'].includes(approval.status));
    const approval = existing ?? this.options.approvals.create(toolRequest, policy, this.approvalTimeoutMs);
    const decided = approval.status === 'pending' ? await this.waitForApproval(approval.id, input.request.signal) : approval;
    if (decided.status !== 'approved') {
      if (permissionOnly) return false;
      throw new Error(`ACP operation was not approved: ${decided.status}`);
    }
    if (!this.options.approvals.consume(decided.id)) throw new Error('ACP approval could not be consumed');
    return true;
  }

  private async waitForApproval(id: string, signal: AbortSignal): Promise<ReturnType<ApprovalService['get']> extends infer T ? NonNullable<T> : never> {
    const deadline = Date.now() + this.approvalTimeoutMs;
    while (Date.now() < deadline) {
      if (signal.aborted) throw new Error('ACP approval wait aborted');
      const approval = this.options.approvals.get(id);
      if (approval && approval.status !== 'pending') return approval as NonNullable<ReturnType<ApprovalService['get']>>;
      await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, this.approvalPollMs));
    }
    const expired = this.options.approvals.get(id);
    if (expired && expired.status !== 'pending') return expired as NonNullable<ReturnType<ApprovalService['get']>>;
    throw new Error(`ACP approval timed out: ${id}`);
  }

  private async safePath(value: unknown, write: boolean): Promise<string> {
    if (typeof value !== 'string' || !isAbsolute(value) || value.includes('\0')) throw new Error('ACP file paths must be absolute and NUL-free');
    const candidate = resolve(value);
    const resolvedParent = write ? await realpath(dirname(candidate)).catch(() => undefined) : undefined;
    const canonicalCandidate = write
      ? resolvedParent ? resolve(resolvedParent, basename(candidate)) : candidate
      : await realpath(candidate).catch(() => candidate);
    if (!isWithin(this.root, canonicalCandidate)) throw new Error('ACP file path is outside the workspace root');
    const boundary = write ? resolvedParent : canonicalCandidate;
    const resolvedBoundary = boundary ? await realpath(boundary).catch(() => undefined) : undefined;
    if (!resolvedBoundary || !isWithin(this.root, resolvedBoundary)) throw new Error('ACP file path resolves outside the workspace root');
    if (!write) {
      const info = await stat(canonicalCandidate);
      if (!info.isFile()) throw new Error('ACP read path must be a file');
    }
    return canonicalCandidate;
  }

  private async terminalCwd(value: unknown): Promise<string> {
    const candidate = typeof value === 'string' && value.trim() ? (isAbsolute(value) ? resolve(value) : resolve(this.root, value)) : this.root;
    if (!isWithin(this.root, candidate)) throw new Error('ACP terminal cwd is outside the workspace root');
    const resolved = await realpath(candidate);
    if (!isWithin(this.root, resolved) || !(await stat(resolved)).isDirectory()) throw new Error('ACP terminal cwd must be a workspace directory');
    return resolved;
  }

  private getTerminal(value: unknown, request: AgentRequest): TerminalRecord {
    if (typeof value !== 'string' || !value.trim()) throw new Error('ACP terminalId is required');
    const terminal = this.terminals.get(value);
    if (!terminal || terminal.sessionId !== request.task.sessionId) throw new Error(`ACP terminal not found: ${value}`);
    return terminal;
  }
}

function bounded(value: number, minimum: number, maximum: number, name: string): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) throw new Error(`Invalid ${name}`);
  return value;
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}

function asRecord(value: unknown): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('ACP request params must be an object');
  return value as Record<string, any>;
}

function classifyToolCall(toolCall: AcpToolCall): { capability: SecurityCapability; path?: string; command?: string } {
  const raw = toolCall.rawInput && typeof toolCall.rawInput === 'object' ? toolCall.rawInput as Record<string, unknown> : {};
  const path = typeof raw.path === 'string' ? raw.path : typeof raw.file === 'string' ? raw.file : undefined;
  const command = typeof raw.command === 'string' ? raw.command : typeof raw.cmd === 'string' ? raw.cmd : undefined;
  const kind = `${toolCall.kind ?? ''} ${toolCall.title}`.toLowerCase();
  if (command || kind.includes('terminal') || kind.includes('command') || kind.includes('shell')) return { capability: 'process.exec', ...(command ? { command } : {}) };
  if (path && (kind.includes('write') || kind.includes('edit') || kind.includes('create') || kind.includes('delete'))) return { capability: 'fs.write', path };
  if (path) return { capability: 'fs.read', path };
  return { capability: 'process.exec', command: toolCall.title };
}
