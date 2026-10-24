#!/usr/bin/env node
import { homedir } from 'node:os';
import { join } from 'node:path';
import { CommandAgentAdapter, createClaudeCodeAdapter, createCodexAdapter, createCursorAdapter, JsonlAgentAdapter } from '@agentcorps/adapters';
import type { AgentAdapter } from '@agentcorps/runtime';
import type { Mode, TaskId } from '@agentcorps/domain';
import { listenGateway } from '@agentcorps/gateway';
import { JsonlMemoryStore, MemoryService } from '@agentcorps/memory';
import { JsonlSessionStore, SessionService } from '@agentcorps/session';
import { MockAgent, SqliteEventStore, TaskRuntime } from '@agentcorps/runtime';

function usage(): never {
  console.error(`AgentCorps CLI 0.1.0

Commands:
  demo                                      Run an in-memory local demo
  serve [--port 43210] [--host 127.0.0.1] [--token TOKEN] [--data-dir PATH]    Start the local HTTP/SSE gateway
  task create --title T --objective O       Create a persistent task
       [--mode code|work] [--data-dir PATH]
  task list [--data-dir PATH]               List persistent tasks
  task show TASK_ID [--data-dir PATH]       Show a task and its events
  task run TASK_ID [--agent mock|codex|claude-code|cursor|command] [--data-dir PATH]
       [--agent-command PATH] [--agent-arg ARG]
  task cancel TASK_ID [--data-dir PATH]    Cancel a task
  task retry TASK_ID [--data-dir PATH]     Requeue a failed or cancelled task
  memory save --scope S --content C       Save global/workspace/session memory
       [--workspace-id ID] [--session-id ID] [--sensitivity public|private|secret]
  memory search --query Q                 Search visible memory
       [--workspace-id ID] [--session-id ID] [--include-sensitive]
  memory list                              List exported memories
  memory delete MEMORY_ID                 Soft-delete a memory`);
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

function agentForRun(): AgentAdapter {
  const selected = flag('--agent') ?? 'mock';
  const command = flag('--agent-command');
  const args = repeatedFlag('--agent-arg');
  if (selected === 'mock') return new MockAgent();
  if (selected === 'codex') return args.length ? createCodexAdapter(command ?? 'codex', args) : createCodexAdapter(command ?? 'codex');
  if (selected === 'claude-code') return args.length ? createClaudeCodeAdapter(command ?? 'claude', args) : createClaudeCodeAdapter(command ?? 'claude');
  if (selected === 'cursor') return args.length ? createCursorAdapter(command ?? 'agent', args) : createCursorAdapter(command ?? 'agent');
  if (selected === 'command') {
    if (!command) throw new Error('--agent-command is required for --agent command');
    return new CommandAgentAdapter({ id: 'configured-command', displayName: 'Configured command agent', command, args, outputFormat: 'text', promptPlacement: 'argument' });
  }
  throw new Error(`Unknown agent: ${selected}`);
}

function dataDirectory(): string {
  return flag('--data-dir') ?? join(homedir(), '.agentcorps');
}

function runtime(memory = memoryService()): TaskRuntime {
  return new TaskRuntime({ store: new SqliteEventStore(join(dataDirectory(), 'agentcorps.db')), memory });
}

function memoryService(): MemoryService {
  return new MemoryService(new JsonlMemoryStore(join(dataDirectory(), 'memory.jsonl')));
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? 'help';
  if (command === 'help') usage();

  if (command === 'demo') {
    const local = new TaskRuntime();
    const unsubscribe = local.store.subscribe((event) => console.log(JSON.stringify(event)));
    const created = local.createTask({ workspaceId: 'local-workspace', sessionId: 'local-session', title: 'AgentCorps demo task', objective: 'demonstrate a task flowing through the local event runtime', mode: (process.argv.includes('--work') ? 'work' : 'code') as Mode });
    await local.runTask(created.id, new MockAgent());
    unsubscribe();
    return;
  }

  if (command === 'serve') {
    const port = Number(flag('--port') ?? '43210');
    const host = flag('--host') ?? '127.0.0.1';
    const token = flag('--token');
    if (host !== '127.0.0.1' && host !== 'localhost' && !token) throw new Error('Remote gateway binding requires --token');
    const dataDir = dataDirectory();
    const corsOrigin = flag('--cors-origin') ?? ((!token && (host === '127.0.0.1' || host === 'localhost')) ? '*' : undefined);
    const memories = memoryService();
    const gatewayOptions = { ...(token ? { bearerToken: token } : {}), ...(corsOrigin ? { corsOrigin } : {}), memory: { service: memories }, agentFactory: () => agentForRun() };
    const server = await listenGateway(runtime(memories), port, host, new SessionService(new JsonlSessionStore(join(dataDir, 'sessions.jsonl'))), gatewayOptions);
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
    const adapter = new JsonlAgentAdapter({ id: 'configured-process', displayName: 'Configured process', command: requiredFlag('--command') });
    console.log(JSON.stringify(adapter.descriptor, null, 2));
    return;
  }
  usage();
}

await main();
