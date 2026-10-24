import { describe, expect, it } from 'vitest';
import { CommandAgentAdapter, JsonlAgentAdapter, probeCommand } from './index.js';

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

  it('runs a configured prompt-style command and parses JSONL result text', async () => {
    const output: string[] = [];
    const adapter = new CommandAgentAdapter({
      id: 'prompt-fixture',
      displayName: 'Prompt fixture',
      command: process.execPath,
      args: ['-e', "process.stdin.on('data',()=>console.log(JSON.stringify({type:'result',result:'real command output'})))"],
      promptPlacement: 'stdin',
      outputFormat: 'jsonl',
    });
    await adapter.execute({
      task: { id: 'task-1' as never, workspaceId: 'ws', sessionId: 's', title: 'test', objective: 'do it', mode: 'code', status: 'running', createdAt: '', updatedAt: '' },
      runId: 'run-1' as never,
      signal: new AbortController().signal,
      emit: (text) => output.push(text),
    });
    expect(output).toEqual(['real command output']);
  });

  it('probes an executable without treating a missing command as a crash', async () => {
    await expect(probeCommand(process.execPath, ['-e', "console.log('fixture 1.0.0')"])).resolves.toMatchObject({ available: true, version: 'fixture 1.0.0' });
    await expect(probeCommand('agentcorps-command-that-does-not-exist')).resolves.toMatchObject({ available: false });
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
