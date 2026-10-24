#!/usr/bin/env node
import { homedir } from 'node:os';
import { join } from 'node:path';
import { JsonlAgentAdapter } from '@agentcorps/adapters';
import type { Mode, TaskId } from '@agentcorps/domain';
import { listenGateway } from '@agentcorps/gateway';
import { JsonlSessionStore, SessionService } from '@agentcorps/session';
import { JsonlEventStore, MockAgent, TaskRuntime } from '@agentcorps/runtime';

function usage(): never {
  console.error(`AgentCorps CLI 0.1.0

Commands:
  demo                                      Run an in-memory local demo
  serve [--port 43210] [--host 127.0.0.1] [--token TOKEN] [--data-dir PATH]    Start the local HTTP/SSE gateway
  task create --title T --objective O       Create a persistent task
       [--mode code|work] [--data-dir PATH]
  task list [--data-dir PATH]               List persistent tasks
  task show TASK_ID [--data-dir PATH]       Show a task and its events
  task run TASK_ID [--data-dir PATH]        Run a task with the configured mock agent
  task cancel TASK_ID [--data-dir PATH]    Cancel a task
  task retry TASK_ID [--data-dir PATH]     Requeue a failed or cancelled task`);
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

function dataDirectory(): string {
  return flag('--data-dir') ?? join(homedir(), '.agentcorps');
}

function runtime(): TaskRuntime {
  return new TaskRuntime({ store: new JsonlEventStore(join(dataDirectory(), 'events.jsonl')) });
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
    const corsOrigin = flag('--cors-origin');
    const gatewayOptions = { ...(token ? { bearerToken: token } : {}), ...(corsOrigin ? { corsOrigin } : {}) };
    const server = await listenGateway(runtime(), port, host, new SessionService(new JsonlSessionStore(join(dataDir, 'sessions.jsonl'))), gatewayOptions);
    console.log(`AgentCorps gateway listening on http://${host}:${(server.address() as { port: number }).port}`);
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
    const task = await local.runTask(id, new MockAgent());
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
