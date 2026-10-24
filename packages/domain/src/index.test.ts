import { describe, expect, it } from 'vitest';
import { assertTransition, canTransition, createTask, type TaskId } from './index.js';

describe('task lifecycle', () => {
  it('allows the expected execution path', () => {
    expect(canTransition('queued', 'running')).toBe(true);
    expect(canTransition('running', 'succeeded')).toBe(true);
    expect(canTransition('succeeded', 'running')).toBe(false);
  });

  it('rejects invalid transitions', () => {
    expect(() => assertTransition('succeeded', 'running')).toThrow('Invalid task transition');
  });

  it('creates a normalized task', () => {
    const task = createTask(
      { workspaceId: 'ws-1', sessionId: 'session-1', title: '  Ship it ', objective: '  run tests  ', mode: 'code' },
      'task-1' as TaskId,
      '2026-10-24T00:00:00.000Z',
    );
    expect(task.title).toBe('Ship it');
    expect(task.status).toBe('queued');
  });
});
