import { describe, expect, it } from 'vitest';
import { createZCodeDecoder } from './zcode.js';
import { runToolFixture } from '../fixtures/tool-fixture.js';
import { createAgentToolRegistry } from '../registry.js';

describe('ZCode CLI (GLM)', () => {
  it('passes role and memory and emits only the authoritative workflow result', async () => {
    expect(await runToolFixture('zcode', [
      { type: 'text_delta', text: 'intermediate' },
      { type: 'tool_result', output: 'raw output' },
      { type: 'result', response: 'Final workflow review', turnResponses: ['intermediate', 'Final workflow review'], projection: { status: 'idle' } },
    ])).toEqual(['Final workflow review']);
  });
  it('uses response rather than the incompatible Qwen result field', () => {
    expect(createZCodeDecoder()({ type: 'result', result: 'wrong schema' })).toEqual({});
  });
  it('reports terminal failure even with exit code zero', async () => {
    await expect(runToolFixture('zcode', [{ type: 'result', response: '', projection: { status: 'failed' } }])).rejects.toThrow('ZCode execution failed');
  });
  it('rejects unsupported model flags instead of inventing vendor options', () => {
    expect(() => createAgentToolRegistry().create('zcode', { model: 'glm' })).toThrow('does not declare a model selection flag');
  });
});
