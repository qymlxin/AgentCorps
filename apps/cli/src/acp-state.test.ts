import { describe, expect, it } from 'vitest';
import type { TaskEvent } from '@agentcorps/domain';
import { emptyAcpProjection, reduceAcpProjection } from './acp-state.js';

function event(data: unknown, method = 'session/update', direction: 'request' | 'response' | 'update' = 'update'): Extract<TaskEvent, { type: 'run.protocol' }> {
  return { type: 'run.protocol', id: 'event' as never, version: 1, aggregateType: 'run', aggregateId: 'task' as never, correlationId: 'task', occurredAt: new Date().toISOString(), payload: { runId: 'run' as never, protocol: 'acp', direction, method, data } };
}

describe('ACP TUI projection', () => {
  it('projects plans, tool calls, modes, and usage from structured updates', () => {
    let state = emptyAcpProjection();
    state = reduceAcpProjection(state, event({ sessionId: 'acp-session', update: { sessionUpdate: 'plan', entries: [{ content: 'Inspect files', priority: 'high', status: 'in_progress' }] } }));
    state = reduceAcpProjection(state, event({ sessionId: 'acp-session', update: { sessionUpdate: 'tool_call', toolCall: { toolCallId: 'tool-1', title: 'Read files', status: 'in_progress' } } }));
    state = reduceAcpProjection(state, event({ sessionId: 'acp-session', update: { sessionUpdate: 'current_mode_update', currentModeId: 'work' } }));
    state = reduceAcpProjection(state, event({ sessionId: 'acp-session', update: { sessionUpdate: 'usage_update', used: 12, size: 100 } }));
    expect(state).toMatchObject({ sessionId: 'acp-session', currentModeId: 'work', plan: [{ content: 'Inspect files' }], tools: { 'tool-1': { title: 'Read files', status: 'in_progress' } }, usage: { used: 12, size: 100 } });
  });

  it('tracks permission requests and terminal lifecycle responses', () => {
    let state = emptyAcpProjection();
    state = reduceAcpProjection(state, event({ sessionId: 's', toolCall: { toolCallId: 'tool-2', title: 'Run tests' }, options: [] }, 'session/request_permission', 'request'));
    expect(state.pendingPermission?.title).toBe('Run tests');
    state = reduceAcpProjection(state, event({ sessionId: 's', terminalId: 'term-1', output: 'ok' }, 'terminal/output', 'response'));
    state = reduceAcpProjection(state, event({ sessionId: 's', terminalId: 'term-1', exitCode: 0 }, 'terminal/wait_for_exit', 'response'));
    expect(state.terminals['term-1']).toMatchObject({ output: 'ok', exitCode: 0, running: false });
  });
});
