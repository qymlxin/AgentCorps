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
