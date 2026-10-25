import type { AgentToolRegistry } from '../registry.js';
import { failureMessage, messageText, record, type AgentOutputDecoder } from '../output.js';

export const createKimiDecoder = (): AgentOutputDecoder => (value) => {
  const event = record(value);
  if (!event) return {};
  if (event.type === 'error' || event.is_error === true) return { error: failureMessage(event.error ?? event.message) };
  if (event.role !== 'assistant') return {};
  const text = messageText(event.content);
  return text ? { text } : {};
};

export function registerKimi(registry: AgentToolRegistry): void {
  registry.registerDecoder('kimi-messages', createKimiDecoder).register({
    id: 'kimi', displayName: 'Kimi Code CLI', command: 'kimi', args: ['--output-format', 'stream-json'],
    promptFlag: '--prompt', modelFlag: '--model', outputFormat: 'jsonl', outputProtocol: 'kimi-messages', defaultRole: 'developer',
    documentationUrl: 'https://www.kimi.com/code/docs/en/kimi-code-cli/reference/kimi-command.html',
  });
}
