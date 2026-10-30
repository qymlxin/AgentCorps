/** Value options consume exactly one opaque argument, including vendor flags. */
const VALUE_OPTIONS = new Set([
  '--port', '--host', '--token', '--read-only-token', '--data-dir', '--config', '--cors-origin',
  '--title', '--objective', '--mode', '--agent', '--agents-config', '--acp-config', '--model',
  '--role', '--role-file', '--instructions', '--agent-command', '--agent-arg', '--command', '--workspace-root', '--approval-mode',
  '--sandbox-backend', '--container-image', '--sandbox-network', '--sandbox-memory-mb', '--sandbox-cpu', '--sandbox-pids',
  '--browser-endpoint', '--browser-network', '--browser-host',
  '--scope', '--content', '--workspace-id', '--session-id', '--sensitivity', '--query', '--memory-id',
  '--output', '--input', '--label', '--device-id', '--ttl', '--channel', '--external-user-id', '--decided-by',
]);

export function parseCommandOptions(argv: readonly string[]): ReadonlyMap<string, readonly string[]> {
  const options = new Map<string, string[]>();
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index]!;
    if (option === '--') break;
    if (!option.startsWith('--')) continue;
    const values = options.get(option) ?? [];
    if (VALUE_OPTIONS.has(option)) {
      const value = argv[++index];
      if (value === undefined) throw new Error(`Missing value for ${option}`);
      values.push(value);
    }
    options.set(option, values);
  }
  return options;
}
