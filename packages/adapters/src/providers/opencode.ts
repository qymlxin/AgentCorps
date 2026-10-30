import type { AgentToolRegistry } from '../registry.js';
import { failureMessage, record, type AgentOutputDecoder } from '../output.js';

export const createOpenCodeDecoder = (): AgentOutputDecoder => (value) => {
  const event = record(value);
  if (!event) return {};
  if (event.type === 'error') {
    const error = record(event.error);
    return { error: failureMessage(record(error?.data)?.message ?? error?.message ?? error?.name ?? event.error) };
  }
  if (event.type !== 'text') return {};
  const part = record(event.part);
  return part?.type === 'text' && typeof part.text === 'string' ? { text: part.text } : {};
};

export function registerOpenCode(registry: AgentToolRegistry): void {
  registry.registerDecoder('opencode-events', createOpenCodeDecoder).register({
    id: 'opencode', displayName: 'OpenCode', command: 'opencode', args: ['run', '--format', 'json'],
    promptFlag: '--', modelFlag: '--model', outputFormat: 'jsonl', outputProtocol: 'opencode-events', defaultRole: 'developer',
    documentationUrl: 'https://opencode.ai/docs/cli/',
  });
}
