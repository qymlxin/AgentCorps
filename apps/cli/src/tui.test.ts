import { describe, expect, it } from 'vitest';
import { deleteInputCharacter, insertInputCharacter, moveInputHistory, sanitizeTerminalText, wrapLine, commandSuggestions, type TuiInputState } from './tui.js';

function inputState(overrides: Partial<TuiInputState> = {}): TuiInputState {
  return { input: '', cursor: 0, history: [], historyIndex: -1, ...overrides };
}

describe('TUI helpers', () => {
  it('wraps long lines without exceeding the requested width', () => {
    const lines = wrapLine('alpha beta gamma delta', 10);
    expect(lines).toEqual(['alpha beta', 'gamma', 'delta']);
    expect(lines.every((line) => line.length <= 10)).toBe(true);
  });

  it('removes terminal control sequences from Agent output', () => {
    expect(sanitizeTerminalText('ok\u001b[31m danger\u001b[0m\u001b]0;title\u0007')).toBe('ok danger');
  });

  it('inserts and deletes at the current cursor position', () => {
    const state = inputState({ input: 'ac', cursor: 1 });
    insertInputCharacter(state, 'b');
    expect(state).toMatchObject({ input: 'abc', cursor: 2 });
    deleteInputCharacter(state);
    expect(state).toMatchObject({ input: 'ac', cursor: 1 });
  });

  it('suggests slash commands and filters partial commands', () => {
    expect(commandSuggestions('/')).toEqual(expect.arrayContaining([expect.objectContaining({ command: '/help' }), expect.objectContaining({ command: '/history' })]));
    expect(commandSuggestions('/mode').map((item) => item.command)).toEqual(['/mode MODE_ID']);
    expect(commandSuggestions('/his').map((item) => item.command)).toEqual(['/history']);
    expect(commandSuggestions('/approve ')).toEqual([]);
  });
  it('navigates command history in both directions and restores a blank draft', () => {
    const state = inputState({ history: ['first', 'second'] });
    moveInputHistory(state, -1);
    expect(state).toMatchObject({ input: 'second', cursor: 6, historyIndex: 1 });
    moveInputHistory(state, -1);
    expect(state).toMatchObject({ input: 'first', cursor: 5, historyIndex: 0 });
    moveInputHistory(state, 1);
    expect(state).toMatchObject({ input: 'second', cursor: 6, historyIndex: 1 });
    moveInputHistory(state, 1);
    expect(state).toMatchObject({ input: '', cursor: 0, historyIndex: 2 });
  });
});
