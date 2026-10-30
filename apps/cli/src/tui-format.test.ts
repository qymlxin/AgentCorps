import { describe, expect, it } from 'vitest';
import { formatAgentOutput, formatApproval, formatMarkdown, formatRawJson, summarizeStructuredRecord } from './tui-format.js';

const approval = {
  id: 'approval-123',
  request: { requestId: 'request-1', taskId: 'task-1', capability: 'process.exec' as const, command: 'git status' },
  reason: 'Command execution requires approval',
  status: 'pending' as const,
  createdAt: '2026-10-28T00:00:00.000Z',
  expiresAt: '2026-10-28T01:00:00.000Z',
};

describe('TUI structured formatting', () => {
  it('summarizes provider JSON events instead of displaying raw JSON', () => {
    const lines = formatAgentOutput('{"type":"turn.completed","usage":{"input_tokens":12,"output_tokens":4}}');
    expect(lines.map((item) => item.text)).toEqual(['Turn completed · in 12 · out 4']);
    expect(lines[0]?.text).not.toContain('input_tokens');
  });

  it('extracts assistant content from nested provider frames', () => {
    const lines = formatAgentOutput(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: '## Done\n\n- one' }] } }));
    expect(lines.map((item) => item.kind)).toEqual(['heading', 'text', 'bullet']);
    expect(lines.map((item) => item.text)).toEqual(['Done', '', 'one']);
  });

  it('renders Markdown, code blocks, and diff lines with semantic kinds', () => {
    const lines = formatMarkdown('# Title\n```ts\nconst answer = 42;\n```\n+added\n-removed');
    expect(lines.map((item) => item.kind)).toEqual(['heading', 'muted', 'code', 'diff-add', 'diff-remove']);
  });

  it('renders approvals as actionable human-readable details', () => {
    const lines = formatApproval(approval);
    expect(lines.map((item) => item.text)).toEqual([
      'Approval required · process.exec',
      'Target: git status',
      'Parameters: command=git status',
      'Reason: Command execution requires approval',
      'ID: approval-123 · expires 2026-10-28T01:00:00.000Z',
    ]);
  });

  it('keeps an explicit raw JSON fallback for unknown events', () => {
    const lines = summarizeStructuredRecord({ type: 'future.event', value: 1 });
    expect(lines?.[0]?.text).toContain('future.event');
    expect(lines?.[0]?.raw).toContain('"value": 1');
    expect(formatRawJson({ value: 1 }).map((item) => item.text)).toEqual(['{', '  "value": 1', '}']);
  });
});
