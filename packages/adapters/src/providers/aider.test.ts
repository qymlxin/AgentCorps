import { describe, expect, it } from 'vitest';
import { runToolFixture } from '../fixtures/tool-fixture.js';
import { createAgentToolRegistry } from '../registry.js';

describe('Aider', () => {
  it('runs a one-shot message with model, role and filtered memory', async () => {
    expect(await runToolFixture('aider', ['Aider review complete'], 'text')).toEqual(['Aider review complete']);
  });
  it('disables autonomous commits, dirty commits and gitignore rewrites', () => {
    const definition = createAgentToolRegistry().get('aider');
    expect(definition.args).toEqual(expect.arrayContaining(['--no-auto-commits', '--no-dirty-commits', '--no-gitignore']));
    expect(definition.args).not.toContain('--yes');
    expect(definition.args).not.toContain('--yes-always');
    expect(definition.promptFlag).toBe('--message');
  });
  it('leaves single-message output as plain text rather than decoding JSON-looking replies', async () => {
    expect(await runToolFixture('aider', ['{"type":"answer","text":"done"}'], 'text')).toEqual(['{"type":"answer","text":"done"}']);
  });
});
