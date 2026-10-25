import type { AgentToolRegistry } from '../registry.js';

/** Headless is a one-shot profile; SDK and ACP profiles are persistent servers. */
export function registerDeepSeekHarness(registry: AgentToolRegistry): void {
  registry.register({
    id: 'deepseek-harness', displayName: 'DeepSeek Harness', command: 'dsh', args: ['--profile', 'headless'],
    outputFormat: 'text', defaultRole: 'developer',
    documentationUrl: 'https://github.com/deepseek-ai/deepseek-harness/tree/master/apps/cli',
  });
}
