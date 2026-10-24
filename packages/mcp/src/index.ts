import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { ApprovalService, PolicyEngine, type SecurityCapability, type SecurityContext, type ToolRequest, verifySignedArtifact } from '@agentcorps/security';

export interface McpTool {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: unknown;
}

export interface McpServerInfo {
  readonly name: string;
  readonly version: string;
}

export interface McpResource {
  readonly uri: string;
  readonly name?: string;
  readonly description?: string;
  readonly mimeType?: string;
  readonly [key: string]: unknown;
}

export interface McpPrompt {
  readonly name: string;
  readonly description?: string;
  readonly arguments?: readonly Record<string, unknown>[];
  readonly [key: string]: unknown;
}

export interface McpPage<T> {
  readonly items: readonly T[];
  readonly nextCursor?: string;
}

export interface McpResourceContents {
  readonly contents: readonly Record<string, unknown>[];
  readonly [key: string]: unknown;
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

export interface McpSourceAttestation {
  readonly name: string;
  readonly version: string;
  readonly content: string | Uint8Array;
  readonly sha256: string;
  readonly signature: string;
  readonly publicKey: string;
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
  readonly onNotification?: (method: string, params: unknown) => void;
  /** Optional signed publisher attestation checked before the child process starts. */
  readonly sourceAttestation?: McpSourceAttestation;
}

interface JsonRpcResponse {
  readonly jsonrpc: '2.0';
  readonly id?: number;
  readonly method?: string;
  readonly params?: unknown;
  readonly result?: unknown;
  readonly error?: { readonly code: number; readonly message: string; readonly data?: unknown };
}

export class McpStdioClient {
  private readonly options: McpStdioOptions;
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout; cleanup?: () => void }>();
  private process: ChildProcessWithoutNullStreams | undefined;
  private nextId = 1;
  private started = false;
  private initializeResult: McpInitializeResult | undefined;

  constructor(options: McpStdioOptions) {
    this.options = options;
  }

  async start(): Promise<McpInitializeResult> {
    if (this.started && this.initializeResult) return this.initializeResult;
    if (this.options.sourceAttestation) verifySignedArtifact(this.options.sourceAttestation);
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

  async listToolsPage(cursor?: string): Promise<McpPage<McpTool>> {
    await this.start();
    const result = await this.request('tools/list', cursor ? { cursor } : {}) as { tools?: McpTool[]; nextCursor?: string };
    return { items: result.tools ?? [], ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}) };
  }

  async listTools(): Promise<readonly McpTool[]> {
    return await collectPages((cursor) => this.listToolsPage(cursor));
  }

  async listResourcesPage(cursor?: string): Promise<McpPage<McpResource>> {
    await this.start();
    const result = await this.request('resources/list', cursor ? { cursor } : {}) as { resources?: McpResource[]; nextCursor?: string };
    return { items: result.resources ?? [], ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}) };
  }

  async listResources(): Promise<readonly McpResource[]> {
    return await collectPages((cursor) => this.listResourcesPage(cursor));
  }

  async readResource(uri: string): Promise<McpResourceContents> {
    if (!uri.trim()) throw new Error('MCP resource URI is required');
    await this.start();
    return await this.request('resources/read', { uri }) as McpResourceContents;
  }

  async listPromptsPage(cursor?: string): Promise<McpPage<McpPrompt>> {
    await this.start();
    const result = await this.request('prompts/list', cursor ? { cursor } : {}) as { prompts?: McpPrompt[]; nextCursor?: string };
    return { items: result.prompts ?? [], ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}) };
  }

  async listPrompts(): Promise<readonly McpPrompt[]> {
    return await collectPages((cursor) => this.listPromptsPage(cursor));
  }

  async getPrompt(name: string, arguments_: Record<string, string> = {}): Promise<Record<string, unknown>> {
    if (!name.trim()) throw new Error('MCP prompt name is required');
    await this.start();
    return await this.request('prompts/get', { name, arguments: arguments_ }) as Record<string, unknown>;
  }

  async callTool(name: string, arguments_: Record<string, unknown> = {}, signal?: AbortSignal): Promise<McpCallResult> {
    await this.start();
    return await this.request('tools/call', { name, arguments: arguments_ }, signal) as McpCallResult;
  }

  close(): void {
    this.rejectPending(new Error('MCP client closed'));
    this.process?.kill('SIGTERM');
    this.process = undefined;
    this.started = false;
    this.initializeResult = undefined;
  }

  private request(method: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    const process = this.process;
    if (!process) return Promise.reject(new Error('MCP process is not running'));
    const id = this.nextId++;
    const timeoutMs = this.options.timeoutMs ?? 30_000;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        cleanup();
        reject(new Error(`MCP request timed out: ${method}`));
      }, timeoutMs);
      const abort = () => {
        this.pending.delete(id);
        clearTimeout(timer);
        cleanup();
        try { this.sendNotification('notifications/cancelled', { requestId: id, reason: 'client aborted' }); } catch { /* process may already be closed */ }
        reject(new Error(`MCP request aborted: ${method}`));
      };
      const cleanup = () => signal?.removeEventListener('abort', abort);
      if (signal?.aborted) return abort();
      signal?.addEventListener('abort', abort, { once: true });
      this.pending.set(id, { resolve, reject, timer, cleanup });
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
    if (response.method) {
      this.options.onNotification?.(response.method, response.params);
      return;
    }
    if (response.id === undefined) return;
    const pending = this.pending.get(response.id);
    if (!pending) return;
    this.pending.delete(response.id);
    clearTimeout(pending.timer);
    pending.cleanup?.();
    if (response.error) pending.reject(new Error(`MCP ${response.error.code}: ${response.error.message}`));
    else pending.resolve(response.result);
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

async function collectPages<T>(fetchPage: (cursor?: string) => Promise<McpPage<T>>): Promise<readonly T[]> {
  const items: T[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  while (true) {
    const page = await fetchPage(cursor);
    items.push(...page.items);
    if (!page.nextCursor) return items;
    if (seen.has(page.nextCursor)) throw new Error('MCP pagination cursor repeated');
    seen.add(page.nextCursor);
    cursor = page.nextCursor;
  }
}
export interface McpToolEvent {
  readonly direction: 'request' | 'response' | 'update';
  readonly method: string;
  readonly metadata?: Readonly<Record<string, string | number | boolean>>;
}

export interface GuardedMcpToolCall {
  readonly status: 'completed' | 'approval_required';
  readonly requestId: string;
  readonly result?: McpCallResult;
  readonly approvalId?: string;
}

export interface GuardedMcpToolExecutorOptions {
  readonly client: McpStdioClient;
  readonly policy: PolicyEngine;
  readonly approvals: ApprovalService;
  readonly context: SecurityContext;
  readonly capabilityFor: (tool: McpTool) => SecurityCapability;
  readonly onEvent?: (event: McpToolEvent) => void;
  readonly id?: () => string;
}

export class GuardedMcpToolExecutor {
  private readonly id: () => string;

  constructor(private readonly options: GuardedMcpToolExecutorOptions) {
    this.id = options.id ?? (() => `mcp-request-${crypto.randomUUID()}`);
  }

  async callTool(taskId: string, tool: McpTool, arguments_: Record<string, unknown> = {}, approvalId?: string, requestId?: string, signal?: AbortSignal): Promise<GuardedMcpToolCall> {
    const request: ToolRequest = {
      requestId: requestId ?? this.id(),
      taskId,
      capability: this.options.capabilityFor(tool),
      metadata: { tool: tool.name, arguments: JSON.stringify(arguments_) },
    };
    this.options.onEvent?.({ direction: 'request', method: 'tools/call', metadata: { tool: tool.name, taskId, requestId: request.requestId } });
    const decision = this.options.policy.evaluate(request, this.options.context);
    if (decision.decision === 'deny') {
      this.options.onEvent?.({ direction: 'response', method: 'tools/call', metadata: { tool: tool.name, decision: 'deny' } });
      throw new Error(`MCP tool denied: ${decision.reason}`);
    }
    if (decision.decision === 'approval_required') {
      if (!approvalId) {
        const approval = this.options.approvals.create(request, decision);
        this.options.onEvent?.({ direction: 'response', method: 'approval_required', metadata: { tool: tool.name, approvalId: approval.id } });
        return { status: 'approval_required', approvalId: approval.id, requestId: request.requestId };
      }
      const approval = this.options.approvals.get(approvalId);
      if (!approval || approval.status !== 'approved' || !sameToolRequest(approval.request, request)) {
        this.options.onEvent?.({ direction: 'response', method: 'approval_rejected', metadata: { tool: tool.name, approvalId } });
        throw new Error('MCP approval does not match this tool request');
      }
      if (!this.options.approvals.consume(approvalId)) throw new Error('MCP approval could not be consumed');
      this.options.onEvent?.({ direction: 'update', method: 'approval_consumed', metadata: { tool: tool.name, approvalId } });
    }
    const result = await this.options.client.callTool(tool.name, arguments_, signal);
    this.options.onEvent?.({ direction: 'response', method: 'tools/call', metadata: { tool: tool.name, resultItems: result.content.length } });
    return { status: 'completed', requestId: request.requestId, result };
  }
}

function sameToolRequest(left: ToolRequest, right: ToolRequest): boolean {
  return left.requestId === right.requestId
    && left.taskId === right.taskId
    && left.capability === right.capability
    && JSON.stringify(left.metadata ?? {}) === JSON.stringify(right.metadata ?? {});
}