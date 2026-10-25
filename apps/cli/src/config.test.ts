import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultConfigPath, loadAgentCorpsConfig, resolveConfiguredPath } from './config.js';

describe('AgentCorps configuration', () => {
  it('discovers an absent configuration as the versioned empty config', () => {
    const home = mkdtempSync(join(tmpdir(), 'agentcorps-config-empty-'));
    try {
      expect(defaultConfigPath(home)).toBe(join(home, '.agentcorps', 'config.json'));
      expect(loadAgentCorpsConfig(defaultConfigPath(home))).toEqual({ version: 1 });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('rejects unknown fields and malformed values', () => {
    const directory = mkdtempSync(join(tmpdir(), 'agentcorps-config-invalid-'));
    try {
      const path = join(directory, 'config.json');
      writeFileSync(path, JSON.stringify({ version: 1, defaults: { unsupported: true } }));
      expect(() => loadAgentCorpsConfig(path)).toThrow('Unknown field in defaults configuration');
      writeFileSync(path, JSON.stringify({ version: 1, tools: { kimi: { timeoutMs: 0 } } }));
      expect(() => loadAgentCorpsConfig(path)).toThrow('timeoutMs must be a positive integer');
      writeFileSync(path, JSON.stringify({ version: 1, git: { allowWrite: 'yes' } }));
      expect(() => loadAgentCorpsConfig(path)).toThrow('git.allowWrite and git.requireApproval must be booleans');
      writeFileSync(path, JSON.stringify({ version: 1, terminal: { defaultTimeoutMs: 700000 } }));
      expect(() => loadAgentCorpsConfig(path)).toThrow('terminal.allowExec, terminal.requireApproval, and terminal.defaultTimeoutMs are invalid');
      writeFileSync(path, '{');
      expect(() => loadAgentCorpsConfig(path)).toThrow('Invalid AgentCorps JSON configuration');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('loads gateway, browser, and per-agent sandbox settings', () => {
    const directory = mkdtempSync(join(tmpdir(), 'agentcorps-config-complete-'));
    try {
      const path = join(directory, 'config.json');
      writeFileSync(path, JSON.stringify({ version: 1, gateway: { host: '127.0.0.1', port: 43210, corsOrigin: 'http://127.0.0.1:4173', identityRequired: true }, browser: { endpoint: 'http://127.0.0.1:9222', allowControl: true, requireApproval: true, network: 'allowlist', allowedHosts: ['example.com'] }, tools: { command: { command: 'node', sandbox: { backend: 'container', containerImage: 'node:22', network: 'none', maxMemoryMb: 512 } } } }));
      const config = loadAgentCorpsConfig(path);
      expect(config.gateway?.port).toBe(43210);
      expect(config.browser?.allowedHosts).toEqual(['example.com']);
      expect(config.tools?.command?.sandbox?.backend).toBe('container');
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
  it('expands home-relative paths and resolves relative paths from the launch directory', () => {
    const home = '/tmp/agentcorps-home';
    expect(resolveConfiguredPath('~/workspace', home, '/tmp/project')).toBe('/tmp/agentcorps-home/workspace');
    expect(resolveConfiguredPath('./workspace', home, '/tmp/project')).toBe('/tmp/project/workspace');
  });
});
