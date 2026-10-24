import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';

export interface McpTool {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: unknown;
}

export interface McpServerInfo {
  readonly name: string;
  readonly version: string;
}

export interface McpInitializeResult {
  readonly protocolVersion: string;
  readonly capabilities: Record<string, unknown>;
  readonly serverInfo: McpServerInfo;
}

export interface McpCallResult {
  readonly content: readonly unknown[];
  readonly isError?: boolean;
}

export interface McpStdioOptions {
  readonly command: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly timeoutMs?: number;
  readonly protocolVersion?: string;
  readonly clientName?: string;
  readonly clientVersion?: string;
  readonly onStderr?: (text: string) => void;
}

interface JsonRpcResponse {
  readonly jsonrpc: '2.0';
  readonly id?: number;
  readonly result?: unknown;
  readonly error?: { readonly code: number; readonly message: string; readonly data?: unknown };
}

export class McpStdioClient {
  private readonly options: McpStdioOptions;
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private process: ChildProcessWithoutNullStreams | undefined;
  private nextId = 1;
  private started = false;
  private initializeResult: McpInitializeResult | undefined;

  constructor(options: McpStdioOptions) {
    this.options = options;
  }

  async start(): Promise<McpInitializeResult> {
    if (this.started && this.initializeResult) return this.initializeResult;
    this.process = spawn(this.options.command, [...(this.options.args ?? [])], {
      cwd: this.options.cwd,
      env: { ...process.env, ...this.options.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const lines = createInterface({ input: this.process.stdout, crlfDelay: Infinity });
    lines.on('line', (line) => this.handleLine(line));
    this.process.stderr.on('data', (chunk: Buffer) => this.options.onStderr?.(chunk.toString('utf8')));
    this.process.on('error', (error) => this.rejectPending(error));
    this.process.on('close', (code, signal) => this.rejectPending(new Error(`MCP server exited (code=${code ?? 'null'}, signal=${signal ?? 'none'})`)));
    const result = await this.request('initialize', {
      protocolVersion: this.options.protocolVersion ?? '2026-07-28',
      capabilities: {},
      clientInfo: { name: this.options.clientName ?? 'AgentCorps', version: this.options.clientVersion ?? '0.1.0' },
    }) as McpInitializeResult;
    this.sendNotification('notifications/initialized', {});
    this.started = true;
    this.initializeResult = result;
    return result;
  }

  async listTools(): Promise<readonly McpTool[]> {
    await this.start();
    const result = await this.request('tools/list', {}) as { tools?: McpTool[] };
    return result.tools ?? [];
  }

  async callTool(name: string, arguments_: Record<string, unknown> = {}): Promise<McpCallResult> {
    await this.start();
    return await this.request('tools/call', { name, arguments: arguments_ }) as McpCallResult;
  }

  close(): void {
    this.rejectPending(new Error('MCP client closed'));
    this.process?.kill('SIGTERM');
    this.process = undefined;
    this.started = false;
    this.initializeResult = undefined;
  }

  private request(method: string, params: Record<string, unknown>): Promise<unknown> {
    const process = this.process;
    if (!process) return Promise.reject(new Error('MCP process is not running'));
    const id = this.nextId++;
    const timeoutMs = this.options.timeoutMs ?? 30_000;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      process.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  private sendNotification(method: string, params: Record<string, unknown>): void {
    this.process?.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  private handleLine(line: string): void {
    let response: JsonRpcResponse;
    try {
      response = JSON.parse(line) as JsonRpcResponse;
    } catch {
      return;
    }
    if (response.id === undefined) return;
    const pending = this.pending.get(response.id);
    if (!pending) return;
    this.pending.delete(response.id);
    clearTimeout(pending.timer);
    if (response.error) pending.reject(new Error(`MCP ${response.error.code}: ${response.error.message}`));
    else pending.resolve(response.result);
  }

  private rejectPending(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
  }
}
