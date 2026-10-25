import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ExtensionRegistry, loadMarkdownExtension, scanMarkdownExtensions } from './index.js';

describe('extension registry', () => {
  it('loads a versioned skill manifest with permissions and body', () => {
    const directory = mkdtempSync(join(tmpdir(), 'agentcorps-extension-'));
    const path = join(directory, 'review.md');
    try {
      writeFileSync(path, `---\nid: review.skill\nkind: skill\nname: Release review\nversion: 1.2.0\ndescription: Review a release\npermissions: [fs.read]\nevents: [task.completed]\n---\n\nUse evidence before making a recommendation.\n`);
      const manifest = loadMarkdownExtension(path, 'workspace');
      expect(manifest.kind).toBe('skill');
      expect(manifest.permissions).toEqual(['fs.read']);
      expect(manifest.body).toContain('Use evidence');
      const registry = new ExtensionRegistry();
      registry.register(manifest);
      expect(registry.list('skill')).toHaveLength(1);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('scans nested extension directories and rejects content conflicts', () => {
    const directory = mkdtempSync(join(tmpdir(), 'agentcorps-extension-scan-'));
    const nested = join(directory, 'nested');
    mkdirSync(nested);
    try {
      writeFileSync(join(nested, 'rule.md'), `---\nid: shared.rule\nkind: rule\nname: Shared\nversion: 1.0.0\n---\nRule body\n`);
      const manifest = scanMarkdownExtensions(directory, 'workspace')[0];
      expect(manifest?.contentHash).toMatch(/^[a-f0-9]{64}$/);
      const registry = new ExtensionRegistry();
      registry.register(manifest!);
      expect(() => registry.register({ ...manifest!, body: 'different', contentHash: 'different' })).toThrow('another version or content');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it('rejects duplicate IDs with different versions', () => {
    const registry = new ExtensionRegistry();
    const manifest = { id: 'x', kind: 'rule' as const, name: 'Rule', version: '1.0.0', description: '', source: 'builtin' as const, permissions: [], events: [] };
    registry.register(manifest);
    expect(() => registry.register({ ...manifest, version: '2.0.0' })).toThrow('another version');
  });
});
