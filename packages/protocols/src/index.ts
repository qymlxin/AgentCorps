import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
export interface A2AAgentCard {
  readonly name: string;
  readonly description?: string;
  readonly url: string;
  readonly version?: string;
  readonly protocolVersion?: string;
  readonly capabilities?: Record<string, unknown>;
}

export interface A2ATaskResponse {
  readonly id?: string;
  readonly status?: Record<string, unknown>;
  readonly artifacts?: readonly unknown[];
  readonly history?: readonly unknown[];
}

export class A2AProtocolError extends Error {
  constructor(readonly operation: string, readonly code: number | string, message: string, readonly data?: unknown) {
    super(`A2A ${operation} failed (${code}): ${message}`);
    this.name = 'A2AProtocolError';
  }
}

export interface A2ARequestOptions {
  readonly signal?: AbortSignal;
  readonly idempotencyKey?: string;
  readonly reconnectAttempts?: number;
}

export interface A2AStreamEvent {
  readonly event?: string;
  readonly id?: string;
  readonly data: unknown;
}

export interface A2ATrustPolicy {
  readonly requireHttps?: boolean;
  readonly allowedOrigins?: readonly string[];
  readonly verifyAgentCard?: (card: unknown) => void | Promise<void>;
}

export interface A2AClientOptions {
  readonly agentUrl: string;
  readonly bearerToken?: string;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
  readonly requiredCapabilities?: readonly string[];
  readonly requiredProtocolVersion?: string;
  readonly trust?: A2ATrustPolicy;
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
    if (!response.ok) throw new A2AProtocolError('agent-card', response.status, `HTTP ${response.status}`);
    const card = await response.json() as unknown;
    const validated = validateAgentCard(card);
    const remote = new URL(validated.url);
    if (this.options.trust?.requireHttps && remote.protocol !== 'https:') throw new A2AProtocolError('agent-card', 'untrusted_transport', 'Agent Card URL must use HTTPS');
    if (this.options.trust?.allowedOrigins && !this.options.trust.allowedOrigins.includes(remote.origin)) throw new A2AProtocolError('agent-card', 'untrusted_origin', `Agent Card origin is not trusted: ${remote.origin}`);
    await this.options.trust?.verifyAgentCard?.(card);
    if (this.options.requiredProtocolVersion && validated.protocolVersion !== this.options.requiredProtocolVersion) throw new A2AProtocolError('agent-card', 'protocol_mismatch', `Agent Card protocol version ${validated.protocolVersion ?? '<missing>'} does not satisfy ${this.options.requiredProtocolVersion}`);
    for (const capability of this.options.requiredCapabilities ?? []) if (!validated.capabilities?.[capability]) throw new A2AProtocolError('agent-card', 'missing_capability', `Agent Card does not advertise capability: ${capability}`);
    return validated;
  }

  async *streamMessage(text: string, contextId?: string, requestOptions: A2ARequestOptions = {}): AsyncGenerator<A2AStreamEvent> {
    if (!text.trim()) throw new Error('A2A message cannot be empty');
    const body = JSON.stringify({ jsonrpc: '2.0', id: this.nextId++, method: 'message/stream', params: { message: { messageId: `agentcorps-${crypto.randomUUID()}`, role: 'user', parts: [{ kind: 'text', text }] }, ...(contextId ? { contextId } : {}) } });
    const maxReconnects = requestOptions.reconnectAttempts ?? 2;
    if (!Number.isInteger(maxReconnects) || maxReconnects < 0) throw new Error('A2A reconnectAttempts must be a non-negative integer');
    let lastEventId: string | undefined;
    const seenIds = new Set<string>();
    for (let attempt = 0; attempt <= maxReconnects; attempt += 1) {
      try {
        const response = await this.fetchImpl(this.options.agentUrl, {
          method: 'POST',
          headers: { ...this.headers(), ...(requestOptions.idempotencyKey ? { 'idempotency-key': requestOptions.idempotencyKey } : {}), ...(lastEventId ? { 'last-event-id': lastEventId } : {}), accept: 'text/event-stream', 'content-type': 'application/json' },
          signal: requestSignal(this.options.timeoutMs ?? 30_000, requestOptions.signal),
          body,
        });
        if (!response.ok) throw new A2AProtocolError('message/stream', response.status, `HTTP ${response.status}`);
        if (!response.body) throw new A2AProtocolError('message/stream', 'missing_body', 'Response has no event stream body');
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        while (true) {
          const chunk = await reader.read();
          buffer += decoder.decode(chunk.value ?? new Uint8Array(), { stream: !chunk.done });
          const frames = buffer.split(/\r?\n\r?\n/);
          buffer = frames.pop() ?? '';
          for (const frame of frames) {
            const event = parseSseFrame(frame);
            if (!event) continue;
            if (event.id) lastEventId = event.id;
            if (event.id && seenIds.has(event.id)) continue;
            if (event.id) seenIds.add(event.id);
            if (isRecord(event.data) && event.data.error) {
              const error = event.data.error as Record<string, unknown>;
              throw new A2AProtocolError('message/stream', String(error.code ?? 'stream_error'), String(error.message ?? 'Stream returned an error'), error.data);
            }
            yield event;
          }
          if (chunk.done) {
            if (buffer.trim()) {
              const event = parseSseFrame(buffer);
              if (event) yield event;
            }
            return;
          }
        }
      } catch (error) {
        if (requestOptions.signal?.aborted || attempt >= maxReconnects) throw error;
      }
    }
  }

  async sendMessage(text: string, contextId?: string, requestOptions: A2ARequestOptions = {}): Promise<A2ATaskResponse> {
    if (!text.trim()) throw new Error('A2A message cannot be empty');
    const response = await this.fetchImpl(this.options.agentUrl, {
      method: 'POST', headers: { ...this.headers(), ...(requestOptions.idempotencyKey ? { 'idempotency-key': requestOptions.idempotencyKey } : {}), 'content-type': 'application/json' }, signal: requestSignal(this.options.timeoutMs ?? 30_000, requestOptions.signal),
      body: JSON.stringify({ jsonrpc: '2.0', id: this.nextId++, method: 'message/send', params: { message: { messageId: `agentcorps-${crypto.randomUUID()}`, role: 'user', parts: [{ kind: 'text', text }] }, ...(contextId ? { contextId } : {}) } }),
    });
    if (!response.ok) throw new A2AProtocolError('message/send', response.status, `HTTP ${response.status}`);
    const body = await response.json() as { result?: unknown; error?: { code: number; message: string; data?: unknown } };
    if (body.error) throw new A2AProtocolError('message/send', body.error.code, body.error.message, body.error.data);
    if (!body.result || typeof body.result !== 'object') throw new A2AProtocolError('message/send', 'invalid_result', 'Response is missing a task result');
    return body.result as A2ATaskResponse;
  }

  async cancelTask(taskId: string, requestOptions: A2ARequestOptions = {}): Promise<A2ATaskResponse> {
    if (!taskId.trim()) throw new Error('A2A taskId cannot be empty');
    const response = await this.fetchImpl(this.options.agentUrl, {
      method: 'POST', headers: { ...this.headers(), ...(requestOptions.idempotencyKey ? { 'idempotency-key': requestOptions.idempotencyKey } : {}), 'content-type': 'application/json' }, signal: requestSignal(this.options.timeoutMs ?? 30_000, requestOptions.signal),
      body: JSON.stringify({ jsonrpc: '2.0', id: this.nextId++, method: 'tasks/cancel', params: { id: taskId } }),
    });
    if (!response.ok) throw new A2AProtocolError('tasks/cancel', response.status, `HTTP ${response.status}`);
    const body = await response.json() as { result?: unknown; error?: { code: number; message: string; data?: unknown } };
    if (body.error) throw new A2AProtocolError('tasks/cancel', body.error.code, body.error.message, body.error.data);
    if (!body.result || typeof body.result !== 'object') throw new A2AProtocolError('tasks/cancel', 'invalid_result', 'Response is missing a task result');
    return body.result as A2ATaskResponse;
  }

  private headers(): Record<string, string> {
    return this.options.bearerToken ? { authorization: `Bearer ${this.options.bearerToken}` } : {};
  }
}

function parseSseFrame(frame: string): A2AStreamEvent | undefined {
  let event: string | undefined;
  let id: string | undefined;
  const dataLines: string[] = [];
  for (const line of frame.split(/\r?\n/)) {
    if (!line || line.startsWith(':')) continue;
    const separator = line.indexOf(':');
    const field = separator >= 0 ? line.slice(0, separator) : line;
    const value = separator >= 0 ? line.slice(separator + 1).replace(/^ /, '') : '';
    if (field === 'event') event = value;
    else if (field === 'id') id = value;
    else if (field === 'data') dataLines.push(value);
  }
  if (!dataLines.length) return undefined;
  const raw = dataLines.join('\n');
  let data: unknown;
  try { data = JSON.parse(raw) as unknown; } catch { data = raw; }
  return { ...(event ? { event } : {}), ...(id ? { id } : {}), data };
}

function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }

function validateAgentCard(value: unknown): A2AAgentCard {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new A2AProtocolError('agent-card', 'invalid_card', 'Agent Card must be an object');
  const card = value as Record<string, unknown>;
  if (typeof card.name !== 'string' || !card.name.trim()) throw new A2AProtocolError('agent-card', 'invalid_card', 'Agent Card name is required');
  if (typeof card.url !== 'string' || !/^https?:\/\//.test(card.url)) throw new A2AProtocolError('agent-card', 'invalid_card', 'Agent Card url must be an HTTP(S) URL');
  return {
    name: card.name,
    url: card.url,
    ...(typeof card.description === 'string' ? { description: card.description } : {}),
    ...(typeof card.version === 'string' ? { version: card.version } : {}),
    ...(typeof card.protocolVersion === 'string' ? { protocolVersion: card.protocolVersion } : {}),
    ...(card.capabilities && typeof card.capabilities === 'object' && !Array.isArray(card.capabilities) ? { capabilities: card.capabilities as Record<string, unknown> } : {}),
  };
}

function requestSignal(timeoutMs: number, signal: AbortSignal | undefined): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
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
  readonly requiredProtocolVersion?: number;
  readonly requiredCapabilities?: readonly string[];
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
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout; cleanup?: () => void }>();
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
    if (this.options.requiredProtocolVersion !== undefined && result.protocolVersion !== this.options.requiredProtocolVersion) throw new Error(`ACP protocol version ${result.protocolVersion} does not satisfy required version ${this.options.requiredProtocolVersion}`);
    for (const capability of this.options.requiredCapabilities ?? []) if (!result.agentCapabilities?.[capability]) throw new Error(`ACP agent does not advertise capability: ${capability}`);
    this.initialized = true;
    return result;
  }

  async newSession(cwd: string, mcpServers: readonly unknown[] = []): Promise<AcpSessionResult> {
    if (!this.initialized) await this.initialize();
    if (!cwd.startsWith('/')) throw new Error('ACP session cwd must be an absolute path');
    return await this.request('session/new', { cwd, mcpServers }) as AcpSessionResult;
  }

  async prompt(sessionId: string, text: string, signal?: AbortSignal): Promise<AcpPromptResult> {
    if (!this.initialized) throw new Error('ACP client is not initialized');
    if (!sessionId.trim() || !text.trim()) throw new Error('ACP prompt requires sessionId and text');
    return await this.request('session/prompt', { sessionId, prompt: [{ type: 'text', text }] }, signal, () => this.cancel(sessionId)) as AcpPromptResult;
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

  private request(method: string, params: unknown, signal?: AbortSignal, onAbort?: () => void): Promise<unknown> {
    const id = this.nextId++;
    const timeoutMs = this.options.timeoutMs ?? 30_000;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); cleanup(); reject(new Error(`ACP request timed out: ${method}`)); }, timeoutMs);
      const abort = () => {
        this.pending.delete(id);
        clearTimeout(timer);
        cleanup();
        try { onAbort?.(); } catch { /* the request is already being aborted */ }
        reject(new Error(`ACP request aborted: ${method}`));
      };
      const cleanup = () => signal?.removeEventListener('abort', abort);
      if (signal?.aborted) return abort();
      signal?.addEventListener('abort', abort, { once: true });
      this.pending.set(id, { resolve, reject, timer, cleanup });
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
      pending.cleanup?.();
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
      pending.cleanup?.();
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
