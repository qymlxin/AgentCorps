import { registerKimi } from './providers/kimi.js';
import { registerQwen } from './providers/qwen.js';
import { registerZCode } from './providers/zcode.js';
import { registerDeepSeekHarness } from './providers/deepseek-harness.js';
import { registerOpenCode } from './providers/opencode.js';
import { registerGemini } from './providers/gemini.js';
import { registerAider } from './providers/aider.js';
import type { AgentOutputDecoder } from './output.js';
import type { AcpClientCapabilities } from '@agentcorps/protocols';
import { CommandAgentAdapter, AcpAgentAdapter, type AcpHost, type AcpHostOptions, type CommandAgentOptions } from './index.js';
import { getRolePreset, withRole } from './roles.js';
import type { AgentAdapter, AgentRequest } from '@agentcorps/runtime';

export interface AgentToolDefinition {
  readonly id: string;
  readonly displayName: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly transport?: 'command' | 'acp';
  readonly outputFormat: 'text' | 'jsonl';
  readonly outputProtocol?: string;
  readonly promptPlacement?: 'argument' | 'stdin';
  readonly promptFlag?: string;
  readonly modelFlag?: string;
  readonly versionArgs?: readonly string[];
  readonly documentationUrl?: string;
  readonly defaultRole?: string;
}

export interface CreateToolOptions {
  readonly command?: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly model?: string;
  readonly role?: string | null;
  readonly instructions?: string;
  readonly timeoutMs?: number;
  readonly sandbox?: CommandAgentOptions['sandbox'];
  readonly acp?: {
    readonly clientCapabilities?: AcpClientCapabilities;
    readonly host?: AcpHost | AcpHostOptions | ((request: AgentRequest) => AcpHost | AcpHostOptions);
    readonly onRequest?: (method: string, params: unknown, request?: AgentRequest) => unknown | Promise<unknown>;
  };
}

/** Definitions are data, never shell strings or dynamically imported code. */
export class AgentToolRegistry {
  private readonly definitions = new Map<string, AgentToolDefinition>();
  private readonly decoders = new Map<string, () => AgentOutputDecoder>();

  registerDecoder(id: string, factory: () => AgentOutputDecoder): this {
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(id) || typeof factory !== 'function') throw new Error('Invalid output decoder registration');
    if (this.decoders.has(id)) throw new Error(`Duplicate output decoder: ${id}`);
    this.decoders.set(id, factory);
    return this;
  }

  register(definition: AgentToolDefinition): this {
    validateDefinition(definition);
    if (definition.outputProtocol && !this.decoders.has(definition.outputProtocol)) throw new Error(`Unknown output protocol: ${definition.outputProtocol}`);
    if (this.definitions.has(definition.id)) throw new Error(`Duplicate agent tool: ${definition.id}`);
    this.definitions.set(definition.id, Object.freeze({ ...definition, args: Object.freeze([...definition.args]), ...(definition.env ? { env: Object.freeze({ ...definition.env }) } : {}), ...(definition.versionArgs ? { versionArgs: Object.freeze([...definition.versionArgs]) } : {}) }));
    return this;
  }

  list(): readonly AgentToolDefinition[] {
    return [...this.definitions.values()].map(({ env: _env, ...definition }) => definition);
  }

  get(id: string): AgentToolDefinition {
    const definition = this.definitions.get(id);
    if (!definition) throw new Error(`Unknown agent: ${id}. Available tools: ${this.list().map((entry) => entry.id).join(', ')}`);
    return definition;
  }

  create(id: string, options: CreateToolOptions = {}): AgentAdapter {
    const definition = this.get(id);
    if (definition.transport === 'acp') {
      const adapter = new AcpAgentAdapter({
        id: definition.id,
        displayName: definition.displayName,
        ...(options.model ? { model: options.model } : {}),
        clientOptions: {
          command: options.command ?? definition.command,
          args: options.args ?? definition.args,
          ...(options.cwd ? { cwd: options.cwd } : {}),
          ...(options.env ?? definition.env ? { env: options.env ?? definition.env } : {}),
          ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
          clientName: 'AgentCorps',
          clientVersion: '0.1.0',
          ...(options.acp?.clientCapabilities ? { clientCapabilities: options.acp.clientCapabilities } : {}),
          ...(options.acp?.host ? { host: options.acp.host } : {}),
        },
        ...(options.acp?.onRequest ? { onRequest: options.acp.onRequest } : {}),
      });
      const role = options.role === null ? undefined : options.role ?? definition.defaultRole;
      return withRole(adapter, { ...(role ? { role: getRolePreset(role) } : {}), ...(options.instructions ? { instructions: options.instructions } : {}) });
    }
    if (options.model && !definition.modelFlag) throw new Error(`Tool ${id} does not declare a model selection flag`);
    const args = [...(options.args ?? definition.args), ...(options.model ? [definition.modelFlag!, options.model] : [])];
    const adapter = new CommandAgentAdapter({
      id: definition.id, displayName: definition.displayName, command: options.command ?? definition.command,
      args, outputFormat: definition.outputFormat,
      ...(definition.outputProtocol ? { outputDecoder: this.decoders.get(definition.outputProtocol)! } : {}),
      ...(definition.promptPlacement ? { promptPlacement: definition.promptPlacement } : {}),
      ...(definition.promptFlag && !options.args ? { promptFlag: definition.promptFlag } : {}),
      ...(options.cwd ? { cwd: options.cwd } : {}), ...(options.env ?? definition.env ? { env: options.env ?? definition.env } : {}),
      ...(options.model ? { model: options.model } : {}),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      ...(options.sandbox ? { sandbox: options.sandbox } : {}),
    });
    const role = options.role === null ? undefined : options.role ?? definition.defaultRole;
    return withRole(adapter, { ...(role ? { role: getRolePreset(role) } : {}), ...(options.instructions ? { instructions: options.instructions } : {}) });
  }
}

export function loadAcpAgentServers(value: unknown, registry: AgentToolRegistry): void {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !('agent_servers' in value) || !isRecord(value.agent_servers)) throw new Error('ACP config must contain agent_servers: {}');
  const config = value as Record<string, unknown>;
  if (Object.keys(config).some((key) => key !== 'agent_servers' && key !== 'default_mcp_settings')) throw new Error('Unknown field in ACP configuration');
  if (config.default_mcp_settings !== undefined && !isRecord(config.default_mcp_settings)) throw new Error('ACP default_mcp_settings must be an object');
  for (const [displayName, rawDefinition] of Object.entries(value.agent_servers)) {
    if (!isRecord(rawDefinition)) throw new Error(`Invalid ACP agent server: ${displayName}`);
    const allowed = new Set(['command', 'args', 'env']);
    if (Object.keys(rawDefinition).some((key) => !allowed.has(key))) throw new Error(`Unknown field in ACP agent server: ${displayName}`);
    if (typeof rawDefinition.command !== 'string' || !rawDefinition.command.trim()) throw new Error(`ACP agent server command is required: ${displayName}`);
    if (rawDefinition.args !== undefined && (!Array.isArray(rawDefinition.args) || !rawDefinition.args.every((entry) => typeof entry === 'string' && !entry.includes('\\0')))) throw new Error(`ACP agent server args must be strings: ${displayName}`);
    if (rawDefinition.env !== undefined && (!isRecord(rawDefinition.env) || Object.values(rawDefinition.env).some((entry) => typeof entry !== 'string' || entry.includes('\\0')))) throw new Error(`ACP agent server env must contain string values: ${displayName}`);
    const id = acpAgentId(displayName);
    registry.register({
      id,
      displayName,
      command: rawDefinition.command,
      args: (rawDefinition.args ?? []) as string[],
      ...(rawDefinition.env ? { env: rawDefinition.env as Record<string, string> } : {}),
      transport: 'acp',
      outputFormat: 'text',
    });
  }
}

function acpAgentId(displayName: string): string {
  const id = displayName.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
  if (!id || !/^[a-z]/.test(id)) throw new Error(`ACP agent server name cannot be converted to an agent id: ${displayName}`);
  return id;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function validateDefinition(value: AgentToolDefinition): void {
  if (typeof value.id !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(value.id)) throw new Error('Agent tool id must be a lowercase slug');
  if (typeof value.displayName !== 'string' || !value.displayName.trim() || typeof value.command !== 'string' || !value.command.trim()) throw new Error('Agent tool requires displayName and command strings');
  if (value.command.includes('\0')) throw new Error('Invalid agent executable');
  if (!Array.isArray(value.args) || !value.args.every((entry) => typeof entry === 'string' && !entry.includes('\0'))) throw new Error('Agent args must be an array of strings');
  if (value.env !== undefined && (!isRecord(value.env) || Object.values(value.env).some((entry) => typeof entry !== 'string' || entry.includes('\0')))) throw new Error('Agent env must contain string values');
  if (!['text', 'jsonl'].includes(value.outputFormat)) throw new Error('Agent outputFormat must be text or jsonl');
  if (value.transport !== undefined && value.transport !== 'command' && value.transport !== 'acp') throw new Error('Agent tool transport must be command or acp');
  if (value.transport === 'acp' && value.outputProtocol !== undefined) throw new Error('ACP tools cannot declare an output protocol');
  if (value.transport === 'acp' && (value.promptPlacement !== undefined || value.promptFlag !== undefined || value.modelFlag !== undefined)) throw new Error('ACP tools cannot declare command prompt or model flags');
  if (value.promptPlacement !== undefined && !['argument', 'stdin'].includes(value.promptPlacement)) throw new Error('Invalid prompt placement');
  if (value.promptPlacement === 'stdin' && value.promptFlag !== undefined) throw new Error('stdin tools cannot declare a prompt flag');
  for (const flag of [value.promptFlag, value.modelFlag]) if (flag !== undefined && flag !== '--' && (typeof flag !== 'string' || !/^--?[a-zA-Z][a-zA-Z0-9-]*$/.test(flag))) throw new Error('Invalid agent option flag');
  if (value.versionArgs !== undefined && (!Array.isArray(value.versionArgs) || !value.versionArgs.every((entry) => typeof entry === 'string' && !entry.includes('\0')))) throw new Error('versionArgs must be strings without NUL bytes');
  if (value.outputProtocol !== undefined && (typeof value.outputProtocol !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(value.outputProtocol) || value.outputFormat !== 'jsonl')) throw new Error('outputProtocol requires a decoder id and jsonl output');
  if (value.documentationUrl !== undefined && typeof value.documentationUrl !== 'string') throw new Error('documentationUrl must be a string');
  if (value.defaultRole !== undefined) {
    if (typeof value.defaultRole !== 'string') throw new Error('defaultRole must be a role id string');
    getRolePreset(value.defaultRole);
  }
}

/** Only explicit, trusted configuration may register executable definitions. */
export function loadAgentToolDefinitions(value: unknown, registry: AgentToolRegistry): void {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !('version' in value) || value.version !== 1 || !('tools' in value) || !Array.isArray(value.tools)) throw new Error('Agent config must contain version: 1 and tools: []');
  if (Object.keys(value).some((key) => key !== 'version' && key !== 'tools')) throw new Error('Unknown field in agent configuration');
  for (const entry of value.tools) {
    if (!entry || typeof entry !== 'object') throw new Error('Invalid agent tool definition');
    const allowed = new Set(['id', 'displayName', 'command', 'args', 'env', 'transport', 'outputFormat', 'outputProtocol', 'promptPlacement', 'promptFlag', 'modelFlag', 'versionArgs', 'documentationUrl', 'defaultRole']);
    if (Object.keys(entry).some((key) => !allowed.has(key))) throw new Error('Unknown field in agent tool definition');
    registry.register(entry as AgentToolDefinition);
  }
}

export function createAgentToolRegistry(): AgentToolRegistry {
  const registry = new AgentToolRegistry()
    .register({ id: 'codex', displayName: 'OpenAI Codex CLI', command: 'codex', args: ['exec', '--json'], outputFormat: 'jsonl', modelFlag: '--model' })
    .register({ id: 'claude-code', displayName: 'Anthropic Claude Code', command: 'claude', args: ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages'], outputFormat: 'jsonl', modelFlag: '--model' })
    .register({ id: 'cursor', displayName: 'Cursor CLI', command: 'agent', args: ['-p', '--output-format', 'stream-json', '--stream-partial-output'], outputFormat: 'jsonl', modelFlag: '--model' });
  registerKimi(registry);
  registerQwen(registry);
  registerZCode(registry);
  registerDeepSeekHarness(registry);
  registerOpenCode(registry);
  registerGemini(registry);
  registerAider(registry);
  return registry;
}
