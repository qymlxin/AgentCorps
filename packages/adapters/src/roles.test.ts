import { describe, expect, it, vi } from 'vitest';
import type { AgentAdapter, AgentRequest } from '@agentcorps/runtime';
import { composeRolePrompt, getRolePreset, ROLE_PRESETS, withRole } from './roles.js';

function request(): AgentRequest {
  return { task: { id: 'task-role' as never, workspaceId: 'ws', sessionId: 'session', title: 'Role task', objective: 'Check the patch', mode: 'code', status: 'running', createdAt: '', updatedAt: '' }, runId: 'run-role' as never, signal: new AbortController().signal, emit: vi.fn() };
}

describe('portable role prompts', () => {
  it('provides unique nonempty role presets and rejects unknown names', () => {
    expect(new Set(ROLE_PRESETS.map((role) => role.id)).size).toBe(ROLE_PRESETS.length);
    for (const role of ROLE_PRESETS) expect(role.prompt.length).toBeGreaterThan(50);
    expect(() => getRolePreset('missing')).toThrow('Unknown role');
  });

  it('keeps an unconfigured prompt byte-for-byte unchanged', () => {
    expect(composeRolePrompt('original\n objective', {})).toBe('original\n objective');
  });

  it('orders role, extra instructions, and task without evaluating template syntax', () => {
    const prompt = composeRolePrompt('inspect ${process.env.SECRET}', { role: getRolePreset('reviewer'), instructions: 'Reply in Chinese' });
    expect(prompt.indexOf('You are a code reviewer')).toBeLessThan(prompt.indexOf('Reply in Chinese'));
    expect(prompt.indexOf('Reply in Chinese')).toBeLessThan(prompt.indexOf('inspect ${process.env.SECRET}'));
  });

  it.each(['mock', 'stdio-jsonl', 'acp', 'a2a'] as const)('wraps %s without mutating the task or granting permissions', async (transport) => {
    const execute = vi.fn(async () => undefined);
    const adapter: AgentAdapter = { descriptor: { id: 'fixture', displayName: 'Fixture', version: '1', transport, capabilities: [] }, execute };
    const original = request();
    const wrapped = withRole(adapter, { role: getRolePreset('tester'), instructions: 'No network' });
    await wrapped.execute(original);
    expect(wrapped.descriptor).toBe(adapter.descriptor);
    expect(original.task.objective).toBe('Check the patch');
    const received = execute.mock.calls[0] as unknown as [AgentRequest];
    expect(received[0].task.objective).toContain('You are a test engineer');
    expect(received[0].task.objective).toContain('No network');
    expect(received[0].signal).toBe(original.signal);
  });
});
