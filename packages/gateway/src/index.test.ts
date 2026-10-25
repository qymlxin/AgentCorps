import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { listenGateway } from './index.js';
import { TaskRuntime } from '@agentcorps/runtime';
import { signHmacSha256, encryptWecomMessage, signWecomCallback, parseWecomEncryptedInbound } from '@agentcorps/channels';
import { createDefaultProfile, DevicePairingService, DeviceTokenVerifier, ExternalIdentityResolver, InMemoryDeviceIdentityStore, InMemoryExternalIdentityBindingStore, SignedAccessTokenService } from '@agentcorps/security';

const gitAsync = promisify(execFile);

describe('gateway', () => {
  it('exposes health, task creation, and task event history', async () => {
    const server = await listenGateway(new TaskRuntime(), 0);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected TCP address');
    const base = `http://127.0.0.1:${address.port}`;
    try {
      expect((await fetch(`${base}/health`)).status).toBe(200);
      const sessionResponse = await fetch(`${base}/sessions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'API session', workspaceId: 'ws' }) });
      expect(sessionResponse.status).toBe(201);
      const session = await sessionResponse.json() as { session: { id: string } };
      const messageResponse = await fetch(`${base}/sessions/${session.session.id}/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ role: 'user', content: 'hello from API' }) });
      expect(messageResponse.status).toBe(201);
      const sessionDetail = await fetch(`${base}/sessions/${session.session.id}`);
      expect((await sessionDetail.json() as { messages: unknown[] }).messages).toHaveLength(1);
      const created = await fetch(`${base}/tasks`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'API task', objective: 'test API' }) });
      expect(created.status).toBe(201);
      const body = await created.json() as { task: { id: string } };
      const detail = await fetch(`${base}/tasks/${body.task.id}`);
      expect(detail.status).toBe(200);
      expect((await detail.json() as { events: unknown[] }).events).toHaveLength(1);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
  it('streams valid SSE framing for ready and task events', async () => {
    const server = await listenGateway(new TaskRuntime(), 0);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected TCP address');
    const base = `http://127.0.0.1:${address.port}`;
    const stream = await fetch(`${base}/events`);
    const reader = stream.body?.getReader();
    if (!reader) throw new Error('Expected SSE response body');
    const decoder = new TextDecoder();
    try {
      const ready = await reader.read();
      expect(decoder.decode(ready.value)).toContain('event: ready\ndata:');
      const created = await fetch(`${base}/tasks`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'SSE task', objective: 'stream this event' }) });
      expect(created.status).toBe(201);
      const event = await reader.read();
      const text = decoder.decode(event.value);
      expect(text).toContain('event: task.created\ndata:');
      expect(text).toContain('stream this event');
    } finally {
      await reader.cancel();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('requires explicit external identity mapping before creating channel tasks', async () => {
    const resolver = new ExternalIdentityResolver(new InMemoryExternalIdentityBindingStore(), () => '2026-10-24T00:00:00.000Z');
    const secret = 'channel-secret';
    const server = await listenGateway(new TaskRuntime(), 0, '127.0.0.1', undefined, { channels: { webhookSecrets: { feishu: secret }, identityResolver: resolver } });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected TCP address');
    const base = `http://127.0.0.1:${address.port}`;
    const payload = JSON.stringify({ header: { event_id: 'identity-evt' }, event: { message: { message_id: 'identity-msg', chat_id: 'identity-chat', message_type: 'text', content: JSON.stringify({ text: 'hello' }) }, sender: { sender_id: { open_id: 'external-user' } } } });
    const headers = { 'content-type': 'application/json', 'x-agentcorps-signature': signHmacSha256(payload, secret) };
    try {
      expect((await fetch(`${base}/channels/feishu/webhook`, { method: 'POST', headers, body: payload })).status).toBe(403);
      resolver.bind('feishu', 'external-user', 'device-1', ['user']);
      expect((await fetch(`${base}/channels/feishu/webhook`, { method: 'POST', headers, body: payload })).status).toBe(202);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('bridges signed channel webhooks into shared sessions and tasks', async () => {
    const secret = 'channel-secret';
    const server = await listenGateway(new TaskRuntime(), 0, '127.0.0.1', undefined, { channels: { webhookSecrets: { feishu: secret } } });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected TCP address');
    const base = `http://127.0.0.1:${address.port}`;
    const payload = JSON.stringify({ header: { event_id: 'evt-1' }, event: { message: { message_id: 'm1', chat_id: 'c1', message_type: 'text', content: JSON.stringify({ text: 'prepare report' }) }, sender: { sender_id: { open_id: 'u1' } } } });
    try {
      const headers = { 'content-type': 'application/json', 'x-agentcorps-signature': signHmacSha256(payload, secret) };
      const first = await fetch(`${base}/channels/feishu/webhook`, { method: 'POST', headers, body: payload });
      expect(first.status).toBe(202);
      const firstBody = await first.json() as { session: { id: string }; task: { sessionId: string } };
      expect(firstBody.task.sessionId).toBe(firstBody.session.id);
      const duplicate = await fetch(`${base}/channels/feishu/webhook`, { method: 'POST', headers, body: payload });
      expect(await duplicate.json()).toMatchObject({ accepted: false, duplicate: true });
      const outbound = await fetch(`${base}/channels/feishu/outbound`, { method: 'POST', headers, body: JSON.stringify({ conversationId: 'c1', text: 'received' }) });
      expect(await outbound.json()).toMatchObject({ payload: { receive_id: 'c1', msg_type: 'text', content: JSON.stringify({ text: 'received' }) } });
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
  it('returns an encrypted WeCom passive reply after accepting a signed callback', async () => {
    const token = 'wecom-token';
    const receiveId = 'corp-1';
    const encodingAesKey = Buffer.alloc(32, 7).toString('base64').replace(/=+$/, '');
    const timestamp = String(Math.floor(Date.now() / 1000));
    const nonce = 'nonce-1';
    const encrypted = encryptWecomMessage('<xml><MsgId><![CDATA[wx-1]]></MsgId><FromUserName><![CDATA[user-1]]></FromUserName><ToUserName><![CDATA[corp-1]]></ToUserName><ChatId><![CDATA[chat-1]]></ChatId><Content><![CDATA[hello]]></Content></xml>', encodingAesKey, receiveId, Buffer.alloc(16, 3));
    const server = await listenGateway(new TaskRuntime(), 0, '127.0.0.1', undefined, { channels: { webhookSecrets: { wecom: token }, webhookEncryptionKeys: { wecom: encodingAesKey }, webhookReceiveIds: { wecom: receiveId } } });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected TCP address');
    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/channels/wecom/webhook?timestamp=${timestamp}&nonce=${nonce}&msg_signature=${signWecomCallback(token, timestamp, nonce, encrypted)}`, { method: 'POST', headers: { 'content-type': 'application/xml' }, body: `<xml><ToUserName><![CDATA[${receiveId}]]></ToUserName><Encrypt><![CDATA[${encrypted}]]></Encrypt></xml>` });
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('application/xml');
      expect(parseWecomEncryptedInbound(await response.text(), encodingAesKey, receiveId)).toMatchObject({ ToUserName: 'user-1', FromUserName: receiveId, Content: '已收到，任务已进入处理队列。' });
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('delivers outbound messages through a configured connector', async () => {
    const deliveries: unknown[] = [];
    const server = await listenGateway(new TaskRuntime(), 0, '127.0.0.1', undefined, { channels: { connectors: { feishu: { send: async (message, payload) => { deliveries.push({ message, payload }); return { statusCode: 200, attempts: 1 }; } } } } });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected TCP address');
    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/channels/feishu/outbound`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ conversationId: 'c1', text: 'delivered' }) });
      expect(response.status).toBe(202);
      expect(await response.json()).toMatchObject({ delivered: { statusCode: 200, attempts: 1 } });
      expect(deliveries).toHaveLength(1);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
  it('persists, searches, and deletes scoped memories through the gateway', async () => {
    const server = await listenGateway(new TaskRuntime(), 0, '127.0.0.1', undefined, { memory: { allowSensitiveSearch: true } });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected TCP address');
    const base = `http://127.0.0.1:${address.port}`;
    try {
      const created = await fetch(`${base}/memory`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ scope: 'workspace', workspaceId: 'ws', content: 'release notes are concise', source: 'user' }) });
      expect(created.status).toBe(201);
      const memory = await created.json() as { memory: { id: string } };
      const search = await fetch(`${base}/memory?query=concise&workspaceId=ws`);
      expect((await search.json() as { memories: unknown[] }).memories).toHaveLength(1);
      expect((await fetch(`${base}/memory/${memory.memory.id}`, { method: 'DELETE' })).status).toBe(200);
      const afterDelete = await fetch(`${base}/memory?query=concise&workspaceId=ws`);
      expect(await afterDelete.json()).toMatchObject({ memories: [] });
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
  it('creates and resolves policy-backed approval requests', async () => {
    const server = await listenGateway(new TaskRuntime(), 0, '127.0.0.1', undefined, { security: { context: { mode: 'code', profile: createDefaultProfile('/workspace', 'S2') } } });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected TCP address');
    const base = `http://127.0.0.1:${address.port}`;
    try {
      const created = await fetch(`${base}/approvals`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ taskId: 'task-approval', capability: 'process.exec', command: 'pnpm test' }) });
      expect(created.status).toBe(202);
      const body = await created.json() as { approval: { id: string; status: string } };
      expect(body.approval.status).toBe('pending');
      const approved = await fetch(`${base}/approvals/${body.approval.id}/approve`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ decidedBy: 'local-user' }) });
      expect((await approved.json() as { approval: { status: string } }).approval.status).toBe('approved');
      const consumed = await fetch(`${base}/approvals/${body.approval.id}/consume`, { method: 'POST' });
      expect((await consumed.json() as { approval: { status: string } }).approval.status).toBe('consumed');
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
  it('supports asynchronous device or OIDC token verification', async () => {
    const server = await listenGateway(new TaskRuntime(), 0, '127.0.0.1', undefined, { tokenVerifier: async (token) => token === 'device-token' });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected TCP address');
    try {
      expect((await fetch(`http://127.0.0.1:${address.port}/tasks`)).status).toBe(401);
      expect((await fetch(`http://127.0.0.1:${address.port}/tasks`, { headers: { authorization: 'Bearer device-token' } })).status).toBe(200);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('rejects a validly signed token after its device is revoked', async () => {
    const store = new InMemoryDeviceIdentityStore();
    const pairing = new DevicePairingService(store);
    const device = pairing.redeem(pairing.create('test-device').code, 'device-test');
    const tokens = new SignedAccessTokenService('12345678901234567890123456789012');
    const verifier = new DeviceTokenVerifier(tokens, store);
    const token = tokens.issue(device, 300);
    const server = await listenGateway(new TaskRuntime(), 0, '127.0.0.1', undefined, { tokenVerifier: async (candidate) => Boolean(verifier.verify(candidate)) });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected TCP address');
    try {
      expect((await fetch(`http://127.0.0.1:${address.port}/tasks`, { headers: { authorization: `Bearer ${token}` } })).status).toBe(200);
      pairing.revoke(device.id);
      expect((await fetch(`http://127.0.0.1:${address.port}/tasks`, { headers: { authorization: `Bearer ${token}` } })).status).toBe(401);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('protects remote-capable routes with a bearer token', async () => {
    const server = await listenGateway(new TaskRuntime(), 0, '127.0.0.1', undefined, { bearerToken: 'secret' });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected TCP address');
    const base = `http://127.0.0.1:${address.port}`;
    try {
      expect((await fetch(`${base}/health`)).status).toBe(200);
      expect((await fetch(`${base}/tasks`)).status).toBe(401);
      expect((await fetch(`${base}/tasks`, { headers: { authorization: 'Bearer secret' } })).status).toBe(200);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('exposes authenticated WebSocket event streaming with replay support', async () => {
    const runtime = new TaskRuntime();
    const existing = runtime.createTask({ workspaceId: 'ws', sessionId: 's', title: 'replay', objective: 'replay me', mode: 'code' });
    const server = await listenGateway(runtime, 0);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected TCP address');
    const ws = new WebSocket(`ws://127.0.0.1:${address.port}/ws`, ['agentcorps.v1']);
    const messages: MessageEvent[] = [];
    const waiters: Array<(event: MessageEvent) => void> = [];
    ws.addEventListener('message', (event) => {
      const waiter = waiters.shift();
      if (waiter) waiter(event);
      else messages.push(event);
    });
    const nextMessage = (): Promise<MessageEvent> => {
      const message = messages.shift();
      return message ? Promise.resolve(message) : new Promise((resolve) => waiters.push(resolve));
    };
    try {
      await new Promise<void>((resolve, reject) => { ws.addEventListener('open', () => resolve()); ws.addEventListener('error', () => reject(new Error('WebSocket failed to open'))); });
      const ready = await nextMessage();
      expect(JSON.parse(String(ready.data))).toMatchObject({ type: 'ready' });
      const replayed = await nextMessage();
      expect(JSON.parse(String(replayed.data))).toMatchObject({ type: 'task.created', event: { aggregateId: existing.id } });
    } finally {
      ws.close();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
  it('enforces scoped read-only principals on mutating routes', async () => {
    const server = await listenGateway(new TaskRuntime(), 0, '127.0.0.1', undefined, { tokenVerifier: async (token) => token === 'reader' ? { roles: ['read'] as const } : false });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected TCP address');
    const base = `http://127.0.0.1:${address.port}`;
    try {
      expect((await fetch(`${base}/tasks`, { headers: { authorization: 'Bearer reader' } })).status).toBe(200);
      expect((await fetch(`${base}/tasks`, { method: 'POST', headers: { authorization: 'Bearer reader', 'content-type': 'application/json' }, body: JSON.stringify({ title: 'blocked', objective: 'blocked' }) })).status).toBe(403);
      expect((await fetch(`${base}/tasks`)).status).toBe(401);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('serves a read-only workspace file browser with path and preview boundaries', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agentcorps-files-'));
    const outside = mkdtempSync(join(tmpdir(), 'agentcorps-files-outside-'));
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src', 'main.ts'), 'export const answer = 42;');
    writeFileSync(join(outside, 'secret.txt'), 'outside');
    const server = await listenGateway(new TaskRuntime(), 0, '127.0.0.1', undefined, { files: { root } });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected TCP address');
    const base = `http://127.0.0.1:${address.port}`;
    try {
      const rootListing = await fetch(`${base}/files`);
      expect(rootListing.status).toBe(200);
      expect(await rootListing.json()).toMatchObject({ path: '', entries: [{ name: 'src', kind: 'directory' }] });
      const nested = await fetch(`${base}/files?path=src`);
      expect(await nested.json()).toMatchObject({ entries: [{ name: 'main.ts', kind: 'file' }] });
      const preview = await fetch(`${base}/files/content?path=src/main.ts`);
      expect(await preview.json()).toMatchObject({ path: 'src/main.ts', content: 'export const answer = 42;' });
      expect((await fetch(`${base}/files?path=../${outside.split('/').pop()}`)).status).toBe(400);
      expect((await fetch(`${base}/files/content?path=src/main.ts%00bad`)).status).toBe(400);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('browses Git state and gates write operations with approvals', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agentcorps-git-'));
    const server = await (async () => {
      await gitAsync('git', ['init', '-q', root]);
      await gitAsync('git', ['-C', root, 'config', 'user.email', 'test@example.com']);
      await gitAsync('git', ['-C', root, 'config', 'user.name', 'AgentCorps Test']);
      writeFileSync(join(root, 'README.md'), 'hello');
      await gitAsync('git', ['-C', root, 'add', 'README.md']);
      await gitAsync('git', ['-C', root, 'commit', '-qm', 'initial']);
      writeFileSync(join(root, 'README.md'), 'changed');
      return listenGateway(new TaskRuntime(), 0, '127.0.0.1', undefined, { git: { root, allowWrite: true }, security: { context: { mode: 'code', profile: createDefaultProfile(root, 'S2') } } });
    })();
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected TCP address');
    const base = `http://127.0.0.1:${address.port}`;
    try {
      const status = await (await fetch(`${base}/git/status`)).json() as { branch: string; entries: Array<{ path: string; worktree: string }> };
      expect(status.branch).toEqual(expect.any(String));
      expect(status.branch.length).toBeGreaterThan(0);
      expect(status.entries).toEqual(expect.arrayContaining([expect.objectContaining({ path: 'README.md', worktree: 'M' })]));
      expect((await fetch(`${base}/git/log?limit=1`)).status).toBe(200);
      const diff = await (await fetch(`${base}/git/diff?path=README.md`)).text();
      expect(diff).toContain('-hello');
      const pending = await fetch(`${base}/git/stage`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ taskId: 'git-task', paths: ['README.md'] }) });
      expect(pending.status).toBe(202);
      const approval = (await pending.json() as { approval: { id: string } }).approval;
      expect((await fetch(`${base}/approvals/${approval.id}/approve`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ decidedBy: 'test-user' }) })).status).toBe(200);
      const staged = await fetch(`${base}/git/stage`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ taskId: 'git-task', paths: ['README.md'], approvalId: approval.id }) });
      expect((await staged.json() as { entries: Array<{ index: string }> }).entries[0]?.index).toBe('M');
      const commitPending = await fetch(`${base}/git/commit`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ taskId: 'git-task', message: 'change README' }) });
      expect(commitPending.status).toBe(202);
      const commitApproval = (await commitPending.json() as { approval: { id: string } }).approval;
      expect((await fetch(`${base}/approvals/${commitApproval.id}/approve`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ decidedBy: 'test-user' }) })).status).toBe(200);
      const committed = await fetch(`${base}/git/commit`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ taskId: 'git-task', message: 'change README', approvalId: commitApproval.id }) });
      expect(committed.status).toBe(200);
      expect((await committed.json() as { hash: string; status: { entries: unknown[] } }).hash).toMatch(/^[0-9a-f]+$/);
      const finalStatus = await (await fetch(`${base}/git/status`)).json() as { entries: unknown[] };
      expect(finalStatus.entries).toEqual([]);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('controls a browser tab through the approval boundary', async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    const transport = {
      async listTabs() { return [{ id: 'tab-1', title: 'Example', url: 'https://example.com', type: 'page' }]; },
      async command(_tabId: string, method: string, params?: Readonly<Record<string, unknown>>) {
        calls.push({ method, params });
        if (method === 'Runtime.evaluate') return { result: { value: JSON.stringify({ title: 'Example', url: 'https://example.com', text: 'hello browser' }) } };
        return { frameId: 'frame-1' };
      },
    };
    const server = await listenGateway(new TaskRuntime(), 0, '127.0.0.1', undefined, { browser: { allowControl: true, transport }, security: { context: { mode: 'code', profile: { ...createDefaultProfile('/workspace', 'S2'), network: 'full', allowedHosts: [] } } } });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected TCP address');
    const base = `http://127.0.0.1:${address.port}`;
    try {
      expect((await fetch(`${base}/browser/tabs`)).status).toBe(200);
      const snapshot = await fetch(`${base}/browser/snapshot?tabId=tab-1`);
      expect(await snapshot.text()).toContain('hello browser');
      const request = { taskId: 'browser-task', tabId: 'tab-1', url: 'https://example.org' };
      const pending = await fetch(`${base}/browser/navigate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request) });
      expect(pending.status).toBe(202);
      const approval = (await pending.json() as { approval: { id: string } }).approval;
      expect((await fetch(`${base}/approvals/${approval.id}/approve`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ decidedBy: 'test-user' }) })).status).toBe(200);
      const navigated = await fetch(`${base}/browser/navigate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...request, approvalId: approval.id }) });
      expect(navigated.status).toBe(200);
      expect(calls.some((call) => call.method === 'Page.navigate')).toBe(true);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('executes terminal commands without a shell after approval and preserves the workspace cwd', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agentcorps-terminal-'));
    const server = await listenGateway(new TaskRuntime(), 0, '127.0.0.1', undefined, { terminal: { root, allowExec: true }, security: { context: { mode: 'code', profile: createDefaultProfile(root, 'S2') } } });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected TCP address');
    const base = `http://127.0.0.1:${address.port}`;
    const request = { taskId: 'terminal-task', command: process.execPath, args: ['-e', 'process.stdout.write(process.cwd())'], cwd: '.' };
    try {
      const pending = await fetch(`${base}/terminal/exec`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request) });
      expect(pending.status).toBe(202);
      const approval = (await pending.json() as { approval: { id: string } }).approval;
      expect((await fetch(`${base}/approvals/${approval.id}/approve`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ decidedBy: 'test-user' }) })).status).toBe(200);
      const result = await fetch(`${base}/terminal/exec`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...request, approvalId: approval.id }) });
      expect(result.status).toBe(200);
      expect(await result.json()).toMatchObject({ command: process.execPath, stdout: realpathSync(root), exitCode: 0, timedOut: false });
      expect((await fetch(`${base}/terminal/exec`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...request, cwd: '../' }) })).status).toBe(400);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      rmSync(root, { recursive: true, force: true });
    }
  });
});
