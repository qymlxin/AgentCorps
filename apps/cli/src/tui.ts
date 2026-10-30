import { createInterface } from 'node:readline';
import type { ApprovalService } from '@agentcorps/security';
import type { Task, TaskEvent, TaskId, TaskStatus } from '@agentcorps/domain';
import type { AgentConversationMessage, AgentControl, TaskRuntime } from '@agentcorps/runtime';
import type { SessionService } from '@agentcorps/session';
import { runInkTui } from './tui-ink.js';
import { formatAgentOutput, formatProtocolEvent } from './tui-format.js';

export interface TuiOptions {
  readonly local: TaskRuntime;
  readonly sessions: SessionService;
  readonly approvals: ApprovalService;
  readonly dataDir: string;
  readonly initialSessionId?: string;
  readonly agentId: () => string;
  readonly model?: () => string | undefined;
  readonly acpControl?: (sessionId: string) => AgentControl | undefined;
  readonly runTask: (task: Task, conversation?: readonly AgentConversationMessage[]) => Promise<Task>;
}

const ESC = '\u001b[';
const terminalStatuses: readonly TaskStatus[] = ['succeeded', 'failed', 'cancelled'];
const activeStatuses: readonly TaskStatus[] = ['queued', 'running', 'waiting_approval'];
export interface TuiCommandSuggestion {
  readonly command: string;
  readonly description: string;
  readonly completion: string;
}

const tuiCommands: readonly TuiCommandSuggestion[] = [
  { command: '/help', description: '显示快捷键和命令帮助', completion: '/help' },
  { command: '/new', description: '开始新的会话', completion: '/new' },
  { command: '/tasks', description: '列出当前会话的任务', completion: '/tasks' },
  { command: '/status', description: '显示会话和任务状态', completion: '/status' },
  { command: '/history', description: '查看当前会话消息', completion: '/history' },
  { command: '/approvals', description: '列出待处理审批', completion: '/approvals' },
  { command: '/approve ID', description: '批准一个审批请求', completion: '/approve ' },
  { command: '/deny ID', description: '拒绝一个审批请求', completion: '/deny ' },
  { command: '/pause', description: '暂停当前任务', completion: '/pause' },
  { command: '/resume TASK_ID', description: '恢复暂停或等待中的任务', completion: '/resume ' },
  { command: '/retry [TASK_ID]', description: '重试失败或取消的任务', completion: '/retry ' },
  { command: '/switch TASK_ID', description: '切换到另一个任务会话', completion: '/switch ' },
  { command: '/mode MODE_ID', description: '切换当前 ACP session 模式', completion: '/mode ' },
  { command: '/config ID VALUE', description: '设置当前 ACP session 配置项', completion: '/config ' },
  { command: '/session-load SESSION_ID', description: '加载并恢复 ACP session', completion: '/session-load ' },
  { command: '/session-close', description: '关闭当前 ACP session', completion: '/session-close' },
  { command: '/cancel', description: '取消当前任务', completion: '/cancel' },
  { command: '/raw', description: '切换原始事件显示', completion: '/raw' },
  { command: '/quit', description: '退出 TUI', completion: '/quit' },
];

export function commandSuggestions(value: string): readonly TuiCommandSuggestion[] {
  const query = value.trimStart().toLowerCase();
  if (!query.startsWith('/') || /\s/.test(query)) return [];
  return tuiCommands.filter((entry) => entry.command.toLowerCase().startsWith(query)).slice(0, 8);
}

export function resolveInitialSessionId(sessions: SessionService, requested?: string): string | undefined {
  if (requested) return sessions.get(requested) ? requested : undefined;
  const list = (sessions as SessionService & { list?: () => readonly { readonly id: string }[] }).list;
  return typeof list === 'function' ? list.call(sessions).at(-1)?.id : undefined;
}

function conversationForTask(sessions: SessionService, task: Task): readonly AgentConversationMessage[] {
  return sessions.messages(task.sessionId)
    .filter((message) => message.taskId !== task.id)
    .slice(-24)
    .map((message) => ({ role: message.role, content: message.content }));
}

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

async function runLineTui({ local, sessions, approvals, dataDir, initialSessionId: configuredSessionId, agentId, runTask, acpControl }: TuiOptions): Promise<void> {
  const readline = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: process.stdin.isTTY === true,
    completer: (line: string) => {
      const suggestions = commandSuggestions(line);
      return [suggestions.map((suggestion) => suggestion.completion), line];
    },
  });
  const requestedSessionMissing = Boolean(configuredSessionId && !sessions.get(configuredSessionId));
  let sessionId: string | undefined = resolveInitialSessionId(sessions, configuredSessionId);
  const ask = (question: string): Promise<string> => new Promise((resolve) => readline.question(question, resolve));
  const printHelp = (): void => console.log('Commands: /help, /new, /tasks, /status, /history, /approvals, /approve ID, /deny ID, /mode MODE_ID, /config ID VALUE, /session-load ACP_SESSION_ID, /session-close, /pause, /resume TASK_ID, /retry [TASK_ID], /cancel, /quit. Enter a prompt to run the configured Agent.');
  const printTasks = (): void => {
    const tasks = local.listTasks().filter((task) => !sessionId || task.sessionId === sessionId);
    if (!tasks.length) { console.log('No tasks in the current session.'); return; }
    for (const task of tasks) console.log(`${task.id}  ${task.status.padEnd(17)}  ${task.title}`);
  };
  const execute = async (task: Task): Promise<void> => {
    const unsubscribe = local.store.subscribe((event) => {
      if (event.aggregateId !== task.id) return;
      if (event.type === 'run.output') {
        for (const line of formatAgentOutput(event.payload.text, event.payload.stream)) console.log(line.text);
      }
      if (event.type === 'run.protocol') console.log(formatProtocolEvent(event).text);
      if (event.type === 'task.status_changed') console.log(`\n[${event.payload.to}]${event.payload.reason ? ` ${event.payload.reason}` : ''}`);
    });
    try {
      const completed = await runTask(task, conversationForTask(sessions, task));
      if (completed.status === 'failed') console.error('Run failed. Use /history or task show to inspect the recorded events.');
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
    } finally {
      unsubscribe();
    }
  };
  console.log('AgentCorps TUI · interactive local Agent session');
  console.log(`Data: ${dataDir}`);
  if (requestedSessionMissing) console.log(`Session not found: ${configuredSessionId}. Starting without a session; enter a prompt to create one.`);
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
        if (!['queued', 'waiting_approval', 'paused'].includes(task.status)) { console.log(`Task is ${task.status}; only queued, paused, or waiting tasks can be resumed.`); continue; }
        sessionId = task.sessionId;
        await execute(task.status === 'paused' ? local.resumeTask(task.id) : task);
        continue;
      }
      const modeCommand = /^\/mode\s+([^\s]+)$/.exec(input);
      if (modeCommand) {
        const control = sessionId ? acpControl?.(sessionId) : undefined;
        if (!sessionId) console.log('No active AgentCorps session. Run a prompt first.');
        else if (!control?.setMode) console.log('The selected Agent does not expose ACP mode control.');
        else try { await control.setMode(sessionId, modeCommand[1]!); console.log(`ACP mode changed to ${modeCommand[1]}`); } catch (error) { console.error(error instanceof Error ? error.message : String(error)); }
        continue;
      }
      const configCommand = /^\/config\s+([^\s]+)\s+(.+)$/.exec(input);
      if (configCommand) {
        const control = sessionId ? acpControl?.(sessionId) : undefined;
        if (!sessionId) console.log('No active AgentCorps session. Run a prompt first.');
        else if (!control?.setConfigOption) console.log('The selected Agent does not expose ACP config control.');
        else try { await control.setConfigOption(sessionId, configCommand[1]!, configCommand[2]!); console.log(`ACP config ${configCommand[1]} updated`); } catch (error) { console.error(error instanceof Error ? error.message : String(error)); }
        continue;
      }
      const loadCommand = /^\/session-load\s+([^\s]+)$/.exec(input);
      if (loadCommand) {
        const control = sessionId ? acpControl?.(sessionId) : undefined;
        if (!sessionId) console.log('No active AgentCorps session. Run a prompt first.');
        else if (!control?.loadSession) console.log('The selected Agent does not expose ACP session loading.');
        else try { await control.loadSession(sessionId, loadCommand[1]!); console.log(`Loaded ACP session ${loadCommand[1]} into ${sessionId}`); } catch (error) { console.error(error instanceof Error ? error.message : String(error)); }
        continue;
      }
      const closeCommand = input === '/session-close';
      if (closeCommand) {
        const control = sessionId ? acpControl?.(sessionId) : undefined;
        if (!sessionId) console.log('No active AgentCorps session.');
        else if (!control?.closeSession) console.log('The selected Agent does not expose ACP session closing.');
        else try { await control.closeSession(sessionId); console.log(`Closed ACP session for ${sessionId}`); } catch (error) { console.error(error instanceof Error ? error.message : String(error)); }
        continue;
      }
      if (input === '/pause') {
        const active = local.listTasks().find((task) => task.sessionId === sessionId && activeStatuses.includes(task.status));
        if (active) console.log(JSON.stringify(local.pauseTask(active.id), null, 2)); else console.log('No active run.');
        continue;
      }
      const retryCommand = /^\/retry(?:\s+([^\s]+))?$/.exec(input);
      if (retryCommand) {
        const task = retryCommand[1] ? local.getTask(retryCommand[1] as TaskId) : local.listTasks().find((candidate) => candidate.sessionId === sessionId && (candidate.status === 'failed' || candidate.status === 'cancelled'));
        if (!task) console.log('No failed or cancelled task to retry.');
        else { try { await execute(local.retryTask(task.id)); } catch (error) { console.error(error instanceof Error ? error.message : String(error)); } }
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
  const requestedSessionMissing = Boolean(options.initialSessionId && !options.sessions.get(options.initialSessionId));
  const state: FullScreenState = { sessionId: resolveInitialSessionId(options.sessions, options.initialSessionId), input: '', cursor: 0, history: [], historyIndex: -1, output: [], activeTaskId: undefined, closing: false };
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
    if (state.activeTaskId && event.aggregateId !== state.activeTaskId) return;
    if (event.type === 'run.output') {
      for (const line of formatAgentOutput(event.payload.text, event.payload.stream)) log(line.text, event.payload.stream === 'stderr' ? 'stderr │ ' : '');
    }
    if (event.type === 'run.started') log(`Run started · ${event.payload.agentId}${event.payload.model ? ` · ${event.payload.model}` : ''}`);
    if (event.type === 'run.protocol') log(formatProtocolEvent(event).text);
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
    running = options.runTask(task, conversationForTask(options.sessions, task))
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
  log('Full-screen mode. Type a prompt and press Enter. Type / to browse commands.');
  log(`Data: ${options.dataDir}`);
  if (requestedSessionMissing) log(`Session not found: ${options.initialSessionId}. Starting without a session; enter a prompt to create one.`, 'error │ ');
  showHelp();
  refresh();
  await exited;
}

export async function runTui(options: TuiOptions): Promise<void> {
  if (process.stdin.isTTY && process.stdout.isTTY) await runInkTui(options);
  else await runLineTui(options);
}
