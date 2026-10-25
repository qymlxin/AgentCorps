import type { AgentToolRegistry } from '../registry.js';
import { failureMessage, record, type AgentOutputDecoder } from '../output.js';

export const createGeminiDecoder = (): AgentOutputDecoder => (value) => {
  const event = record(value);
  if (!event) return {};
  if (event.type === 'error') {
    const message = failureMessage(event.message ?? event.error);
    return event.severity === 'warning' ? { text: message, stream: 'stderr' } : { error: message };
  }
  if (event.type === 'result' && event.status === 'error') return { error: failureMessage(event.error) };
  if (event.type === 'message' && event.role === 'assistant' && typeof event.content === 'string') return { text: event.content };
  return {};
};

export function registerGemini(registry: AgentToolRegistry): void {
  registry.registerDecoder('gemini-events', createGeminiDecoder).register({
    id: 'gemini', displayName: 'Gemini CLI', command: 'gemini', args: ['--output-format', 'stream-json'],
    promptFlag: '--prompt', modelFlag: '--model', outputFormat: 'jsonl', outputProtocol: 'gemini-events', defaultRole: 'developer',
    documentationUrl: 'https://geminicli.com/docs/cli/headless/',
  });
}
