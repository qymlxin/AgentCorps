import { expect } from 'vitest';
import { createAgentToolRegistry } from '../registry.js';
import type { AgentRequest } from '@agentcorps/runtime';

/** Runs a real child process against the registered argv and output protocol, without vendor credentials. */
export async function runToolFixture(id: string, frames: readonly unknown[], outputFormat?: 'text'): Promise<string[]> {
  const registry = createAgentToolRegistry();
  const definition = registry.get(id);
  const prefix = [...definition.args, ...(definition.modelFlag ? [definition.modelFlag, 'fixture-model'] : []), ...(definition.promptFlag ? [definition.promptFlag] : [])];
  const script = `const args=process.argv.slice(1); const prompt=args.at(-1); if (JSON.stringify(args.slice(0,-1))!==${JSON.stringify(JSON.stringify(prefix))} || !prompt.includes('code reviewer') || !prompt.includes('Reply in Chinese') || !prompt.includes('Inspect release') || !prompt.includes('release checklist') || prompt.includes('private-secret-value')) { console.error('Invalid argv or role prompt'); process.exit(7); } ${frames.map((frame) => `console.log(${JSON.stringify(outputFormat === 'text' ? String(frame) : JSON.stringify(frame))});`).join(' ')}`;
  registry.register({ ...definition, id: `fixture-${id}`, command: process.execPath, args: ['-e', script, '--', ...definition.args] });
  const adapter = registry.create(`fixture-${id}`, { role: 'reviewer', instructions: 'Reply in Chinese', ...(definition.modelFlag ? { model: 'fixture-model' } : {}) });
  const output: string[] = [];
  const memory = [
    { id: 'm1', scope: 'global', content: 'release checklist', source: 'user', confidence: 1, sensitivity: 'private', createdAt: '', updatedAt: '' },
    { id: 'm2', scope: 'global', content: 'private-secret-value', source: 'user', confidence: 1, sensitivity: 'secret', createdAt: '', updatedAt: '' },
  ] as NonNullable<AgentRequest['memory']>;
  await adapter.execute({ task: { id: 't1' as never, workspaceId: 'ws', sessionId: 's1', title: 'Fixture', objective: 'Inspect release', mode: 'code', status: 'running', createdAt: '', updatedAt: '' }, runId: 'r1' as never, signal: new AbortController().signal, memory, emit: (text) => output.push(text) });
  expect(adapter.descriptor.displayName).toBe(definition.displayName);
  return output;
}
