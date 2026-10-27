#!/usr/bin/env node
import { parseCommandOptions } from './options.js';
import { defaultConfigPath, loadAgentCorpsConfig, resolveConfiguredPath, roleFromConfig, type AgentCorpsConfig, type AgentRuntimeConfig } from './config.js';
import { createHash, randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline';
import { copyFileSync, existsSync, mkdirSync, chmodSync, readFileSync, renameSync, writeFileSync, accessSync, constants } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { CommandAgentAdapter, createAgentToolRegistry, loadAgentToolDefinitions, probeAgent, getRolePreset, ROLE_PRESETS, withRole, type AgentProbeOptions, type CommandAgentOptions, type RolePreset } from '@agentcorps/adapters';
import type { AgentAdapter } from '@agentcorps/runtime';
import type { Mode, TaskId } from '@agentcorps/domain';
import { listenGateway, type RunAgentContext } from '@agentcorps/gateway';
import { SqliteChannelStateStore } from '@agentcorps/channels';
import { JsonlMemoryStore, migrateMemoryStore, MemoryService, SqliteMemoryStore } from '@agentcorps/memory';
import { DeviceTokenVerifier, ExternalIdentityResolver, SignedAccessTokenService, SqliteApprovalStore, SqliteAuditLog, PolicyEngine, ApprovalService, createDefaultProfile, isWithin, SqliteDeviceIdentityStore, SqliteExternalIdentityBindingStore, type ChannelKind, type DeviceIdentity, type ExternalIdentityRole } from '@agentcorps/security';
import { JsonlSessionStore, migrateSessionStore, SessionService, SqliteSessionStore } from '@agentcorps/session';
import { MockAgent, SqliteEventStore, SqliteUsageStore, TaskRuntime, UsageService, ApprovalRequiredError } from '@agentcorps/runtime';

function usage(): never {
  console.error(`AgentCorps CLI 0.1.0

Commands:
  demo                                      Run an in-memory local demo
  serve [--port 43210] [--host 127.0.0.1] [--token TOKEN] [--read-only-token TOKEN] [--data-dir PATH] [--workspace-root PATH] [--git-write] [--git-no-approval] [--terminal-exec] [--terminal-no-approval] [--browser-control] [--browser-no-approval]    Start the local HTTP/SSE/WebSocket gateway (loopback is open by default)
  run "PROMPT" [--agent TOOL] [--model MODEL] [--role ROLE] [--instructions TEXT] [--data-dir PATH]
       Start one complete local Agent run with automatic session and task setup
  tui [--agent TOOL] [--model MODEL] [--role ROLE] [--data-dir PATH]
       Start an interactive terminal Agent session
  task create --title T --objective O       Create a persistent task
       [--mode code|work] [--data-dir PATH]
  task list [--data-dir PATH]               List persistent tasks
  task show TASK_ID [--data-dir PATH]       Show a task and its events
  agents                                    List configured external agent tools
  doctor [--json] [--strict] [--config PATH]  Diagnose gateway, agents, versions, login hints, and models
  roles                                     List reusable role prompt presets
  task run TASK_ID [--agent mock|TOOL|command] [--data-dir PATH]
       [--config PATH] [--agents-config PATH] [--model MODEL]
       [--role developer|reviewer|planner|tester|security|writer] [--role-file PATH] [--instructions TEXT]
       [--agent-command PATH] [--agent-arg ARG] [--workspace-root PATH] [--approval-mode never|always]
       [--sandbox-backend macos|container]
       [--container-image IMAGE] [--sandbox-network full] [--sandbox-memory-mb N] [--sandbox-cpu N] [--sandbox-pids N]
  task cancel TASK_ID [--data-dir PATH]    Cancel a task
  task retry TASK_ID [--data-dir PATH]     Requeue a failed or cancelled task
  task probe [--agent TOOL] [--command PATH] [--agents-config PATH]    Probe an Agent executable
  approval list [--data-dir PATH]      List persisted AgentCorps approvals
  approval approve APPROVAL_ID [--decided-by ID]
  approval deny APPROVAL_ID [--decided-by ID]
  memory save --scope S --content C       Save global/workspace/session memory
       [--workspace-id ID] [--session-id ID] [--sensitivity public|private|secret]
  memory search --query Q                 Search visible memory
       [--workspace-id ID] [--session-id ID] [--include-sensitive]
  memory list                              List exported memories
  memory delete MEMORY_ID                 Soft-delete a memory
  usage summary [--from ISO] [--to ISO] [--tool ID] [--model MODEL] [--kind model|tool|protocol]
  usage calls [--limit N] [--task-id ID] [--run-id ID] [--status STATUS]  List invocation records
  data migrate [--data-dir PATH]          Migrate legacy JSONL sessions and memory
  data export --output PATH               Export events, sessions, messages, and memories
  data backup --output PATH                Copy the SQLite database to a backup file
  data restore --input PATH                Replace the SQLite database from a backup file
  device provision --label LABEL           Create a local device identity and print its token
  device list                              List local device identities
  device token DEVICE_ID [--ttl SECONDS]   Issue a new token for a device
  device revoke DEVICE_ID                  Revoke a local device identity
  identity bind --channel KIND --external-user-id ID --device-id DEVICE [--role user|operator|admin]
  identity list [--include-revoked]         List channel-to-device identity bindings
  identity revoke --channel KIND --external-user-id ID
  serve --identity-required                 Require external channel identity bindings

Built-in tools (TOOL): ${createAgentToolRegistry().list().map((tool) => tool.id).join(', ')}
Use agents to inspect definitions; serve accepts the same tool and role options as task run.
Role presets are prompt guidance, not permission or sandbox enforcement.`);
  process.exit(1);
}

let commandOptions: ReturnType<typeof parseCommandOptions> | undefined;
function options(): ReturnType<typeof parseCommandOptions> {
  return commandOptions ??= parseCommandOptions(process.argv.slice(2));
}

function flag(name: string): string | undefined {
  return options().get(name)?.[0];
}

function hasFlag(name: string): boolean { return options().has(name); }

function requiredFlag(name: string): string {
  const value = flag(name);
  if (!value) {
    console.error(`Missing required flag: ${name}`);
    process.exit(1);
  }
  return value;
}

function taskId(value: string | undefined): TaskId {
  if (!value) usage();
  return value as TaskId;
}

function repeatedFlag(name: string): readonly string[] {
  return options().get(name) ?? [];
}

let configuredAgentCorpsConfig: AgentCorpsConfig | undefined;
function agentCorpsConfig(): AgentCorpsConfig {
  if (configuredAgentCorpsConfig) return configuredAgentCorpsConfig;
  configuredAgentCorpsConfig = loadAgentCorpsConfig(flag('--config') ?? defaultConfigPath());
  return configuredAgentCorpsConfig;
}

function runtimeConfig(agentId: string): AgentRuntimeConfig {
  return agentCorpsConfig().tools?.[agentId] ?? {};
}

function selectedAgentId(override?: string): string {
  return override ?? flag('--agent') ?? agentCorpsConfig().defaults?.agent ?? 'mock';
}

function selectedRole(agentId = selectedAgentId(), requestedRole?: string): { role?: RolePreset; configured: boolean } {
  const config = agentCorpsConfig();
  const configured = runtimeConfig(agentId);
  const roleId = requestedRole ?? flag('--role') ?? configured.role ?? config.defaults?.role;
  const roleFile = flag('--role-file');
  if (roleId && roleFile) throw new Error('--role and --role-file are mutually exclusive');
  if (roleFile) {
    const prompt = readFileSync(resolveConfiguredPath(roleFile), 'utf8').trim();
    if (!prompt || Buffer.byteLength(prompt) > 64 * 1024) throw new Error('--role-file must contain between 1 and 65536 bytes of prompt text');
    return { configured: true, role: { id: 'custom', displayName: 'Custom role', description: 'Explicitly configured prompt file', prompt } };
  }
  if (!roleId) return { configured: false };
  return { configured: true, role: roleFromConfig(roleId, config) ?? getRolePreset(roleId) };
}

function agentInstructions(agentId = selectedAgentId()): string | undefined {
  return flag('--instructions') ?? runtimeConfig(agentId).instructions ?? agentCorpsConfig().defaults?.instructions;
}

let configuredTools: ReturnType<typeof createAgentToolRegistry> | undefined;
function agentTools() {
  if (configuredTools) return configuredTools;
  const registry = createAgentToolRegistry();
  const config = agentCorpsConfig();
  if (config.toolDefinitions?.length) loadAgentToolDefinitions({ version: 1, tools: config.toolDefinitions }, registry);
  const compatibilityConfig = flag('--agents-config');
  if (compatibilityConfig) {
    const contents = readFileSync(resolveConfiguredPath(compatibilityConfig), 'utf8');
    if (Buffer.byteLength(contents) > 1024 * 1024) throw new Error('Agent configuration exceeds 1 MiB');
    loadAgentToolDefinitions(JSON.parse(contents) as unknown, registry);
  }
  configuredTools = registry;
  return registry;
}

function agentForRun(context?: RunAgentContext): AgentAdapter {
  const agentId = selectedAgentId(context?.agent);
  const roleSelection = selectedRole(agentId, context?.role);
  const instructions = context?.instructions ?? agentInstructions(agentId);
  const adapter = withRole(unconfiguredAgentForRun(roleSelection.configured, context, agentId), { ...(roleSelection.role ? { role: roleSelection.role } : {}), ...(instructions !== undefined ? { instructions } : {}) });
  return withAgentControls(adapter, agentId);
}

function agentControlConfig(agentId: string): { cwd: string; workspaceRoot: string; approvalMode: 'never' | 'always' } {
  const configured = runtimeConfig(agentId);
  const workspaceRoot = resolveConfiguredPath(flag('--workspace-root') ?? configured.workspaceRoot ?? configured.cwd ?? process.cwd());
  const cwd = resolveConfiguredPath(configured.cwd ?? flag('--workspace-root') ?? process.cwd());
  if (!isWithin(workspaceRoot, cwd)) throw new Error(`Agent working directory must be inside workspace root: ${cwd}`);
  const approvalMode = flag('--approval-mode') ?? configured.approvalMode ?? 'never';
  if (approvalMode !== 'never' && approvalMode !== 'always') throw new Error('--approval-mode must be never or always');
  return { cwd, workspaceRoot, approvalMode };
}

function unconfiguredAgentForRun(roleConfigured = false, context?: RunAgentContext, agentId = selectedAgentId()): AgentAdapter {
  const selected = agentId;
  const configured = runtimeConfig(selected);
  const controls = agentControlConfig(selected);
  const command = flag('--agent-command') ?? configured.command;
  const args = options().has('--agent-arg') ? repeatedFlag('--agent-arg') : configured.args;
  const model = context?.model ?? flag('--model') ?? configured.model ?? agentCorpsConfig().defaults?.model;
  if (selected === 'mock') return new MockAgent();
  if (selected === 'command') {
    if (!command) throw new Error('--agent-command or tools.command is required for --agent command');
    const sandbox = commandSandbox(controls.cwd, controls.workspaceRoot, configured.sandbox);
    return new CommandAgentAdapter({ id: 'configured-command', displayName: 'Configured command agent', command, ...(args ? { args } : {}), outputFormat: 'text', promptPlacement: 'argument', cwd: controls.cwd, ...(model ? { model } : {}), ...(configured.env ? { env: configured.env } : {}), ...(configured.timeoutMs === undefined ? {} : { timeoutMs: configured.timeoutMs }), ...(sandbox ? { sandbox } : {}) });
  }
  const sandbox = commandSandbox(controls.cwd, controls.workspaceRoot);
  return agentTools().create(selected, {
    ...(command ? { command } : {}), ...(args ? { args } : {}), cwd: controls.cwd,
    ...(configured.env ? { env: configured.env } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(roleConfigured ? { role: null } : {}),
    ...(configured.timeoutMs === undefined ? {} : { timeoutMs: configured.timeoutMs }),
    ...(sandbox ? { sandbox } : {}),
  });
}

function commandSandbox(cwd?: string, workspaceRoot?: string, configured?: AgentRuntimeConfig['sandbox']): CommandAgentOptions['sandbox'] {
  const backend = flag('--sandbox-backend') ?? configured?.backend;
  if (!backend) return undefined;
  if (backend !== 'macos' && backend !== 'container') throw new Error('--sandbox-backend must be macos or container');
  const containerImage = flag('--container-image') ?? configured?.containerImage;
  if (backend === 'container' && !containerImage) throw new Error('--container-image is required for container sandboxing');
  const network = flag('--sandbox-network') ?? configured?.network ?? 'none';
  if (network !== 'none' && network !== 'full') throw new Error('--sandbox-network must be none or full');
  return {
    backend, workspaceRoot: resolveConfiguredPath(workspaceRoot ?? cwd ?? process.cwd()), network,
    ...(containerImage ? { containerImage } : {}),
    maxMemoryMb: Number(flag('--sandbox-memory-mb') ?? configured?.maxMemoryMb ?? '1024'), maxCpu: Number(flag('--sandbox-cpu') ?? configured?.maxCpu ?? '2'), maxPids: Number(flag('--sandbox-pids') ?? configured?.maxPids ?? '128'),
  };
}

let agentControlSecurity: { readonly audit: SqliteAuditLog; readonly store: SqliteApprovalStore; readonly engine: PolicyEngine; readonly approvals: ApprovalService } | undefined;
function agentControlServices(): { readonly audit: SqliteAuditLog; readonly store: SqliteApprovalStore; readonly engine: PolicyEngine; readonly approvals: ApprovalService } {
  if (agentControlSecurity) return agentControlSecurity;
  const dataDir = dataDirectory();
  const databasePath = deviceDatabasePath(dataDir);
  const audit = new SqliteAuditLog(databasePath);
  const store = new SqliteApprovalStore(databasePath);
  agentControlSecurity = { audit, store, engine: new PolicyEngine(audit), approvals: new ApprovalService(store) };
  return agentControlSecurity;
}

function closeAgentControlServices(): void {
  agentControlSecurity?.audit.close();
  agentControlSecurity?.store.close();
  agentControlSecurity = undefined;
}

function withAgentControls(adapter: AgentAdapter, agentId: string): AgentAdapter {
  const controls = agentControlConfig(agentId);
  if (controls.approvalMode === 'never') return adapter;
  const services = agentControlServices();
  return {
    descriptor: adapter.descriptor,
    async execute(request) {
      const toolRequest = {
        requestId: `agent:${request.task.id}:${adapter.descriptor.id}`,
        taskId: request.task.id,
        capability: 'process.exec' as const,
        command: adapter.descriptor.id,
        metadata: { agentId, cwd: controls.cwd, workspaceRoot: controls.workspaceRoot },
      };
      const policy = services.engine.evaluate(toolRequest, { mode: request.task.mode, profile: createDefaultProfile(controls.workspaceRoot, 'S2') });
      if (policy.decision === 'deny') throw new Error(`Agent execution denied: ${policy.reason}`);
      const existing = services.approvals.list().find((approval) => approval.request.requestId === toolRequest.requestId && (approval.status === 'pending' || approval.status === 'approved'));
      if (existing?.status === 'pending') throw new ApprovalRequiredError(existing.id);
      if (existing?.status === 'approved') {
        if (!services.approvals.consume(existing.id)) throw new ApprovalRequiredError(existing.id);
      } else {
        const approval = services.approvals.create(toolRequest, policy);
        throw new ApprovalRequiredError(approval.id);
      }
      await adapter.execute(request);
    },
  };
}

function agentProbeOptions(): AgentProbeOptions {
  const selected = selectedAgentId() === 'mock' ? 'command' : selectedAgentId();
  const configured = runtimeConfig(selected);
  const command = flag('--command') ?? flag('--agent-command') ?? configured.command;
  if (selected === 'command' && command) return { id: 'configured-command', displayName: 'Configured command agent', command };
  if (selected === 'command') throw new Error('--command, --agent-command, or tools.command is required for command probing');
  const definition = agentTools().get(selected);
  return { id: definition.id, displayName: definition.displayName, command: command ?? definition.command, ...(definition.versionArgs ? { versionArgs: definition.versionArgs } : {}) };
}

function dataDirectory(): string {
  return resolveConfiguredPath(flag('--data-dir') ?? agentCorpsConfig().paths?.dataDir ?? join(homedir(), '.agentcorps'));
}

function deviceDatabasePath(dataDir = dataDirectory()): string {
  return join(dataDir, 'agentcorps.db');
}

function accessTokenSecret(dataDir = dataDirectory()): string {
  const configured = process.env.AGENTCORPS_TOKEN_SECRET?.trim();
  if (configured) return configured;
  const path = join(dataDir, 'device-token.secret');
  mkdirSync(dataDir, { recursive: true });
  if (existsSync(path)) {
    const secret = readFileSync(path, 'utf8').trim();
    if (secret.length >= 32) return secret;
    throw new Error(`Device token secret is too short: ${path}`);
  }
  const secret = randomBytes(32).toString('base64url');
  writeFileSync(path, `${secret}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  return secret;
}

function deviceAuth(dataDir = dataDirectory()): { store: SqliteDeviceIdentityStore; tokens: SignedAccessTokenService; verifier: DeviceTokenVerifier } {
  const store = new SqliteDeviceIdentityStore(deviceDatabasePath(dataDir));
  const tokens = new SignedAccessTokenService(accessTokenSecret(dataDir));
  return { store, tokens, verifier: new DeviceTokenVerifier(tokens, store) };
}

function channelKind(value: string | undefined): ChannelKind {
  if (value === 'feishu' || value === 'dingtalk' || value === 'wecom' || value === 'custom') return value;
  throw new Error('--channel must be feishu, dingtalk, wecom, or custom');
}

function identityRoles(): ExternalIdentityRole[] {
  const roles = repeatedFlag('--role');
  const values = roles.length ? roles : ['user'];
  if (values.some((role) => role !== 'user' && role !== 'operator' && role !== 'admin')) throw new Error('--role must be user, operator, or admin');
  return [...new Set(values)] as ExternalIdentityRole[];
}

function identityStore(dataDir = dataDirectory()): SqliteExternalIdentityBindingStore {
  return new SqliteExternalIdentityBindingStore(deviceDatabasePath(dataDir));
}
function provisionDevice(label: string, dataDir = dataDirectory()): DeviceIdentity {
  if (!label.trim()) throw new Error('--label is required');
  const { store, tokens } = deviceAuth(dataDir);
  try {
    const device: DeviceIdentity = { id: `device-${randomBytes(12).toString('hex')}`, label: label.trim(), createdAt: new Date().toISOString() };
    store.save(device);
    console.log(JSON.stringify({ device, token: tokens.issue(device) }, null, 2));
    return device;
  } finally {
    store.close();
  }
}

function runtime(memory = memoryService()): TaskRuntime {
  const databasePath = join(dataDirectory(), 'agentcorps.db');
  return new TaskRuntime({ store: new SqliteEventStore(databasePath), usage: new UsageService(new SqliteUsageStore(databasePath)), memory });
}

function bridgeRunToSession(local: TaskRuntime, sessions: SessionService, task: import('@agentcorps/domain').Task, agentId?: string): () => void {
  let active = true;
  const unsubscribe = local.store.subscribe((event) => {
    if (!active || event.aggregateId !== task.id) return;
    if (event.type === 'run.output' && event.payload.text.trim()) {
      try { sessions.appendMessage({ sessionId: task.sessionId, role: 'agent', content: event.payload.text, ...(agentId ? { agentId } : {}), taskId: task.id }); } catch { /* Keep the runtime event if the session is archived. */ }
    }
    if (event.type === 'task.status_changed' && ['succeeded', 'failed', 'cancelled', 'waiting_approval'].includes(event.payload.to)) { active = false; unsubscribe(); }
  });
  return unsubscribe;
}

function memoryService(): MemoryService {
  return new MemoryService(new SqliteMemoryStore(join(dataDirectory(), 'agentcorps.db')));
}

type DoctorStatus = 'healthy' | 'warning' | 'error';
interface DoctorAgentReport {
  readonly id: string;
  readonly displayName: string;
  readonly command: string;
  readonly installed: boolean;
  readonly version: string;
  readonly login: { readonly status: 'credential-detected' | 'not-detected'; readonly environment: readonly string[] };
  readonly model: { readonly value: string; readonly source: 'tool' | 'default' | 'provider-default' };
  readonly documentationUrl?: string;
  readonly output?: string;
}
interface DoctorReport {
  readonly status: DoctorStatus;
  readonly config: { readonly path: string; readonly status: 'found' | 'using-defaults' };
  readonly data: { readonly directory: string; readonly database: string; readonly writable: boolean };
  readonly gateway: { readonly url: string; readonly status: 'online' | 'offline'; readonly detail?: string };
  readonly agents: readonly DoctorAgentReport[];
}

const credentialEnvironment: Readonly<Record<string, readonly string[]>> = {
  codex: ['OPENAI_API_KEY'],
  'claude-code': ['ANTHROPIC_API_KEY'],
  cursor: ['CURSOR_API_KEY'],
  kimi: ['MOONSHOT_API_KEY', 'KIMI_API_KEY'],
  qwen: ['DASHSCOPE_API_KEY', 'QWEN_API_KEY'],
  zcode: ['ZAI_API_KEY', 'ZHIPUAI_API_KEY'],
  'deepseek-harness': ['DEEPSEEK_API_KEY'],
  opencode: ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY'],
  gemini: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
  aider: ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY'],
};

async function gatewayDoctorCheck(url: string): Promise<DoctorReport['gateway']> {
  try {
    const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(1200) });
    if (!response.ok) return { url, status: 'offline', detail: `HTTP ${response.status}` };
    return { url, status: 'online' };
  } catch (error) {
    return { url, status: 'offline', detail: error instanceof Error ? error.message : String(error) };
  }
}

async function doctorReport(): Promise<DoctorReport> {
  const configPath = flag('--config') ?? defaultConfigPath();
  const configExists = existsSync(configPath);
  const config = agentCorpsConfig();
  const dataDir = dataDirectory();
  const database = deviceDatabasePath(dataDir);
  let writable = false;
  try { mkdirSync(dataDir, { recursive: true }); accessSync(dataDir, constants.W_OK); writable = true; } catch { /* Report the failed write check. */ }
  const host = config.gateway?.host ?? '127.0.0.1';
  const port = config.gateway?.port ?? 43210;
  const gateway = await gatewayDoctorCheck(`http://${host}:${port}`);
  const agents = await Promise.all(agentTools().list().map(async (definition): Promise<DoctorAgentReport> => {
    const configured = runtimeConfig(definition.id);
    const probe = await probeAgent({ id: definition.id, displayName: definition.displayName, command: configured.command ?? definition.command, ...(definition.versionArgs ? { versionArgs: definition.versionArgs } : {}) });
    const environment = (credentialEnvironment[definition.id] ?? []).filter((key) => Boolean(process.env[key] || configured.env?.[key]));
    const model = configured.model ? { value: configured.model, source: 'tool' as const } : config.defaults?.model ? { value: config.defaults.model, source: 'default' as const } : { value: 'provider default', source: 'provider-default' as const };
    return { id: definition.id, displayName: definition.displayName, command: probe.command, installed: probe.available, version: probe.version ?? 'unavailable', login: { status: environment.length ? 'credential-detected' : 'not-detected', environment }, model, ...(definition.documentationUrl ? { documentationUrl: definition.documentationUrl } : {}), ...(probe.output ? { output: probe.output.slice(0, 240) } : {}) };
  }));
  const status: DoctorStatus = !writable || gateway.status === 'offline' ? 'error' : agents.some((agent) => !agent.installed || agent.login.status === 'not-detected') ? 'warning' : 'healthy';
  return { status, config: { path: configPath, status: configExists ? 'found' : 'using-defaults' }, data: { directory: dataDir, database, writable }, gateway, agents };
}

function printDoctor(report: DoctorReport): void {
  const icon = (status: DoctorStatus | boolean): string => status === 'healthy' || status === true ? '✓' : status === 'warning' ? '!' : '×';
  console.log(`AgentCorps doctor · ${report.status}`);
  console.log(`${icon(report.config.status === 'found')} config     ${report.config.path} (${report.config.status})`);
  console.log(`${icon(report.data.writable)} data       ${report.data.directory} (${report.data.writable ? 'writable' : 'not writable'})`);
  console.log(`${icon(report.gateway.status === 'online')} gateway    ${report.gateway.url} (${report.gateway.status}${report.gateway.detail ? `: ${report.gateway.detail}` : ''})`);
  console.log('\nAgents');
  for (const agent of report.agents) {
    console.log(`${icon(agent.installed)} ${agent.id.padEnd(18)} ${agent.installed ? agent.version : 'not installed'} · ${agent.command}`);
    console.log(`  login: ${agent.login.status}${agent.login.environment.length ? ` (${agent.login.environment.join(', ')})` : ' (run the provider login command if this tool uses interactive auth)'}`);
    console.log(`  model: ${agent.model.value} (${agent.model.source})`);
  }
  console.log('\nA warning means the installation or login could not be confirmed without contacting the provider.');
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? 'help';
  if (command === 'help') usage();

  if (command === 'agents') {
    console.log(JSON.stringify(agentTools().list(), null, 2));
    return;
  }

  if (command === 'doctor') {
    const report = await doctorReport();
    if (hasFlag('--json')) console.log(JSON.stringify(report, null, 2));
    else printDoctor(report);
    if (hasFlag('--strict') && report.status !== 'healthy') process.exitCode = 1;
    return;
  }

  if (command === 'roles') {
    const customRoles = Object.entries(agentCorpsConfig().roles ?? {}).map(([id, role]) => ({ id, ...role }));
    console.log(JSON.stringify([...ROLE_PRESETS, ...customRoles], null, 2));
    return;
  }

  if (command === 'demo') {
    const local = new TaskRuntime();
    const unsubscribe = local.store.subscribe((event) => console.log(JSON.stringify(event)));
    const created = local.createTask({ workspaceId: 'local-workspace', sessionId: 'local-session', title: 'AgentCorps demo task', objective: 'demonstrate a task flowing through the local event runtime', mode: (hasFlag('--work') ? 'work' : 'code') as Mode });
    await local.runTask(created.id, new MockAgent());
    unsubscribe();
    return;
  }

  if (command === 'run') {
    const prompt = process.argv[3]?.trim();
    if (!prompt) throw new Error('Usage: agentcorps run "PROMPT" [options]');
    const dataDir = dataDirectory();
    const sessionStore = new SqliteSessionStore(join(dataDir, 'agentcorps.db'));
    const sessions = new SessionService(sessionStore);
    const workspaceId = flag('--workspace-id') ?? 'local-workspace';
    const mode = flag('--mode') === 'work' ? 'work' : 'code';
    const sessionId = flag('--session-id');
    const session = sessionId ? sessions.get(sessionId) : sessions.create({ workspaceId, title: flag('--title') ?? prompt.split('\n')[0]!.slice(0, 80), mode });
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    const local = runtime();
    const task = local.createTask({ workspaceId: session.workspaceId, sessionId: session.id, title: flag('--title') ?? session.title, objective: prompt, mode: session.mode });
    sessions.appendMessage({ sessionId: session.id, role: 'user', content: prompt, taskId: task.id });
    const bridge = bridgeRunToSession(local, sessions, task, selectedAgentId());
    const unsubscribe = local.store.subscribe((event) => {
      if (event.type === 'run.output') process.stdout.write(event.payload.text.endsWith('\n') ? event.payload.text : `${event.payload.text}\n`);
      if (event.type === 'task.status_changed' && event.aggregateId === task.id && event.payload.to === 'waiting_approval') process.stderr.write(`\nApproval required: ${event.payload.reason ?? 'the Agent requested approval'}\n`);
    });
    try {
      const completed = await local.runTask(task.id, agentForRun());
      if (completed.status === 'failed' || completed.status === 'cancelled') process.exitCode = 1;
    } finally {
      unsubscribe();
      bridge();
      sessionStore.close();
    }
    return;
  }

  if (command === 'tui') {
    const readline = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    let sessionId: string | undefined;
    const dataDir = dataDirectory();
    const sessionStore = new SqliteSessionStore(join(dataDir, 'agentcorps.db'));
    const sessions = new SessionService(sessionStore);
    const local = runtime();
    const ask = (question: string): Promise<string> => new Promise((resolve) => readline.question(question, resolve));
    const printHelp = (): void => console.log('Commands: /help, /new, /history, /cancel, /quit. Enter a prompt to run the configured Agent.');
    console.log('AgentCorps TUI · interactive local Agent session');
    console.log(`Data: ${dataDir}`);
    printHelp();
    try {
      while (true) {
        const input = (await ask(sessionId ? '\nYou › ' : '\nPrompt › ')).trim();
        if (!input) continue;
        if (input === '/quit' || input === '/exit') break;
        if (input === '/help') { printHelp(); continue; }
        if (input === '/new') { sessionId = undefined; console.log('Started a new session.'); continue; }
        if (input === '/history') {
          if (!sessionId) console.log('No active session yet.');
          else for (const message of sessions.messages(sessionId)) console.log(`${message.role}: ${message.content}`);
          continue;
        }
        if (input === '/cancel') {
          const active = local.listTasks().find((task) => task.sessionId === sessionId && ['queued', 'running', 'waiting_approval'].includes(task.status));
          if (active) console.log(JSON.stringify(local.cancelTask(active.id), null, 2)); else console.log('No active run.');
          continue;
        }
        const session = sessionId ? sessions.get(sessionId) : sessions.create({ workspaceId: 'local-workspace', title: input.slice(0, 80), mode: 'code' });
        if (!session) throw new Error(`Session not found: ${sessionId}`);
        sessionId = session.id;
        const task = local.createTask({ workspaceId: session.workspaceId, sessionId: session.id, title: session.title, objective: input, mode: session.mode });
        sessions.appendMessage({ sessionId: session.id, role: 'user', content: input, taskId: task.id });
        const bridge = bridgeRunToSession(local, sessions, task, selectedAgentId());
        const unsubscribe = local.store.subscribe((event) => {
          if (event.aggregateId !== task.id) return;
          if (event.type === 'run.output') process.stdout.write(event.payload.text.endsWith('\n') ? event.payload.text : `${event.payload.text}\n`);
          if (event.type === 'task.status_changed') console.log(`\n[${event.payload.to}]`);
        });
        try {
          const completed = await local.runTask(task.id, agentForRun());
          if (completed.status === 'failed') console.error('Run failed. Use /history or task show to inspect the recorded events.');
        } finally { unsubscribe(); bridge(); }
      }
    } finally {
      readline.close();
      sessionStore.close();
    }
    return;
  }

  if (command === 'approval') {
    const action = process.argv[3];
    const store = new SqliteApprovalStore(deviceDatabasePath());
    const service = new ApprovalService(store);
    try {
      if (action === 'list') {
        console.log(JSON.stringify(service.list(), null, 2));
        return;
      }
      const id = process.argv[4];
      if (!id) throw new Error('Approval ID is required');
      const decidedBy = flag('--decided-by') ?? 'cli-user';
      if (action === 'approve') {
        console.log(JSON.stringify(service.approve(id, decidedBy), null, 2));
        return;
      }
      if (action === 'deny') {
        console.log(JSON.stringify(service.deny(id, decidedBy), null, 2));
        return;
      }
      usage();
    } finally {
      store.close();
    }
  }

  if (command === 'device') {
    const action = process.argv[3];
    const dataDir = dataDirectory();
    if (action === 'provision') {
      provisionDevice(requiredFlag('--label'), dataDir);
      return;
    }
    const { store, tokens } = deviceAuth(dataDir);
    try {
      if (action === 'list') {
        console.log(JSON.stringify(store.list(), null, 2));
        return;
      }
      if (action === 'revoke') {
        const id = process.argv[4] ?? flag('--device-id');
        if (!id) usage();
        const device = store.get(id);
        if (!device) throw new Error(`Device not found: ${id}`);
        const revoked = { ...device, revokedAt: new Date().toISOString() };
        store.save(revoked);
        console.log(JSON.stringify(revoked, null, 2));
        return;
      }
      if (action === 'token') {
        const id = process.argv[4] ?? flag('--device-id');
        if (!id) usage();
        const device = store.get(id);
        if (!device) throw new Error(`Device not found: ${id}`);
        console.log(tokens.issue(device, Number(flag('--ttl') ?? '3600')));
        return;
      }
    } finally {
      store.close();
    }
    usage();
  }

  if (command === 'identity') {
    const action = process.argv[3];
    const dataDir = dataDirectory();
    const bindings = identityStore(dataDir);
    const devices = new SqliteDeviceIdentityStore(deviceDatabasePath(dataDir));
    const resolver = new ExternalIdentityResolver(bindings);
    try {
      if (action === 'bind') {
        const deviceId = requiredFlag('--device-id');
        const device = devices.get(deviceId);
        if (!device) throw new Error(`Device not found: ${deviceId}`);
        if (device.revokedAt) throw new Error(`Cannot bind a revoked device: ${deviceId}`);
        const binding = resolver.bind(channelKind(requiredFlag('--channel')), requiredFlag('--external-user-id'), deviceId, identityRoles());
        console.log(JSON.stringify(binding, null, 2));
        return;
      }
      if (action === 'list') {
        const includeRevoked = hasFlag('--include-revoked');
        console.log(JSON.stringify(resolver.list().filter((binding) => includeRevoked || !binding.revokedAt), null, 2));
        return;
      }
      if (action === 'revoke') {
        const binding = resolver.revoke(channelKind(requiredFlag('--channel')), requiredFlag('--external-user-id'));
        console.log(JSON.stringify(binding, null, 2));
        return;
      }
    } finally {
      devices.close();
      bindings.close();
    }
    usage();
  }

  if (command === 'data') {
    const action = process.argv[3];
    const dataDir = dataDirectory();
    const databasePath = join(dataDir, 'agentcorps.db');
    mkdirSync(dataDir, { recursive: true });
    if (action === 'migrate') {
      let memoryRecords = 0;
      let sessionRecords = 0;
      const legacyMemoryPath = join(dataDir, 'memory.jsonl');
      if (existsSync(legacyMemoryPath)) {
        const target = new SqliteMemoryStore(databasePath);
        memoryRecords = migrateMemoryStore(new JsonlMemoryStore(legacyMemoryPath), target);
        target.close();
      }
      const legacySessionPath = join(dataDir, 'sessions.jsonl');
      if (existsSync(legacySessionPath)) {
        const target = new SqliteSessionStore(databasePath);
        sessionRecords = migrateSessionStore(new JsonlSessionStore(legacySessionPath), target);
        target.close();
      }
      console.log(JSON.stringify({ databasePath, memoryRecords, sessionRecords }, null, 2));
      return;
    }
    if (action === 'export') {
      const output = requiredFlag('--output');
      const eventStore = new SqliteEventStore(databasePath);
      const sessionStore = new SqliteSessionStore(databasePath);
      const memoryStore = new SqliteMemoryStore(databasePath);
      try {
        const sessions = sessionStore.listSessions().map((session) => ({ session, messages: sessionStore.listMessages(session.id) }));
        const snapshot = { schemaVersion: 1, generatedAt: new Date().toISOString(), events: eventStore.list(), sessions, memories: memoryStore.list().filter((record) => !record.deletedAt) };
        const serialized = JSON.stringify(snapshot, null, 2);
        mkdirSync(dirname(output), { recursive: true });
        const temporary = `${output}.tmp-${process.pid}`;
        writeFileSync(temporary, `${serialized}\n`, { encoding: 'utf8', mode: 0o600 });
        renameSync(temporary, output);
        console.log(JSON.stringify({ output, sha256: createHash('sha256').update(serialized).digest('hex'), counts: { events: snapshot.events.length, sessions: snapshot.sessions.length, memories: snapshot.memories.length } }, null, 2));
      } finally {
        eventStore.close();
        sessionStore.close();
        memoryStore.close();
      }
      return;
    }
    if (action === 'backup') {
      const output = requiredFlag('--output');
      if (!existsSync(databasePath)) throw new Error(`Database not found: ${databasePath}`);
      const database = new SqliteEventStore(databasePath);
      try {
        if (database.integrityCheck() !== 'ok') throw new Error(`Database integrity check failed: ${databasePath}`);
        database.checkpoint();
      } finally {
        database.close();
      }
      mkdirSync(dirname(output), { recursive: true });
      const temporary = `${output}.tmp-${process.pid}`;
      copyFileSync(databasePath, temporary);
      chmodSync(temporary, 0o600);
      renameSync(temporary, output);
      console.log(JSON.stringify({ source: databasePath, output }));
      return;
    }
    if (action === 'restore') {
      const input = requiredFlag('--input');
      if (!existsSync(input)) throw new Error(`Backup not found: ${input}`);
      const validation = new SqliteEventStore(input);
      try {
        if (validation.integrityCheck() !== 'ok') throw new Error(`Backup integrity check failed: ${input}`);
      } finally {
        validation.close();
      }
      mkdirSync(dirname(databasePath), { recursive: true });
      const temporary = `${databasePath}.restore-${process.pid}`;
      copyFileSync(input, temporary);
      chmodSync(temporary, 0o600);
      renameSync(temporary, databasePath);
      console.log(JSON.stringify({ input, databasePath }));
      return;
    }
    usage();
  }

  if (command === 'serve') {
    const gatewayConfig = agentCorpsConfig().gateway;
    const port = Number(flag('--port') ?? gatewayConfig?.port ?? '43210');
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('--port must be between 1 and 65535');
    const host = flag('--host') ?? gatewayConfig?.host ?? '127.0.0.1';
    const token = flag('--token') ?? gatewayConfig?.token;
    const readOnlyToken = flag('--read-only-token') ?? gatewayConfig?.readOnlyToken;
    if (host !== '127.0.0.1' && host !== 'localhost' && !token && !readOnlyToken) throw new Error('Remote gateway binding requires --token or --read-only-token');
    const dataDir = dataDirectory();
    const workspaceRoot = resolveConfiguredPath(flag('--workspace-root') ?? agentCorpsConfig().paths?.workspaceRoot ?? process.cwd());
    const corsOrigin = flag('--cors-origin') ?? gatewayConfig?.corsOrigin;
    const memories = memoryService();
    const identityRequired = hasFlag('--identity-required') || gatewayConfig?.identityRequired === true;
    const bindings = identityRequired ? identityStore(dataDir) : undefined;
    const identityResolver = bindings ? new ExternalIdentityResolver(bindings) : undefined;
    const channelState = new SqliteChannelStateStore(deviceDatabasePath(dataDir));
    const audit = new SqliteAuditLog(deviceDatabasePath(dataDir));
    const approvalStore = new SqliteApprovalStore(deviceDatabasePath(dataDir));
    const terminalConfig = agentCorpsConfig().terminal;
    const browserConfig = agentCorpsConfig().browser;
    const browserNetwork = flag('--browser-network') ?? browserConfig?.network ?? 'none';
    if (browserNetwork !== 'none' && browserNetwork !== 'allowlist' && browserNetwork !== 'full') throw new Error('--browser-network must be none, allowlist, or full');
    const browserHosts = options().has('--browser-host') ? repeatedFlag('--browser-host') : browserConfig?.allowedHosts ?? [];
    const securityProfile = { ...createDefaultProfile(workspaceRoot, 'S2'), network: browserNetwork as 'none' | 'allowlist' | 'full', allowedHosts: browserHosts };
    const gatewayOptions = {
      ...((token || readOnlyToken) ? { tokenVerifier: async (candidate: string) => candidate === readOnlyToken ? { roles: ['read'] as const } : candidate === token } : {}),
      ...(corsOrigin ? { corsOrigin } : {}),
      channels: { stateStore: channelState, ...(identityResolver ? { identityResolver } : {}) },
      files: { root: workspaceRoot },
      git: { root: workspaceRoot, allowWrite: hasFlag('--git-write') || agentCorpsConfig().git?.allowWrite === true, requireApproval: !hasFlag('--git-no-approval') && agentCorpsConfig().git?.requireApproval !== false },
      terminal: { root: workspaceRoot, allowExec: hasFlag('--terminal-exec') || terminalConfig?.allowExec === true, requireApproval: !hasFlag('--terminal-no-approval') && terminalConfig?.requireApproval !== false, ...(terminalConfig?.defaultTimeoutMs === undefined ? {} : { defaultTimeoutMs: terminalConfig.defaultTimeoutMs }) },
      browser: { endpoint: flag('--browser-endpoint') ?? browserConfig?.endpoint ?? 'http://127.0.0.1:9222', allowControl: hasFlag('--browser-control') || browserConfig?.allowControl === true, requireApproval: !hasFlag('--browser-no-approval') && browserConfig?.requireApproval !== false, ...(browserConfig?.timeoutMs === undefined ? {} : { timeoutMs: browserConfig.timeoutMs }), ...(browserConfig?.maxTextBytes === undefined ? {} : { maxTextBytes: browserConfig.maxTextBytes }), ...(browserConfig?.maxScreenshotBytes === undefined ? {} : { maxScreenshotBytes: browserConfig.maxScreenshotBytes }) },
      memory: { service: memories },
      security: { context: { mode: 'code' as const, profile: securityProfile }, engine: new PolicyEngine(audit), approvals: new ApprovalService(approvalStore), allowApprovalDecisions: true },
      agentFactory: (_task: import('@agentcorps/domain').Task, context: RunAgentContext | undefined) => agentForRun(context),
    };
    const sessionStore = new SqliteSessionStore(join(dataDir, 'agentcorps.db'));
    const localRuntime = runtime(memories);
    const server = await listenGateway(localRuntime, port, host, new SessionService(sessionStore), gatewayOptions);
    const shutdown = (): void => {
      localRuntime.shutdown('Gateway shutting down');
      server.close();
      channelState.close();
      audit.close();
      approvalStore.close();
      sessionStore.close();
      bindings?.close();
      closeAgentControlServices();
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
    console.log(`AgentCorps gateway listening on http://${host}:${(server.address() as { port: number }).port}`);
    return;
  }

  if (command === 'memory') {
    const service = memoryService();
    const action = process.argv[3];
    if (action === 'save') {
      const scope = requiredFlag('--scope');
      if (scope !== 'global' && scope !== 'workspace' && scope !== 'session') throw new Error('Memory scope must be global, workspace, or session');
      const sensitivity = flag('--sensitivity') ?? 'private';
      if (sensitivity !== 'public' && sensitivity !== 'private' && sensitivity !== 'secret') throw new Error('Memory sensitivity must be public, private, or secret');
      const workspaceId = flag('--workspace-id');
      const sessionId = flag('--session-id');
      console.log(JSON.stringify(service.save({
        scope,
        content: requiredFlag('--content'),
        source: 'user',
        sensitivity,
        ...(workspaceId ? { workspaceId } : {}),
        ...(sessionId ? { sessionId } : {}),
      }), null, 2));
      return;
    }
    if (action === 'search') {
      const workspaceId = flag('--workspace-id');
      const sessionId = flag('--session-id');
      console.log(JSON.stringify(service.search(requiredFlag('--query'), { ...(workspaceId ? { workspaceId } : {}), ...(sessionId ? { sessionId } : {}), includeSensitive: hasFlag('--include-sensitive') }), null, 2));
      return;
    }
    if (action === 'list') {
      console.log(JSON.stringify(service.export(), null, 2));
      return;
    }
    if (action === 'delete') {
      const memoryId = process.argv[4] ?? flag('--memory-id');
      if (!memoryId) usage();
      console.log(JSON.stringify(service.delete(memoryId), null, 2));
      return;
    }
    usage();
  }

  if (command === 'usage') {
    const action = process.argv[3];
    const service = new UsageService(new SqliteUsageStore(deviceDatabasePath()));
    try {
      const filter = {
        ...(flag('--from') ? { from: flag('--from')! } : {}),
        ...(flag('--to') ? { to: flag('--to')! } : {}),
        ...(flag('--task-id') ? { taskId: flag('--task-id')! } : {}),
        ...(flag('--run-id') ? { runId: flag('--run-id')! } : {}),
        ...(flag('--tool') ? { toolId: flag('--tool')! } : {}),
        ...(flag('--model') ? { model: flag('--model')! } : {}),
        ...(flag('--kind') ? { kind: flag('--kind') as 'model' | 'tool' | 'protocol' } : {}),
        ...(flag('--status') ? { status: flag('--status') as 'succeeded' | 'failed' | 'approval_required' | 'cancelled' } : {}),
        ...(flag('--limit') ? { limit: Number(flag('--limit')) } : {}),
      };
      if (action === 'summary') console.log(JSON.stringify(service.summary(filter), null, 2));
      else if (action === 'calls' || action === 'logs') console.log(JSON.stringify(service.list(filter), null, 2));
      else usage();
    } finally { service.close(); }
    return;
  }

  if (command !== 'task') usage();
  const action = process.argv[3];
  if (!action) usage();
  const local = runtime();

  if (action === 'create') {
    const task = local.createTask({ workspaceId: 'local-workspace', sessionId: 'local-session', title: requiredFlag('--title'), objective: requiredFlag('--objective'), mode: (flag('--mode') === 'work' ? 'work' : 'code') as Mode });
    console.log(JSON.stringify(task, null, 2));
    return;
  }
  if (action === 'list') {
    console.log(JSON.stringify(local.listTasks(), null, 2));
    return;
  }
  const id = taskId(process.argv[4]);
  if (action === 'show') {
    const task = local.getTask(id);
    if (!task) throw new Error(`Task not found: ${id}`);
    console.log(JSON.stringify({ task, events: local.store.list(id) }, null, 2));
    return;
  }
  if (action === 'run') {
    const task = await local.runTask(id, agentForRun());
    console.log(JSON.stringify(task, null, 2));
    return;
  }
  if (action === 'cancel') {
    console.log(JSON.stringify(local.cancelTask(id), null, 2));
    return;
  }
  if (action === 'retry') {
    console.log(JSON.stringify(local.retryTask(id), null, 2));
    return;
  }
  if (action === 'probe') {
    console.log(JSON.stringify(await probeAgent(agentProbeOptions()), null, 2));
    return;
  }
  usage();
}

await main();
