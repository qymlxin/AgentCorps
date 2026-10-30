import { createServer } from 'node:http';
import { describe, expect, it } from 'vitest';
import { A2AClient, AcpStdioClient, protocolDescriptors } from './index.js';

describe('A2A client', () => {
  it('discovers an agent card and sends a message', async () => {
    const server = createServer((request, response) => {
      response.setHeader('content-type', 'application/json');
      if (request.url === '/.well-known/agent-card.json') return response.end(JSON.stringify({ name: 'remote-reviewer', url: 'http://127.0.0.1' }));
      let body = ''; request.on('data', (chunk) => { body += chunk; }); request.on('end', () => response.end(JSON.stringify({ jsonrpc: '2.0', id: JSON.parse(body).id, result: { id: 'remote-task-1', status: { state: 'submitted' } } })));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected TCP address');
    const client = new A2AClient({ agentUrl: `http://127.0.0.1:${address.port}` });
    try {
      expect((await client.getAgentCard()).name).toBe('remote-reviewer');
      expect((await client.sendMessage('review this'))).toMatchObject({ id: 'remote-task-1' });
      expect(protocolDescriptors.a2a.maturity).toBe('experimental');
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('enforces remote trust policy and capability negotiation', async () => {
    const client = new A2AClient({
      agentUrl: 'http://agent.example.test',
      requiredCapabilities: ['streaming'],
      trust: { allowedOrigins: ['http://agent.example.test'], verifyAgentCard: (card) => { if ((card as { version?: string }).version !== '1.0') throw new Error('untrusted card'); } },
      fetchImpl: async () => new Response(JSON.stringify({ name: 'trusted', url: 'http://agent.example.test', version: '1.0', capabilities: { streaming: true } }), { status: 200 }),
    });
    await expect(client.getAgentCard()).resolves.toMatchObject({ name: 'trusted', version: '1.0' });
    const rejected = new A2AClient({ agentUrl: 'http://agent.example.test', trust: { requireHttps: true }, fetchImpl: async () => new Response(JSON.stringify({ name: 'insecure', url: 'http://agent.example.test' }), { status: 200 }) });
    await expect(rejected.getAgentCard()).rejects.toThrow('untrusted_transport');
  });

  it('streams SSE events, reconnects with Last-Event-ID, and deduplicates replayed events', async () => {
    let calls = 0;
    const stream = (chunks: string[], fail = false): ReadableStream<Uint8Array> => new ReadableStream({ start(controller) { for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk)); if (fail) setTimeout(() => controller.error(new Error('connection reset')), 0); else controller.close(); } });
    const client = new A2AClient({
      agentUrl: 'http://agent.example.test',
      fetchImpl: async (_input, init) => {
        calls += 1;
        if (calls === 1) return new Response(stream(['id: 1\nevent: update\ndata: {"state":"working"}\n\n'], true), { status: 200, headers: { 'content-type': 'text/event-stream' } });
        expect(new Headers(init?.headers).get('last-event-id')).toBe('1');
        return new Response(stream(['id: 1\ndata: {"state":"working"}\n\nid: 2\ndata: {"state":"completed"}\n\n']), { status: 200, headers: { 'content-type': 'text/event-stream' } });
      },
    });
    const events: unknown[] = [];
    for await (const event of client.streamMessage('stream this', undefined, { idempotencyKey: 'stream-1', reconnectAttempts: 1 })) events.push(event.data);
    expect(events).toEqual([{ state: 'working' }, { state: 'completed' }]);
    expect(calls).toBe(2);
  });

  it('rejects malformed Agent Cards and supports cancellation with abort signals', async () => {
    const calls: string[] = [];
    const client = new A2AClient({
      agentUrl: 'http://127.0.0.1:1',
      fetchImpl: async (input) => {
        calls.push(String(input));
        if (calls.length === 1) return new Response(JSON.stringify({ name: 'invalid' }), { status: 200 });
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { id: 'task-1', status: { state: 'canceled' } } }), { status: 200 });
      },
    });
    await expect(client.getAgentCard()).rejects.toThrow('invalid_card');
    await expect(client.cancelTask('task-1', { idempotencyKey: 'cancel-1' })).resolves.toMatchObject({ id: 'task-1' });
  });


  it('advertises client capabilities and returns a protocol error for unsupported Agent requests', async () => {
    const script = "const rl=require('node:readline').createInterface({input:process.stdin}); rl.on('line',l=>{const m=JSON.parse(l); if(m.method==='initialize'){if(!m.params.clientCapabilities.fs?.readTextFile || !m.params.clientCapabilities.terminal) process.exit(2); console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{protocolVersion:1,agentCapabilities:{}}})); setTimeout(()=>console.log(JSON.stringify({jsonrpc:'2.0',id:7,method:'fs/read_text_file',params:{sessionId:'s',path:'/tmp/a'}})),0);} if(m.id===7 && m.error?.code!==-32601) process.exit(3); if(m.method==='session/new') console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{sessionId:'s'}}));});";
    const client = new AcpStdioClient({ command: process.execPath, args: ['-e', script], clientCapabilities: { fs: { readTextFile: true }, terminal: true } });
    try {
      await expect(client.initialize()).resolves.toMatchObject({ protocolVersion: 1 });
      await expect(client.newSession('/tmp')).resolves.toMatchObject({ sessionId: 's' });
    } finally {
      client.close();
    }
  });
  it('negotiates ACP over stdio, receives updates, and prompts a session', async () => {
    const updates: unknown[] = [];
    const script = "const rl=require('node:readline').createInterface({input:process.stdin}); rl.on('line',l=>{const m=JSON.parse(l); if(m.method==='initialize') console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{protocolVersion:1,agentCapabilities:{}}})); if(m.method==='session/new') console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{sessionId:'acp-session-1'}})); if(m.method==='session/prompt'){console.log(JSON.stringify({jsonrpc:'2.0',method:'session/update',params:{update:'working'}})); console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{stopReason:'end_turn'}}));}});";
    const client = new AcpStdioClient({ command: process.execPath, args: ['-e', script], onUpdate: (update) => updates.push(update) });
    try {
      expect((await client.initialize()).protocolVersion).toBe(1);
      const session = await client.newSession('/tmp');
      expect(session.sessionId).toBe('acp-session-1');
      expect((await client.prompt(session.sessionId, 'fix the test')).stopReason).toBe('end_turn');
      expect(updates).toEqual([{ update: 'working' }]);
      expect(protocolDescriptors.acp.maturity).toBe('experimental');
    } finally {
      client.close();
    }
  });
});
