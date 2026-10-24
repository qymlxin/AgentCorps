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

export const protocolDescriptors = {
  mcp: { direction: 'agent-to-tool', maturity: 'adopted' },
  a2a: { direction: 'agent-to-agent', maturity: 'experimental' },
  acp: { direction: 'editor-to-coding-agent', maturity: 'adapter-planned' },
} as const;
