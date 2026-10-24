import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { InMemoryMemoryStore, JsonlMemoryStore, MemoryService, SqliteMemoryStore, migrateMemoryStore } from './index.js';

describe('memory service', () => {
  it('enforces scopes and retrieves only visible memories', () => {
    let sequence = 0;
    const service = new MemoryService(new InMemoryMemoryStore(), () => '2026-10-24T00:00:00.000Z', () => `memory-${++sequence}`);
    service.save({ scope: 'global', content: 'User prefers concise release notes', source: 'user' });
    service.save({ scope: 'workspace', workspaceId: 'ws-1', content: 'The API uses JSONL events', source: 'agent' });
    service.save({ scope: 'session', workspaceId: 'ws-1', sessionId: 's-1', content: 'The current task is memory search', source: 'agent' });
    service.save({ scope: 'global', content: 'Database token is private', source: 'user', sensitivity: 'secret' });

    expect(service.search('prefers', { workspaceId: 'other' })).toHaveLength(1);
    expect(service.search('JSONL', { workspaceId: 'other' })).toHaveLength(0);
    expect(service.search('JSONL', { workspaceId: 'ws-1' })).toHaveLength(1);
    expect(service.search('current', { workspaceId: 'ws-1', sessionId: 'other' })).toHaveLength(0);
  });

  it('persists records and tombstones to JSONL', () => {
    const directory = mkdtempSync(join(tmpdir(), 'agentcorps-memory-'));
    const path = join(directory, 'memory.jsonl');
    try {
      const first = new MemoryService(new JsonlMemoryStore(path), () => '2026-10-24T00:00:00.000Z', () => 'memory-1');
      const record = first.save({ scope: 'global', content: 'portable fact', source: 'user' });
      expect(first.delete(record.id)?.deletedAt).toBe('2026-10-24T00:00:00.000Z');
      const second = new MemoryService(new JsonlMemoryStore(path), () => '2026-10-24T00:00:00.000Z');
      expect(second.export()).toHaveLength(0);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('migrates JSONL records and tombstones into SQLite', () => {
    const directory = mkdtempSync(join(tmpdir(), 'agentcorps-memory-sqlite-'));
    const sourcePath = join(directory, 'memory.jsonl');
    const databasePath = join(directory, 'agentcorps.db');
    try {
      const sourceService = new MemoryService(new JsonlMemoryStore(sourcePath), () => '2026-10-24T00:00:00.000Z', () => 'memory-1');
      const record = sourceService.save({ scope: 'workspace', workspaceId: 'ws', content: 'migrated fact', source: 'user' });
      sourceService.delete(record.id);
      const source = new JsonlMemoryStore(sourcePath);
      const target = new SqliteMemoryStore(databasePath);
      expect(migrateMemoryStore(source, target)).toBe(1);
      expect(target.get(record.id)?.deletedAt).toBeDefined();
      target.close();
      const reopened = new SqliteMemoryStore(databasePath);
      expect(reopened.list()).toHaveLength(1);
      reopened.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
