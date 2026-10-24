import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { TaskId } from '@agentcorps/domain';
import { InMemorySessionStore, SessionService, type MessageRole, type SessionMode } from '@agentcorps/session';
import { MockAgent, type TaskRuntime } from '@agentcorps/runtime';
import {
  GenericWebhookAdapter,
  MessageDeduplicator,
  verifyHmacSha256,
  type ChannelAdapter,
  type ChannelKind,
  type InboundMessage,
  type OutboundMessage,
} from '@agentcorps/channels';

const MAX_BODY_BYTES = 1024 * 1024;

type JsonRecord = Record<string, unknown>;

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(payload) });
  response.end(payload);
}

async function readBody(request: IncomingMessage): Promise<Buffer> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > MAX_BODY_BYTES) throw new Error('Request body exceeds 1 MiB');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function parseJsonBody(body: Buffer): JsonRecord {
  const value: unknown = JSON.parse(body.toString('utf8') || '{}');
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Request body must be a JSON object');
  return value as JsonRecord;
}

async function readJson(request: IncomingMessage): Promise<JsonRecord> {
  return parseJsonBody(await readBody(request));
}

function taskIdFrom(pathname: string): TaskId | undefined {
  const match = /^\/tasks\/([^/]+)(?:\/([^/]+))?$/.exec(pathname);
  return match?.[1] as TaskId | undefined;
}

function sessionIdFrom(pathname: string): string | undefined {
  const match = /^\/sessions\/([^/]+)(?:\/([^/]+))?$/.exec(pathname);
  return match?.[1];
}

function messageRole(value: unknown): MessageRole {
  if (value === 'user' || value === 'agent' || value === 'system' || value === 'tool') return value;
  throw new Error('Message role must be user, agent, system, or tool');
}

export interface ChannelGatewayOptions {
  readonly adapters?: Partial<Record<ChannelKind, ChannelAdapter>>;
  readonly webhookSecrets?: Partial<Record<ChannelKind, string>>;
  readonly defaultMode?: SessionMode;
  readonly workspaceId?: string;
  readonly sessionIds?: Map<string, string>;
}

export interface GatewayOptions {
  readonly bearerToken?: string;
  readonly corsOrigin?: string;
  readonly channels?: ChannelGatewayOptions;
}

const channelKinds: readonly ChannelKind[] = ['feishu', 'dingtalk', 'wecom', 'custom'];

function channelKindFrom(pathname: string): ChannelKind | undefined {
  const match = /^\/channels\/([^/]+)\/(webhook|outbound)$/.exec(pathname);
  if (!match || !channelKinds.includes(match[1] as ChannelKind)) return undefined;
  return match[1] as ChannelKind;
}

function defaultChannelAdapters(): Record<ChannelKind, ChannelAdapter> {
  return Object.fromEntries(channelKinds.map((kind) => [kind, new GenericWebhookAdapter(kind)])) as Record<ChannelKind, ChannelAdapter>;
}

function channelSessionKey(message: Pick<InboundMessage, 'channel' | 'externalConversationId'>): string {
  return `${message.channel}:${message.externalConversationId}`;
}

function setCors(response: ServerResponse, options: GatewayOptions): void {
  if (!options.corsOrigin) return;
  response.setHeader('access-control-allow-origin', options.corsOrigin);
  response.setHeader('access-control-allow-headers', 'authorization, content-type');
  response.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
}

function isAuthorized(request: IncomingMessage, options: GatewayOptions): boolean {
  if (!options.bearerToken) return true;
  return request.headers.authorization === `Bearer ${options.bearerToken}`;
}

export function createGatewayServer(runtime: TaskRuntime, sessions = new SessionService(new InMemorySessionStore()), options: GatewayOptions = {}): Server {
  const adapters = { ...defaultChannelAdapters(), ...options.channels?.adapters };
  const deduplicator = new MessageDeduplicator();
  const sessionIds = options.channels?.sessionIds ?? new Map<string, string>();
  return createServer(async (request, response) => {
    setCors(response, options);
    if (request.method === 'OPTIONS') {
      response.writeHead(204);
      response.end();
      return;
    }
    if (!isAuthorized(request, options) && request.url !== '/health') {
      sendJson(response, 401, { error: 'Bearer token required' });
      return;
    }
    try {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      const { pathname } = url;
      if (request.method === 'GET' && pathname === '/health') {
        sendJson(response, 200, { status: 'ok', service: 'agentcorps-gateway', version: '0.1.0' });
        return;
      }
      if (request.method === 'GET' && pathname === '/channels') {
        sendJson(response, 200, { channels: channelKinds.map((kind) => ({ kind, configured: Boolean(options.channels?.adapters?.[kind] || options.channels?.webhookSecrets?.[kind]) })) });
        return;
      }
      const channelPath = /^\/channels\/([^/]+)\/(webhook|outbound)$/.exec(pathname);
      if (request.method === 'POST' && channelPath) {
        const kind = channelKindFrom(pathname);
        if (!kind) return sendJson(response, 404, { error: 'Unknown channel' });
        const adapter = adapters[kind];
        const rawBody = await readBody(request);
        const secret = options.channels?.webhookSecrets?.[kind];
        if (secret && channelPath[2] === 'webhook') {
          const signatureHeader = request.headers['x-agentcorps-signature'] ?? request.headers['x-signature'];
          const signature = Array.isArray(signatureHeader) ? signatureHeader[0] : signatureHeader;
          if (!signature || !verifyHmacSha256(rawBody.toString('utf8'), signature, secret)) {
            return sendJson(response, 401, { error: 'Invalid channel signature' });
          }
        }
        const body = parseJsonBody(rawBody);
        if (channelPath[2] === 'outbound') {
          const outbound: OutboundMessage = {
            channel: kind,
            externalConversationId: String(body.externalConversationId ?? body.conversationId ?? ''),
            text: String(body.text ?? ''),
            ...(body.replyToExternalMessageId ? { replyToExternalMessageId: String(body.replyToExternalMessageId) } : {}),
          };
          if (!outbound.externalConversationId || !outbound.text.trim()) throw new Error('Outbound channel message requires conversation and text');
          return sendJson(response, 200, { channel: kind, payload: adapter.formatOutbound(outbound) });
        }
        const inbound = adapter.parseInbound(body);
        if (!deduplicator.accept(inbound)) return sendJson(response, 200, { accepted: false, duplicate: true, externalMessageId: inbound.externalMessageId });
        const key = channelSessionKey(inbound);
        let session = sessions.get(sessionIds.get(key) ?? '');
        if (!session || session.archivedAt) {
          session = sessions.create({
            workspaceId: options.channels?.workspaceId ?? `channel:${kind}`,
            title: `${kind}:${inbound.externalConversationId}`,
            mode: options.channels?.defaultMode ?? 'work',
          });
          sessionIds.set(key, session.id);
        }
        const message = sessions.appendMessage({ sessionId: session.id, role: 'user', content: inbound.text });
        const task = runtime.createTask({
          workspaceId: session.workspaceId,
          sessionId: session.id,
          title: `Channel message: ${inbound.text.slice(0, 80)}`,
          objective: inbound.text,
          mode: session.mode,
        });
        return sendJson(response, 202, { accepted: true, channel: kind, externalMessageId: inbound.externalMessageId, session, message, task });
      }
      if (request.method === 'GET' && pathname === '/sessions') {
        sendJson(response, 200, { sessions: sessions.list() });
        return;
      }
      if (request.method === 'POST' && pathname === '/sessions') {
        const body = await readJson(request);
        const session = sessions.create({ workspaceId: String(body.workspaceId ?? 'local-workspace'), title: String(body.title ?? ''), mode: body.mode === 'work' ? 'work' : 'code' });
        sendJson(response, 201, { session });
        return;
      }
      const sessionId = sessionIdFrom(pathname);
      const sessionAction = pathname.split('/')[3];
      if (sessionId && request.method === 'GET' && !sessionAction) {
        const session = sessions.get(sessionId);
        if (!session) return sendJson(response, 404, { error: 'Session not found' });
        return sendJson(response, 200, { session, messages: sessions.messages(sessionId) });
      }
      if (sessionId && request.method === 'POST' && sessionAction === 'messages') {
        const body = await readJson(request);
        const message = sessions.appendMessage({ sessionId, role: messageRole(body.role), content: String(body.content ?? ''), ...(body.agentId ? { agentId: String(body.agentId) } : {}), ...(body.taskId ? { taskId: String(body.taskId) } : {}) });
        return sendJson(response, 201, { message });
      }
      if (sessionId && request.method === 'POST' && sessionAction === 'archive') return sendJson(response, 200, { session: sessions.archive(sessionId) });
      if (request.method === 'GET' && pathname === '/tasks') {
        sendJson(response, 200, { tasks: runtime.listTasks() });
        return;
      }
      if (request.method === 'GET' && pathname === '/events') {
        response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive' });
        response.write(`event: ready\\ndata: ${JSON.stringify({ service: 'agentcorps-gateway' })}\\n\\n`);
        const unsubscribe = runtime.store.subscribe((event) => response.write(`event: ${event.type}\\ndata: ${JSON.stringify(event)}\\n\\n`));
        request.on('close', unsubscribe);
        return;
      }
      if (request.method === 'POST' && pathname === '/tasks') {
        const body = await readJson(request);
        const task = runtime.createTask({
          workspaceId: String(body.workspaceId ?? 'local-workspace'),
          sessionId: String(body.sessionId ?? 'local-session'),
          title: String(body.title ?? ''),
          objective: String(body.objective ?? ''),
          mode: body.mode === 'work' ? 'work' : 'code',
        });
        sendJson(response, 201, { task });
        return;
      }
      const taskId = taskIdFrom(pathname);
      const action = pathname.split('/')[3];
      if (taskId && request.method === 'GET' && !action) {
        const task = runtime.getTask(taskId);
        if (!task) return sendJson(response, 404, { error: 'Task not found' });
        return sendJson(response, 200, { task, events: runtime.store.list(taskId) });
      }
      if (taskId && request.method === 'POST' && action === 'run') {
        const task = runtime.getTask(taskId);
        if (!task) return sendJson(response, 404, { error: 'Task not found' });
        void runtime.runTask(taskId, new MockAgent());
        return sendJson(response, 202, { taskId, status: 'accepted' });
      }
      if (taskId && request.method === 'POST' && action === 'cancel') return sendJson(response, 200, { task: runtime.cancelTask(taskId) });
      if (taskId && request.method === 'POST' && action === 'retry') return sendJson(response, 200, { task: runtime.retryTask(taskId) });
      sendJson(response, 404, { error: 'Route not found' });
    } catch (error) {
      sendJson(response, 400, { error: error instanceof Error ? error.message : String(error) });
    }
  });
}

export function listenGateway(runtime: TaskRuntime, port = 43210, host = '127.0.0.1', sessions = new SessionService(new InMemorySessionStore()), options: GatewayOptions = {}): Promise<Server> {
  const server = createGatewayServer(runtime, sessions, options);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.removeListener('error', reject);
      resolve(server);
    });
  });
}
