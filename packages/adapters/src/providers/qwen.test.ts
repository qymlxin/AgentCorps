import { describe, expect, it } from 'vitest';
import { createQwenDecoder } from './qwen.js';
import { runToolFixture } from '../fixtures/tool-fixture.js';

const assistant = (text: string) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });

describe('Qwen Code', () => {
  it('passes model, role and memory, ignoring metadata and duplicate summaries', async () => {
    expect(await runToolFixture('qwen', [
      { type: 'system', subtype: 'session_start' }, assistant('Review complete'),
      { type: 'result', is_error: false, result: 'Review complete' },
    ])).toEqual(['Review complete']);
  });
  it('preserves different final responses and result-only output', () => {
    const decode = createQwenDecoder();
    expect(decode(assistant('Working'))).toEqual({ text: 'Working' });
    expect(decode({ type: 'result', result: 'Done' })).toEqual({ text: 'Done' });
    expect(createQwenDecoder()({ type: 'result', result: 'Done' })).toEqual({ text: 'Done' });
  });
  it('ignores tool blocks, reasoning and partial events', () => {
    const decode = createQwenDecoder();
    expect(decode({ type: 'assistant', message: { content: [{ type: 'thinking', text: 'hidden' }, { type: 'tool_use', input: {} }] } })).toEqual({});
    expect(decode({ type: 'stream_event', event: { type: 'content_block_delta', delta: { text: 'partial' } } })).toEqual({});
  });
  it('fails structured errors even when the process exits zero', async () => {
    await expect(runToolFixture('qwen', [{ type: 'result', is_error: true, errors: ['Qwen quota exceeded'] }])).rejects.toThrow('Qwen quota exceeded');
  });
});
