const readline = require('node:readline');

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', (line) => {
  if (!line.trim()) return;
  const request = JSON.parse(line);
  if (request.method === 'initialize') {
    process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { protocolVersion: '2026-07-28', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } } })}\n`);
  } else if (request.method === 'tools/list') {
    process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { tools: [{ name: 'echo_text', description: 'echo text input', inputSchema: { type: 'object' } }] } })}\n`);
  } else if (request.method === 'tools/call') {
    process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { content: [{ type: 'text', text: 'dynamic tool selected' }] } })}\n`);
  }
});
