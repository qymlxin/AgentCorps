import { describe, expect, it } from 'vitest';
import { createKimiDecoder } from './kimi.js';
import { runToolFixture } from '../fixtures/tool-fixture.js';

describe('Kimi Code CLI', () => {
  it('runs the registered prompt command with model, role and memory context', async () => {
    expect(await runToolFixture('kimi', [{ role: 'assistant', content: 'Review complete' }])).toEqual(['Review complete']);
  });
  it('extracts message blocks and ignores tools and reasoning', () => {
    const decode = createKimiDecoder();
    expect(decode({ role: 'tool', content: 'raw command output' })).toEqual({});
    expect(decode({ role: 'assistant', content: [{ type: 'think', text: 'private reasoning' }, { type: 'text', text: 'answer' }] })).toEqual({ text: 'answer' });
  });
  it('reports structured failures', async () => {
    await expect(runToolFixture('kimi', [{ type: 'error', error: { message: 'Kimi authentication required' } }])).rejects.toThrow('Kimi authentication required');
  });
});
