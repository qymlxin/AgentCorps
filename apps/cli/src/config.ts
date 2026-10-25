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
  readonly sandbox?: {
    readonly backend?: 'macos' | 'container';
    readonly containerImage?: string;
    readonly network?: 'none' | 'full';
    readonly maxMemoryMb?: number;
    readonly maxCpu?: number;
    readonly maxPids?: number;
  };
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
  readonly gateway?: { readonly host?: string; readonly port?: number; readonly token?: string; readonly readOnlyToken?: string; readonly corsOrigin?: string; readonly identityRequired?: boolean };
  readonly git?: { readonly allowWrite?: boolean; readonly requireApproval?: boolean };
  readonly terminal?: { readonly allowExec?: boolean; readonly requireApproval?: boolean; readonly defaultTimeoutMs?: number };
  readonly browser?: { readonly endpoint?: string; readonly allowControl?: boolean; readonly requireApproval?: boolean; readonly network?: 'none' | 'allowlist' | 'full'; readonly allowedHosts?: readonly string[]; readonly timeoutMs?: number; readonly maxTextBytes?: number; readonly maxScreenshotBytes?: number };
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
  const allowed = new Set(['version', 'paths', 'defaults', 'tools', 'toolDefinitions', 'roles', 'gateway', 'git', 'terminal', 'browser']);
  if (Object.keys(value).some((key) => !allowed.has(key))) throw new Error(`Unknown field in AgentCorps configuration: ${path}`);
  if (value.paths !== undefined) validatePaths(value.paths, path);
  if (value.defaults !== undefined) validateDefaults(value.defaults, path);
  if (value.tools !== undefined) validateTools(value.tools, path);
  if (value.toolDefinitions !== undefined && (!Array.isArray(value.toolDefinitions) || value.toolDefinitions.some((entry) => !isRecord(entry)))) throw new Error(`toolDefinitions must be an array of tool definitions: ${path}`);
  if (value.roles !== undefined) validateRoles(value.roles, path);
  if (value.gateway !== undefined) validateGateway(value.gateway, path);
  if (value.git !== undefined) validateGit(value.git, path);
  if (value.terminal !== undefined) validateTerminal(value.terminal, path);
  if (value.browser !== undefined) validateBrowser(value.browser, path);
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
  const allowed = new Set(['command', 'args', 'cwd', 'workspaceRoot', 'env', 'model', 'role', 'instructions', 'timeoutMs', 'approvalMode', 'sandbox']);
  for (const [id, config] of Object.entries(value)) {
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(id) || !isRecord(config)) throw new Error(`Invalid tool configuration: ${id}`);
    if (Object.keys(config).some((key) => !allowed.has(key))) throw new Error(`Unknown field in tools.${id}: ${path}`);
    for (const key of ['command', 'cwd', 'workspaceRoot', 'model', 'role', 'instructions']) if (config[key] !== undefined && typeof config[key] !== 'string') throw new Error(`tools.${id}.${key} must be a string: ${path}`);
    if (config.args !== undefined && (!Array.isArray(config.args) || !config.args.every((entry) => typeof entry === 'string' && !entry.includes('\0')))) throw new Error(`tools.${id}.args must be strings: ${path}`);
    if (config.env !== undefined && (!isRecord(config.env) || Object.values(config.env).some((entry) => typeof entry !== 'string' || entry.includes('\0')))) throw new Error(`tools.${id}.env must contain string values: ${path}`);
    if (config.timeoutMs !== undefined && (!Number.isInteger(config.timeoutMs) || config.timeoutMs < 1)) throw new Error(`tools.${id}.timeoutMs must be a positive integer: ${path}`);
    if (config.approvalMode !== undefined && config.approvalMode !== 'never' && config.approvalMode !== 'always') throw new Error(`tools.${id}.approvalMode must be never or always: ${path}`);
    if (config.sandbox !== undefined) validateSandbox(config.sandbox, `tools.${id}.sandbox`, path);
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

function validateGateway(value: unknown, path: string): void {
  if (!isRecord(value)) throw new Error(`gateway must be an object: ${path}`);
  const allowed = new Set(['host', 'port', 'token', 'readOnlyToken', 'corsOrigin', 'identityRequired']);
  if (Object.keys(value).some((key) => !allowed.has(key))) throw new Error(`Unknown field in gateway configuration: ${path}`);
  if (value.host !== undefined && !isNonEmptyString(value.host)) throw new Error(`gateway.host must be a non-empty string: ${path}`);
  if (value.port !== undefined && (!Number.isInteger(value.port) || value.port < 1 || value.port > 65535)) throw new Error(`gateway.port must be between 1 and 65535: ${path}`);
  for (const key of ['token', 'readOnlyToken', 'corsOrigin']) if (value[key] !== undefined && !isNonEmptyString(value[key])) throw new Error(`gateway.${key} must be a non-empty string: ${path}`);
  if (value.identityRequired !== undefined && typeof value.identityRequired !== 'boolean') throw new Error(`gateway.identityRequired must be a boolean: ${path}`);
}

function validateSandbox(value: unknown, field: string, path: string): void {
  if (!isRecord(value)) throw new Error(`${field} must be an object: ${path}`);
  const allowed = new Set(['backend', 'containerImage', 'network', 'maxMemoryMb', 'maxCpu', 'maxPids']);
  if (Object.keys(value).some((key) => !allowed.has(key))) throw new Error(`Unknown field in ${field}: ${path}`);
  if (value.backend !== undefined && value.backend !== 'macos' && value.backend !== 'container') throw new Error(`${field}.backend must be macos or container: ${path}`);
  if (value.containerImage !== undefined && !isNonEmptyString(value.containerImage)) throw new Error(`${field}.containerImage must be a non-empty string: ${path}`);
  if (value.network !== undefined && value.network !== 'none' && value.network !== 'full') throw new Error(`${field}.network must be none or full: ${path}`);
  for (const key of ['maxMemoryMb', 'maxCpu', 'maxPids']) if (value[key] !== undefined && (!Number.isInteger(value[key]) || value[key] < 1)) throw new Error(`${field}.${key} must be a positive integer: ${path}`);
}

function validateGit(value: unknown, path: string): void {
  if (!isRecord(value) || Object.keys(value).some((key) => key !== 'allowWrite' && key !== 'requireApproval') || (value.allowWrite !== undefined && typeof value.allowWrite !== 'boolean') || (value.requireApproval !== undefined && typeof value.requireApproval !== 'boolean')) throw new Error(`git.allowWrite and git.requireApproval must be booleans: ${path}`);
}

function validateTerminal(value: unknown, path: string): void {
  if (!isRecord(value) || Object.keys(value).some((key) => key !== 'allowExec' && key !== 'requireApproval' && key !== 'defaultTimeoutMs') || (value.allowExec !== undefined && typeof value.allowExec !== 'boolean') || (value.requireApproval !== undefined && typeof value.requireApproval !== 'boolean') || (value.defaultTimeoutMs !== undefined && (!Number.isInteger(value.defaultTimeoutMs) || value.defaultTimeoutMs < 1 || value.defaultTimeoutMs > 600000))) throw new Error(`terminal.allowExec, terminal.requireApproval, and terminal.defaultTimeoutMs are invalid: ${path}`);
}

function validateBrowser(value: unknown, path: string): void {
  if (!isRecord(value)) throw new Error(`browser must be an object: ${path}`);
  const allowed = new Set(['endpoint', 'allowControl', 'requireApproval', 'network', 'allowedHosts', 'timeoutMs', 'maxTextBytes', 'maxScreenshotBytes']);
  if (Object.keys(value).some((key) => !allowed.has(key))) throw new Error(`Unknown field in browser configuration: ${path}`);
  if (value.endpoint !== undefined && (!isNonEmptyString(value.endpoint) || !/^https?:\/\/[^\s]+$/.test(value.endpoint))) throw new Error(`browser.endpoint must be an HTTP or HTTPS URL: ${path}`);
  for (const key of ['allowControl', 'requireApproval']) if (value[key] !== undefined && typeof value[key] !== 'boolean') throw new Error(`browser.${key} must be a boolean: ${path}`);
  if (value.network !== undefined && value.network !== 'none' && value.network !== 'allowlist' && value.network !== 'full') throw new Error(`browser.network must be none, allowlist, or full: ${path}`);
  if (value.allowedHosts !== undefined && (!Array.isArray(value.allowedHosts) || value.allowedHosts.some((host) => !isNonEmptyString(host)))) throw new Error(`browser.allowedHosts must be an array of host strings: ${path}`);
  for (const key of ['timeoutMs', 'maxTextBytes', 'maxScreenshotBytes']) if (value[key] !== undefined && (!Number.isInteger(value[key]) || value[key] < 1)) throw new Error(`browser.${key} must be a positive integer: ${path}`);
  if (value.timeoutMs !== undefined && value.timeoutMs > 120000) throw new Error(`browser.timeoutMs cannot exceed 120000: ${path}`);
  if (value.maxTextBytes !== undefined && value.maxTextBytes > 4 * 1024 * 1024) throw new Error(`browser.maxTextBytes cannot exceed 4194304: ${path}`);
  if (value.maxScreenshotBytes !== undefined && value.maxScreenshotBytes > 16 * 1024 * 1024) throw new Error(`browser.maxScreenshotBytes cannot exceed 16777216: ${path}`);
}

function isRecord(value: unknown): value is Record<string, any> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function isNonEmptyString(value: unknown): value is string { return typeof value === 'string' && value.trim().length > 0 && !value.includes('\0'); }
