import type { Task, TaskEvent, TaskStatus } from '@agentcorps/domain';
import type { Approval } from '@agentcorps/security';

export type TuiLineKind =
  | 'text'
  | 'muted'
  | 'heading'
  | 'bullet'
  | 'code'
  | 'diff-add'
  | 'diff-remove'
  | 'error'
  | 'success'
  | 'event'
  | 'warning';

export interface TuiRenderLine {
  readonly kind: TuiLineKind;
  readonly text: string;
  /** Original structured event, available through the raw-event toggle. */
  readonly raw?: string;
}

export interface TuiTaskSummary {
  readonly status: TaskStatus;
  readonly statusLabel: string;
  readonly icon: string;
  readonly elapsed: string;
  readonly agent: string;
  readonly taskId: string;
  readonly title: string;
  readonly objective: string;
}

const terminalStatuses = new Set<TaskStatus>(['succeeded', 'failed', 'cancelled']);

export function sanitizeTerminalText(value: string): string {
  return value
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, '')
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
}

export function statusIcon(status: TaskStatus): string {
  if (status === 'succeeded') return '✓';
  if (status === 'failed') return '×';
  if (status === 'cancelled') return '–';
  if (status === 'waiting_approval') return '!';
  if (status === 'paused') return 'Ⅱ';
  if (status === 'running') return '»';
  return '·';
}

export function statusLabel(status: TaskStatus): string {
  if (status === 'waiting_approval') return 'Waiting for approval';
  if (status === 'paused') return 'Paused';
  return status[0]!.toUpperCase() + status.slice(1);
}

export function formatDuration(startedAt: string, endedAt = new Date().toISOString()): string {
  const elapsedMs = Math.max(0, Date.parse(endedAt) - Date.parse(startedAt));
  const seconds = Math.floor(elapsedMs / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function summarizeTask(task: Task, agent: string, now = new Date().toISOString()): TuiTaskSummary {
  return {
    status: task.status,
    statusLabel: statusLabel(task.status),
    icon: statusIcon(task.status),
    elapsed: formatDuration(task.createdAt, terminalStatuses.has(task.status) ? task.updatedAt : now),
    agent,
    taskId: task.id,
    title: task.title,
    objective: task.objective,
  };
}

function line(kind: TuiLineKind, text: string, raw?: string): TuiRenderLine {
  return raw === undefined ? { kind, text } : { kind, text, raw };
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function contentText(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    const parts = value.map((item) => contentText(item)).filter((item): item is string => Boolean(item));
    return parts.length ? parts.join('\n') : undefined;
  }
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  return stringValue(record.text)
    ?? stringValue(record.response)
    ?? contentText(record.content)
    ?? contentText(record.message)
    ?? contentText(record.output)
    ?? contentText(record.part);
}

function usageSummary(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const usage = value as Record<string, unknown>;
  const input = usage.input_tokens ?? usage.prompt_tokens;
  const output = usage.output_tokens ?? usage.completion_tokens;
  const cached = usage.cached_input_tokens;
  const parts = [
    typeof input === 'number' ? `in ${input}` : undefined,
    typeof output === 'number' ? `out ${output}` : undefined,
    typeof cached === 'number' ? `cached ${cached}` : undefined,
  ].filter((part): part is string => Boolean(part));
  return parts.length ? parts.join(' · ') : undefined;
}

function formatAcpEvent(event: Extract<TaskEvent, { type: 'run.protocol' }>): TuiRenderLine | undefined {
  const payload = event.payload.data;
  const root = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload as Record<string, unknown> : undefined;
  const update = root?.update && typeof root.update === 'object' && !Array.isArray(root.update) ? root.update as Record<string, unknown> : root;
  const updateName = stringValue(update?.sessionUpdate);
  const phase = event.payload.direction === 'request' ? '→' : event.payload.direction === 'response' ? '←' : '↳';
  const raw = JSON.stringify(event, null, 2);
  if (updateName === 'agent_message_chunk') return undefined;
  if (updateName === 'agent_thought_chunk') return line('muted', `${phase} … Agent thought`, raw);
  if (updateName === 'tool_call' || updateName === 'tool_call_update') {
    const tool = (update?.toolCall && typeof update.toolCall === 'object' ? update.toolCall : update) as Record<string, unknown>;
    const title = stringValue(tool.title) ?? stringValue(tool.toolCallId) ?? 'tool call';
    const status = stringValue(tool.status);
    return line('event', `${phase} ⚙ ${title}${status ? ` · ${status}` : ''}`, raw);
  }
  if (updateName === 'plan') {
    const entries = Array.isArray(update?.entries) ? update.entries : Array.isArray(update?.plan) ? update.plan : [];
    return line('heading', `${phase} PLAN · ${entries.length} step${entries.length === 1 ? '' : 's'}`, raw);
  }
  if (updateName === 'current_mode_update') return line('event', `${phase} Mode · ${stringValue(update?.currentModeId) ?? 'unknown'}`, raw);
  if (updateName === 'usage_update') return line('muted', `${phase} Usage · ${typeof update?.used === 'number' ? update.used : '?'}${typeof update?.size === 'number' ? ` / ${update.size}` : ''}`, raw);
  if (updateName === 'config_option_update') return line('event', `${phase} Configuration options updated`, raw);
  if (event.payload.method === 'session/request_permission') return line(event.payload.direction === 'request' ? 'warning' : 'success', `${phase} Permission ${event.payload.direction === 'request' ? 'requested' : 'resolved'}`, raw);
  if (event.payload.method.startsWith('terminal/')) return line(event.payload.direction === 'request' ? 'warning' : 'event', `${phase} Terminal · ${event.payload.method.slice('terminal/'.length)}`, raw);
  if (event.payload.method.startsWith('fs/')) return line('event', `${phase} File · ${event.payload.method.slice('fs/'.length)}`, raw);
  return undefined;
}

export function formatProtocolEvent(event: Extract<TaskEvent, { type: 'run.protocol' }>): TuiRenderLine {
  if (event.payload.protocol === 'acp') {
    const acp = formatAcpEvent(event);
    if (acp) return acp;
  }
  const metadata = event.payload.metadata ?? {};
  const providerEvent = sanitizeTerminalText(stringValue(metadata.providerEvent) ?? event.payload.method);
  const toolName = stringValue(metadata.toolName) ? sanitizeTerminalText(stringValue(metadata.toolName)!) : undefined;
  const command = stringValue(metadata.command) ? sanitizeTerminalText(stringValue(metadata.command)!) : undefined;
  const itemType = stringValue(metadata.itemType) ? sanitizeTerminalText(stringValue(metadata.itemType)!) : undefined;
  const status = stringValue(metadata.status) ? sanitizeTerminalText(stringValue(metadata.status)!) : undefined;
  const isReasoning = metadata.reasoning === true;
  const phase = event.payload.direction === 'request' ? '→' : event.payload.direction === 'response' ? '←' : '↳';
  const label = toolName
    ? `⚙ ${toolName}${status ? ` · ${status}` : ''}${command ? ` · ${command}` : ''}`
    : isReasoning
      ? `… Reasoning update${status ? ` · ${status}` : ''}`
      : itemType
        ? `▸ ${itemType}${status ? ` · ${status}` : ''}${command ? ` · ${command}` : ''}`
        : `◇ ${providerEvent}`;
  return line(isReasoning ? 'muted' : toolName || itemType ? 'event' : 'muted', `${phase} ${label}`, JSON.stringify(event, null, 2));
}
export function summarizeStructuredRecord(record: Record<string, unknown>): TuiRenderLine[] | undefined {
  const type = stringValue(record.type) ?? stringValue(record.event) ?? stringValue(record.kind);
  const usage = usageSummary(record.usage);
  if (type === 'thread.started') return [line('event', `Thread started${stringValue(record.thread_id) ? ` · ${record.thread_id}` : ''}`, JSON.stringify(record, null, 2))];
  if (type === 'turn.started') return [line('event', 'Turn started', JSON.stringify(record, null, 2))];
  if (type === 'turn.completed') return [line('success', `Turn completed${usage ? ` · ${usage}` : ''}`, JSON.stringify(record, null, 2))];
  if (type === 'result' || type === 'response.completed') {
    const text = contentText(record.response) ?? contentText(record.output) ?? contentText(record.content);
    return text ? formatMarkdown(text).map((item) => ({ ...item, raw: JSON.stringify(record, null, 2) })) : [line('success', `Completed${usage ? ` · ${usage}` : ''}`, JSON.stringify(record, null, 2))];
  }
  if (type === 'assistant' || type === 'message' || type === 'text') {
    const text = contentText(record.content) ?? contentText(record.message) ?? contentText(record.text) ?? contentText(record.part);
    return text ? formatMarkdown(text).map((item) => ({ ...item, raw: JSON.stringify(record, null, 2) })) : [line('event', type, JSON.stringify(record, null, 2))];
  }
  if (type) {
    const details = Object.entries(record)
      .filter(([key]) => key !== 'type' && key !== 'event' && key !== 'kind' && key !== 'usage')
      .map(([key, value]) => `${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`)
      .join(' · ');
    return [line('event', `${type}${details ? ` · ${details}` : ''}`, JSON.stringify(record, null, 2))];
  }
  return undefined;
}

export function formatMarkdown(value: string): TuiRenderLine[] {
  const clean = sanitizeTerminalText(value);
  const output: TuiRenderLine[] = [];
  let inCode = false;
  for (const sourceLine of clean.split(/\r?\n/)) {
    const trimmed = sourceLine.trim();
    if (trimmed.startsWith('```')) {
      inCode = !inCode;
      if (inCode && trimmed.slice(3).trim()) output.push(line('muted', `code · ${trimmed.slice(3).trim()}`));
      continue;
    }
    if (inCode) output.push(line('code', sourceLine));
    else if (/^#{1,6}\s+/.test(trimmed)) output.push(line('heading', trimmed.replace(/^#{1,6}\s+/, '')));
    else if (/^[-*+]\s+/.test(trimmed)) output.push(line('bullet', trimmed.replace(/^[-*+]\s+/, '')));
    else if (trimmed.startsWith('>')) output.push(line('muted', trimmed.replace(/^>\s?/, '')));
    else if (/^\+/.test(sourceLine) && !sourceLine.startsWith('+++')) output.push(line('diff-add', sourceLine));
    else if (/^-/.test(sourceLine) && !sourceLine.startsWith('---')) output.push(line('diff-remove', sourceLine));
    else if (/^(error|failed|exception):/i.test(trimmed)) output.push(line('error', sourceLine));
    else output.push(line('text', sourceLine));
  }
  return output.length ? output : [line('text', '')];
}

export function formatAgentOutput(value: string, stream: 'stdout' | 'stderr' | 'assistant' = 'stdout'): TuiRenderLine[] {
  const output: TuiRenderLine[] = [];
  for (const rawLine of sanitizeTerminalText(value).split(/\r?\n/)) {
    if (!rawLine && output.length) continue;
    let parsed: unknown;
    try { parsed = JSON.parse(rawLine); } catch { parsed = undefined; }
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const structured = summarizeStructuredRecord(parsed as Record<string, unknown>);
      if (structured) { output.push(...structured); continue; }
    }
    if (stream === 'stderr') output.push(line('error', rawLine));
    else output.push(...formatMarkdown(rawLine));
  }
  return output.length ? output : [line(stream === 'stderr' ? 'error' : 'text', '')];
}

export function formatApproval(approval: Approval): TuiRenderLine[] {
  const request = approval.request;
  const target = request.path ?? request.command ?? request.host ?? 'unspecified target';
  const parameters = [
    request.path ? `path=${request.path}` : undefined,
    request.command ? `command=${request.command}` : undefined,
    request.host ? `host=${request.host}` : undefined,
  ].filter((item): item is string => Boolean(item));
  return [
    line('warning', `Approval required · ${request.capability}`),
    line('text', `Target: ${target}`),
    ...(parameters.length ? [line('muted', `Parameters: ${parameters.join(' · ')}`)] : []),
    line('text', `Reason: ${approval.reason}`),
    line('muted', `ID: ${approval.id} · expires ${approval.expiresAt}`),
  ];
}

export function formatRawJson(value: unknown): TuiRenderLine[] {
  return JSON.stringify(value, null, 2).split('\n').map((text) => line('code', text));
}
