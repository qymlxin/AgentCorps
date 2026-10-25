import type { AgentToolRegistry } from '../registry.js';

export function registerAider(registry: AgentToolRegistry): void {
  registry.register({
    id: 'aider', displayName: 'Aider', command: 'aider',
    args: ['--no-auto-commits', '--no-dirty-commits', '--no-stream', '--no-pretty', '--no-gitignore'],
    promptFlag: '--message', modelFlag: '--model', outputFormat: 'text', defaultRole: 'developer',
    documentationUrl: 'https://aider.chat/docs/scripting.html',
  });
}
