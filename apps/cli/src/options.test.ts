import { describe, expect, it } from 'vitest';
import { parseCommandOptions } from './options.js';

describe('CLI option boundaries', () => {
  it('keeps vendor model and role flags opaque inside agent arguments', () => {
    const options = parseCommandOptions(['task', 'run', 't1', '--agent', 'zcode', '--agent-arg', '--model', '--agent-arg', 'native-model', '--agent-arg', '--role-file', '--agent-arg', 'native-role.md', '--role', 'reviewer']);
    expect(options.get('--agent-arg')).toEqual(['--model', 'native-model', '--role-file', 'native-role.md']);
    expect(options.has('--model')).toBe(false);
    expect(options.has('--role-file')).toBe(false);
    expect(options.get('--role')).toEqual(['reviewer']);
  });
  it('does not activate gateway or memory switches from prompt text', () => {
    const options = parseCommandOptions(['--instructions', '--include-sensitive', '--agent-arg', '--read-only']);
    expect(options.has('--include-sensitive')).toBe(false);
    expect(options.has('--read-only')).toBe(false);
  });
  it('preserves repeated values and stops after the argument terminator', () => {
    const options = parseCommandOptions(['--role', 'user', '--role', 'operator', '--identity-required', '--', '--model', 'ignored']);
    expect(options.get('--role')).toEqual(['user', 'operator']);
    expect(options.has('--identity-required')).toBe(true);
    expect(options.has('--model')).toBe(false);
  });
  it('rejects missing option values', () => {
    expect(() => parseCommandOptions(['--role-file'])).toThrow('Missing value for --role-file');
  });
});
