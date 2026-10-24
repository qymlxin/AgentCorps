import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { TaskId } from '@agentcorps/domain';
import { InMemoryMemoryStore, MemoryService, type MemoryRecord, type MemorySensitivity, type MemoryScope } from '@agentcorps/memory';
import { ApprovalService, ExternalIdentityResolver, InMemoryApprovalStore, InMemoryAuditLog, PolicyEngine, type SecurityCapability, type SecurityContext, type ToolRequest } from '@agentcorps/security';
import { InMemorySessionStore, SessionService, type MessageRole, type SessionMode } from '@agentcorps/session';
import { MockAgent, type AgentAdapter, type TaskRuntime } from '@agentcorps/runtime';
import {
  FeishuEventAdapter,
  GenericWebhookAdapter,
  InMemoryChannelStateStore,
  DingTalkRobotAdapter,
  WecomMessageAdapter,
  parseWecomEncryptedInbound,
  parseWecomXmlEnvelope,
  verifyDingTalkCallbackSignature,
  verifyFeishuEventSignature,
  verifyWecomCallbackSignature,
  verifyHmacSha256,
  formatWecomPassiveReply,
  type ChannelAdapter,
  type ChannelConnector,
  type ChannelKind,
  type ChannelStateStore,
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

function memoryIdFrom(pathname: string): string | undefined {
  const match = /^\/memory\/([^/]+)$/.exec(pathname);
  return match?.[1];
}

function memoryScope(value: unknown): MemoryScope {
  if (value === 'global' || value === 'workspace' || value === 'session') return value;
  throw new Error('Memory scope must be global, workspace, or session');
}

function memorySensitivity(value: unknown): MemorySensitivity {
  if (value === undefined || value === 'public' || value === 'private' || value === 'secret') return value ?? 'private';
  throw new Error('Memory sensitivity must be public, private, or secret');
}

function memorySource(value: unknown): MemoryRecord['source'] {
  if (value === 'user' || value === 'agent' || value === 'system') return value;
  throw new Error('Memory source must be user, agent, or system');
}

function approvalRoute(pathname: string): { id?: string; action?: 'approve' | 'deny' | 'consume' } | undefined {
  if (pathname === '/approvals') return {};
  const match = /^\/approvals\/([^/]+)(?:\/(approve|deny|consume))?$/.exec(pathname);
  if (!match || !match[1]) return undefined;
  return { id: match[1], ...(match[2] ? { action: match[2] as 'approve' | 'deny' | 'consume' } : {}) };
}

function securityCapability(value: unknown): SecurityCapability {
  if (value === 'fs.read' || value === 'fs.write' || value === 'process.exec' || value === 'network.connect' || value === 'secret.read') return value;
  throw new Error('Unknown security capability');
}

function messageRole(value: unknown): MessageRole {
  if (value === 'user' || value === 'agent' || value === 'system' || value === 'tool') return value;
  throw new Error('Message role must be user, agent, system, or tool');
}

export interface ChannelGatewayOptions {
  readonly adapters?: Partial<Record<ChannelKind, ChannelAdapter>>;
  readonly connectors?: Partial<Record<ChannelKind, ChannelConnector>>;
  readonly webhookSecrets?: Partial<Record<ChannelKind, string>>;
  readonly webhookEncryptionKeys?: Partial<Record<ChannelKind, string>>;
  readonly webhookReceiveIds?: Partial<Record<ChannelKind, string>>;
  readonly defaultMode?: SessionMode;
  readonly workspaceId?: string;
  readonly sessionIds?: Map<string, string>;
  readonly stateStore?: ChannelStateStore;
  /** When configured, every inbound external user must be explicitly mapped to a local device. */
  readonly identityResolver?: ExternalIdentityResolver;
}

export interface MemoryGatewayOptions {
  readonly service?: MemoryService;
  readonly allowSensitiveSearch?: boolean;
}

export interface SecurityGatewayOptions {
  readonly context: SecurityContext;
  readonly engine?: PolicyEngine;
  readonly approvals?: ApprovalService;
  readonly allowApprovalDecisions?: boolean;
}

export interface GatewayOptions {
  readonly bearerToken?: string;
  readonly tokenVerifier?: (token: string) => boolean | Promise<boolean>;
  readonly corsOrigin?: string;
  readonly channels?: ChannelGatewayOptions;
  readonly memory?: MemoryGatewayOptions;
  readonly security?: SecurityGatewayOptions;
  readonly agentFactory?: (task: import('@agentcorps/domain').Task) => AgentAdapter;
}

const channelKinds: readonly ChannelKind[] = ['feishu', 'dingtalk', 'wecom', 'custom'];

function channelKindFrom(pathname: string): ChannelKind | undefined {
  const match = /^\/channels\/([^/]+)\/(webhook|outbound)$/.exec(pathname);
  if (!match || !channelKinds.includes(match[1] as ChannelKind)) return undefined;
  return match[1] as ChannelKind;
}

function defaultChannelAdapters(): Record<ChannelKind, ChannelAdapter> {
  return {
    feishu: new FeishuEventAdapter(),
    dingtalk: new DingTalkRobotAdapter(),
    wecom: new WecomMessageAdapter(),
    custom: new GenericWebhookAdapter('custom'),
  };
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

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

async function isAuthorized(request: IncomingMessage, options: GatewayOptions): Promise<boolean> {
  const authorization = request.headers.authorization;
  if (!authorization?.startsWith('Bearer ')) return !options.bearerToken && !options.tokenVerifier;
  const token = authorization.slice('Bearer '.length);
  if (options.bearerToken && token === options.bearerToken) return true;
  if (!options.tokenVerifier) return false;
  try { return await options.tokenVerifier(token); } catch { return false; }
}

export function createGatewayServer(runtime: TaskRuntime, sessions = new SessionService(new InMemorySessionStore()), options: GatewayOptions = {}): Server {
  const adapters = { ...defaultChannelAdapters(), ...options.channels?.adapters };
  const stateStore = options.channels?.stateStore ?? new InMemoryChannelStateStore();
  const sessionIds = options.channels?.sessionIds ?? new Map<string, string>();
  const memories = options.memory?.service ?? new MemoryService(new InMemoryMemoryStore());
  const policyEngine = options.security?.engine ?? new PolicyEngine(new InMemoryAuditLog());
  const approvals = options.security?.approvals ?? new ApprovalService(new InMemoryApprovalStore());
  return createServer(async (request, response) => {
    setCors(response, options);
    if (request.method === 'OPTIONS') {
      response.writeHead(204);
      response.end();
      return;
    }
    if (!await isAuthorized(request, options) && request.url !== '/health') {
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
        const rawText = rawBody.toString('utf8');
        const wecomTimestamp = url.searchParams.get('timestamp');
        const wecomNonce = url.searchParams.get('nonce');
        const secret = options.channels?.webhookSecrets?.[kind];
        if (secret && channelPath[2] === 'webhook') {
          const larkSignature = headerValue(request.headers['x-lark-signature']);
          const larkTimestamp = headerValue(request.headers['x-lark-request-timestamp']);
          const larkNonce = headerValue(request.headers['x-lark-request-nonce']);
          const dingTimestamp = url.searchParams.get('timestamp');
          const dingSignature = url.searchParams.get('sign');
          const wecomSignature = url.searchParams.get('msg_signature');
          const wecomEncrypted = kind === 'wecom' ? parseWecomXmlEnvelope(rawText).encrypt : undefined;
          const signatureHeader = headerValue(request.headers['x-agentcorps-signature'] ?? request.headers['x-signature']);
          const valid = kind === 'feishu' && larkSignature && larkTimestamp && larkNonce
            ? verifyFeishuEventSignature(rawText, { signature: larkSignature, timestamp: larkTimestamp, nonce: larkNonce }, secret)
            : kind === 'dingtalk' && dingTimestamp && dingSignature
              ? verifyDingTalkCallbackSignature(dingTimestamp, dingSignature, secret)
              : kind === 'wecom' && wecomSignature && wecomTimestamp && wecomNonce && wecomEncrypted
                ? verifyWecomCallbackSignature(secret, wecomTimestamp, wecomNonce, wecomEncrypted, wecomSignature)
                : Boolean(signatureHeader && verifyHmacSha256(rawText, signatureHeader, secret));
          if (!valid) return sendJson(response, 401, { error: 'Invalid channel signature' });
        }
        let body: JsonRecord;
        if (kind === 'wecom' && options.channels?.webhookEncryptionKeys?.[kind]) {
          body = parseWecomEncryptedInbound(rawText, options.channels.webhookEncryptionKeys[kind]!, options.channels.webhookReceiveIds?.[kind]) as JsonRecord;
        } else {
          body = parseJsonBody(rawBody);
        }
        if (kind === 'feishu' && typeof body.challenge === 'string') return sendJson(response, 200, { challenge: body.challenge });
        if (channelPath[2] === 'outbound') {
          const outbound: OutboundMessage = {
            channel: kind,
            externalConversationId: String(body.externalConversationId ?? body.conversationId ?? ''),
            text: String(body.text ?? ''),
            ...(body.replyToExternalMessageId ? { replyToExternalMessageId: String(body.replyToExternalMessageId) } : {}),
          };
          if (!outbound.externalConversationId || !outbound.text.trim()) throw new Error('Outbound channel message requires conversation and text');
          const payload = adapter.formatOutbound(outbound);
          const connector = options.channels?.connectors?.[kind];
          if (connector) {
            const delivered = await connector.send(outbound, payload);
            stateStore.recordDelivery(`${kind}:${outbound.externalConversationId}:${outbound.replyToExternalMessageId ?? outbound.text}`, outbound, delivered);
            return sendJson(response, 202, { channel: kind, delivered, payload });
          }
          return sendJson(response, 200, { channel: kind, payload });
        }
        const inbound = adapter.parseInbound(body);
        const identity = options.channels?.identityResolver?.resolve(inbound.channel, inbound.externalUserId);
        if (options.channels?.identityResolver && !identity) return sendJson(response, 403, { error: 'External user is not mapped to a local device', channel: inbound.channel, externalUserId: inbound.externalUserId });
        if (!stateStore.claimInbound(inbound.channel, inbound.externalMessageId)) return sendJson(response, 200, { accepted: false, duplicate: true, externalMessageId: inbound.externalMessageId });
        const key = channelSessionKey(inbound);
        let session = sessions.get(stateStore.getSessionId(key) ?? sessionIds.get(key) ?? '');
        if (!session || session.archivedAt) {
          session = sessions.create({
            workspaceId: options.channels?.workspaceId ?? `channel:${kind}`,
            title: `${kind}:${inbound.externalConversationId}`,
            mode: options.channels?.defaultMode ?? 'work',
          });
          sessionIds.set(key, session.id);
          stateStore.setSessionId(key, session.id);
        }
        const message = sessions.appendMessage({ sessionId: session.id, role: 'user', content: inbound.text });
        const task = runtime.createTask({
          workspaceId: session.workspaceId,
          sessionId: session.id,
          title: `Channel message: ${inbound.text.slice(0, 80)}`,
          objective: inbound.text,
          mode: session.mode,
        });
        if (kind === 'wecom' && options.channels?.webhookEncryptionKeys?.[kind] && secret) {
          const reply = formatWecomPassiveReply({ toUserName: inbound.externalUserId, fromUserName: String(body.ToUserName ?? body.toUserName ?? 'agentcorps'), content: '已收到，任务已进入处理队列。' }, options.channels.webhookEncryptionKeys[kind]!, secret, wecomNonce ?? 'agentcorps', wecomTimestamp ?? String(Math.floor(Date.now() / 1000)));
          response.writeHead(200, { 'content-type': 'application/xml; charset=utf-8', 'content-length': Buffer.byteLength(reply) });
          response.end(reply);
          return;
        }
        return sendJson(response, 202, { accepted: true, channel: kind, externalMessageId: inbound.externalMessageId, ...(identity ? { identity: { deviceId: identity.deviceId, roles: identity.roles } } : {}), session, message, task });
      }
      const approval = approvalRoute(pathname);
      if (approval) {
        if (!options.security) return sendJson(response, 503, { error: 'Approval routes require an explicit security context' });
        if (request.method === 'GET' && pathname === '/approvals') return sendJson(response, 200, { approvals: approvals.list() });
        if (request.method === 'GET' && approval.id && !approval.action) {
          const record = approvals.get(approval.id);
          return record ? sendJson(response, 200, { approval: record }) : sendJson(response, 404, { error: 'Approval not found' });
        }
        if (request.method === 'POST' && pathname === '/approvals') {
          const body = await readJson(request);
          const toolRequest: ToolRequest = {
            requestId: String(body.requestId ?? `gateway-request-${crypto.randomUUID()}`),
            taskId: String(body.taskId ?? ''),
            capability: securityCapability(body.capability),
            ...(body.path ? { path: String(body.path) } : {}),
            ...(body.command ? { command: String(body.command) } : {}),
            ...(body.host ? { host: String(body.host) } : {}),
          };
          if (!toolRequest.taskId) throw new Error('Approval request requires taskId');
          const policy = policyEngine.evaluate(toolRequest, options.security.context);
          if (policy.decision === 'allow') return sendJson(response, 200, { decision: policy.decision, policy });
          if (policy.decision === 'deny') return sendJson(response, 403, { decision: policy.decision, policy });
          const record = approvals.create(toolRequest, policy, body.ttlMs === undefined ? undefined : Number(body.ttlMs));
          return sendJson(response, 202, { decision: policy.decision, policy, approval: record });
        }
        if (request.method === 'POST' && approval.id && approval.action) {
          if (approval.action !== 'consume' && options.security.allowApprovalDecisions === false) return sendJson(response, 403, { error: 'Approval decisions are disabled' });
          if (approval.action === 'consume') {
            const consumed = approvals.consume(approval.id);
            return consumed ? sendJson(response, 200, { approval: consumed }) : sendJson(response, 409, { error: 'Approval is not approved or has expired' });
          }
          const body = await readJson(request);
          const decidedBy = String(body.decidedBy ?? '');
          const decisionReason = body.reason ? String(body.reason) : undefined;
          const decided = approval.action === 'approve' ? approvals.approve(approval.id, decidedBy, decisionReason) : approvals.deny(approval.id, decidedBy, decisionReason);
          return sendJson(response, 200, { approval: decided });
        }
        return sendJson(response, 404, { error: 'Approval route not found' });
      }
      const memoryId = memoryIdFrom(pathname);
      if (request.method === 'GET' && pathname === '/memory') {
        const query = url.searchParams.get('query') ?? '';
        if (!query.trim()) return sendJson(response, 400, { error: 'Memory query is required' });
        const includeSensitive = url.searchParams.get('includeSensitive') === 'true';
        if (includeSensitive && !options.memory?.allowSensitiveSearch) return sendJson(response, 403, { error: 'Sensitive memory search is disabled' });
        const limitValue = Number(url.searchParams.get('limit') ?? '10');
        const limit = Number.isInteger(limitValue) && limitValue > 0 && limitValue <= 100 ? limitValue : 10;
        const found = memories.search(query, { ...(url.searchParams.get('workspaceId') ? { workspaceId: url.searchParams.get('workspaceId')! } : {}), ...(url.searchParams.get('sessionId') ? { sessionId: url.searchParams.get('sessionId')! } : {}), includeSensitive }, limit);
        return sendJson(response, 200, { memories: found });
      }
      if (request.method === 'POST' && pathname === '/memory') {
        const body = await readJson(request);
        const record = memories.save({
          scope: memoryScope(body.scope),
          ...(body.workspaceId ? { workspaceId: String(body.workspaceId) } : {}),
          ...(body.sessionId ? { sessionId: String(body.sessionId) } : {}),
          content: String(body.content ?? ''),
          source: memorySource(body.source ?? 'user'),
          sensitivity: memorySensitivity(body.sensitivity),
          ...(body.sourceEventId ? { sourceEventId: String(body.sourceEventId) } : {}),
          ...(body.confidence !== undefined ? { confidence: Number(body.confidence) } : {}),
          ...(body.expiresAt ? { expiresAt: String(body.expiresAt) } : {}),
        });
        return sendJson(response, 201, { memory: record });
      }
      if (request.method === 'DELETE' && memoryId) {
        const deleted = memories.delete(memoryId);
        if (!deleted) return sendJson(response, 404, { error: 'Memory not found' });
        return sendJson(response, 200, { memory: deleted });
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
        response.write(`event: ready\ndata: ${JSON.stringify({ service: 'agentcorps-gateway' })}\n\n`);
        const unsubscribe = runtime.store.subscribe((event) => response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`));
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
        void runtime.runTask(taskId, options.agentFactory?.(task) ?? new MockAgent());
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
