import { createServer } from 'node:http';
import { describe, expect, it } from 'vitest';
import { A2AClient, protocolDescriptors } from './index.js';

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
});
