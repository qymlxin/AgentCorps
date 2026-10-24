import { describe, expect, it } from 'vitest';
import { ApprovalService, InMemoryApprovalStore, InMemoryAuditLog, PolicyEngine, createDefaultProfile } from '@agentcorps/security';
import { GuardedMcpToolExecutor, McpStdioClient } from './index.js';

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

  it('requires and consumes a matching approval before calling an MCP tool', async () => {
    const script = `
      process.stdin.on('data', chunk => { for (const line of chunk.toString().split('\\n')) { if (!line) continue; const req=JSON.parse(line); if(req.id && req.method==='initialize') console.log(JSON.stringify({jsonrpc:'2.0',id:req.id,result:{protocolVersion:'2026-07-28',capabilities:{},serverInfo:{name:'fixture',version:'1'}}})); if(req.id && req.method==='tools/call') console.log(JSON.stringify({jsonrpc:'2.0',id:req.id,result:{content:[{type:'text',text:'executed'}]}})); } });
    `;
    const client = new McpStdioClient({ command: process.execPath, args: ['-e', script] });
    const audit = new InMemoryAuditLog();
    const approvals = new ApprovalService(new InMemoryApprovalStore(), () => '2026-10-24T00:00:00.000Z', () => 'approval-1');
    const executor = new GuardedMcpToolExecutor({
      client,
      policy: new PolicyEngine(audit, () => '2026-10-24T00:00:00.000Z'),
      approvals,
      context: { mode: 'code', profile: createDefaultProfile('/workspace', 'S2') },
      capabilityFor: () => 'process.exec',
      id: () => 'request-1',
    });
    const tool = { name: 'run_command', inputSchema: { type: 'object' } };
    try {
      const pending = await executor.callTool('task-1', tool, { command: 'pnpm test' });
      expect(pending.status).toBe('approval_required');
      expect(audit.list()).toHaveLength(1);
      approvals.approve(pending.approvalId!, 'user-1');
      await expect(executor.callTool('task-1', tool, { command: 'different command' }, pending.approvalId, pending.requestId)).rejects.toThrow('does not match');
      const completed = await executor.callTool('task-1', tool, { command: 'pnpm test' }, pending.approvalId, pending.requestId);
      expect(completed).toMatchObject({ status: 'completed', requestId: 'request-1', result: { content: [{ type: 'text', text: 'executed' }] } });
      expect(approvals.get(pending.approvalId!)?.status).toBe('consumed');
    } finally {
      client.close();
    }
  });  it('surfaces JSON-RPC errors', async () => {
    const script = `process.stdin.on('data', chunk => { const req=JSON.parse(chunk); if(req.id) console.log(JSON.stringify({jsonrpc:'2.0',id:req.id,error:{code:-1,message:'denied'}})); });`;
    const client = new McpStdioClient({ command: process.execPath, args: ['-e', script] });
    await expect(client.start()).rejects.toThrow('MCP -1: denied');
    client.close();
  });
});
