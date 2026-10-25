import { describe, expect, it } from 'vitest';
import { createOpenCodeDecoder } from './opencode.js';
import { runToolFixture } from '../fixtures/tool-fixture.js';

describe('OpenCode', () => {
  it('runs JSON mode with model, role and memory while filtering nontext events', async () => {
    expect(await runToolFixture('opencode', [
      { type: 'step_start', part: { type: 'step-start' } },
      { type: 'tool_use', part: { type: 'tool', state: { output: 'raw output' } } },
      { type: 'text', part: { type: 'text', text: 'OpenCode review complete' } },
      { type: 'step_finish', part: { type: 'step-finish' } },
    ])).toEqual(['OpenCode review complete']);
  });
  it('ignores hidden reasoning and unrelated JSON', () => {
    const decode = createOpenCodeDecoder();
    expect(decode({ type: 'reasoning', part: { text: 'private' } })).toEqual({});
    expect(decode({ type: 'text', part: { type: 'reasoning', text: 'private' } })).toEqual({});
  });
  it('unwraps nested provider failures even with zero exit status', async () => {
    await expect(runToolFixture('opencode', [{ type: 'error', error: { name: 'APIError', data: { message: 'OpenCode authentication failed' } } }])).rejects.toThrow('OpenCode authentication failed');
  });
});
