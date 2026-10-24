import { describe, expect, it } from 'vitest';
import { JsonlAgentAdapter } from './index.js';

describe('JsonlAgentAdapter', () => {
  it('streams JSON frames and tolerates plain diagnostic lines', async () => {
    const output: Array<[string, string]> = [];
    const adapter = new JsonlAgentAdapter({
      id: 'fixture',
      displayName: 'Fixture Agent',
      command: process.execPath,
      args: ['-e', "process.stdin.on('data',()=>{console.log('diagnostic'); console.log(JSON.stringify({type:'output',text:'hello'})); console.log(JSON.stringify({type:'completed'}));})"],
    });
    await adapter.execute({
      task: { id: 'task-1' as never, workspaceId: 'ws', sessionId: 's', title: 'test', objective: 'do it', mode: 'code', status: 'running', createdAt: '', updatedAt: '' },
      runId: 'run-1' as never,
      signal: new AbortController().signal,
      emit: (text, stream = 'assistant') => output.push([text, stream]),
    });
    expect(output).toEqual([['diagnostic', 'stdout'], ['hello', 'assistant']]);
  });

  it('rejects when the process exits before completion', async () => {
    const adapter = new JsonlAgentAdapter({ id: 'broken', displayName: 'Broken', command: process.execPath, args: ['-e', 'process.exit(3)'] });
    await expect(adapter.execute({
      task: { id: 'task-1' as never, workspaceId: 'ws', sessionId: 's', title: 'test', objective: 'do it', mode: 'code', status: 'running', createdAt: '', updatedAt: '' },
      runId: 'run-1' as never,
      signal: new AbortController().signal,
      emit: () => undefined,
    })).rejects.toThrow('Agent exited before completion');
  });
});
