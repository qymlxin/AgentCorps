import { describe, expect, it } from 'vitest';
import { AgentToolRegistry, createAgentToolRegistry, loadAgentToolDefinitions, loadAcpAgentServers } from './registry.js';

describe('agent tool registry', () => {
  it('ships common tools as declarative definitions', () => {
    const registry = createAgentToolRegistry();
    expect(registry.list().map((entry) => entry.id)).toEqual(expect.arrayContaining(['codex', 'claude-code', 'cursor']));
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

  it('creates ACP tools through the same registry used by task runs', () => {
    const registry = new AgentToolRegistry();
    loadAcpAgentServers({ agent_servers: { 'External ACP Agent': { command: process.execPath, args: ['-e', ''] } } }, registry);
    const adapter = registry.create('external-acp-agent');
    expect(adapter.descriptor.transport).toBe('acp');
    expect(adapter.descriptor.id).toBe('external-acp-agent');
    expect(registry.get('external-acp-agent').displayName).toBe('External ACP Agent');
  });
  it('loads JetBrains ACP env settings without exposing credentials in listings', () => {
    const registry = new AgentToolRegistry();
    loadAcpAgentServers({ default_mcp_settings: { use_custom_mcp: true }, agent_servers: { 'External ACP Agent': { command: process.execPath, args: ['-e', ''], env: { API_KEY: 'secret-value' } } } }, registry);
    expect(registry.list()[0]).not.toHaveProperty('env');
    expect(registry.get('external-acp-agent').env).toEqual({ API_KEY: 'secret-value' });
  });
  it('allows a standalone double dash as a positional prompt separator', () => {
    const registry = new AgentToolRegistry();
    registry.register({ id: 'separator', displayName: 'Separator', command: 'separator', args: [], outputFormat: 'text', promptFlag: '--' });
    expect(registry.get('separator').promptFlag).toBe('--');
  });

  it.each([
    { id: 42 }, { displayName: 42 }, { command: false }, { args: 'not-an-array' },
    { defaultRole: false }, { defaultRole: '' }, { documentationUrl: {} }, { promptPlacement: '' },
    { promptFlag: '' }, { versionArgs: ['\0'] }, { outputProtocol: 42 }, { transport: 'websocket' },
  ])('rejects malformed custom configuration values: %j', (invalid) => {
    expect(() => loadAgentToolDefinitions({ version: 1, tools: [{ id: 'custom', displayName: 'Custom', command: 'custom', args: [], outputFormat: 'text', ...invalid }] }, new AgentToolRegistry())).toThrow();
  });

  it('supports reusing installed protocol decoders but rejects incompatible or unknown ones', () => {
    const registry = createAgentToolRegistry();
    const definition = { id: 'custom-qwen', displayName: 'Custom Qwen', command: 'custom-qwen', args: [], outputFormat: 'jsonl', outputProtocol: 'qwen-messages' } as const;
    loadAgentToolDefinitions({ version: 1, tools: [definition] }, registry);
    expect(registry.create('custom-qwen').descriptor.id).toBe('custom-qwen');
    expect(() => registry.register({ ...definition, id: 'unknown', outputProtocol: 'missing' })).toThrow('Unknown output protocol');
    expect(() => registry.register({ ...definition, id: 'text', outputFormat: 'text' })).toThrow('jsonl output');
    expect(() => registry.register(definition)).toThrow('Duplicate agent tool');
    expect(() => registry.registerDecoder('qwen-messages', () => () => ({}))).toThrow('Duplicate output decoder');
  });

  it('takes immutable copies of definition arrays and rejects unknown top-level options', () => {
    const registry = new AgentToolRegistry();
    const args = ['--headless'];
    registry.register({ id: 'custom', displayName: 'Custom', command: 'custom', args, outputFormat: 'text' });
    args.push('--unintended');
    expect(registry.get('custom').args).toEqual(['--headless']);
    expect(Object.isFrozen(registry.get('custom'))).toBe(true);
    expect(Object.isFrozen(registry.get('custom').args)).toBe(true);
    expect(() => loadAgentToolDefinitions({ version: 1, tools: [], shell: 'untrusted' }, registry)).toThrow('Unknown field');
  });

  it('rejects unsafe or ambiguous definitions', () => {
    expect(() => new AgentToolRegistry().register({ id: 'Bad Tool', displayName: 'Bad', command: 'bad', args: [], outputFormat: 'text' })).toThrow('lowercase slug');
    expect(() => new AgentToolRegistry().register({ id: 'bad', displayName: 'Bad', command: 'bad', args: [], outputFormat: 'jsonl', promptPlacement: 'stdin', promptFlag: '-p' })).toThrow('stdin tools');
    expect(() => new AgentToolRegistry().register({ id: 'bad', displayName: 'Bad', command: 'bad', args: ['\0'], outputFormat: 'text' })).toThrow('strings');
  });
});
