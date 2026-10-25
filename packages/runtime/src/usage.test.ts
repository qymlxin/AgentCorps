import { describe, expect, it } from 'vitest';
import { InMemoryUsageStore, JsonlUsageStore, SqliteUsageStore, UsageService } from './usage.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

function exercise(service: UsageService): void {
  const model = service.start({ taskId: 'task-1', runId: 'run-1', kind: 'model', toolId: 'codex', model: 'gpt-5', operation: 'agent.execute' });
  model.inputText('hello world');
  model.outputText('done');
  model.finish('succeeded');
  const tool = service.start({ taskId: 'task-1', runId: 'run-1', kind: 'tool', toolId: 'mcp-server', operation: 'mcp.tools/call:search' });
  tool.setTokenUsage(4, 6);
  tool.finish('failed', 'upstream unavailable');
}

describe('usage records', () => {
  it('records model and tool calls and summarizes by tool and model', () => {
    const store = new InMemoryUsageStore();
    exercise(new UsageService(store, () => '2026-10-26T00:00:00.000Z', (prefix) => `${prefix}-1`));
    const service = new UsageService(store);
    expect(service.list()).toHaveLength(2);
    expect(service.summary()).toMatchObject([
      { kind: 'model', toolId: 'codex', model: 'gpt-5', calls: 1, estimatedCalls: 1 },
      { kind: 'tool', toolId: 'mcp-server', calls: 1, failed: 1, totalTokens: 10, estimatedCalls: 0 },
    ]);
  });

  it('persists JSONL and SQLite records with filters', () => {
    const directory = mkdtempSync(join(tmpdir(), 'agentcorps-usage-'));
    try {
      const jsonl = new JsonlUsageStore(join(directory, 'usage.jsonl'));
      exercise(new UsageService(jsonl));
      expect(jsonl.list({ model: 'gpt-5' })).toHaveLength(1);
      const sqlite = new SqliteUsageStore(join(directory, 'agentcorps.db'));
      const service = new UsageService(sqlite);
      exercise(service);
      expect(service.list({ kind: 'tool', status: 'failed' })).toHaveLength(1);
      expect(service.summary({ toolId: 'codex' })[0]?.inputTokens).toBeGreaterThan(0);
      service.close();
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});
