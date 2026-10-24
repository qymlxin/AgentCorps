#!/usr/bin/env node
import { TaskRuntime, MockAgent, formatEvent } from '@agentcorps/runtime';
import type { Mode } from '@agentcorps/domain';

function usage(): never {
  console.error(`AgentCorps CLI 0.1.0\n\nCommands:\n  demo                         Run a local task through the runtime\n  help                         Show this help`);
  process.exit(1);
}

const runtime = new TaskRuntime();
const command = process.argv[2] ?? 'help';

if (command === 'demo') {
  const unsubscribe = runtime.store.subscribe((event) => console.log(formatEvent(event), JSON.stringify(event.payload)));
  const mode = (process.argv.includes('--work') ? 'work' : 'code') as Mode;
  const task = runtime.createTask({
    workspaceId: 'local-workspace',
    sessionId: 'local-session',
    title: 'AgentCorps demo task',
    objective: 'demonstrate a task flowing through the local event runtime',
    mode,
  });
  await runtime.runTask(task.id, new MockAgent());
  unsubscribe();
} else {
  usage();
}
