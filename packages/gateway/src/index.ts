import { createHash } from 'node:crypto';
import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import type { TaskId } from '@agentcorps/domain';
import { InMemoryMemoryStore, MemoryService, type MemoryRecord, type MemorySensitivity, type MemoryScope } from '@agentcorps/memory';
import { ApprovalService, ExternalIdentityResolver, InMemoryApprovalStore, InMemoryAuditLog, isWithin, PolicyEngine, type SecurityCapability, type SecurityContext, type ToolRequest } from '@agentcorps/security';
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

import { gitAdd, gitCommit, gitDiff, gitLog, gitRestoreStaged, gitStatus, type GitGatewayOptions } from './git.js';

const MAX_BODY_BYTES = 1024 * 1024;

type JsonRecord = Record<string, unknown>;

export type GatewayRole = 'read' | 'write' | 'approve' | 'admin';

export interface GatewayPrincipal {
  readonly subject?: string;
  readonly roles: readonly GatewayRole[];
}

export type GatewayTokenVerification = boolean | GatewayPrincipal;

function principalFromVerification(value: GatewayTokenVerification): GatewayPrincipal | undefined {
  if (value === false) return undefined;
  if (value === true) return { roles: ['admin'] };
  return value.roles.length ? value : undefined;
}

function hasRole(principal: GatewayPrincipal, role: GatewayRole): boolean {
  return principal.roles.includes('admin') || principal.roles.includes(role);
}

function requiredRole(method: string, pathname: string): GatewayRole {
  if (method === 'GET' || method === 'HEAD') return 'read';
  if (/^\/approvals\/[^/]+\/(approve|deny|consume)$/.test(pathname)) return 'approve';
  return 'write';
}

function sendSse(response: ServerResponse, event: { id?: string; type: string; payload: unknown }): void {
  response.write(`event: ${event.type}\ndata: ${JSON.stringify(event.payload)}\n${event.id ? `id: ${event.id}\n` : ''}\n`);
}

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

export interface FileGatewayOptions {
  /** Absolute or relative local directory exposed as the read-only browser root. */
  readonly root: string;
  readonly maxEntries?: number;
  readonly maxReadBytes?: number;
}

export interface SecurityGatewayOptions {
  readonly context: SecurityContext;
  readonly engine?: PolicyEngine;
  readonly approvals?: ApprovalService;
  readonly allowApprovalDecisions?: boolean;
}

export interface GatewayOptions {
  readonly bearerToken?: string;
  /** Returns true for a full-access principal, or a scoped principal for remote read-only clients. */
  readonly tokenVerifier?: (token: string) => GatewayTokenVerification | Promise<GatewayTokenVerification>;
  readonly corsOrigin?: string;
  readonly channels?: ChannelGatewayOptions;
  readonly memory?: MemoryGatewayOptions;
  readonly files?: FileGatewayOptions;
  readonly git?: GitGatewayOptions;
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

function replayStart<T extends { id: string }>(history: readonly T[], lastEventId: string | undefined): number {
  if (!lastEventId) return 0;
  const index = history.findIndex((event) => event.id === lastEventId);
  return index < 0 ? 0 : index + 1;
}

async function authenticate(request: IncomingMessage, options: GatewayOptions, tokenOverride?: string): Promise<GatewayPrincipal | undefined> {
  const authorization = request.headers.authorization;
  const token = tokenOverride ?? (authorization?.startsWith('Bearer ') ? authorization.slice('Bearer '.length) : undefined);
  if (!token) return !options.bearerToken && !options.tokenVerifier ? { roles: ['admin'] } : undefined;
  if (options.bearerToken && token === options.bearerToken) return { roles: ['admin'] };
  if (!options.tokenVerifier) return undefined;
  try { return principalFromVerification(await options.tokenVerifier(token)); } catch { return undefined; }
}

function bearerFromWebSocket(request: IncomingMessage): string | undefined {
  const authorization = request.headers.authorization;
  if (authorization?.startsWith('Bearer ')) return authorization.slice('Bearer '.length);
  try {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const queryToken = url.searchParams.get('access_token');
    if (queryToken) return queryToken;
  } catch { /* malformed upgrade URLs are rejected by the caller */ }
  const protocols = headerValue(request.headers['sec-websocket-protocol'])?.split(',').map((value) => value.trim()) ?? [];
  const bearer = protocols.find((value) => value.startsWith('bearer.'));
  return bearer ? Buffer.from(bearer.slice('bearer.'.length), 'base64url').toString('utf8') : undefined;
}

function websocketFrame(value: string | Buffer, opcode = 0x1): Buffer {
  const payload = Buffer.isBuffer(value) ? value : Buffer.from(value);
  const header = payload.byteLength < 126 ? Buffer.from([0x80 | opcode, payload.byteLength])
    : payload.byteLength <= 0xffff ? Buffer.from([0x80 | opcode, 126, payload.byteLength >> 8, payload.byteLength & 0xff])
      : Buffer.concat([Buffer.from([0x80 | opcode, 127]), Buffer.from([0, 0, 0, 0, payload.byteLength >>> 24, (payload.byteLength >>> 16) & 0xff, (payload.byteLength >>> 8) & 0xff, payload.byteLength & 0xff])]);
  return Buffer.concat([header, payload]);
}

function attachWebSocket(server: Server, runtime: TaskRuntime, options: GatewayOptions): void {
  const clients = new Set<{ socket: Duplex; buffer: Buffer; unsubscribe: () => void }>();
  server.on('upgrade', async (request, socket, head) => {
    let url: URL;
    try { url = new URL(request.url ?? '/', 'http://127.0.0.1'); } catch { socket.destroy(); return; }
    if (url.pathname !== '/ws') { socket.destroy(); return; }
    const principal = await authenticate(request, options, bearerFromWebSocket(request));
    if (!principal || !hasRole(principal, 'read')) { socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); socket.destroy(); return; }
    const key = headerValue(request.headers['sec-websocket-key']);
    if (!key) { socket.destroy(); return; }
    const protocols = headerValue(request.headers['sec-websocket-protocol'])?.split(',').map((value) => value.trim()) ?? [];
    const protocol = protocols.includes('agentcorps.v1') ? 'agentcorps.v1' : undefined;
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64')}\r\n${protocol ? `Sec-WebSocket-Protocol: ${protocol}\r\n` : ''}\r\n`);
    const client: { socket: Duplex; buffer: Buffer; unsubscribe: () => void } = { socket, buffer: Buffer.alloc(0), unsubscribe: () => undefined };
    clients.add(client);
    const lastEventId = headerValue(request.headers['last-event-id']) ?? url.searchParams.get('lastEventId') ?? undefined;
    const history = runtime.store.list();
    const start = replayStart(history, lastEventId);
    const replayEvents = history.slice(start);
    const replayedIds = new Set(replayEvents.map((event) => event.id));
    const pending: Array<(typeof history)[number]> = [];
    let replaying = true;
    const send = (payload: unknown): void => { if (!socket.destroyed) socket.write(websocketFrame(JSON.stringify(payload))); };
    client.unsubscribe = runtime.store.subscribe((event) => {
      if (replaying) pending.push(event);
      else send({ type: event.type, event });
    });
    setImmediate(() => {
      send({ type: 'ready', service: 'agentcorps-gateway' });
      for (const event of replayEvents) send({ type: event.type, event });
      replaying = false;
      for (const event of pending) if (!replayedIds.has(event.id)) send({ type: event.type, event });
    });
    const close = (): void => { client.unsubscribe(); clients.delete(client); if (!socket.destroyed) socket.end(); };
    socket.on('data', (chunk: Buffer) => {
      client.buffer = Buffer.concat([client.buffer, chunk]);
      while (client.buffer.byteLength >= 2) {
        const first = client.buffer[0]!; const second = client.buffer[1]!;
        let length = second & 0x7f; let offset = 2;
        if (length === 126) { if (client.buffer.byteLength < 4) return; length = client.buffer.readUInt16BE(2); offset = 4; }
        else if (length === 127) { if (client.buffer.byteLength < 10) return; const large = client.buffer.readBigUInt64BE(2); if (large > BigInt(Number.MAX_SAFE_INTEGER)) return close(); length = Number(large); offset = 10; }
        const masked = (second & 0x80) !== 0;
        if (masked) offset += 4;
        if (client.buffer.byteLength < offset + length) return;
        const mask = masked ? client.buffer.subarray(offset - 4, offset) : undefined;
        const payload = Buffer.from(client.buffer.subarray(offset, offset + length));
        client.buffer = client.buffer.subarray(offset + length);
        if (mask) for (let index = 0; index < payload.length; index += 1) payload[index] = payload[index]! ^ mask[index % 4]!;
        const opcode = first & 0x0f;
        if (opcode === 0x8) return close();
        if (opcode === 0x9) socket.write(websocketFrame(payload, 0xA));
      }
    });
    socket.on('error', close);
    socket.on('close', close);
    if (head.length) socket.emit('data', head);
  });
  server.on('close', () => { for (const client of clients) { client.unsubscribe(); client.socket.end(); } clients.clear(); });
}

function normalizeFilePath(value: string | null): string {
  const requested = value ?? '';
  if (requested.includes('\0') || isAbsolute(requested)) throw new Error('File path must be relative to the configured workspace root');
  return requested;
}

async function resolveFilePath(root: string, requested: string | null): Promise<{ root: string; path: string; relativePath: string }> {
  const rootPath = await realpath(resolve(root));
  const candidate = await realpath(join(rootPath, normalizeFilePath(requested)));
  if (!isWithin(rootPath, candidate)) throw new Error('File path is outside the configured workspace root');
  return { root: rootPath, path: candidate, relativePath: relative(rootPath, candidate).split('\\').join('/') };
}

async function listFiles(options: FileGatewayOptions, requested: string | null): Promise<unknown> {
  const target = await resolveFilePath(options.root, requested);
  const directory = await stat(target.path);
  if (!directory.isDirectory()) throw new Error('File path is not a directory');
  const maxEntries = options.maxEntries ?? 500;
  if (!Number.isInteger(maxEntries) || maxEntries < 1 || maxEntries > 5000) throw new Error('Invalid file browser entry limit');
  const entries = await readdir(target.path, { withFileTypes: true });
  const visible = entries.slice(0, maxEntries);
  return {
    root: target.root,
    path: target.relativePath,
    truncated: entries.length > visible.length,
    entries: await Promise.all(visible.map(async (entry) => {
      const entryPath = await realpath(join(target.path, entry.name));
      if (!isWithin(target.root, entryPath)) return undefined;
      const details = await stat(entryPath);
      return { name: entry.name, path: relative(target.root, entryPath).split('\\').join('/'), kind: details.isDirectory() ? 'directory' : 'file', size: details.isFile() ? details.size : undefined, modifiedAt: details.mtime.toISOString() };
    })).then((items) => items.filter(Boolean)),
  };
}

async function readFileContent(options: FileGatewayOptions, requested: string | null): Promise<unknown> {
  const target = await resolveFilePath(options.root, requested);
  const details = await stat(target.path);
  if (!details.isFile()) throw new Error('File path is not a file');
  const maxReadBytes = options.maxReadBytes ?? 512 * 1024;
  if (!Number.isInteger(maxReadBytes) || maxReadBytes < 1 || maxReadBytes > 4 * 1024 * 1024) throw new Error('Invalid file browser read limit');
  if (details.size > maxReadBytes) throw new Error(`File exceeds the ${maxReadBytes}-byte preview limit`);
  return { path: target.relativePath, content: await readFile(target.path, 'utf8'), size: details.size, modifiedAt: details.mtime.toISOString() };
}

interface GitMutationAuthorization { readonly allowed: boolean; readonly status?: number; readonly body?: unknown; }

function gitMutationTaskId(body: JsonRecord, operation: string): string {
  const value = body.taskId === undefined ? `git:${operation}` : String(body.taskId);
  if (!value.trim()) throw new Error('Git mutation requires a taskId');
  return value;
}

function gitMutationCommand(operation: string, value: unknown): string {
  const command = operation === 'restore-staged' ? 'restore --staged' : operation;
  return `git ${command} ${JSON.stringify(value)}`;
}

function authorizeGitMutation(options: GatewayOptions, policyEngine: PolicyEngine, approvals: ApprovalService, operation: string, command: string, body: JsonRecord): GitMutationAuthorization {
  if (!options.git?.allowWrite) return { allowed: false, status: 403, body: { error: 'Git write operations are disabled' } };
  if (options.git.requireApproval !== false && !options.security) return { allowed: false, status: 503, body: { error: 'Git write operations require an explicit security context' } };
  const taskId = gitMutationTaskId(body, operation);
  const approvalId = body.approvalId ? String(body.approvalId) : undefined;
  if (approvalId) {
    const approval = approvals.get(approvalId);
    if (!approval || approval.status !== 'approved' || approval.request.taskId !== taskId || approval.request.command !== command) return { allowed: false, status: 409, body: { error: 'Git approval is missing, expired, or does not match this operation' } };
    return approvals.consume(approvalId) ? { allowed: true } : { allowed: false, status: 409, body: { error: 'Git approval could not be consumed' } };
  }
  if (options.git.requireApproval === false) return { allowed: true };
  const request: ToolRequest = { requestId: `git:${crypto.randomUUID()}`, taskId, capability: 'process.exec', command };
  const policy = policyEngine.evaluate(request, options.security!.context);
  if (policy.decision === 'deny') return { allowed: false, status: 403, body: { decision: policy.decision, policy } };
  if (policy.decision === 'allow') return { allowed: true };
  return { allowed: false, status: 202, body: { decision: policy.decision, policy, approval: approvals.create(request, policy) } };
}

export function createGatewayServer(runtime: TaskRuntime, sessions = new SessionService(new InMemorySessionStore()), options: GatewayOptions = {}): Server {
  const adapters = { ...defaultChannelAdapters(), ...options.channels?.adapters };
  const stateStore = options.channels?.stateStore ?? new InMemoryChannelStateStore();
  const sessionIds = options.channels?.sessionIds ?? new Map<string, string>();
  const memories = options.memory?.service ?? new MemoryService(new InMemoryMemoryStore());
  const policyEngine = options.security?.engine ?? new PolicyEngine(new InMemoryAuditLog());
  const approvals = options.security?.approvals ?? new ApprovalService(new InMemoryApprovalStore());
  const server = createServer(async (request, response) => {
    setCors(response, options);
    if (request.method === 'OPTIONS') {
      response.writeHead(204);
      response.end();
      return;
    }
    try {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      const { pathname } = url;
      if (request.method === 'GET' && pathname === '/health') {
        sendJson(response, 200, { status: 'ok', service: 'agentcorps-gateway', version: '0.1.0' });
        return;
      }
      const principal = await authenticate(request, options);
      if (!principal) {
        sendJson(response, 401, { error: 'Bearer token required' });
        return;
      }
      if (!hasRole(principal, requiredRole(request.method ?? 'GET', pathname))) {
        sendJson(response, 403, { error: 'Insufficient gateway role' });
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
      if (options.git && request.method === 'GET' && pathname === '/git/status') return sendJson(response, 200, await gitStatus(options.git));
      if (options.git && request.method === 'GET' && pathname === '/git/log') return sendJson(response, 200, { commits: await gitLog(options.git, Number(url.searchParams.get('limit') ?? '30')) });
      if (options.git && request.method === 'GET' && pathname === '/git/diff') return sendJson(response, 200, await gitDiff(options.git, url.searchParams.get('path') ?? undefined));
      if (options.git && request.method === 'POST' && (pathname === '/git/stage' || pathname === '/git/unstage' || pathname === '/git/commit')) {
        const body = await readJson(request);
        if (pathname === '/git/commit' && typeof body.message !== 'string') throw new Error('Git commit requires a message');
        const paths = body.paths === undefined ? [] : Array.isArray(body.paths) ? body.paths.map(String) : (() => { throw new Error('Git paths must be an array'); })();
        const operation = pathname === '/git/stage' ? 'add' : pathname === '/git/unstage' ? 'restore-staged' : 'commit';
        const operationValue = pathname === '/git/commit' ? String(body.message) : paths;
        const authorization = authorizeGitMutation(options, policyEngine, approvals, operation, gitMutationCommand(operation, operationValue), body);
        if (!authorization.allowed) return sendJson(response, authorization.status ?? 409, authorization.body ?? { error: 'Git operation was not authorized' });
        if (pathname === '/git/stage') return sendJson(response, 200, await gitAdd(options.git, paths));
        if (pathname === '/git/unstage') return sendJson(response, 200, await gitRestoreStaged(options.git, paths));
        return sendJson(response, 200, await gitCommit(options.git, String(body.message)));
      }
      if (options.files && request.method === 'GET' && pathname === '/files') {
        return sendJson(response, 200, await listFiles(options.files, url.searchParams.get('path')));
      }
      if (options.files && request.method === 'GET' && pathname === '/files/content') {
        return sendJson(response, 200, await readFileContent(options.files, url.searchParams.get('path')));
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
        sendSse(response, { type: 'ready', payload: { service: 'agentcorps-gateway' } });
        const lastEventId = headerValue(request.headers['last-event-id']) ?? url.searchParams.get('lastEventId') ?? undefined;
        const history = runtime.store.list();
        const start = replayStart(history, lastEventId);
        const replayEvents = history.slice(start);
        const replayedIds = new Set(replayEvents.map((event) => event.id));
        const pending: Array<(typeof history)[number]> = [];
        let replaying = true;
        const unsubscribe = runtime.store.subscribe((event) => {
          if (replaying) pending.push(event);
          else sendSse(response, { id: event.id, type: event.type, payload: event });
        });
        sendSse(response, { type: 'ready', payload: { service: 'agentcorps-gateway' } });
        for (const event of replayEvents) sendSse(response, { id: event.id, type: event.type, payload: event });
        replaying = false;
        for (const event of pending) if (!replayedIds.has(event.id)) sendSse(response, { id: event.id, type: event.type, payload: event });
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
  attachWebSocket(server, runtime, options);
  return server;
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

export { gitAdd, gitCommit, gitDiff, gitLog, gitRestoreStaged, gitStatus } from './git.js';
export type { GitCommit, GitGatewayOptions, GitStatus, GitStatusEntry } from './git.js';
