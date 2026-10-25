import type { AgentToolRegistry } from '../registry.js';
import { failureMessage, record, type AgentOutputDecoder } from '../output.js';

export const createZCodeDecoder = (): AgentOutputDecoder => (value) => {
  const event = record(value);
  if (!event) return {};
  if (event.type === 'error' || event.is_error === true) return { error: failureMessage(event.error ?? event.message) };
  if (event.type !== 'result') return {};
  const status = record(event.projection)?.status;
  if (typeof status === 'string' && ['error', 'failed', 'cancelled', 'canceled', 'interrupted'].includes(status.toLowerCase())) {
    return { error: failureMessage(event.error ?? `ZCode execution ${status}`) };
  }
  // ZCode's terminal response is authoritative after any workflow follow-up turns.
  return typeof event.response === 'string' ? { text: event.response } : {};
};

export function registerZCode(registry: AgentToolRegistry): void {
  registry.registerDecoder('zcode-result', createZCodeDecoder).register({
    id: 'zcode', displayName: 'ZCode CLI (GLM)', command: 'zcode', args: ['--output-format', 'stream-json', '--no-color'],
    promptFlag: '--prompt', outputFormat: 'jsonl', outputProtocol: 'zcode-result', defaultRole: 'developer',
    documentationUrl: 'https://github.com/zai-org/ZCode/tree/main/apps/zcode-cli',
  });
}
