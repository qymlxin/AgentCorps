import { describe, expect, it } from 'vitest';
import { AgentToolRegistry, createAgentToolRegistry, loadAgentToolDefinitions } from './registry.js';

describe('agent tool registry', () => {
  it('ships common tools as declarative definitions', () => {
    const registry = createAgentToolRegistry();
    expect(registry.list().map((entry) => entry.id)).toEqual(['codex', 'claude-code', 'cursor']);
    expect(registry.get('codex').args).toContain('--json');
  });

  it('creates a tool with model and role prompt options without executing shell text', () => {
    const registry = createAgentToolRegistry();
    const adapter = registry.create('codex', { command: '/usr/bin/codex', model: 'test-model', role: 'reviewer' });
    expect(adapter.descriptor.id).toBe('codex');
  });

  it('loads custom providers with strict schema and supports disabling defaults', () => {
    const registry = new AgentToolRegistry();
    loadAgentToolDefinitions({ version: 1, tools: [{ id: 'kimi', displayName: 'Kimi Code', command: 'kimi', args: ['--print', '--output-format=stream-json'], outputFormat: 'jsonl', promptPlacement: 'argument', promptFlag: '-p', modelFlag: '--model', defaultRole: 'developer', documentationUrl: 'https://www.kimi.com/code/docs' }] }, registry);
    const adapter = registry.create('kimi', { role: null });
    expect(adapter.descriptor.displayName).toBe('Kimi Code');
    expect(() => loadAgentToolDefinitions({ version: 1, tools: [{ id: 'bad', displayName: 'Bad', command: 'bad', args: [], outputFormat: 'text', unexpected: true }] }, new AgentToolRegistry())).toThrow('Unknown field');
  });

  it('rejects unsafe or ambiguous definitions', () => {
    expect(() => new AgentToolRegistry().register({ id: 'Bad Tool', displayName: 'Bad', command: 'bad', args: [], outputFormat: 'text' })).toThrow('lowercase slug');
    expect(() => new AgentToolRegistry().register({ id: 'bad', displayName: 'Bad', command: 'bad', args: [], outputFormat: 'jsonl', promptPlacement: 'stdin', promptFlag: '-p' })).toThrow('stdin tools');
    expect(() => new AgentToolRegistry().register({ id: 'bad', displayName: 'Bad', command: 'bad', args: ['\0'], outputFormat: 'text' })).toThrow('strings');
  });
});
