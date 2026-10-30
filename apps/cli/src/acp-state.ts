import type { TaskEvent } from '@agentcorps/domain';
import type { AcpPlanEntry, AcpToolCall, AcpToolCallUpdate } from '@agentcorps/protocols';

export interface AcpToolState {
  readonly id: string;
  readonly title: string;
  readonly kind: string | undefined;
  readonly status: string | undefined;
  readonly content: readonly unknown[] | undefined;
  readonly rawOutput: unknown;
}

export interface AcpTerminalState {
  readonly id: string;
  readonly output: string | undefined;
  readonly exitCode: number | undefined;
  readonly signal: string | undefined;
  readonly running: boolean;
}

export interface AcpProjection {
  readonly sessionId: string | undefined;
  readonly currentModeId: string | undefined;
  readonly tools: Readonly<Record<string, AcpToolState>>;
  readonly plan: readonly AcpPlanEntry[];
  readonly terminals: Readonly<Record<string, AcpTerminalState>>;
  readonly usage: { readonly used: number | undefined; readonly size: number | undefined } | undefined;
  readonly configOptions: readonly Record<string, unknown>[];
  readonly pendingPermission: { readonly title: string; readonly requestId: string | undefined } | undefined;
  readonly notices: readonly string[];
  readonly activity: readonly string[];
}

export const emptyAcpProjection = (): AcpProjection => ({ sessionId: undefined, currentModeId: undefined, tools: {}, plan: [], terminals: {}, usage: undefined, configOptions: [], pendingPermission: undefined, notices: [], activity: [] });

export function reduceAcpProjection(state: AcpProjection, event: Extract<TaskEvent, { type: 'run.protocol' }>): AcpProjection {
  if (event.payload.protocol !== 'acp') return state;
  const data = event.payload.data;
  const update = record(data)?.update;
  const value = record(update) ?? record(data);
  const name = event.payload.method;
  const activity = [`${event.payload.direction}:${name}`, ...state.activity].slice(0, 20);
  let next: AcpProjection = { ...state, activity };
  const sessionId = stringValue(record(data)?.sessionId);
  if (sessionId) next = { ...next, sessionId };

  if (name === 'session/update' && value) {
    const updateName = stringValue(value.sessionUpdate);
    if (updateName === 'tool_call' && record(value.toolCall)) next = applyTool(next, record(value.toolCall) as AcpToolCall);
    else if (updateName === 'tool_call_update') next = applyToolUpdate(next, value as AcpToolCallUpdate);
    else if (updateName === 'plan') next = { ...next, plan: (array(value.entries) ?? array(value.plan) ?? []).filter(isPlanEntry) };
    else if (updateName === 'current_mode_update' && stringValue(value.currentModeId)) next = { ...next, currentModeId: stringValue(value.currentModeId) };
    else if (updateName === 'config_option_update') next = { ...next, configOptions: (array(value.configOptions) ?? []).filter((item): item is Record<string, unknown> => Boolean(record(item))) };
    else if (updateName === 'usage_update') next = { ...next, usage: { used: numberValue(value.used), size: numberValue(value.size) } };
    else if (updateName === 'session_info_update' && stringValue(value.title)) next = { ...next, notices: [`Session: ${stringValue(value.title)}`, ...state.notices].slice(0, 8) };
    return next;
  }

  if (name === 'session/request_permission' && event.payload.direction === 'request') {
    const toolCall = record(value?.toolCall);
    return { ...next, pendingPermission: { title: stringValue(toolCall?.title) ?? 'Agent requested permission', requestId: stringValue(value?.toolCallId) } };
  }
  if (name === 'session/request_permission' && event.payload.direction === 'response') return { ...next, pendingPermission: undefined };
  if (name === 'terminal/create' && event.payload.direction === 'response') {
    const terminalId = stringValue(value?.terminalId);
    if (terminalId) return { ...next, terminals: { ...next.terminals, [terminalId]: { id: terminalId, output: undefined, exitCode: undefined, signal: undefined, running: true } } };
  }
  if (name === 'terminal/output' && event.payload.direction === 'response') {
    const terminalId = stringValue(record(data)?.terminalId);
    const output = stringValue(value?.output);
    if (terminalId) return { ...next, terminals: { ...next.terminals, [terminalId]: { ...(next.terminals[terminalId] ?? { id: terminalId, output: undefined, exitCode: undefined, signal: undefined, running: true }), id: terminalId, output: output ?? next.terminals[terminalId]?.output, exitCode: next.terminals[terminalId]?.exitCode, signal: next.terminals[terminalId]?.signal, running: true } } };
  }
  if (name === 'terminal/wait_for_exit' && event.payload.direction === 'response') {
    const terminalId = stringValue(record(data)?.terminalId);
    const exitCode = numberValue(value?.exitCode);
    if (terminalId) return { ...next, terminals: { ...next.terminals, [terminalId]: { ...(next.terminals[terminalId] ?? { id: terminalId, output: undefined, exitCode: undefined, signal: undefined, running: false }), id: terminalId, output: next.terminals[terminalId]?.output, exitCode: exitCode ?? next.terminals[terminalId]?.exitCode, signal: next.terminals[terminalId]?.signal, running: false } } };
  }
  if (name === 'session/set_mode' && event.payload.direction === 'response' && stringValue(record(data)?.modeId)) return { ...next, currentModeId: stringValue(record(data)?.modeId) };
  if (name === 'session/update' && event.payload.direction === 'update') return next;
  return next;
}

function applyTool(state: AcpProjection, tool: AcpToolCall): AcpProjection {
  const id = stringValue(tool.toolCallId);
  if (!id) return state;
  return { ...state, tools: { ...state.tools, [id]: { id, title: stringValue(tool.title) ?? id, kind: stringValue(tool.kind), status: stringValue(tool.status), content: tool.content, rawOutput: tool.rawOutput } } };
}

function applyToolUpdate(state: AcpProjection, update: AcpToolCallUpdate): AcpProjection {
  const existing = state.tools[update.toolCallId] ?? { id: update.toolCallId, title: update.toolCallId, kind: undefined, status: undefined, content: undefined, rawOutput: undefined };
  return { ...state, tools: { ...state.tools, [update.toolCallId]: { ...existing, title: update.title ?? existing.title, kind: update.kind ?? existing.kind, status: update.status ?? existing.status, content: update.content ?? existing.content, rawOutput: update.rawOutput === undefined ? existing.rawOutput : update.rawOutput } } };}

function record(value: unknown): Record<string, any> | undefined { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : undefined; }
function array(value: unknown): unknown[] | undefined { return Array.isArray(value) ? value : undefined; }
function stringValue(value: unknown): string | undefined { return typeof value === 'string' && value.trim() ? value.trim() : undefined; }
function numberValue(value: unknown): number | undefined { return typeof value === 'number' && Number.isFinite(value) ? value : undefined; }
function isPlanEntry(value: unknown): value is AcpPlanEntry { const item = record(value); return Boolean(item && typeof item.content === 'string' && typeof item.status === 'string' && typeof item.priority === 'string'); }
