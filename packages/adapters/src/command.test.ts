import { describe, expect, it, vi } from 'vitest';
import { CommandAgentAdapter, type CommandAgentOptions } from './index.js';
import type { AgentRequest } from '@agentcorps/runtime';

function request(signal = new AbortController().signal): AgentRequest {
  return { task: { id: 'task-process' as never, workspaceId: 'ws', sessionId: 's', title: 'test', objective: 'Inspect files', mode: 'code', status: 'running', createdAt: '', updatedAt: '' }, runId: 'run-process' as never, signal, emit: vi.fn() };
}
function adapter(script: string, options: Partial<CommandAgentOptions> = {}) {
  return new CommandAgentAdapter({ id: 'fixture', displayName: 'Fixture', command: process.execPath, args: ['-e', script], ...options });
}

describe('bounded command execution', () => {
  it('rejects a pre-aborted run before launching a command', async () => {
    const controller = new AbortController(); controller.abort();
    await expect(adapter("console.log('should not run')").execute(request(controller.signal))).rejects.toMatchObject({ name: 'AbortError' });
  });
  it('cancels a running process and removes its abort listener', async () => {
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    const promise = adapter('setInterval(()=>{},1000)').execute(request(controller.signal));
    controller.abort();
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
  });
  it('bounds output without waiting for a newline', async () => {
    await expect(adapter("process.stdout.write('a'.repeat(1024));setInterval(()=>{},1000)", { maxLineBytes: 128 }).execute(request())).rejects.toThrow('line exceeds');
  });
  it('bounds stderr as well as stdout', async () => {
    await expect(adapter("process.stderr.write('a'.repeat(1024))", { maxOutputBytes: 128 }).execute(request())).rejects.toThrow('output exceeds');
  });
  it('enforces a timeout', async () => {
    await expect(adapter('setInterval(()=>{},1000)', { timeoutMs: 50 }).execute(request())).rejects.toThrow('timed out');
  });
  it('treats structured provider failure as failure even with exit code zero', async () => {
    await expect(adapter("console.log(JSON.stringify({type:'result',is_error:true}))", { outputFormat: 'jsonl', outputDecoder: () => () => ({ error: 'provider rejected credentials' }) }).execute(request())).rejects.toThrow('provider rejected credentials');
  });
  it('ignores metadata and creates fresh decoder state for every execution', async () => {
    const createDecoder = vi.fn(() => (value: unknown) => (value as { type: string }).type === 'answer' ? { text: 'answer' } : {});
    const tool = adapter("console.log(JSON.stringify({type:'metadata'}));console.log(JSON.stringify({type:'answer'}))", { outputFormat: 'jsonl', outputDecoder: createDecoder });
    const first = request(); const second = request();
    await tool.execute(first); await tool.execute(second);
    expect(first.emit).toHaveBeenCalledTimes(1);
    expect(second.emit).toHaveBeenCalledWith('answer', 'assistant');
    expect(createDecoder).toHaveBeenCalledTimes(2);
  });
});
