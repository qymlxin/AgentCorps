import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import type { AgentToolDefinition, RolePreset } from '@agentcorps/adapters';

export interface AgentRuntimeConfig {
  readonly command?: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly workspaceRoot?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly model?: string;
  readonly role?: string;
  readonly instructions?: string;
  readonly timeoutMs?: number;
  readonly approvalMode?: 'never' | 'always';
}

export interface CustomRoleConfig {
  readonly displayName: string;
  readonly description: string;
  readonly prompt: string;
}

export interface AgentCorpsConfig {
  readonly version: 1;
  readonly paths?: { readonly dataDir?: string; readonly workspaceRoot?: string };
  readonly defaults?: {
    readonly agent?: string;
    readonly model?: string;
    readonly role?: string;
    readonly instructions?: string;
  };
  readonly tools?: Readonly<Record<string, AgentRuntimeConfig>>;
  readonly toolDefinitions?: readonly AgentToolDefinition[];
  readonly roles?: Readonly<Record<string, CustomRoleConfig>>;
}

export const defaultConfigPath = (home = homedir()): string => join(home, '.agentcorps', 'config.json');

export function resolveConfiguredPath(value: string, home = homedir(), base = process.cwd()): string {
  const expanded = value === '~' ? home : value.startsWith('~/') ? join(home, value.slice(2)) : value;
  return isAbsolute(expanded) ? expanded : resolve(base, expanded);
}

const emptyConfig: AgentCorpsConfig = Object.freeze({ version: 1 });

export function loadAgentCorpsConfig(path = defaultConfigPath()): AgentCorpsConfig {
  if (!existsSync(path)) return emptyConfig;
  const contents = readFileSync(path, 'utf8');
  if (Buffer.byteLength(contents) > 1024 * 1024) throw new Error(`AgentCorps configuration exceeds 1 MiB: ${path}`);
  let value: unknown;
  try { value = JSON.parse(contents); } catch (error) { throw new Error(`Invalid AgentCorps JSON configuration: ${path}`, { cause: error }); }
  return validateConfig(value, path);
}

export function roleFromConfig(id: string, config: AgentCorpsConfig): RolePreset | undefined {
  const custom = config.roles?.[id];
  if (!custom) return undefined;
  return Object.freeze({ id, displayName: custom.displayName, description: custom.description, prompt: custom.prompt });
}

function validateConfig(value: unknown, path: string): AgentCorpsConfig {
  if (!isRecord(value) || value.version !== 1) throw new Error(`AgentCorps configuration must contain version: 1: ${path}`);
  const allowed = new Set(['version', 'paths', 'defaults', 'tools', 'toolDefinitions', 'roles']);
  if (Object.keys(value).some((key) => !allowed.has(key))) throw new Error(`Unknown field in AgentCorps configuration: ${path}`);
  if (value.paths !== undefined) validatePaths(value.paths, path);
  if (value.defaults !== undefined) validateDefaults(value.defaults, path);
  if (value.tools !== undefined) validateTools(value.tools, path);
  if (value.toolDefinitions !== undefined && (!Array.isArray(value.toolDefinitions) || value.toolDefinitions.some((entry) => !isRecord(entry)))) throw new Error(`toolDefinitions must be an array of tool definitions: ${path}`);
  if (value.roles !== undefined) validateRoles(value.roles, path);
  return value as unknown as AgentCorpsConfig;
}

function validatePaths(value: unknown, path: string): void {
  if (!isRecord(value)) throw new Error(`paths must be an object: ${path}`);
  if (Object.keys(value).some((key) => key !== 'dataDir' && key !== 'workspaceRoot')) throw new Error(`Unknown field in paths configuration: ${path}`);
  for (const key of ['dataDir', 'workspaceRoot']) if (value[key] !== undefined && !isNonEmptyString(value[key])) throw new Error(`paths.${key} must be a non-empty string: ${path}`);
}

function validateDefaults(value: unknown, path: string): void {
  if (!isRecord(value)) throw new Error(`defaults must be an object: ${path}`);
  const allowed = new Set(['agent', 'model', 'role', 'instructions']);
  if (Object.keys(value).some((key) => !allowed.has(key))) throw new Error(`Unknown field in defaults configuration: ${path}`);
  for (const key of ['agent', 'model', 'role', 'instructions']) if (value[key] !== undefined && typeof value[key] !== 'string') throw new Error(`defaults.${key} must be a string: ${path}`);
}

function validateTools(value: unknown, path: string): void {
  if (!isRecord(value)) throw new Error(`tools must be an object: ${path}`);
  const allowed = new Set(['command', 'args', 'cwd', 'workspaceRoot', 'env', 'model', 'role', 'instructions', 'timeoutMs', 'approvalMode']);
  for (const [id, config] of Object.entries(value)) {
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(id) || !isRecord(config)) throw new Error(`Invalid tool configuration: ${id}`);
    if (Object.keys(config).some((key) => !allowed.has(key))) throw new Error(`Unknown field in tools.${id}: ${path}`);
    for (const key of ['command', 'cwd', 'workspaceRoot', 'model', 'role', 'instructions']) if (config[key] !== undefined && typeof config[key] !== 'string') throw new Error(`tools.${id}.${key} must be a string: ${path}`);
    if (config.args !== undefined && (!Array.isArray(config.args) || !config.args.every((entry) => typeof entry === 'string' && !entry.includes('\0')))) throw new Error(`tools.${id}.args must be strings: ${path}`);
    if (config.env !== undefined && (!isRecord(config.env) || Object.values(config.env).some((entry) => typeof entry !== 'string' || entry.includes('\0')))) throw new Error(`tools.${id}.env must contain string values: ${path}`);
    if (config.timeoutMs !== undefined && (!Number.isInteger(config.timeoutMs) || config.timeoutMs < 1)) throw new Error(`tools.${id}.timeoutMs must be a positive integer: ${path}`);
    if (config.approvalMode !== undefined && config.approvalMode !== 'never' && config.approvalMode !== 'always') throw new Error(`tools.${id}.approvalMode must be never or always: ${path}`);
  }
}

function validateRoles(value: unknown, path: string): void {
  if (!isRecord(value)) throw new Error(`roles must be an object: ${path}`);
  for (const [id, role] of Object.entries(value)) {
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(id) || !isRecord(role)) throw new Error(`Invalid custom role: ${id}`);
    const allowed = new Set(['displayName', 'description', 'prompt']);
    if (Object.keys(role).some((key) => !allowed.has(key)) || !isNonEmptyString(role.displayName) || !isNonEmptyString(role.description) || !isNonEmptyString(role.prompt)) throw new Error(`Invalid custom role: ${id}`);
  }
}

function isRecord(value: unknown): value is Record<string, any> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function isNonEmptyString(value: unknown): value is string { return typeof value === 'string' && value.trim().length > 0 && !value.includes('\0'); }
