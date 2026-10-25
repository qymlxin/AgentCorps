import type { ReactNode } from 'react';
import { SHORTCUTS, type ShortcutAction } from '../shortcuts.js';

export function ShortcutOverlay({ mode, onAction, onClose }: {
  mode: 'palette' | 'help';
  onAction: (action: ShortcutAction) => void;
  onClose: () => void;
}) {
  if (mode === 'help') {
    return <div className="shortcut-backdrop" role="presentation" onMouseDown={onClose}>
      <section className="shortcut-dialog" role="dialog" aria-modal="true" aria-labelledby="shortcut-help-title" onMouseDown={(event) => event.stopPropagation()}>
        <div className="dialog-head"><div><div className="eyebrow">KEYBOARD CONTROL</div><h2 id="shortcut-help-title">Shortcuts</h2></div><button className="close-button" aria-label="Close shortcuts" onClick={onClose}>×</button></div>
        <div className="shortcut-list">{SHORTCUTS.map((shortcut) => <div className="shortcut-row" key={shortcut.action}><span>{shortcut.label}</span><kbd>{shortcut.keys}</kbd></div>)}</div>
      </section>
    </div>;
  }
  return <div className="shortcut-backdrop" role="presentation" onMouseDown={onClose}>
    <section className="shortcut-dialog command-palette" role="dialog" aria-modal="true" aria-labelledby="command-palette-title" onMouseDown={(event) => event.stopPropagation()}>
      <div className="dialog-head"><div><div className="eyebrow">COMMAND PALETTE</div><h2 id="command-palette-title">Jump to action</h2></div><button className="close-button" aria-label="Close command palette" onClick={onClose}>×</button></div>
      <div className="palette-actions">
        <PaletteAction label="New task" keys="N" action="new-task" onAction={onAction}>Create a work unit in the current workspace.</PaletteAction>
        <PaletteAction label="Overview" keys="1" action="overview" onAction={onAction}>See active work, event history, and approvals.</PaletteAction>
        <PaletteAction label="Sessions" keys="2" action="sessions" onAction={onAction}>Open shared conversation threads.</PaletteAction>
        <PaletteAction label="Event stream" keys="3" action="events" onAction={onAction}>Inspect replayable runtime events.</PaletteAction>
        <PaletteAction label="Refresh data" keys="R" action="refresh" onAction={onAction}>Fetch the latest runtime snapshot.</PaletteAction>
      </div>
    </section>
  </div>;
}

function PaletteAction({ label, keys, action, onAction, children }: { label: string; keys: string; action: ShortcutAction; onAction: (action: ShortcutAction) => void; children: ReactNode }) {
  return <button className="palette-action" onClick={() => onAction(action)}><span><strong>{label}</strong><small>{children}</small></span><kbd>{keys}</kbd></button>;
}
