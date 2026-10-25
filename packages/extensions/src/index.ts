import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

export type ExtensionKind = 'plugin' | 'skill' | 'rule' | 'command' | 'hook';
export type ExtensionSource = 'builtin' | 'workspace' | 'user' | 'remote';
export type ExtensionPermission = 'fs.read' | 'fs.write' | 'process.exec' | 'network.connect' | 'secret.read';

export interface ExtensionManifest {
  readonly id: string;
  readonly kind: ExtensionKind;
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly source: ExtensionSource;
  readonly path?: string;
  readonly contentHash?: string;
  readonly permissions: readonly ExtensionPermission[];
  readonly events: readonly string[];
  readonly conflicts?: readonly string[];
  readonly argumentSchema?: Readonly<Record<string, unknown>>;
  readonly body?: string;
}

const kinds = new Set<ExtensionKind>(['plugin', 'skill', 'rule', 'command', 'hook']);
const permissions = new Set<ExtensionPermission>(['fs.read', 'fs.write', 'process.exec', 'network.connect', 'secret.read']);

export class ExtensionRegistry {
  private readonly entries = new Map<string, ExtensionManifest>();

  register(manifest: ExtensionManifest): ExtensionManifest {
    validateManifest(manifest);
    const existing = this.entries.get(manifest.id);
    if (existing && (existing.version !== manifest.version || existing.contentHash !== manifest.contentHash)) throw new Error(`Extension ID already registered with another version or content: ${manifest.id}`);
    this.entries.set(manifest.id, manifest);
    return manifest;
  }

  registerAll(manifests: readonly ExtensionManifest[]): readonly ExtensionManifest[] {
    const ordered = [...manifests].sort((left, right) => sourcePriority(right.source) - sourcePriority(left.source) || left.id.localeCompare(right.id));
    for (const manifest of ordered) {
      const existing = this.entries.get(manifest.id);
      if (!existing) this.register(manifest);
      else if (existing.version !== manifest.version || existing.contentHash !== manifest.contentHash) throw new Error(`Conflicting extension manifests for ${manifest.id}`);
    }
    return this.list();
  }

  get(id: string): ExtensionManifest | undefined { return this.entries.get(id); }
  list(kind?: ExtensionKind): readonly ExtensionManifest[] { return [...this.entries.values()].filter((entry) => !kind || entry.kind === kind); }
  remove(id: string): boolean { return this.entries.delete(id); }
}

export function loadMarkdownExtension(filePath: string, source: ExtensionSource, defaultKind?: ExtensionKind): ExtensionManifest {
  const raw = readFileSync(filePath, 'utf8');
  const match = /^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/u.exec(raw);
  if (!match) throw new Error(`Extension file has no frontmatter: ${filePath}`);
  const metadata = parseFrontmatter(match[1] ?? '');
  const kind = (metadata.kind ?? defaultKind) as ExtensionKind | undefined;
  if (!kind) throw new Error(`Extension kind is required: ${filePath}`);
  const declaredPermissions = parseList(metadata.permissions);
  for (const permission of declaredPermissions) if (!permissions.has(permission as ExtensionPermission)) throw new Error(`Unknown extension permission: ${permission}`);
  return {
    id: metadata.id ?? filePath,
    kind,
    name: metadata.name ?? metadata.id ?? filePath,
    version: metadata.version ?? '0.0.0',
    description: metadata.description ?? '',
    source,
    path: filePath,
    contentHash: createHash('sha256').update(raw).digest('hex'),
    permissions: declaredPermissions as ExtensionPermission[],
    events: parseList(metadata.events),
    ...(parseList(metadata.conflicts).length ? { conflicts: parseList(metadata.conflicts) } : {}),
    ...(metadata.argumentSchema ? { argumentSchema: parseJsonMetadata(metadata.argumentSchema, 'argumentSchema') } : {}),
    body: match[2] ?? '',
  };
}

export function validateManifest(manifest: ExtensionManifest): void {
  if (!manifest.id.trim() || !manifest.name.trim()) throw new Error('Extension id and name are required');
  if (!kinds.has(manifest.kind)) throw new Error(`Unknown extension kind: ${manifest.kind}`);
  if (!/^\d+\.\d+\.\d+$/.test(manifest.version)) throw new Error(`Extension version must be semver: ${manifest.version}`);
  for (const permission of manifest.permissions) if (!permissions.has(permission)) throw new Error(`Unknown extension permission: ${permission}`);
  if (manifest.conflicts?.some((id) => !id.trim() || id === manifest.id)) throw new Error(`Extension conflicts are invalid: ${manifest.id}`);
  for (const event of manifest.events) if (!event.trim()) throw new Error(`Extension event is empty: ${manifest.id}`);
}

export function scanMarkdownExtensions(directory: string, source: ExtensionSource, defaultKind?: ExtensionKind): readonly ExtensionManifest[] {
  const files: string[] = [];
  const visit = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory() && !entry.isSymbolicLink()) visit(path);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) files.push(path);
    }
  };
  if (statSync(directory).isDirectory()) visit(directory);
  return files.sort().map((filePath) => loadMarkdownExtension(filePath, source, defaultKind));
}

function sourcePriority(source: ExtensionSource): number {
  return source === 'builtin' ? 0 : source === 'remote' ? 1 : source === 'user' ? 2 : 3;
}

function parseFrontmatter(value: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of value.split('\n')) {
    const index = line.indexOf(':');
    if (index < 1) continue;
    result[line.slice(0, index).trim()] = line.slice(index + 1).trim().replace(/^['"]|['"]$/g, '');
  }
  return result;
}

function parseJsonMetadata(value: string, field: string): Readonly<Record<string, unknown>> {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('must be an object');
    return parsed as Readonly<Record<string, unknown>>;
  } catch (error) {
    throw new Error(`Extension ${field} must be a JSON object: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function parseList(value: string | undefined): string[] {
  if (!value) return [];
  const normalized = value.replace(/^\[|\]$/g, '');
  return normalized.split(',').map((item) => item.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
}
