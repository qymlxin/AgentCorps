import type { AgentToolRegistry } from '../registry.js';
import { failureMessage, messageText, record, type AgentOutputDecoder } from '../output.js';

export function createQwenDecoder(): AgentOutputDecoder {
  let lastMessage: string | undefined;
  return (value) => {
    const event = record(value);
    if (!event) return {};
    if (event.type === 'error' || event.is_error === true) {
      return { error: failureMessage(event.error ?? (Array.isArray(event.errors) ? event.errors.map(failureMessage).join('; ') : undefined) ?? event.result ?? event.message) };
    }
    if (event.type === 'assistant') {
      const message = record(event.message);
      const text = messageText(message?.content);
      if (text) { lastMessage = text; return { text }; }
    }
    // Default mode emits complete assistant messages. Ignore optional partial events.
    if (event.type === 'result' && typeof event.result === 'string' && event.result !== lastMessage) return { text: event.result };
    return {};
  };
}

export function registerQwen(registry: AgentToolRegistry): void {
  registry.registerDecoder('qwen-messages', createQwenDecoder).register({
    id: 'qwen', displayName: 'Qwen Code', command: 'qwen', args: ['--output-format', 'stream-json'],
    promptFlag: '--prompt', modelFlag: '--model', outputFormat: 'jsonl', outputProtocol: 'qwen-messages', defaultRole: 'developer',
    documentationUrl: 'https://qwenlm.github.io/qwen-code-docs/en/users/features/headless/',
  });
}
