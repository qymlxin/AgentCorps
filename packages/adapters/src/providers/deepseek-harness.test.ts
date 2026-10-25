import { describe, expect, it } from 'vitest';
import { runToolFixture } from '../fixtures/tool-fixture.js';
import { createAgentToolRegistry } from '../registry.js';

describe('DeepSeek Harness', () => {
  it('executes a headless prompt with reviewer role, instructions and filtered memory', async () => {
    expect(await runToolFixture('deepseek-harness', ['Harness review complete'], 'text')).toEqual(['Harness review complete']);
  });
  it('selects the one-shot headless profile rather than the SDK or web server', () => {
    const definition = createAgentToolRegistry().get('deepseek-harness');
    expect(definition.command).toBe('dsh');
    expect(definition.args).toEqual(['--profile', 'headless']);
    expect(definition.outputFormat).toBe('text');
    expect(definition.defaultRole).toBe('developer');
  });
  it('requires native profile configuration for model selection', () => {
    expect(() => createAgentToolRegistry().create('deepseek-harness', { model: 'deepseek' })).toThrow('does not declare a model selection flag');
  });
});
