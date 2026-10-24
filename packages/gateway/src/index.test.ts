import { describe, expect, it } from 'vitest';
import { listenGateway } from './index.js';
import { TaskRuntime } from '@agentcorps/runtime';
import { signHmacSha256 } from '@agentcorps/channels';
import { createDefaultProfile } from '@agentcorps/security';

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
  });  it('bridges signed channel webhooks into shared sessions and tasks', async () => {
    const secret = 'channel-secret';
    const server = await listenGateway(new TaskRuntime(), 0, '127.0.0.1', undefined, { channels: { webhookSecrets: { feishu: secret } } });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected TCP address');
    const base = `http://127.0.0.1:${address.port}`;
    const payload = JSON.stringify({ message: { message_id: 'm1', conversation_id: 'c1', text: 'prepare report' }, sender: { sender_id: 'u1' } });
    try {
      const headers = { 'content-type': 'application/json', 'x-agentcorps-signature': signHmacSha256(payload, secret) };
      const first = await fetch(`${base}/channels/feishu/webhook`, { method: 'POST', headers, body: payload });
      expect(first.status).toBe(202);
      const firstBody = await first.json() as { session: { id: string }; task: { sessionId: string } };
      expect(firstBody.task.sessionId).toBe(firstBody.session.id);
      const duplicate = await fetch(`${base}/channels/feishu/webhook`, { method: 'POST', headers, body: payload });
      expect(await duplicate.json()).toMatchObject({ accepted: false, duplicate: true });
      const outbound = await fetch(`${base}/channels/feishu/outbound`, { method: 'POST', headers, body: JSON.stringify({ conversationId: 'c1', text: 'received' }) });
      expect(await outbound.json()).toMatchObject({ payload: { conversation_id: 'c1' } });
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
});
