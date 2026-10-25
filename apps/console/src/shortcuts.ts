export type ShortcutAction = 'new-task' | 'overview' | 'sessions' | 'events' | 'files' | 'git' | 'terminal' | 'browser' | 'refresh' | 'palette' | 'help' | 'close';

export const SHORTCUTS: readonly { readonly keys: string; readonly label: string; readonly action: ShortcutAction }[] = Object.freeze([
  { keys: 'N', label: 'New task', action: 'new-task' },
  { keys: '1', label: 'Overview', action: 'overview' },
  { keys: '2', label: 'Sessions', action: 'sessions' },
  { keys: '3', label: 'Event stream', action: 'events' },
  { keys: '4', label: 'Files', action: 'files' },
  { keys: '5', label: 'Git', action: 'git' },
  { keys: '6', label: 'Terminal', action: 'terminal' },
  { keys: '7', label: 'Browser', action: 'browser' },
  { keys: 'R', label: 'Refresh data', action: 'refresh' },
  { keys: '⌘ K / Ctrl K', label: 'Open command palette', action: 'palette' },
  { keys: '?', label: 'Show keyboard shortcuts', action: 'help' },
  { keys: 'Esc', label: 'Close overlay or dialog', action: 'close' },
]);

export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
}

export function shortcutAction(event: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'target'>): ShortcutAction | undefined {
  if (event.key === 'Escape') return 'close';
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') return 'palette';
  if (isEditableTarget(event.target)) return undefined;
  switch (event.key) {
    case 'n': case 'N': return 'new-task';
    case '1': return 'overview';
    case '2': return 'sessions';
    case '3': return 'events';
    case '4': return 'files';
    case '5': return 'git';
    case '6': return 'terminal';
    case '7': return 'browser';
    case 'r': case 'R': return 'refresh';
    case '?': return 'help';
    default: return undefined;
  }
}
