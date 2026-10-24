import { readFileSync } from 'node:fs';

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
  readonly permissions: readonly ExtensionPermission[];
  readonly events: readonly string[];
  readonly body?: string;
}

const kinds = new Set<ExtensionKind>(['plugin', 'skill', 'rule', 'command', 'hook']);
const permissions = new Set<ExtensionPermission>(['fs.read', 'fs.write', 'process.exec', 'network.connect', 'secret.read']);

export class ExtensionRegistry {
  private readonly entries = new Map<string, ExtensionManifest>();

  register(manifest: ExtensionManifest): ExtensionManifest {
    validateManifest(manifest);
    const existing = this.entries.get(manifest.id);
    if (existing && existing.version !== manifest.version) throw new Error(`Extension ID already registered with another version: ${manifest.id}`);
    this.entries.set(manifest.id, manifest);
    return manifest;
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
    permissions: declaredPermissions as ExtensionPermission[],
    events: parseList(metadata.events),
    body: match[2] ?? '',
  };
}

export function validateManifest(manifest: ExtensionManifest): void {
  if (!manifest.id.trim() || !manifest.name.trim()) throw new Error('Extension id and name are required');
  if (!kinds.has(manifest.kind)) throw new Error(`Unknown extension kind: ${manifest.kind}`);
  if (!/^\d+\.\d+\.\d+$/.test(manifest.version)) throw new Error(`Extension version must be semver: ${manifest.version}`);
  for (const permission of manifest.permissions) if (!permissions.has(permission)) throw new Error(`Unknown extension permission: ${permission}`);
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

function parseList(value: string | undefined): string[] {
  if (!value) return [];
  const normalized = value.replace(/^\[|\]$/g, '');
  return normalized.split(',').map((item) => item.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
}
