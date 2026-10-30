import React from 'react';
import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import type { Task, TaskEvent, TaskId } from '@agentcorps/domain';
import type { TuiOptions } from './tui.js';
import { InkTui, inputViewport } from './tui-ink.js';

function makeTask(status: Task['status'] = 'queued'): Task {
  return {
    id: 'task-ink-1' as TaskId,
    workspaceId: 'workspace',
    sessionId: 'session-1',
    title: 'Ink task',
    objective: 'Inspect the terminal interface',
    mode: 'code',
    status,
    createdAt: '2026-10-28T00:00:00.000Z',
    updatedAt: '2026-10-28T00:00:00.000Z',
  };
}

function makeOptions() {
  let task = makeTask();
  let listener: ((event: TaskEvent) => void) | undefined;
  const session = { id: 'session-1', workspaceId: 'workspace', title: 'Ink session', mode: 'code' as const, createdAt: task.createdAt, updatedAt: task.updatedAt };
  const options: TuiOptions = {
    local: {
      listTasks: () => [task],
      getTask: () => task,
      createTask: () => task,
      cancelTask: () => { task = { ...task, status: 'cancelled' }; return task; },
      retryTask: () => { task = { ...task, status: 'queued' }; return task; },
      store: { subscribe: (next: (event: TaskEvent) => void) => { listener = next; return () => { listener = undefined; }; } },
    } as unknown as TuiOptions['local'],
    sessions: {
      get: () => session,
      create: () => session,
      messages: () => [],
      appendMessage: () => undefined,
    } as unknown as TuiOptions['sessions'],
    approvals: { list: () => [], get: () => undefined } as unknown as TuiOptions['approvals'],
    dataDir: '/tmp/agentcorps',
    agentId: () => 'mock',
    model: () => 'fixture-model',
    runTask: async (nextTask) => { task = { ...nextTask, status: 'succeeded' }; return task; },
  };
  return { options, emit: (event: TaskEvent) => listener?.(event) };
}

describe('Ink TUI', () => {
  it('keeps long and multiline drafts inside a fixed-height viewport', () => {
    const longDraft = inputViewport('one two three four five six seven eight nine', 44, 12, 3);
    expect(longDraft.length).toBeLessThanOrEqual(3);
    expect(longDraft.some((row) => row.cursor)).toBe(true);
    expect(longDraft.every((row) => row.text.length <= 12)).toBe(true);

    const multiline = inputViewport('first line\\nsecond line\\nthird line', 23, 20, 3);
    expect(multiline.map((row) => row.text.replace('▌', ''))).toContain('second line');
    expect(multiline.some((row) => row.cursor)).toBe(true);
  });

  it('renders visual hierarchy, task metadata, and discoverable controls', () => {
    const { options } = makeOptions();
    const instance = render(<InkTui options={options} onExit={() => instance.unmount()} />);
    const frame = instance.lastFrame() ?? '';
    expect(frame).toContain('AgentCorps');
    expect(frame).toContain('Ink task');
    expect(frame).toContain('Agent: mock');
    expect(frame).toContain('Shift+Enter multiline');
    instance.unmount();
  });

  it('shows slash command suggestions and lets Escape dismiss them', async () => {
    const { options } = makeOptions();
    const instance = render(<InkTui options={options} onExit={() => instance.unmount()} />);
    instance.stdin.write('/');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(instance.lastFrame()).toContain('/help');
    instance.stdin.write('\u001b');
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(instance.lastFrame()).not.toContain('显示快捷键和命令帮助');
    instance.unmount();
  });

  it('shows public tool and reasoning updates in the transcript', async () => {
    const { options, emit } = makeOptions();
    const instance = render(<InkTui options={options} onExit={() => instance.unmount()} />);
    emit({ type: 'run.protocol', id: 'event-protocol' as TaskEvent['id'], version: 1, aggregateType: 'run', aggregateId: 'task-ink-1', correlationId: 'task-ink-1', occurredAt: new Date().toISOString(), payload: { runId: 'run-1' as never, protocol: 'stdio-jsonl', direction: 'update', method: 'agent.item.started', metadata: { itemType: 'command_execution', toolName: 'Read', status: 'started' } } });
    emit({ type: 'run.protocol', id: 'event-reasoning' as TaskEvent['id'], version: 1, aggregateType: 'run', aggregateId: 'task-ink-1', correlationId: 'task-ink-1', occurredAt: new Date().toISOString(), payload: { runId: 'run-1' as never, protocol: 'stdio-jsonl', direction: 'update', method: 'agent.reasoning', metadata: { reasoning: true } } });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(instance.lastFrame()).toContain('Read');
    expect(instance.lastFrame()).toContain('Reasoning update');
    instance.unmount();
  });

  it('shows structured provider output as readable content and supports raw toggle', async () => {
    const { options, emit } = makeOptions();
    const instance = render(<InkTui options={options} onExit={() => instance.unmount()} />);
    emit({ type: 'run.output', id: 'event-1' as TaskEvent['id'], version: 1, aggregateType: 'task', aggregateId: 'task-ink-1', correlationId: 'task-ink-1', occurredAt: new Date().toISOString(), payload: { runId: 'run-1' as never, stream: 'assistant', text: JSON.stringify({ type: 'assistant', content: '## Completed\n\n- readable' }) } });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(instance.lastFrame()).toContain('Completed');
    expect(instance.lastFrame()).toContain('• readable');
    instance.unmount();
  });
});
