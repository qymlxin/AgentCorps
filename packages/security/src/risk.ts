export type CommandRisk = 'low' | 'medium' | 'high' | 'critical';

export interface CommandRiskFinding {
  readonly risk: CommandRisk;
  readonly rule: string;
  readonly reason: string;
}

export interface CommandRiskAssessment {
  readonly command: string;
  readonly risk: CommandRisk;
  readonly findings: readonly CommandRiskFinding[];
  readonly requiresApproval: boolean;
}

const rank: Record<CommandRisk, number> = { low: 0, medium: 1, high: 2, critical: 3 };

/** Classifies shell commands before execution. It is intentionally conservative. */
export function assessCommandRisk(command: string): CommandRiskAssessment {
  const normalized = command.trim();
  if (!normalized) return { command, risk: 'critical', findings: [{ risk: 'critical', rule: 'empty-command', reason: 'An empty command cannot be safely classified' }], requiresApproval: true };
  const findings: CommandRiskFinding[] = [];
  const add = (risk: CommandRisk, rule: string, reason: string): void => { findings.push({ risk, rule, reason }); };
  if (/(^|\s)(rm\s+(-[A-Za-z]*f|--force)|mkfs(?:\.|\s)|dd\s+if=|wipefs|diskutil\s+erase|format\s+)/i.test(normalized)) add('critical', 'destructive-filesystem', 'The command can destroy filesystems or large data ranges');
  if (/(curl|wget|fetch)\b[^\n|;]*\|\s*(sh|bash|zsh|fish)\b|\bsh\s+-c\s+['"]?[^\n]*https?:\/\//i.test(normalized)) add('critical', 'remote-code-execution', 'The command executes code downloaded from a remote endpoint');
  if (/(^|\s)(sudo|doas|su\s+-|chmod\s+[0-7]*7|chown\s+)/i.test(normalized)) add('high', 'privilege-escalation', 'The command changes privilege or ownership boundaries');
  if (/(git\s+(push|remote\s+set-url)|npm\s+publish|pnpm\s+publish|cargo\s+publish|docker\s+push)\b/i.test(normalized)) add('high', 'external-publish', 'The command can publish or exfiltrate project content');
  if (/(docker\s+(-H|--host)|\/var\/run\/docker\.sock|nc\s+|ncat\s+|ssh\s+|scp\s+|rsync\s+[^\n]*:)/i.test(normalized)) add('high', 'external-control', 'The command can control a remote host or container daemon');
  if (/(^|\s)(curl|wget|nc|ncat|ssh|scp|ftp|telnet)\b|https?:\/\//i.test(normalized)) add('medium', 'network-access', 'The command accesses a network endpoint');
  if (/(npm|pnpm|yarn|pip|uv|cargo|go)\s+(install|add|get|update|upgrade)\b/i.test(normalized)) add('medium', 'dependency-change', 'The command changes installed dependencies');
  if (/\b(printenv|env|set)\b|\$(?:AWS|GITHUB|OPENAI|ANTHROPIC|TOKEN|SECRET|PASSWORD|PRIVATE_KEY)/i.test(normalized)) add('high', 'credential-exposure', 'The command may print or interpolate credentials');
  if (/[;&|`$()<>]/.test(normalized) && !findings.some((finding) => finding.rule === 'remote-code-execution')) add('medium', 'shell-composition', 'Shell metacharacters make command intent harder to constrain');
  const risk = findings.reduce<CommandRisk>((current, finding) => rank[finding.risk] > rank[current] ? finding.risk : current, 'low');
  return { command, risk, findings, requiresApproval: risk !== 'low' };
}

export function assertCommandRisk(command: string, maximum: CommandRisk = 'high'): CommandRiskAssessment {
  const assessment = assessCommandRisk(command);
  if (rank[assessment.risk] > rank[maximum]) throw new Error(`Command risk ${assessment.risk} exceeds configured maximum ${maximum}`);
  return assessment;
}
