import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

export type MemoryScope = 'global' | 'workspace' | 'session';
export type MemorySensitivity = 'public' | 'private' | 'secret';

export interface MemoryRecord {
  readonly id: string;
  readonly scope: MemoryScope;
  readonly workspaceId?: string;
  readonly sessionId?: string;
  readonly content: string;
  readonly sourceEventId?: string;
  readonly source: 'user' | 'agent' | 'system';
  readonly confidence: number;
  readonly sensitivity: MemorySensitivity;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly expiresAt?: string;
  readonly deletedAt?: string;
}

export interface MemoryContext {
  readonly workspaceId?: string;
  readonly sessionId?: string;
  readonly includeSensitive?: boolean;
}

export interface SaveMemoryInput {
  readonly scope: MemoryScope;
  readonly workspaceId?: string;
  readonly sessionId?: string;
  readonly content: string;
  readonly sourceEventId?: string;
  readonly source: MemoryRecord['source'];
  readonly confidence?: number;
  readonly sensitivity?: MemorySensitivity;
  readonly expiresAt?: string;
}

interface MemoryOperation {
  readonly op: 'upsert' | 'delete';
  readonly record: MemoryRecord;
}

export interface MemoryStore {
  upsert(record: MemoryRecord): void;
  delete(id: string, deletedAt: string): MemoryRecord | undefined;
  get(id: string): MemoryRecord | undefined;
  list(): readonly MemoryRecord[];
}

export class JsonlMemoryStore implements MemoryStore {
  private readonly records = new Map<string, MemoryRecord>();

  constructor(private readonly filePath: string) {
    mkdirSync(dirname(filePath), { recursive: true });
    if (!existsSync(filePath)) return;
    for (const line of readFileSync(filePath, 'utf8').split('\\n').filter(Boolean)) {
      const operation = JSON.parse(line) as MemoryOperation;
      if (operation.op === 'upsert') this.records.set(operation.record.id, operation.record);
      if (operation.op === 'delete') this.records.set(operation.record.id, operation.record);
    }
  }

  upsert(record: MemoryRecord): void {
    this.append({ op: 'upsert', record });
    this.records.set(record.id, record);
  }

  delete(id: string, deletedAt: string): MemoryRecord | undefined {
    const current = this.records.get(id);
    if (!current || current.deletedAt) return undefined;
    const record = { ...current, deletedAt, updatedAt: deletedAt };
    this.append({ op: 'delete', record });
    this.records.set(id, record);
    return record;
  }

  get(id: string): MemoryRecord | undefined {
    return this.records.get(id);
  }

  list(): readonly MemoryRecord[] {
    return [...this.records.values()];
  }

  private append(operation: MemoryOperation): void {
    appendFileSync(this.filePath, `${JSON.stringify(operation)}\\n`, 'utf8');
  }
}

export class InMemoryMemoryStore implements MemoryStore {
  private readonly records = new Map<string, MemoryRecord>();

  upsert(record: MemoryRecord): void { this.records.set(record.id, record); }
  delete(id: string, deletedAt: string): MemoryRecord | undefined {
    const current = this.records.get(id);
    if (!current || current.deletedAt) return undefined;
    const record = { ...current, deletedAt, updatedAt: deletedAt };
    this.records.set(id, record);
    return record;
  }
  get(id: string): MemoryRecord | undefined { return this.records.get(id); }
  list(): readonly MemoryRecord[] { return [...this.records.values()]; }
}

export class MemoryService {
  constructor(
    private readonly store: MemoryStore,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly id: () => string = () => `memory-${crypto.randomUUID()}`,
  ) {}

  save(input: SaveMemoryInput): MemoryRecord {
    const content = input.content.trim();
    if (!content) throw new Error('Memory content cannot be empty');
    if (!['global', 'workspace', 'session'].includes(input.scope)) throw new Error(`Unknown memory scope: ${input.scope}`);
    if (input.scope === 'workspace' && !input.workspaceId) throw new Error('Workspace memory requires workspaceId');
    if (input.scope === 'session' && (!input.workspaceId || !input.sessionId)) throw new Error('Session memory requires workspaceId and sessionId');
    const confidence = input.confidence ?? 1;
    if (confidence < 0 || confidence > 1) throw new Error('Memory confidence must be between 0 and 1');
    const now = this.now();
    const record: MemoryRecord = {
      id: this.id(),
      scope: input.scope,
      ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      content,
      ...(input.sourceEventId ? { sourceEventId: input.sourceEventId } : {}),
      source: input.source,
      confidence,
      sensitivity: input.sensitivity ?? 'private',
      createdAt: now,
      updatedAt: now,
      ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
    };
    this.store.upsert(record);
    return record;
  }

  search(query: string, context: MemoryContext, limit = 10): readonly MemoryRecord[] {
    const terms = query.toLowerCase().split(/\\s+/).filter(Boolean);
    if (!terms.length) return [];
    const now = this.now();
    return this.store.list()
      .filter((record) => !record.deletedAt && (!record.expiresAt || record.expiresAt > now))
      .filter((record) => this.visible(record, context))
      .map((record) => ({ record, score: this.score(record, terms) }))
      .filter(({ score }) => score > 0)
      .sort((a, b) => b.score - a.score || b.record.updatedAt.localeCompare(a.record.updatedAt))
      .slice(0, limit)
      .map(({ record }) => record);
  }

  delete(id: string): MemoryRecord | undefined {
    return this.store.delete(id, this.now());
  }

  export(): readonly MemoryRecord[] {
    return this.store.list().filter((record) => !record.deletedAt);
  }

  private visible(record: MemoryRecord, context: MemoryContext): boolean {
    if (record.sensitivity === 'secret' && !context.includeSensitive) return false;
    if (record.scope === 'global') return true;
    if (!context.workspaceId || record.workspaceId !== context.workspaceId) return false;
    return record.scope === 'workspace' || record.sessionId === context.sessionId;
  }

  private score(record: MemoryRecord, terms: readonly string[]): number {
    const haystack = record.content.toLowerCase();
    return terms.reduce((score, term) => score + (haystack.includes(term) ? 1 : 0), 0) * record.confidence;
  }
}
