import type { AgentAdapter, AgentRequest } from '@agentcorps/runtime';

export interface RolePreset {
  readonly id: string;
  readonly displayName: string;
  readonly description: string;
  readonly prompt: string;
}

export const ROLE_PRESETS: readonly RolePreset[] = Object.freeze([
  { id: 'developer', displayName: 'Developer', description: 'Implement focused changes and verify them.', prompt: 'You are a software implementation specialist. Inspect the existing code and conventions, implement the smallest complete change, add regression tests, and report the commands you actually ran. Preserve unrelated work. Ask before destructive operations or changes to credentials.' },
  { id: 'reviewer', displayName: 'Code reviewer', description: 'Review correctness, regressions, and maintainability.', prompt: 'You are a code reviewer. Inspect the relevant implementation and tests. Prioritize concrete correctness defects, security issues, and regressions. Cite file locations and explain impact. Separate confirmed findings from uncertainty. Review without modifying files unless the task explicitly requests fixes.' },
  { id: 'planner', displayName: 'Planner', description: 'Explore requirements and produce an actionable plan.', prompt: 'You are a technical planning specialist. Explore the existing implementation, identify constraints and trade-offs, and produce a sequenced implementation and verification plan. State assumptions and unresolved questions. Stay read-only unless the task explicitly authorizes implementation.' },
  { id: 'tester', displayName: 'Test engineer', description: 'Reproduce defects and verify behavior.', prompt: 'You are a test engineer. Derive checks from observable behavior, cover success and failure paths, and add deterministic regression tests where requested. Run the relevant checks and distinguish passed, failed, skipped, and untested behavior. Never claim a test ran without evidence.' },
  { id: 'security', displayName: 'Security reviewer', description: 'Inspect trust boundaries and actionable vulnerabilities.', prompt: 'You are a security reviewer. Trace untrusted inputs, authentication, authorization, secret handling, command execution, and data boundaries. Report reproducible vulnerabilities with realistic impact and focused mitigations. Do not expose secrets or execute destructive demonstrations. Stay read-only unless fixes are explicitly requested.' },
  { id: 'writer', displayName: 'Documentation writer', description: 'Write accurate, runnable documentation.', prompt: 'You are a technical documentation specialist. Verify claims against the implementation, write clear task-oriented instructions and runnable examples, document prerequisites and limitations, and keep terminology consistent. Never invent supported options or claim unverified integrations work.' },
].map((role) => Object.freeze(role)));

export function getRolePreset(id: string): RolePreset {
  const role = ROLE_PRESETS.find((entry) => entry.id === id);
  if (!role) throw new Error(`Unknown role: ${id}. Available roles: ${ROLE_PRESETS.map((entry) => entry.id).join(', ')}`);
  return role;
}

export interface RolePromptOptions {
  readonly role?: RolePreset;
  readonly instructions?: string;
}

/** Prompt guidance only: roles never grant capabilities, approvals, or sandbox permissions. */
export function composeRolePrompt(objective: string, options: RolePromptOptions): string {
  const sections: string[] = [];
  if (options.role) sections.push(`--- AgentCorps role: ${options.role.id} ---\n${options.role.prompt.trim()}\n--- End role ---`);
  if (options.instructions?.trim()) sections.push(`--- Run instructions ---\n${options.instructions.trim()}\n--- End run instructions ---`);
  if (!sections.length) return objective;
  return ['AgentCorps execution context (guidance only; permissions are unchanged)', ...sections, `--- Task objective ---\n${objective}\n--- End task objective ---`].join('\n\n');
}

/** Works with every adapter without vendor-specific role flags or changing the stored task. */
export function withRole(adapter: AgentAdapter, options: RolePromptOptions): AgentAdapter {
  if (!options.role && !options.instructions?.trim()) return adapter;
  return {
    descriptor: adapter.descriptor,
    execute(request: AgentRequest) {
      return adapter.execute({ ...request, task: { ...request.task, objective: composeRolePrompt(request.task.objective, options) } });
    },
  };
}
