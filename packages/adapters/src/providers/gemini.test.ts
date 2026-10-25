import { describe, expect, it } from 'vitest';
import { createGeminiDecoder } from './gemini.js';
import { runToolFixture } from '../fixtures/tool-fixture.js';

describe('Gemini CLI', () => {
  it('passes model, role and memory and streams assistant chunks only', async () => {
    expect(await runToolFixture('gemini', [
      { type: 'init', session_id: 'fixture' },
      { type: 'message', role: 'user', content: 'private prompt' },
      { type: 'message', role: 'assistant', content: 'Review ', delta: true },
      { type: 'message', role: 'assistant', content: 'complete', delta: true },
      { type: 'tool_result', output: 'raw output' },
      { type: 'result', status: 'success', stats: {} },
    ])).toEqual(['Review ', 'complete']);
  });
  it('preserves warnings as diagnostics without failing the run', () => {
    expect(createGeminiDecoder()({ type: 'error', severity: 'warning', message: 'Retrying request' })).toEqual({ text: 'Retrying request', stream: 'stderr' });
  });
  it('propagates fatal error events', async () => {
    await expect(runToolFixture('gemini', [{ type: 'error', severity: 'error', message: 'Gemini authentication required' }])).rejects.toThrow('Gemini authentication required');
  });
  it('propagates final result errors even with a zero exit code', async () => {
    await expect(runToolFixture('gemini', [{ type: 'result', status: 'error', error: { type: 'quota', message: 'Gemini quota exceeded' } }])).rejects.toThrow('Gemini quota exceeded');
  });
});
