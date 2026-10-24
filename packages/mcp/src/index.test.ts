import { describe, expect, it } from 'vitest';
import { McpStdioClient } from './index.js';

describe('McpStdioClient', () => {
  it('initializes, discovers tools, and calls a tool', async () => {
    const script = `
      let buffer = '';
      process.stdin.on('data', chunk => {
        buffer += chunk.toString();
        const lines = buffer.split('\\n'); buffer = lines.pop();
        for (const line of lines) { if (!line) continue; const req = JSON.parse(line);
          if (req.id && req.method === 'initialize') console.log(JSON.stringify({jsonrpc:'2.0',id:req.id,result:{protocolVersion:'2026-07-28',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}}}));
          if (req.id && req.method === 'tools/list') console.log(JSON.stringify({jsonrpc:'2.0',id:req.id,result:{tools:[{name:'echo',description:'Echo text',inputSchema:{type:'object'}}]}}));
          if (req.id && req.method === 'tools/call') console.log(JSON.stringify({jsonrpc:'2.0',id:req.id,result:{content:[{type:'text',text:req.params.arguments.text}]}}));
        }
      });
    `;
    const client = new McpStdioClient({ command: process.execPath, args: ['-e', script] });
    try {
      expect((await client.start()).serverInfo.name).toBe('fixture');
      expect((await client.listTools())[0]?.name).toBe('echo');
      expect((await client.callTool('echo', { text: 'hello' })).content).toEqual([{ type: 'text', text: 'hello' }]);
    } finally {
      client.close();
    }
  });

  it('surfaces JSON-RPC errors', async () => {
    const script = `process.stdin.on('data', chunk => { const req=JSON.parse(chunk); if(req.id) console.log(JSON.stringify({jsonrpc:'2.0',id:req.id,error:{code:-1,message:'denied'}})); });`;
    const client = new McpStdioClient({ command: process.execPath, args: ['-e', script] });
    await expect(client.start()).rejects.toThrow('MCP -1: denied');
    client.close();
  });
});
