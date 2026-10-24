import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
export interface A2AAgentCard {
  readonly name: string;
  readonly description?: string;
  readonly url: string;
  readonly version?: string;
  readonly capabilities?: Record<string, unknown>;
}

export interface A2ATaskResponse {
  readonly id?: string;
  readonly status?: Record<string, unknown>;
  readonly artifacts?: readonly unknown[];
  readonly history?: readonly unknown[];
}

export interface A2AClientOptions {
  readonly agentUrl: string;
  readonly bearerToken?: string;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
}

export class A2AClient {
  private readonly options: A2AClientOptions;
  private readonly fetchImpl: typeof fetch;
  private nextId = 1;

  constructor(options: A2AClientOptions) {
    this.options = options;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async getAgentCard(): Promise<A2AAgentCard> {
    const response = await this.fetchImpl(new URL('/.well-known/agent-card.json', this.options.agentUrl), { headers: this.headers(), signal: AbortSignal.timeout(this.options.timeoutMs ?? 30_000) });
    if (!response.ok) throw new Error(`A2A agent card failed: HTTP ${response.status}`);
    return await response.json() as A2AAgentCard;
  }

  async sendMessage(text: string, contextId?: string): Promise<A2ATaskResponse> {
    if (!text.trim()) throw new Error('A2A message cannot be empty');
    const response = await this.fetchImpl(this.options.agentUrl, {
      method: 'POST', headers: { ...this.headers(), 'content-type': 'application/json' }, signal: AbortSignal.timeout(this.options.timeoutMs ?? 30_000),
      body: JSON.stringify({ jsonrpc: '2.0', id: this.nextId++, method: 'message/send', params: { message: { messageId: `agentcorps-${crypto.randomUUID()}`, role: 'user', parts: [{ kind: 'text', text }] }, ...(contextId ? { contextId } : {}) } }),
    });
    if (!response.ok) throw new Error(`A2A send failed: HTTP ${response.status}`);
    const body = await response.json() as { result?: A2ATaskResponse; error?: { code: number; message: string } };
    if (body.error) throw new Error(`A2A ${body.error.code}: ${body.error.message}`);
    return body.result ?? {};
  }

  private headers(): Record<string, string> {
    return this.options.bearerToken ? { authorization: `Bearer ${this.options.bearerToken}` } : {};
  }
}

export interface AcpInitializeResult {
  readonly protocolVersion: number;
  readonly agentCapabilities?: Record<string, unknown>;
  readonly agentInfo?: Record<string, unknown>;
}

export interface AcpSessionResult {
  readonly sessionId: string;
  readonly modes?: Record<string, unknown>;
  readonly models?: Record<string, unknown>;
}

export interface AcpPromptResult {
  readonly stopReason?: string;
  readonly [key: string]: unknown;
}

export interface AcpClientOptions {
  readonly command: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly timeoutMs?: number;
  readonly clientName?: string;
  readonly clientVersion?: string;
  readonly onUpdate?: (params: unknown) => void;
  readonly onRequest?: (method: string, params: unknown) => unknown | Promise<unknown>;
}

interface AcpRpcMessage {
  readonly jsonrpc: '2.0';
  readonly id?: number;
  readonly method?: string;
  readonly params?: unknown;
  readonly result?: unknown;
  readonly error?: { readonly code: number; readonly message: string; readonly data?: unknown };
}

export class AcpStdioClient {
  private readonly options: AcpClientOptions;
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private process: ChildProcessWithoutNullStreams | undefined;
  private nextId = 1;
  private initialized = false;

  constructor(options: AcpClientOptions) {
    this.options = options;
  }

  async initialize(): Promise<AcpInitializeResult> {
    this.ensureProcess();
    const result = await this.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: this.options.clientName ?? 'AgentCorps', version: this.options.clientVersion ?? '0.1.0' },
    }) as AcpInitializeResult;
    this.initialized = true;
    return result;
  }

  async newSession(cwd: string, mcpServers: readonly unknown[] = []): Promise<AcpSessionResult> {
    if (!this.initialized) await this.initialize();
    if (!cwd.startsWith('/')) throw new Error('ACP session cwd must be an absolute path');
    return await this.request('session/new', { cwd, mcpServers }) as AcpSessionResult;
  }

  async prompt(sessionId: string, text: string): Promise<AcpPromptResult> {
    if (!this.initialized) throw new Error('ACP client is not initialized');
    if (!sessionId.trim() || !text.trim()) throw new Error('ACP prompt requires sessionId and text');
    return await this.request('session/prompt', { sessionId, prompt: [{ type: 'text', text }] }) as AcpPromptResult;
  }

  cancel(sessionId: string): void {
    if (!sessionId.trim()) throw new Error('ACP cancellation requires sessionId');
    this.send({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId } });
  }

  close(): void {
    this.rejectPending(new Error('ACP client closed'));
    this.process?.kill('SIGTERM');
    this.process = undefined;
    this.initialized = false;
  }

  private ensureProcess(): void {
    if (this.process) return;
    this.process = spawn(this.options.command, [...(this.options.args ?? [])], { cwd: this.options.cwd, env: { ...process.env, ...this.options.env }, stdio: ['pipe', 'pipe', 'pipe'] });
    const lines = createInterface({ input: this.process.stdout, crlfDelay: Infinity });
    lines.on('line', (line) => this.handleLine(line));
    this.process.on('error', (error) => this.rejectPending(error));
    this.process.on('close', (code, signal) => this.rejectPending(new Error(`ACP agent exited (code=${code ?? 'null'}, signal=${signal ?? 'none'})`)));
  }

  private request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    const timeoutMs = this.options.timeoutMs ?? 30_000;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`ACP request timed out: ${method}`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ jsonrpc: '2.0', id, method, params });
    });
  }

  private send(message: AcpRpcMessage): void {
    if (!this.process) throw new Error('ACP process is not running');
    this.process.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private handleLine(line: string): void {
    let message: AcpRpcMessage;
    try { message = JSON.parse(line) as AcpRpcMessage; } catch { return; }
    if (message.id !== undefined && !message.method) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(`ACP ${message.error.code}: ${message.error.message}`));
      else pending.resolve(message.result);
      return;
    }
    if (message.method === 'session/update') {
      this.options.onUpdate?.(message.params);
      return;
    }
    if (message.method && message.id !== undefined && this.options.onRequest) {
      const requestId = message.id;
      Promise.resolve(this.options.onRequest(message.method, message.params)).then((result) => this.send({ jsonrpc: '2.0', id: requestId, result })).catch((error: unknown) => this.send({ jsonrpc: '2.0', id: requestId, error: { code: -32000, message: error instanceof Error ? error.message : String(error) } }));
    }
  }

  private rejectPending(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
  }
}

export const protocolDescriptors = {
  mcp: { direction: 'agent-to-tool', maturity: 'adopted' },
  a2a: { direction: 'agent-to-agent', maturity: 'experimental' },
  acp: { direction: 'editor-to-coding-agent', maturity: 'experimental' },
} as const;
