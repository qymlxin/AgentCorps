import { useCallback, useRef, useState } from 'react';
import { loadConnection, saveConnection, type ApprovalAction, type Connection, type TaskAction } from './api.js';
import { errorMessage, useDashboard } from './useDashboard.js';
import { SettingsDialog, TaskDialog } from './components/Dialogs.js';
import { ApprovalsPanel, EventsPanel, TasksPanel } from './components/Panels.js';
import { SessionsPanel } from './components/SessionsPanel.js';

type View = 'overview' | 'sessions' | 'events';

export function App() {
  const [connection, setConnection] = useState(loadConnection);
  // A connection switch remounts all connection-specific state and cancels old effects.
  return <Console key={`${connection.apiBase}\n${connection.token}`} connection={connection} onConnection={(value) => { saveConnection(value); setConnection(value); }} />;
}

function Console({ connection, onConnection }: { connection: Connection; onConnection: (value: Connection) => void }) {
  const data = useDashboard(connection);
  const [view, setView] = useState<View>('overview');
  const [dialog, setDialog] = useState<'task' | 'settings' | null>(null);
  const [actionError, setActionError] = useState('');
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const locks = useRef(new Set<string>());
  const perform = useCallback(async (id: string, operation: () => Promise<unknown>) => {
    if (locks.current.has(id)) return;
    locks.current.add(id); setBusy(new Set(locks.current)); setActionError('');
    try { await operation(); await data.refresh(); }
    catch (reason) { setActionError(errorMessage(reason)); }
    finally { locks.current.delete(id); setBusy(new Set(locks.current)); }
  }, [data.refresh]);
  const taskAction = useCallback((id: string, action: TaskAction) => { void perform(id, () => data.client.taskAction(id, action)); }, [perform, data.client]);
  const decide = useCallback((id: string, action: ApprovalAction) => { void perform(id, () => data.client.decide(id, action)); }, [perform, data.client]);
  const activeTasks = data.tasks.filter((task) => ['queued', 'running', 'waiting_approval'].includes(task.status)).length;
  const live = data.live === 'live' || data.live === 'polling';
  const healthLabel = data.error ? 'runtime offline' : data.loading ? 'connecting' : data.live === 'live' ? 'runtime online · live' : data.live === 'polling' ? 'runtime online · SSE' : 'runtime online · polling';

  return <>
    <div className="grain" aria-hidden="true" />
    <header className="topbar">
      <div className="brand"><span className="brand-mark" aria-hidden="true">◆</span><span>AGENTCORPS</span><small>signal room</small></div>
      <div className="connection"><span className={`pulse ${data.error ? 'error' : data.loading ? '' : 'ok'}`} /><span role="status">{healthLabel}</span><button className="icon-button" title="Connection settings" aria-label="Connection settings" onClick={() => setDialog('settings')}>⚙</button></div>
    </header>
    <main className="shell">
      <aside className="rail">
        <div className="eyebrow">WORKSPACE</div><div className="workspace-name"><span className="workspace-icon" aria-hidden="true">⌂</span><span>local-workspace</span></div>
        <nav className="nav" aria-label="Main navigation">{([['overview', '◈', 'Overview'], ['sessions', '◎', 'Sessions'], ['events', '≋', 'Event stream']] as const).map(([value, icon, label]) => <button key={value} className={`nav-item ${view === value ? 'active' : ''}`} aria-current={view === value ? 'page' : undefined} onClick={() => setView(value)}><span aria-hidden="true">{icon}</span>{label}</button>)}</nav>
        <div className="rail-footer"><span className="tiny-dot" /><span>LOCAL-FIRST RUNTIME</span><span className="version">v0.1</span></div>
      </aside>
      <section className="content" aria-label="Management console">
        <div className="hero-row">
          <div><div className="eyebrow">{new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric', year: 'numeric' })}</div><h1>Control the work.<br /><em>Keep the context.</em></h1><p className="lede">One local command center for every agent, session, and decision.</p></div>
          <button className="primary-button" onClick={() => setDialog('task')}><span aria-hidden="true">＋ </span>New task</button>
        </div>
        {(data.error || actionError) && <div role="alert" className="error-banner"><div>{actionError || data.error}{data.error && <p>Open connection settings to check the gateway URL and token.</p>}</div><button className="text-button" onClick={() => { setActionError(''); void data.refresh(); }}>Retry ↗</button></div>}
        <section className="metrics" aria-label="Runtime metrics">{[
          ['ACTIVE TASKS', activeTasks, 'in the runtime'], ['SESSIONS', data.sessions.length, 'shared threads'], ['EVENTS', data.eventCount, 'replayable facts'], ['APPROVALS', data.approvals.filter((approval) => approval.status === 'pending').length, 'awaiting decision'],
        ].map(([label, value, note], index) => <article className={`metric ${index % 2 ? 'accent' : ''}`} key={label}><span className="metric-label">{label}</span><strong>{data.loading ? '—' : value}</strong><span className="metric-note">{note}</span></article>)}</section>
        {view === 'overview' && <>
          <div className="work-grid"><TasksPanel tasks={data.tasks} loading={data.loading} busy={busy} onAction={taskAction} onRefresh={data.refresh} /><EventsPanel events={data.events} live={live} /></div>
          <ApprovalsPanel approvals={data.approvals} error={data.approvalError} busy={busy} onDecision={decide} />
        </>}
        {view === 'events' && <EventsPanel events={data.events} live={live} />}
        {view === 'sessions' && <SessionsPanel sessions={data.sessions} client={data.client} visible />}
      </section>
    </main>
    {dialog === 'settings' && <SettingsDialog connection={connection} onSave={(value) => { onConnection(value); setDialog(null); }} onClose={() => setDialog(null)} />}
    {dialog === 'task' && <TaskDialog sessions={data.sessions} client={data.client} onClose={() => setDialog(null)} onCreated={() => { setDialog(null); void data.refresh(); }} />}
  </>;
}
