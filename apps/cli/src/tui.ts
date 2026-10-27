import { createInterface } from 'node:readline';
import type { ApprovalService } from '@agentcorps/security';
import type { Task, TaskEvent, TaskId, TaskStatus } from '@agentcorps/domain';
import type { TaskRuntime } from '@agentcorps/runtime';
import type { SessionService } from '@agentcorps/session';

export interface TuiOptions {
  readonly local: TaskRuntime;
  readonly sessions: SessionService;
  readonly approvals: ApprovalService;
  readonly dataDir: string;
  readonly agentId: () => string;
  readonly runTask: (task: Task) => Promise<Task>;
}

const ESC = '\u001b[';
const terminalStatuses: readonly TaskStatus[] = ['succeeded', 'failed', 'cancelled'];
const activeStatuses: readonly TaskStatus[] = ['queued', 'running', 'waiting_approval'];

function appendText(lines: string[], text: string, prefix = ''): void {
  const clean = sanitizeTerminalText(text);
  const chunks = clean.split(/\r?\n/);
  for (const chunk of chunks) {
    if (chunk.length || chunks.length === 1) lines.push(`${prefix}${chunk}`);
  }
}

export function sanitizeTerminalText(value: string): string {
  return value
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, '')
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
}

export function wrapLine(value: string, width: number): string[] {
  const safeWidth = Math.max(8, width);
  if (!value) return [''];
  const output: string[] = [];
  let remaining = value;
  while (remaining.length > safeWidth) {
    let cut = remaining.lastIndexOf(' ', safeWidth);
    if (cut < Math.floor(safeWidth * 0.55)) cut = safeWidth;
    output.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut).replace(/^\s+/, '');
  }
  output.push(remaining);
  return output;
}

function wrapLines(lines: readonly string[], width: number): string[] {
  return lines.flatMap((line) => wrapLine(line, width));
}

function taskLabel(task: Task, width: number): string {
  const shortId = task.id.slice(-8);
  const label = `${task.status} ${shortId} ${task.title}`;
  return label.length > width ? `${label.slice(0, Math.max(0, width - 1))}…` : label;
}

function statusIcon(status: TaskStatus): string {
  if (status === 'succeeded') return '✓';
  if (status === 'failed') return '×';
  if (status === 'cancelled') return '–';
  if (status === 'waiting_approval') return '!';
  if (status === 'running') return '»';
  return '·';
}

async function runLineTui({ local, sessions, approvals, dataDir, agentId, runTask }: TuiOptions): Promise<void> {
  const readline = createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY === true });
  let sessionId: string | undefined;
  const ask = (question: string): Promise<string> => new Promise((resolve) => readline.question(question, resolve));
  const printHelp = (): void => console.log('Commands: /help, /new, /tasks, /status, /history, /approvals, /approve ID, /deny ID, /resume TASK_ID, /cancel, /quit. Enter a prompt to run the configured Agent.');
  const printTasks = (): void => {
    const tasks = local.listTasks().filter((task) => !sessionId || task.sessionId === sessionId);
    if (!tasks.length) { console.log('No tasks in the current session.'); return; }
    for (const task of tasks) console.log(`${task.id}  ${task.status.padEnd(17)}  ${task.title}`);
  };
  const execute = async (task: Task): Promise<void> => {
    const unsubscribe = local.store.subscribe((event) => {
      if (event.aggregateId !== task.id) return;
      if (event.type === 'run.output') process.stdout.write(event.payload.text.endsWith('\n') ? event.payload.text : `${event.payload.text}\n`);
      if (event.type === 'task.status_changed') console.log(`\n[${event.payload.to}]`);
    });
    try {
      const completed = await runTask(task);
      if (completed.status === 'failed') console.error('Run failed. Use /history or task show to inspect the recorded events.');
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
    } finally {
      unsubscribe();
    }
  };
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
      if (input === '/tasks') { printTasks(); continue; }
      if (input === '/status') {
        if (!sessionId) console.log('No active session yet.');
        else { const session = sessions.get(sessionId); console.log(`Session: ${session?.title ?? sessionId}`); printTasks(); }
        continue;
      }
      if (input === '/history') {
        if (!sessionId) console.log('No active session yet.');
        else for (const message of sessions.messages(sessionId)) console.log(`${message.role}: ${message.content}`);
        continue;
      }
      if (input === '/approvals') {
        const pending = approvals.list().filter((approval) => approval.status === 'pending' && (!sessionId || approval.request.taskId === local.listTasks().find((task) => task.sessionId === sessionId && task.status === 'waiting_approval')?.id));
        console.log(pending.length ? JSON.stringify(pending, null, 2) : 'No pending approvals.');
        continue;
      }
      const approvalCommand = /^(\/approve|\/deny)\s+([^\s]+)$/.exec(input);
      if (approvalCommand) {
        const id = approvalCommand[2]!;
        const approval = approvals.get(id);
        if (!approval) throw new Error(`Approval not found: ${id}`);
        const decision = approvalCommand[1] === '/approve' ? approvals.approve(id, 'tui-user') : approvals.deny(id, 'tui-user');
        console.log(JSON.stringify(decision, null, 2));
        if (decision.status === 'approved') {
          const waiting = local.getTask(approval.request.taskId as TaskId);
          if (waiting?.status === 'waiting_approval') await execute(waiting);
        }
        continue;
      }
      const resumeCommand = /^\/resume\s+([^\s]+)$/.exec(input);
      if (resumeCommand) {
        const task = local.getTask(resumeCommand[1] as TaskId);
        if (!task) { console.log(`Task not found: ${resumeCommand[1]}`); continue; }
        if (task.status === 'running') { console.log(`Task is already running: ${task.id}`); continue; }
        if (!['queued', 'waiting_approval'].includes(task.status)) { console.log(`Task is ${task.status}; only queued or waiting tasks can be resumed.`); continue; }
        sessionId = task.sessionId;
        await execute(task);
        continue;
      }
      if (input === '/cancel') {
        const active = local.listTasks().find((task) => task.sessionId === sessionId && activeStatuses.includes(task.status));
        if (active) console.log(JSON.stringify(local.cancelTask(active.id), null, 2)); else console.log('No active run.');
        continue;
      }
      const session = sessionId ? sessions.get(sessionId) : sessions.create({ workspaceId: 'local-workspace', title: input.slice(0, 80), mode: 'code' });
      if (!session) throw new Error(`Session not found: ${sessionId}`);
      sessionId = session.id;
      const task = local.createTask({ workspaceId: session.workspaceId, sessionId: session.id, title: session.title, objective: input, mode: session.mode });
      sessions.appendMessage({ sessionId: session.id, role: 'user', content: input, taskId: task.id });
      await execute(task);
    }
  } finally {
    readline.close();
  }
}

export interface TuiInputState {
  input: string;
  cursor: number;
  history: string[];
  historyIndex: number;
}

export function insertInputCharacter(state: TuiInputState, character: string): void {
  state.input = `${state.input.slice(0, state.cursor)}${character}${state.input.slice(state.cursor)}`;
  state.cursor += character.length;
}

export function deleteInputCharacter(state: TuiInputState): void {
  if (state.cursor <= 0) return;
  state.input = `${state.input.slice(0, state.cursor - 1)}${state.input.slice(state.cursor)}`;
  state.cursor -= 1;
}

export function moveInputHistory(state: TuiInputState, direction: -1 | 1): void {
  if (!state.history.length) return;
  if (state.historyIndex < 0) state.historyIndex = state.history.length;
  state.historyIndex = Math.max(0, Math.min(state.history.length, state.historyIndex + direction));
  state.input = state.historyIndex === state.history.length ? '' : state.history[state.historyIndex] ?? '';
  state.cursor = state.input.length;
}

interface FullScreenState extends TuiInputState {
  sessionId: string | undefined;
  output: string[];
  activeTaskId: TaskId | undefined;
  closing: boolean;
}

function renderFullScreen(options: TuiOptions, state: FullScreenState): void {
  const width = Math.max(40, process.stdout.columns || 80);
  const rows = Math.max(14, process.stdout.rows || 24);
  const tasks = options.local.listTasks();
  const currentSession = state.sessionId ? options.sessions.get(state.sessionId) : undefined;
  const pendingApprovals = options.approvals.list().filter((approval) => approval.status === 'pending');
  const activeTask = state.activeTaskId ? options.local.getTask(state.activeTaskId) : undefined;
  const title = `AgentCorps TUI  ·  ${activeTask ? `${statusIcon(activeTask.status)} ${activeTask.status}` : 'ready'}  ·  ${options.agentId()}`;
  const sidebarWidth = Math.min(30, Math.max(24, Math.floor(width * 0.32)));
  const bodyRows = Math.max(5, rows - 5);
  const lines: string[] = [title.slice(0, width), ''];

  if (width < 72) {
    const sessionLine = currentSession ? `Session: ${currentSession.title} (${currentSession.id.slice(-8)})` : 'Session: none';
    lines.push(sessionLine, `Tasks: ${tasks.length}  Approvals: ${pendingApprovals.length}`, '─'.repeat(width));
    lines.push(...wrapLines(state.output.slice(-Math.max(1, bodyRows - 5)), width));
  } else {
    const left: string[] = ['SESSION', currentSession ? currentSession.title : 'No active session', currentSession ? currentSession.id.slice(-16) : 'Type a prompt to begin', '', `TASKS (${tasks.length})`];
    for (const task of tasks.slice(-8)) left.push(taskLabel(task, sidebarWidth - 2));
    left.push('', `APPROVALS (${pendingApprovals.length})`);
    if (pendingApprovals.length) for (const approval of pendingApprovals.slice(-3)) left.push(`! ${approval.id.slice(-12)}`);
    else left.push('None');
    const rightWidth = width - sidebarWidth - 3;
    const right = wrapLines(state.output.slice(-bodyRows), rightWidth);
    for (let index = 0; index < Math.max(left.length, right.length, bodyRows); index += 1) {
      const leftValue = (left[index] ?? '').slice(0, sidebarWidth).padEnd(sidebarWidth);
      const rightValue = (right[index] ?? '').slice(0, rightWidth).padEnd(rightWidth);
      lines.push(`${leftValue} │ ${rightValue}`.slice(0, width));
    }
  }

  while (lines.length < rows - 2) lines.push('');
  lines.push('─'.repeat(width));
  const hint = pendingApprovals.length ? ' /approve ID  /deny ID  /approvals  /cancel  /quit' : ' /help  /tasks  /status  /history  /resume ID  /quit';
  const prompt = `> ${state.input}`;
  lines.push(`${prompt}${hint}`.slice(-width));
  const rendered = lines.slice(0, rows).join('\n');
  const inputColumn = Math.min(width, Math.max(1, 3 + state.cursor));
  process.stdout.write(`${ESC}H${ESC}2J${rendered}${ESC}${Math.min(rows, lines.length)};${inputColumn}H${ESC}?25h`);
}

async function runFullScreenTui(options: TuiOptions): Promise<void> {
  const input = process.stdin;
  const output = process.stdout;
  const state: FullScreenState = { sessionId: undefined, input: '', cursor: 0, history: [], historyIndex: -1, output: [], activeTaskId: undefined, closing: false };
  let escapeSequence = '';
  let running: Promise<void> | undefined;
  let resolveExit: (() => void) | undefined;
  const exited = new Promise<void>((resolve) => { resolveExit = resolve; });

  const log = (text: string, prefix = ''): void => {
    appendText(state.output, text, prefix);
    if (state.output.length > 600) state.output.splice(0, state.output.length - 600);
  };
  const refresh = (): void => renderFullScreen(options, state);
  const onEvent = (event: TaskEvent): void => {
    if (event.type === 'run.output') log(event.payload.text, event.payload.stream === 'stderr' ? 'stderr │ ' : '');
    if (event.type === 'task.status_changed') {
      log(`[${event.payload.to}]${event.payload.reason ? ` ${event.payload.reason}` : ''}`);
      if (terminalStatuses.includes(event.payload.to) || event.payload.to === 'waiting_approval') state.activeTaskId = undefined;
    }
    refresh();
  };
  const unsubscribe = options.local.store.subscribe(onEvent);
  const cleanup = (): void => {
    unsubscribe();
    input.removeListener('data', onData);
    output.removeListener('resize', refresh);
    if (input.isTTY) input.setRawMode(false);
    input.pause();
    output.write(`${ESC}?25h${ESC}?1049l`);
  };
  const finish = async (): Promise<void> => {
    if (state.closing) return;
    state.closing = true;
    if (state.activeTaskId) options.local.cancelTask(state.activeTaskId);
    options.local.shutdown('TUI exited');
    await running?.catch(() => undefined);
    cleanup();
    resolveExit?.();
  };
  const execute = (task: Task): void => {
    state.activeTaskId = task.id;
    running = options.runTask(task)
      .then((completed) => { if (completed.status === 'failed') log('Run failed. Use /history or task show to inspect the recorded events.', 'error │ '); })
      .catch((error: unknown) => log(error instanceof Error ? error.message : String(error), 'error │ '))
      .finally(() => { state.activeTaskId = undefined; running = undefined; refresh(); });
    void running;
  };
  const showHelp = (): void => log('Commands: /help /new /tasks /status /history /approvals /approve ID /deny ID /resume ID /cancel /quit');
  const showTasks = (): void => {
    const tasks = options.local.listTasks().filter((task) => !state.sessionId || task.sessionId === state.sessionId);
    if (!tasks.length) log('No tasks in the current session.');
    else for (const task of tasks) log(`${statusIcon(task.status)} ${task.id}  ${task.status}  ${task.title}`);
  };
  const showHistory = (): void => {
    if (!state.sessionId) { log('No active session yet.'); return; }
    for (const message of options.sessions.messages(state.sessionId)) log(`${message.role}: ${message.content}`);
  };
  const showApprovals = (): void => {
    const pending = options.approvals.list().filter((approval) => approval.status === 'pending');
    log(pending.length ? JSON.stringify(pending, null, 2) : 'No pending approvals.');
  };
  const executeInput = async (value: string): Promise<void> => {
    const command = value.trim();
    if (!command) return;
    if (command === '/quit' || command === '/exit') { await finish(); return; }
    if (command === '/help') { showHelp(); return; }
    if (command === '/new') { state.sessionId = undefined; log('Started a new session.'); return; }
    if (command === '/tasks') { showTasks(); return; }
    if (command === '/status') {
      const session = state.sessionId ? options.sessions.get(state.sessionId) : undefined;
      log(session ? `Session: ${session.title} (${session.id})` : 'No active session yet.');
      showTasks();
      return;
    }
    if (command === '/history') { showHistory(); return; }
    if (command === '/approvals') { showApprovals(); return; }
    if (command === '/cancel') {
      const active = state.activeTaskId ? options.local.getTask(state.activeTaskId) : options.local.listTasks().find((task) => task.sessionId === state.sessionId && activeStatuses.includes(task.status));
      if (active) log(JSON.stringify(options.local.cancelTask(active.id), null, 2)); else log('No active run.');
      return;
    }
    const approvalCommand = /^(\/approve|\/deny)\s+([^\s]+)$/.exec(command);
    if (approvalCommand) {
      const id = approvalCommand[2]!;
      const approval = options.approvals.get(id);
      if (!approval) { log(`Approval not found: ${id}`, 'error │ '); return; }
      const decision = approvalCommand[1] === '/approve' ? options.approvals.approve(id, 'tui-user') : options.approvals.deny(id, 'tui-user');
      log(JSON.stringify(decision, null, 2));
      if (decision.status === 'approved') {
        const waiting = options.local.getTask(approval.request.taskId as TaskId);
        if (waiting?.status === 'waiting_approval') execute(waiting);
      }
      return;
    }
    const resumeCommand = /^\/resume\s+([^\s]+)$/.exec(command);
    if (resumeCommand) {
      const task = options.local.getTask(resumeCommand[1] as TaskId);
      if (!task) { log(`Task not found: ${resumeCommand[1]}`); return; }
      if (task.status === 'running') { log(`Task is already running: ${task.id}`); return; }
      if (!['queued', 'waiting_approval'].includes(task.status)) { log(`Task is ${task.status}; only queued or waiting tasks can be resumed.`); return; }
      state.sessionId = task.sessionId;
      execute(task);
      return;
    }
    if (state.activeTaskId) { log('A task is already running. Use /status, /approvals, or /cancel first.'); return; }
    const session = state.sessionId ? options.sessions.get(state.sessionId) : options.sessions.create({ workspaceId: 'local-workspace', title: command.slice(0, 80), mode: 'code' });
    if (!session) { log(`Session not found: ${state.sessionId}`, 'error │ '); return; }
    state.sessionId = session.id;
    const task = options.local.createTask({ workspaceId: session.workspaceId, sessionId: session.id, title: session.title, objective: command, mode: session.mode });
    options.sessions.appendMessage({ sessionId: session.id, role: 'user', content: command, taskId: task.id });
    log(`Created task ${task.id}: ${task.title}`);
    execute(task);
  };
  const submit = (): void => {
    const value = state.input.trim();
    if (!value) return refresh();
    state.history = [...state.history.filter((item) => item !== value), value].slice(-50);
    state.historyIndex = -1;
    state.input = '';
    state.cursor = 0;
    void executeInput(value).then(refresh).catch((error: unknown) => { log(error instanceof Error ? error.message : String(error), 'error │ '); refresh(); });
    refresh();
  };
  const moveHistory = (direction: -1 | 1): void => moveInputHistory(state, direction);
  const insertCharacter = (character: string): void => insertInputCharacter(state, character);
  const onData = (chunk: Buffer | string): void => {
    if (state.closing) return;
    for (const character of chunk.toString()) {
      if (escapeSequence) {
        escapeSequence += character;
        if (escapeSequence === '[') continue;
        if (/^[0-9;]*[A-Za-z~]$/.test(escapeSequence)) {
          if (escapeSequence === '[A') moveHistory(-1);
          else if (escapeSequence === '[B') moveHistory(1);
          else if (escapeSequence === '[C') state.cursor = Math.min(state.input.length, state.cursor + 1);
          else if (escapeSequence === '[D') state.cursor = Math.max(0, state.cursor - 1);
          else if (escapeSequence === '[H' || escapeSequence === '[1~') state.cursor = 0;
          else if (escapeSequence === '[F' || escapeSequence === '[4~') state.cursor = state.input.length;
          escapeSequence = '';
        }
        continue;
      }
      if (character === '\u001b') { escapeSequence = ''; continue; }
      if (character === '\u0003') { void finish(); continue; }
      if (character === '\u0004') { void finish(); continue; }
      if (character === '\r' || character === '\n') { submit(); continue; }
      if (character === '\u007f' || character === '\b') {
        deleteInputCharacter(state);
        continue;
      }
      if (character === '\u0015') { state.input = ''; state.cursor = 0; continue; }
      if (character >= ' ' && character !== '\u007f') insertCharacter(character);
    }
    refresh();
  };

  input.setRawMode(true);
  input.setEncoding('utf8');
  input.resume();
  input.on('data', onData);
  output.on('resize', refresh);
  output.write(`${ESC}?1049h${ESC}?25l`);
  log('Full-screen mode. Type a prompt and press Enter.');
  log(`Data: ${options.dataDir}`);
  showHelp();
  refresh();
  await exited;
}

export async function runTui(options: TuiOptions): Promise<void> {
  if (process.stdin.isTTY && process.stdout.isTTY) await runFullScreenTui(options);
  else await runLineTui(options);
}
