import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Box, Text, render, useInput, useWindowSize, type Key } from 'ink';
import type { Task, TaskEvent, TaskId, TaskStatus } from '@agentcorps/domain';
import type { Approval } from '@agentcorps/security';
import type { TuiOptions } from './tui.js';
import { deleteInputCharacter, insertInputCharacter, moveInputHistory, commandSuggestions, resolveInitialSessionId, type TuiCommandSuggestion } from './tui.js';
import { emptyAcpProjection, reduceAcpProjection, type AcpProjection } from './acp-state.js';
import { formatAgentOutput, formatApproval, formatDuration, formatMarkdown, formatProtocolEvent, statusIcon, statusLabel, type TuiLineKind, type TuiRenderLine } from './tui-format.js';


const activeStatuses: readonly TaskStatus[] = ['queued', 'running', 'waiting_approval'];
const terminalStatuses: readonly TaskStatus[] = ['succeeded', 'failed', 'cancelled'];
const colors: Record<TuiLineKind, string | undefined> = {
  text: undefined,
  muted: 'gray',
  heading: 'cyan',
  bullet: 'white',
  code: 'yellow',
  'diff-add': 'green',
  'diff-remove': 'red',
  error: 'red',
  success: 'green',
  event: 'blue',
  warning: 'yellow',
};

interface InkTuiProps {
  readonly options: TuiOptions;
  readonly onExit: () => void;
}

function shorten(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 1))}…`;
}

interface InputViewportRow {
  readonly text: string;
  readonly cursor: boolean;
}

function splitInputLine(value: string, width: number): string[] {
  if (!value) return [''];
  const rows: string[] = [];
  for (let offset = 0; offset < value.length; offset += width) rows.push(value.slice(offset, offset + width));
  return rows;
}

/** Render only the fixed-height portion of the draft around the cursor. */
export function inputViewport(value: string, cursor: number, width: number, maxRows: number): readonly InputViewportRow[] {
  const safeWidth = Math.max(8, width);
  const logicalLines = value.split('\\n');
  const rows: InputViewportRow[] = [];
  let offset = 0;
  let cursorRow = 0;

  for (const logicalLine of logicalLines) {
    const lineStart = offset;
    const lineEnd = offset + logicalLine.length;
    const cursorColumn = cursor - lineStart;
    const chunks = splitInputLine(logicalLine, safeWidth);
    for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex += 1) {
      const chunk = chunks[chunkIndex]!;
      const chunkStart = chunkIndex * safeWidth;
      const chunkEnd = chunkStart + chunk.length;
      const cursorOnChunk = cursor >= lineStart && cursor <= lineEnd
        && (cursorColumn >= chunkStart && cursorColumn < chunkEnd
          || cursorColumn === chunkEnd && chunkEnd === logicalLine.length);
      let text = chunk;
      if (cursorOnChunk) {
        const localCursor = Math.max(0, cursorColumn - chunkStart);
        text = `${chunk.slice(0, localCursor)}▌${chunk.slice(localCursor)}`.slice(0, safeWidth);
        cursorRow = rows.length;
      }
      rows.push({ text, cursor: cursorOnChunk });
    }
    offset = lineEnd + 1;
  }

  const rowLimit = Math.max(1, maxRows);
  const start = Math.max(0, Math.min(cursorRow, rows.length - rowLimit));
  const visible = rows.slice(start, start + rowLimit);
  return visible.length ? visible : [{ text: '▌', cursor: true }];
}

function statusColor(status: TaskStatus): string {
  if (status === 'succeeded') return 'green';
  if (status === 'failed' || status === 'cancelled') return 'red';
  if (status === 'waiting_approval') return 'yellow';
  if (status === 'paused') return 'magenta';
  if (status === 'running') return 'cyan';
  return 'gray';
}

function TaskList({ tasks, selectedIndex, width }: { readonly tasks: readonly Task[]; readonly selectedIndex: number; readonly width: number }): React.ReactElement {
  if (!tasks.length) return <Text dimColor>No tasks yet</Text>;
  return <Box flexDirection="column" overflow="hidden">
    {tasks.slice(-8).map((task, index) => {
      const selected = index === selectedIndex;
      return <Text key={task.id} color={selected ? 'white' : statusColor(task.status)} inverse={selected} wrap="truncate-end">
        {selected ? '› ' : '  '}{statusIcon(task.status)} {shorten(task.title, Math.max(12, width - 8))}
      </Text>;
    })}
  </Box>;
}

function RenderedLine({ item, showRaw }: { readonly item: TuiRenderLine; readonly showRaw: boolean }): React.ReactElement {
  const text = showRaw && item.raw ? item.raw : item.text;
  const prefix = item.kind === 'bullet' ? '• ' : item.kind === 'diff-add' ? '+ ' : item.kind === 'diff-remove' ? '- ' : '';
  const style = { bold: item.kind === 'heading' || item.kind === 'warning', dimColor: item.kind === 'muted' };
  const content = <Text {...(colors[item.kind] ? { color: colors[item.kind]! } : {})} {...style} wrap="truncate-end">
    {prefix}{text.replace(/\\r?\\n/g, ' ')}
  </Text>;
  return content;
}

function CommandSuggestions({ suggestions, selectedIndex }: { readonly suggestions: readonly TuiCommandSuggestion[]; readonly selectedIndex: number }): React.ReactElement | null {
  if (!suggestions.length) return null;
  return <Box flexDirection="column" paddingX={1} borderStyle="round" borderColor="magenta" overflow="hidden">
    {suggestions.map((suggestion, index) => <Text key={suggestion.command} color={index === selectedIndex ? 'white' : 'gray'} inverse={index === selectedIndex} wrap="truncate-end">
      {index === selectedIndex ? '› ' : '  '}{suggestion.command.padEnd(22)} {suggestion.description}
    </Text>)}
    <Text dimColor>↑/↓ 选择 · Enter 补全/执行 · Esc 关闭</Text>
  </Box>;
}
function HelpPanel(): React.ReactElement {
  return <Box flexDirection="column" paddingX={1} overflow="hidden">
    <Text bold color="cyan">Keyboard</Text>
    <Text dimColor wrap="truncate-end">Enter send · Shift+Enter newline · ↑/↓ history · ←/→ edit</Text>
    <Text dimColor wrap="truncate-end">PageUp/PageDown scroll · Home/End jump · Tab select task</Text>
    <Text color="yellow" wrap="truncate-end">Ctrl+P pause/resume · Ctrl+X cancel · Ctrl+R retry · Ctrl+O approve</Text>
    <Text dimColor wrap="truncate-end">ACP controls: /mode MODE_ID · /config ID VALUE · /session-load ACP_SESSION_ID · /session-close</Text>
  </Box>;
}

function ApprovalPanel({ approvals }: { readonly approvals: readonly Approval[] }): React.ReactElement {
  if (!approvals.length) return <Text dimColor>No pending approvals</Text>;
  return <Box flexDirection="column">
    {approvals.slice(0, 3).map((approval) => <Box key={approval.id} flexDirection="column">
      {formatApproval(approval).map((item, index) => <RenderedLine key={`${approval.id}-${index}`} item={item} showRaw={false} />)}
    </Box>)}
    <Text dimColor>a approve first · d deny first</Text>
  </Box>;
}

function AcpPanel({ acp }: { readonly acp: AcpProjection }): React.ReactElement | null {
  const tools = Object.values(acp.tools);
  const terminals = Object.values(acp.terminals);
  if (!tools.length && !terminals.length && !acp.currentModeId && !acp.usage) return null;
  return <Box marginTop={1} flexDirection="column" overflow="hidden">
    <Text bold color="magenta">ACP {acp.currentModeId ? `· ${acp.currentModeId}` : ''}</Text>
    {tools.slice(-4).map((tool) => <Text key={tool.id} color={tool.status === 'completed' ? 'green' : tool.status === 'failed' ? 'red' : 'yellow'} wrap="truncate-end">⚙ {shorten(tool.title, 22)}{tool.status ? ` · ${tool.status}` : ''}</Text>)}
    {terminals.slice(-2).map((terminal) => <Text key={terminal.id} color={terminal.running ? 'yellow' : 'gray'} wrap="truncate-end">⌁ terminal {terminal.running ? 'running' : `exit ${terminal.exitCode ?? '?'}`}</Text>)}
    {acp.usage && <Text dimColor wrap="truncate-end">usage {acp.usage.used ?? '?'}{acp.usage.size === undefined ? '' : ` / ${acp.usage.size}`}</Text>}
  </Box>;
}

function taskMatchesSearch(task: Task, query: string): boolean {
  const haystack = `${task.id} ${task.title} ${task.objective} ${task.status}`.toLowerCase();
  return haystack.includes(query.toLowerCase());
}

export function InkTui({ options, onExit }: InkTuiProps): React.ReactElement {
  const { columns, rows } = useWindowSize();
  const requestedSessionMissing = Boolean(options.initialSessionId && !options.sessions.get(options.initialSessionId));
  const initialSessionId = resolveInitialSessionId(options.sessions, options.initialSessionId);
  const [draft, setDraft] = useState('');
  const [cursor, setCursor] = useState(0);
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [sessionId, setSessionId] = useState<string | undefined>(initialSessionId);
  const [output, setOutput] = useState<TuiRenderLine[]>(() => [
    ...(requestedSessionMissing ? [{ kind: 'error' as const, text: `Session not found: ${options.initialSessionId}. Starting without a session; enter a prompt to create one.` }] : []),
    ...(sessionId ? options.sessions.messages(sessionId).flatMap((message) => [{ kind: 'muted' as const, text: `${message.role}:` }, ...formatMarkdown(message.content)]) : []),
  ]);
  const [activeTaskId, setActiveTaskId] = useState<TaskId>();
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [scroll, setScroll] = useState(0);
  const [folded, setFolded] = useState(false);
  const [showRaw, setShowRaw] = useState(false);
  const [help, setHelp] = useState(false);
  const [searchMode, setSearchMode] = useState(false);
  const [search, setSearch] = useState('');
  const [commandIndex, setCommandIndex] = useState(0);
  const [commandMenuDismissed, setCommandMenuDismissed] = useState(false);
  const [clock, setClock] = useState(() => new Date().toISOString());
  const [acp, setAcp] = useState<AcpProjection>(emptyAcpProjection);

  const suggestions = useMemo(() => commandMenuDismissed ? [] : commandSuggestions(draft), [commandMenuDismissed, draft]);
  const selectedCommand = suggestions[commandIndex] ?? suggestions[0];
  const allTasks = options.local.listTasks();
  const tasks = allTasks.filter((task) => !sessionId || task.sessionId === sessionId);
  const pendingApprovals = options.approvals.list().filter((approval) => approval.status === 'pending');
  const selectedIndexSafe = tasks.length ? Math.min(selectedIndex, tasks.length - 1) : 0;
  const selectedTask = tasks[selectedIndexSafe];
  const activeTask = activeTaskId ? options.local.getTask(activeTaskId) : selectedTask;
  const visibleTasks = search ? tasks.filter((task) => taskMatchesSearch(task, search)) : tasks;
  const isNarrow = columns < 88;
  const inputRows = 3;
  const composerHeight = inputRows + 3;
  const suggestionRows = suggestions.length ? Math.min(12, suggestions.length + 3) : 0;
  const searchRows = searchMode ? 1 : 0;
  const mainHeight = Math.max(3, rows - 2 - searchRows - composerHeight - suggestionRows);
  const outputHeight = Math.max(1, mainHeight - (isNarrow ? 2 : 1));
  const visibleOutput = useMemo(() => {
    const source = folded ? output.slice(-Math.min(8, output.length)) : output;
    const maxStart = Math.max(0, source.length - outputHeight);
    const start = Math.max(0, Math.min(maxStart, source.length - outputHeight - scroll));
    return source.slice(start, start + outputHeight);
  }, [folded, output, outputHeight, scroll]);

  const append = useCallback((lines: readonly TuiRenderLine[]): void => {
    setOutput((current) => [...current, ...lines].slice(-1200));
    setScroll(0);
  }, []);

  useEffect(() => {
    setCommandIndex((current) => suggestions.length ? Math.min(current, suggestions.length - 1) : 0);
  }, [suggestions.length]);

  useEffect(() => {
    const timer = setInterval(() => setClock(new Date().toISOString()), 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    const unsubscribe = options.local.store.subscribe((event: TaskEvent) => {
      setClock(new Date().toISOString());
      if (activeTaskId && event.aggregateId !== activeTaskId && event.type === 'run.output') return;
      if (event.type === 'run.output') append(formatAgentOutput(event.payload.text, event.payload.stream));
    if (event.type === 'run.started') {
      setAcp(emptyAcpProjection());
      append([{ kind: 'event', text: `Run started · ${event.payload.agentId}${event.payload.model ? ` · ${event.payload.model}` : ''}` }]);
    }
    else if (event.type === 'run.protocol') {
        if (event.payload.protocol === 'acp') setAcp((current) => reduceAcpProjection(current, event));
        append([formatProtocolEvent(event)]);
      } else if (event.type === 'task.status_changed') {
        if (event.aggregateId === activeTaskId && terminalStatuses.includes(event.payload.to)) setActiveTaskId(undefined);
        const kind = event.payload.to === 'failed' ? 'error' : event.payload.to === 'succeeded' ? 'success' : event.payload.to === 'waiting_approval' ? 'warning' : 'event';
        append([{ kind, text: `${statusIcon(event.payload.to)} ${statusLabel(event.payload.to)}${event.payload.reason ? ` · ${event.payload.reason}` : ''}` }]);
      }
    });
    return unsubscribe;
  }, [activeTaskId, append, options.local.store]);

  const executeTask = useCallback((task: Task): void => {
    if (activeTaskId) { append([{ kind: 'warning', text: 'A task is already running. Use c to cancel it first.' }]); return; }
    setSessionId(task.sessionId);
    setActiveTaskId(task.id);
    append([{ kind: 'event', text: `Starting ${task.title} · ${task.id}` }]);
    const runnable = task.status === 'paused' ? options.local.resumeTask(task.id) : task;
    const conversation = options.sessions.messages(task.sessionId)
      .filter((message) => message.taskId !== task.id)
      .slice(-24)
      .map((message) => ({ role: message.role, content: message.content }));
    void options.runTask(runnable, conversation)
      .then((completed) => {
        if (completed.status === 'failed') append([{ kind: 'error', text: 'Run failed. Press r to retry the selected task.' }]);
      })
      .catch((error: unknown) => append([{ kind: 'error', text: error instanceof Error ? error.message : String(error) }]))
      .finally(() => setActiveTaskId(undefined));
  }, [activeTaskId, append, options]);

  const approve = useCallback((decision: 'approve' | 'deny'): void => {
    const approval = pendingApprovals[0];
    if (!approval) { append([{ kind: 'muted', text: 'No pending approvals.' }]); return; }
    try {
      const result = decision === 'approve' ? options.approvals.approve(approval.id, 'tui-user') : options.approvals.deny(approval.id, 'tui-user');
      append([{ kind: result.status === 'approved' ? 'success' : 'warning', text: `Approval ${result.status} · ${approval.id}` }]);
      if (result.status === 'approved') {
        const waiting = options.local.getTask(approval.request.taskId as TaskId);
        if (waiting?.status === 'waiting_approval') executeTask(waiting);
      }
    } catch (error: unknown) { append([{ kind: 'error', text: error instanceof Error ? error.message : String(error) }]); }
  }, [append, executeTask, options, pendingApprovals]);

  const selectTask = useCallback((index: number): void => {
    if (!tasks.length) return;
    setSelectedIndex(Math.max(0, Math.min(tasks.length - 1, index)));
  }, [tasks.length]);

  const submit = useCallback((value: string): void => {
    const command = value.trim();
    if (!command) return;
    setHistory((current) => [...current.filter((item) => item !== value), value].slice(-50));
    setHistoryIndex(-1);
    setCommandMenuDismissed(false);
    setDraft('');
    setCursor(0);
    if (command === '/quit' || command === '/exit') { onExit(); return; }
    if (command === '/help') { setHelp(true); return; }
    if (command === '/new') { setSessionId(undefined); setSelectedIndex(0); append([{ kind: 'success', text: 'Started a new session.' }]); return; }
    if (command === '/tasks') { append(tasks.length ? tasks.map((task) => ({ kind: 'text' as const, text: `${statusIcon(task.status)} ${task.id} · ${statusLabel(task.status)} · ${task.title}` })) : [{ kind: 'muted', text: 'No tasks in the current session.' }]); return; }
    if (command === '/status') { append([{ kind: 'event', text: activeTask ? `${statusIcon(activeTask.status)} ${statusLabel(activeTask.status)} · ${activeTask.id}` : 'No active task.' }]); return; }
    if (command === '/history') {
      if (!sessionId) append([{ kind: 'muted', text: 'No active session yet.' }]);
      else append(options.sessions.messages(sessionId).flatMap((message) => [{ kind: 'muted' as const, text: `${message.role}:` }, ...formatMarkdown(message.content)]));
      return;
    }
    if (command === '/approvals') { append(pendingApprovals.flatMap((approval) => formatApproval(approval))); return; }
    if (command === '/raw') { setShowRaw((current) => !current); append([{ kind: 'event', text: `Raw event view ${showRaw ? 'disabled' : 'enabled'}` }]); return; }
    const approvalCommand = /^(\/approve|\/deny)\s+([^\s]+)$/.exec(command);
    if (approvalCommand) {
      const approval = options.approvals.get(approvalCommand[2]!);
      if (!approval) append([{ kind: 'error', text: `Approval not found: ${approvalCommand[2]}` }]);
      else {
        try {
          const result = approvalCommand[1] === '/approve' ? options.approvals.approve(approval.id, 'tui-user') : options.approvals.deny(approval.id, 'tui-user');
          append([{ kind: result.status === 'approved' ? 'success' : 'warning', text: `Approval ${result.status} · ${approval.id}` }]);
          if (result.status === 'approved') { const waiting = options.local.getTask(approval.request.taskId as TaskId); if (waiting?.status === 'waiting_approval') executeTask(waiting); }
        } catch (error: unknown) { append([{ kind: 'error', text: error instanceof Error ? error.message : String(error) }]); }
      }
      return;
    }
    const resume = /^\/resume\s+([^\s]+)$/.exec(command);
    if (resume) { const task = options.local.getTask(resume[1] as TaskId); if (!task) append([{ kind: 'error', text: `Task not found: ${resume[1]}` }]); else executeTask(task); return; }
    const retry = /^\/retry(?:\s+([^\s]+))?$/.exec(command);
    if (retry) {
      const task = retry[1] ? options.local.getTask(retry[1] as TaskId) : selectedTask;
      if (!task) append([{ kind: 'error', text: 'Select a task to retry.' }]);
      else { try { executeTask(options.local.retryTask(task.id)); } catch (error: unknown) { append([{ kind: 'error', text: error instanceof Error ? error.message : String(error) }]); } }
      return;
    }
    const switchCommand = /^\/switch\s+([^\s]+)$/.exec(command);
    if (switchCommand) { const task = options.local.getTask(switchCommand[1] as TaskId); if (!task) append([{ kind: 'error', text: `Task not found: ${switchCommand[1]}` }]); else { setSessionId(task.sessionId); setSelectedIndex(0); append([{ kind: 'success', text: `Switched to task ${task.id}` }]); } return; }
    const modeCommand = /^\/mode\s+([^\s]+)$/.exec(command);
    if (modeCommand) {
      const control = sessionId ? options.acpControl?.(sessionId) : undefined;
      if (!sessionId) append([{ kind: 'error', text: 'No active AgentCorps session. Run a prompt first.' }]);
      else if (!control?.setMode) append([{ kind: 'error', text: 'The selected Agent does not expose ACP mode control.' }]);
      else void control.setMode(sessionId, modeCommand[1]!).then(() => append([{ kind: 'success', text: `ACP mode changed to ${modeCommand[1]}` }])).catch((error: unknown) => append([{ kind: 'error', text: error instanceof Error ? error.message : String(error) }]));
      return;
    }
    const configCommand = /^\/config\s+([^\s]+)\s+(.+)$/.exec(command);
    if (configCommand) {
      const control = sessionId ? options.acpControl?.(sessionId) : undefined;
      if (!sessionId) append([{ kind: 'error', text: 'No active AgentCorps session. Run a prompt first.' }]);
      else if (!control?.setConfigOption) append([{ kind: 'error', text: 'The selected Agent does not expose ACP config control.' }]);
      else void control.setConfigOption(sessionId, configCommand[1]!, configCommand[2]!).then(() => append([{ kind: 'success', text: `ACP config ${configCommand[1]} updated` }])).catch((error: unknown) => append([{ kind: 'error', text: error instanceof Error ? error.message : String(error) }]));
      return;
    }
    const loadCommand = /^\/session-load\s+([^\s]+)$/.exec(command);
    if (loadCommand) {
      const control = sessionId ? options.acpControl?.(sessionId) : undefined;
      if (!sessionId) append([{ kind: 'error', text: 'No active AgentCorps session. Run a prompt first.' }]);
      else if (!control?.loadSession) append([{ kind: 'error', text: 'The selected Agent does not expose ACP session loading.' }]);
      else void control.loadSession(sessionId, loadCommand[1]!).then(() => append([{ kind: 'success', text: `Loaded ACP session ${loadCommand[1]} into ${sessionId}` }])).catch((error: unknown) => append([{ kind: 'error', text: error instanceof Error ? error.message : String(error) }]));
      return;
    }
    if (command === '/session-close') {
      const control = sessionId ? options.acpControl?.(sessionId) : undefined;
      if (!sessionId) append([{ kind: 'error', text: 'No active AgentCorps session.' }]);
      else if (!control?.closeSession) append([{ kind: 'error', text: 'The selected Agent does not expose ACP session closing.' }]);
      else void control.closeSession(sessionId).then(() => append([{ kind: 'success', text: `Closed ACP session for ${sessionId}` }])).catch((error: unknown) => append([{ kind: 'error', text: error instanceof Error ? error.message : String(error) }]));
      return;
    }
    if (command === '/pause') {
      const task = activeTaskId ? options.local.getTask(activeTaskId) : selectedTask;
      if (task && activeStatuses.includes(task.status)) { options.local.pauseTask(task.id); append([{ kind: 'warning', text: `Paused ${task.id}. Use Ctrl+P or /resume ${task.id} to continue.` }]); }
      else if (task?.status === 'paused') append([{ kind: 'muted', text: `Task ${task.id} is already paused.` }]);
      else append([{ kind: 'muted', text: 'No active task to pause.' }]);
      return;
    }
    if (command === '/cancel') {
      const task = activeTaskId ? options.local.getTask(activeTaskId) : selectedTask;
      if (task && activeStatuses.includes(task.status)) { options.local.cancelTask(task.id); append([{ kind: 'warning', text: `Cancelled ${task.id}` }]); }
      else append([{ kind: 'muted', text: 'No active task to cancel.' }]);
      return;
    }
    if (activeTaskId) { append([{ kind: 'warning', text: 'A task is already running. Use c to cancel it first.' }]); return; }
    const session = sessionId ? options.sessions.get(sessionId) : options.sessions.create({ workspaceId: 'local-workspace', title: command.split('\n')[0]!.slice(0, 80), mode: 'code' });
    if (!session) { append([{ kind: 'error', text: `Session not found: ${sessionId}` }]); return; }
    append(command.split('\n').map((line, index) => ({ kind: 'text' as const, text: `${index === 0 ? '› ' : '  '}${line}` })));
    setSessionId(session.id);
    const task = options.local.createTask({ workspaceId: session.workspaceId, sessionId: session.id, title: session.title, objective: command, mode: session.mode });
    options.sessions.appendMessage({ sessionId: session.id, role: 'user', content: command, taskId: task.id });
    executeTask(task);
  }, [activeTask, activeTaskId, append, executeTask, onExit, options, pendingApprovals, selectedTask, sessionId, tasks]);

  const onKey = useCallback((input: string, key: Key): void => {
    if (searchMode) {
      if (key.escape || key.return) { setSearchMode(false); return; }
      if (key.backspace) { setSearch((current) => current.slice(0, -1)); return; }
      if (input && !key.ctrl) setSearch((current) => `${current}${input}`);
      return;
    }
    if (key.ctrl && (input === 'c' || input === 'd')) { onExit(); return; }
    if (key.escape || input === '\u001b') { setHelp(false); setSearch(''); setShowRaw(false); setCommandMenuDismissed(true); setCommandIndex(0); return; }
    if (suggestions.length && key.upArrow && draft.startsWith('/')) { setCommandIndex((current) => (current - 1 + suggestions.length) % suggestions.length); return; }
    if (suggestions.length && key.downArrow && draft.startsWith('/')) { setCommandIndex((current) => (current + 1) % suggestions.length); return; }
    if (key.pageUp) { setScroll((current) => current + Math.max(1, outputHeight - 2)); return; }
    if (key.pageDown) { setScroll((current) => Math.max(0, current - Math.max(1, outputHeight - 2))); return; }
    if (key.home) { setScroll(Math.max(0, output.length)); return; }
    if (key.end) { setScroll(0); return; }
    if (key.upArrow) { const state = { input: draft, cursor, history, historyIndex }; moveInputHistory(state, -1); setDraft(state.input); setCursor(state.cursor); setHistoryIndex(state.historyIndex); setCommandMenuDismissed(!state.input.startsWith('/')); return; }
    if (key.downArrow) { const state = { input: draft, cursor, history, historyIndex }; moveInputHistory(state, 1); setDraft(state.input); setCursor(state.cursor); setHistoryIndex(state.historyIndex); setCommandMenuDismissed(!state.input.startsWith('/')); return; }
    if (key.leftArrow) { setCursor((current) => Math.max(0, current - 1)); return; }
    if (key.rightArrow) { setCursor((current) => Math.min(draft.length, current + 1)); return; }
    if (key.backspace || key.delete) { const state = { input: draft, cursor, history, historyIndex }; deleteInputCharacter(state); setDraft(state.input); setCursor(state.cursor); setCommandMenuDismissed(!state.input.startsWith('/')); return; }
    if (key.return) {
      if (key.shift) { const state = { input: draft, cursor, history, historyIndex }; insertInputCharacter(state, '\n'); setDraft(state.input); setCursor(state.cursor); }
      else if (suggestions.length && selectedCommand && draft !== selectedCommand.completion && draft.trim() === draft && draft.trim().startsWith('/')) { setDraft(selectedCommand.completion); setCursor(selectedCommand.completion.length); setCommandIndex(0); setCommandMenuDismissed(false); }
      else submit(draft);
      return;
    }
    if (input === '?' && !draft) { setHelp((current) => !current); return; }
    if (input === '/' && !draft) { const state = { input: draft, cursor, history, historyIndex }; insertInputCharacter(state, '/'); setDraft(state.input); setCursor(state.cursor); setCommandMenuDismissed(false); return; }
    if (input === 'a' && !draft) { approve('approve'); return; }
    if (input === 'd' && !draft) { approve('deny'); return; }
    if (key.ctrl && input === 'p') {
      const task = activeTaskId ? options.local.getTask(activeTaskId) : selectedTask;
      if (task?.status === 'paused') { executeTask(task); return; }
      if (task && activeStatuses.includes(task.status)) { options.local.pauseTask(task.id); append([{ kind: 'warning', text: `Paused ${task.id}. Press Ctrl+P to resume.` }]); return; }
      append([{ kind: 'muted', text: 'Select an active or paused task first.' }]);
      return;
    }
    if (key.ctrl && input === 'x') { submit('/cancel'); return; }
    if (key.ctrl && input === 'r') { submit('/retry'); return; }
    if (key.ctrl && input === 'o') { approve('approve'); return; }
    if (key.ctrl && input === 'f') { setSearchMode(true); setSearch(''); return; }
    if (key.ctrl && input === 'g') { setFolded((current) => !current); return; }
    if (key.ctrl && input === 'v') { setShowRaw((current) => !current); return; }
    if (key.tab) { selectTask(selectedIndex + 1); return; }
    if (input && !key.ctrl) { const state = { input: draft, cursor, history, historyIndex }; insertInputCharacter(state, input); setDraft(state.input); setCursor(state.cursor); setCommandMenuDismissed(false); }
  }, [approve, cursor, draft, history, historyIndex, onExit, output.length, outputHeight, searchMode, selectedCommand, selectedIndex, selectTask, submit, suggestions]);

  useInput(onKey);

  const filteredOutput = search ? output.filter((item) => item.text.toLowerCase().includes(search.toLowerCase())) : output;
  const displayOutput = search ? filteredOutput.slice(-outputHeight) : visibleOutput;
  const currentSession = sessionId ? options.sessions.get(sessionId) : undefined;
  const model = options.model?.() ?? 'provider default';
  const taskInfo = activeTask ? `${statusIcon(activeTask.status)} ${statusLabel(activeTask.status)} · ${formatDuration(activeTask.createdAt, terminalStatuses.includes(activeTask.status) ? activeTask.updatedAt : clock)}` : 'Ready';
  const selectedSearchIndex = visibleTasks.findIndex((task) => task.id === selectedTask?.id);
  const inputWidth = Math.max(8, columns - 6);
  const inputRowsVisible = useMemo(() => inputViewport(draft, cursor, inputWidth, inputRows), [cursor, draft, inputRows, inputWidth]);

  return <Box flexDirection="column" width="100%" height={rows} overflow="hidden">
    <Box height={2} flexShrink={0} flexDirection="column" paddingX={1} overflow="hidden">
      <Box justifyContent="space-between">
        <Text bold color="cyan">◆ AgentCorps <Text dimColor>session</Text></Text>
        <Text color={activeTask ? statusColor(activeTask.status) : 'green'} wrap="truncate-end">{taskInfo}</Text>
      </Box>
      <Box justifyContent="space-between">
        <Text dimColor wrap="truncate-end">Agent: {options.agentId()} · {model} · {currentSession ? shorten(currentSession.title, 32) : 'new session'}</Text>
        <Text color={pendingApprovals.length || acp.pendingPermission ? 'yellow' : 'gray'} wrap="truncate-end">{pendingApprovals.length || acp.pendingPermission ? `! ${pendingApprovals.length + (acp.pendingPermission ? 1 : 0)} approval${pendingApprovals.length + (acp.pendingPermission ? 1 : 0) === 1 ? '' : 's'}` : 'no approvals'}</Text>
      </Box>
    </Box>

    {searchMode && <Box height={1} flexShrink={0} paddingX={1} overflow="hidden"><Text color="magenta" wrap="truncate-end">/ search {search}▌</Text></Box>}

    <Box height={mainHeight} flexShrink={0} flexDirection={isNarrow ? 'column' : 'row'} paddingX={1} overflow="hidden">
      {!isNarrow && <Box width={27} flexShrink={0} flexDirection="column" paddingRight={1} borderRight borderColor="gray" overflow="hidden">
        <Text bold color="cyan" wrap="truncate-end">TASKS {search ? `· ${search}` : `· ${tasks.length}`}</Text>
        <TaskList tasks={visibleTasks} selectedIndex={selectedSearchIndex < 0 ? selectedIndexSafe : selectedSearchIndex} width={25} />
        <Box marginTop={1} flexDirection="column" overflow="hidden">
          <Text bold color="cyan">APPROVALS</Text>
          <ApprovalPanel approvals={pendingApprovals} />
          {acp.pendingPermission && <Text color="yellow" wrap="truncate-end">ACP: {shorten(acp.pendingPermission.title, 24)}</Text>}
          {acp.plan.length > 0 && <Box marginTop={1} flexDirection="column"><Text bold color="cyan">PLAN</Text>{acp.plan.slice(0, 5).map((entry, index) => <Text key={`${entry.content}-${index}`} color={entry.status === 'completed' ? 'green' : entry.status === 'in_progress' ? 'yellow' : 'gray'} wrap="truncate-end">{entry.status === 'completed' ? '✓' : entry.status === 'in_progress' ? '›' : '·'} {shorten(entry.content, 24)}</Text>)}</Box>}
          <AcpPanel acp={acp} />
        </Box>
      </Box>}

      <Box flexGrow={1} flexDirection="column" paddingLeft={isNarrow ? 0 : 1} overflow="hidden">
        {isNarrow && <Box height={1} flexShrink={0} justifyContent="space-between" overflow="hidden">
          <Text bold color="cyan">TASKS · {allTasks.length}</Text>
          <Text color={pendingApprovals.length || acp.pendingPermission ? 'yellow' : 'gray'}>{pendingApprovals.length || acp.pendingPermission ? `! ${pendingApprovals.length + (acp.pendingPermission ? 1 : 0)} approvals` : 'ready'}</Text>
        </Box>}
        {help ? <HelpPanel /> : <>
          <Box height={1} flexShrink={0} justifyContent="space-between" overflow="hidden">
            <Text bold color="white">Conversation</Text>
            <Text dimColor wrap="truncate-end">{folded ? 'folded' : `${output.length} lines`}{showRaw ? ' · raw' : ''}</Text>
          </Box>
          <Box height={Math.max(1, mainHeight - (isNarrow ? 1 : 0) - 1)} flexShrink={0} flexDirection="column" overflow="hidden">
            {!displayOutput.length ? <Text dimColor>Describe a task to begin.</Text> : displayOutput.map((item, index) => <RenderedLine key={`${index}-${item.text}`} item={item} showRaw={showRaw} />)}
            {scroll > 0 && <Text dimColor>↑ scrolled · PageDown or End follows live output</Text>}
          </Box>
        </>}
      </Box>
    </Box>

    {suggestionRows > 0 && <Box height={suggestionRows} flexShrink={0}><CommandSuggestions suggestions={suggestions} selectedIndex={commandIndex} /></Box>}

    <Box height={composerHeight} flexShrink={0} flexDirection="column" paddingX={1} borderStyle="round" borderColor={draft ? 'cyan' : 'gray'} overflow="hidden">
      <Box height={inputRows} flexShrink={0} flexDirection="column" overflow="hidden">
        {inputRowsVisible.map((row, index) => <Text key={`${index}-${row.text}`} color={row.cursor ? 'green' : 'gray'} wrap="truncate-end">{index === 0 ? '› ' : '  '}{row.text}</Text>)}
      </Box>
      <Text dimColor wrap="truncate-end">Enter send · Shift+Enter multiline · Ctrl+P pause · Ctrl+X cancel · Ctrl+R retry · Ctrl+F search · Ctrl+C exit</Text>
    </Box>
  </Box>;
}

export async function runInkTui(options: TuiOptions): Promise<void> {
  await new Promise<void>((resolve) => {
    let instance: ReturnType<typeof render> | undefined;
    const finish = (): void => {
      instance?.unmount();
      resolve();
    };
    instance = render(<InkTui options={options} onExit={finish} />, { exitOnCtrlC: false });
  });
}
