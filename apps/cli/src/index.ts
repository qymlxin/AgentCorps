#!/usr/bin/env node
import { createHash, randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, chmodSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { CommandAgentAdapter, createAgentToolRegistry, loadAgentToolDefinitions, probeAgent, getRolePreset, ROLE_PRESETS, withRole, type AgentProbeOptions, type CommandAgentOptions, type RolePreset } from '@agentcorps/adapters';
import type { AgentAdapter } from '@agentcorps/runtime';
import type { Mode, TaskId } from '@agentcorps/domain';
import { listenGateway } from '@agentcorps/gateway';
import { SqliteChannelStateStore } from '@agentcorps/channels';
import { JsonlMemoryStore, migrateMemoryStore, MemoryService, SqliteMemoryStore } from '@agentcorps/memory';
import { DeviceTokenVerifier, ExternalIdentityResolver, SignedAccessTokenService, SqliteApprovalStore, SqliteAuditLog, PolicyEngine, ApprovalService, createDefaultProfile, SqliteDeviceIdentityStore, SqliteExternalIdentityBindingStore, type ChannelKind, type DeviceIdentity, type ExternalIdentityRole } from '@agentcorps/security';
import { JsonlSessionStore, migrateSessionStore, SessionService, SqliteSessionStore } from '@agentcorps/session';
import { MockAgent, SqliteEventStore, TaskRuntime } from '@agentcorps/runtime';

function usage(): never {
  console.error(`AgentCorps CLI 0.1.0

Commands:
  demo                                      Run an in-memory local demo
  serve [--port 43210] [--host 127.0.0.1] [--token TOKEN] [--read-only-token TOKEN] [--data-dir PATH]    Start the local HTTP/SSE/WebSocket gateway
  task create --title T --objective O       Create a persistent task
       [--mode code|work] [--data-dir PATH]
  task list [--data-dir PATH]               List persistent tasks
  task show TASK_ID [--data-dir PATH]       Show a task and its events
  agents                                    List configured external agent tools
  roles                                     List reusable role prompt presets
  task run TASK_ID [--agent mock|codex|claude-code|cursor|command] [--data-dir PATH]
       [--role developer|reviewer|planner|tester|security|writer] [--role-file PATH] [--instructions TEXT]
       [--agent-command PATH] [--agent-arg ARG] [--sandbox-backend macos|container]
       [--container-image IMAGE] [--sandbox-network full] [--sandbox-memory-mb N] [--sandbox-cpu N] [--sandbox-pids N]
  task cancel TASK_ID [--data-dir PATH]    Cancel a task
  task retry TASK_ID [--data-dir PATH]     Requeue a failed or cancelled task
  task probe [--agent codex|claude-code|cursor] [--command PATH]    Probe an Agent executable
  memory save --scope S --content C       Save global/workspace/session memory
       [--workspace-id ID] [--session-id ID] [--sensitivity public|private|secret]
  memory search --query Q                 Search visible memory
       [--workspace-id ID] [--session-id ID] [--include-sensitive]
  memory list                              List exported memories
  memory delete MEMORY_ID                 Soft-delete a memory
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
  serve --identity-required                 Require external channel identity bindings`);
  process.exit(1);
}

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

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

function repeatedFlag(name: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < process.argv.length; index += 1) if (process.argv[index] === name && process.argv[index + 1]) values.push(process.argv[index + 1]!);
  return values;
}

let configuredTools: ReturnType<typeof createAgentToolRegistry> | undefined;
function agentTools() {
  if (configuredTools) return configuredTools;
  const registry = createAgentToolRegistry();
  const config = flag('--agents-config');
  if (config) {
    const contents = readFileSync(config, 'utf8');
    if (Buffer.byteLength(contents) > 1024 * 1024) throw new Error('Agent configuration exceeds 1 MiB');
    loadAgentToolDefinitions(JSON.parse(contents) as unknown, registry);
  }
  configuredTools = registry;
  return registry;
}

function agentForRun(): AgentAdapter {
  const roleId = flag('--role');
  const roleFile = flag('--role-file');
  if (roleId && roleFile) throw new Error('--role and --role-file are mutually exclusive');
  let role: RolePreset | undefined = roleId ? getRolePreset(roleId) : undefined;
  if (roleFile) {
    const prompt = readFileSync(roleFile, 'utf8').trim();
    if (!prompt || Buffer.byteLength(prompt) > 64 * 1024) throw new Error('--role-file must contain between 1 and 65536 bytes of prompt text');
    role = { id: 'custom', displayName: 'Custom role', description: 'Explicitly configured prompt file', prompt };
  }
  const instructions = flag('--instructions');
  return withRole(unconfiguredAgentForRun(), { ...(role ? { role } : {}), ...(instructions ? { instructions } : {}) });
}

function unconfiguredAgentForRun(): AgentAdapter {
  const selected = flag('--agent') ?? 'mock';
  const command = flag('--agent-command');
  const args = repeatedFlag('--agent-arg');
  if (selected === 'mock') return new MockAgent();
  if (selected === 'command') {
    if (!command) throw new Error('--agent-command is required for --agent command');
    const sandbox = commandSandbox();
    return new CommandAgentAdapter({ id: 'configured-command', displayName: 'Configured command agent', command, args, outputFormat: 'text', promptPlacement: 'argument', ...(sandbox ? { sandbox } : {}) });
  }
  const sandbox = commandSandbox();
  return agentTools().create(selected, {
    ...(command ? { command } : {}), ...(args.length ? { args } : {}),
    ...(flag('--model') ? { model: flag('--model')! } : {}),
    ...((flag('--role') || flag('--role-file')) ? { role: null } : {}),
    ...(sandbox ? { sandbox } : {}),
  });
}

function commandSandbox(): CommandAgentOptions['sandbox'] {
  const backend = flag('--sandbox-backend');
  if (!backend) return undefined;
  if (backend !== 'macos' && backend !== 'container') throw new Error('--sandbox-backend must be macos or container');
  if (backend === 'container' && !flag('--container-image')) throw new Error('--container-image is required for container sandboxing');
  return {
    backend, workspaceRoot: process.cwd(), network: flag('--sandbox-network') === 'full' ? 'full' as const : 'none' as const,
    ...(flag('--container-image') ? { containerImage: flag('--container-image')! } : {}),
    maxMemoryMb: Number(flag('--sandbox-memory-mb') ?? '1024'), maxCpu: Number(flag('--sandbox-cpu') ?? '2'), maxPids: Number(flag('--sandbox-pids') ?? '128'),
  };
}

function agentProbeOptions(): AgentProbeOptions {
  const selected = flag('--agent') ?? 'command';
  const command = flag('--command') ?? flag('--agent-command');
  if (selected === 'command' && command) return { id: 'configured-command', displayName: 'Configured command agent', command };
  if (selected === 'command') throw new Error('--command or --agent-command is required for command probing');
  const definition = agentTools().get(selected);
  return { id: definition.id, displayName: definition.displayName, command: command ?? definition.command, ...(definition.versionArgs ? { versionArgs: definition.versionArgs } : {}) };
}

function dataDirectory(): string {
  return flag('--data-dir') ?? join(homedir(), '.agentcorps');
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
  return new TaskRuntime({ store: new SqliteEventStore(join(dataDirectory(), 'agentcorps.db')), memory });
}

function memoryService(): MemoryService {
  return new MemoryService(new SqliteMemoryStore(join(dataDirectory(), 'agentcorps.db')));
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? 'help';
  if (command === 'help') usage();

  if (command === 'agents') {
    console.log(JSON.stringify(agentTools().list(), null, 2));
    return;
  }

  if (command === 'roles') {
    console.log(JSON.stringify(ROLE_PRESETS, null, 2));
    return;
  }

  if (command === 'demo') {
    const local = new TaskRuntime();
    const unsubscribe = local.store.subscribe((event) => console.log(JSON.stringify(event)));
    const created = local.createTask({ workspaceId: 'local-workspace', sessionId: 'local-session', title: 'AgentCorps demo task', objective: 'demonstrate a task flowing through the local event runtime', mode: (process.argv.includes('--work') ? 'work' : 'code') as Mode });
    await local.runTask(created.id, new MockAgent());
    unsubscribe();
    return;
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
        const includeRevoked = process.argv.includes('--include-revoked');
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
    const port = Number(flag('--port') ?? '43210');
    const host = flag('--host') ?? '127.0.0.1';
    const token = flag('--token');
    const readOnlyToken = flag('--read-only-token');
    if (host !== '127.0.0.1' && host !== 'localhost' && !token && !readOnlyToken) throw new Error('Remote gateway binding requires --token or --read-only-token');
    const dataDir = dataDirectory();
    const corsOrigin = flag('--cors-origin') ?? ((!token && (host === '127.0.0.1' || host === 'localhost')) ? undefined : undefined);
    const memories = memoryService();
    const deviceServices = token ? undefined : deviceAuth(dataDir);
    const identityRequired = process.argv.includes('--identity-required');
    const bindings = identityRequired ? identityStore(dataDir) : undefined;
    const identityResolver = bindings ? new ExternalIdentityResolver(bindings) : undefined;
    const channelState = new SqliteChannelStateStore(deviceDatabasePath(dataDir));
    const audit = new SqliteAuditLog(deviceDatabasePath(dataDir));
    const approvalStore = new SqliteApprovalStore(deviceDatabasePath(dataDir));
    const gatewayOptions = {
      ...((token || readOnlyToken) ? { tokenVerifier: async (candidate: string) => candidate === readOnlyToken ? { roles: ['read'] as const } : candidate === token } : { tokenVerifier: async (candidate: string) => Boolean(deviceServices?.verifier.verify(candidate)) }),
      ...(corsOrigin ? { corsOrigin } : {}),
      channels: { stateStore: channelState, ...(identityResolver ? { identityResolver } : {}) },
      memory: { service: memories },
      security: { context: { mode: 'code' as const, profile: createDefaultProfile(process.cwd(), 'S2') }, engine: new PolicyEngine(audit), approvals: new ApprovalService(approvalStore), allowApprovalDecisions: true },
      agentFactory: () => agentForRun(),
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
      deviceServices?.store.close();
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
      console.log(JSON.stringify(service.search(requiredFlag('--query'), { ...(workspaceId ? { workspaceId } : {}), ...(sessionId ? { sessionId } : {}), includeSensitive: process.argv.includes('--include-sensitive') }), null, 2));
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
