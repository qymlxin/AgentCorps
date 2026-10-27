import { useEffect, useRef, useState, type ReactNode } from 'react';
import { normalizeApiBase, type Connection, type GatewayClient, type RunInput, type Session } from '../api.js';
import { errorMessage } from '../useDashboard.js';

function Dialog({ title, eyebrow, onClose, children, busy = false }: { title: string; eyebrow: string; onClose: () => void; children: ReactNode; busy?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { const dialog = ref.current; dialog?.showModal(); return () => dialog?.close(); }, []);
  return <dialog ref={ref} className="task-dialog" aria-label={title} aria-busy={busy} onCancel={(event) => { event.preventDefault(); if (!busy) onClose(); }}>
    <div className="dialog-content">
      <div className="dialog-head"><div><div className="eyebrow">{eyebrow}</div><h2>{title}</h2></div><button type="button" className="close-button" aria-label="Close" disabled={busy} onClick={onClose}>×</button></div>
      {children}
    </div>
  </dialog>;
}

export function SettingsDialog({ connection, onSave, onClose }: { connection: Connection; onSave: (value: Connection) => void; onClose: () => void }) {
  const [apiBase, setApiBase] = useState(connection.apiBase);
  const [token, setToken] = useState(connection.token);
  const [error, setError] = useState('');
  return <Dialog title="Runtime endpoint" eyebrow="LOCAL CONNECTION" onClose={onClose}>
    <form onSubmit={(event) => { event.preventDefault(); try { onSave({ apiBase: normalizeApiBase(apiBase), token: token.trim() }); } catch (reason) { setError(errorMessage(reason)); } }}>
      <label>API base URL<input type="url" required value={apiBase} onChange={(event) => setApiBase(event.target.value)} /></label>
      <label>Bearer token<input type="password" autoComplete="off" value={token} onChange={(event) => setToken(event.target.value)} placeholder="Stored only in this browser" /></label>
      <p className="form-note">Connection settings stay in this browser. Use HTTPS for remote gateways.</p>
      {error && <p role="alert" className="form-error">{error}</p>}
      <div className="dialog-actions"><button type="button" className="secondary-button" onClick={onClose}>Cancel</button><button type="submit" className="primary-button">Save connection →</button></div>
    </form>
  </Dialog>;
}

export function RunDialog({ sessions, client, onStarted, onClose }: { sessions: Session[]; client: GatewayClient; onStarted: () => void; onClose: () => void }) {
  const [prompt, setPrompt] = useState('');
  const [title, setTitle] = useState('');
  const [agent, setAgent] = useState('mock');
  const [model, setModel] = useState('');
  const [role, setRole] = useState('');
  const [sessionId, setSessionId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return <Dialog title="Run an Agent" eyebrow="NEW AGENT RUN" onClose={onClose} busy={busy}>
    <form onSubmit={async (event) => {
      event.preventDefault();
      if (busy) return;
      if (!prompt.trim()) { setError('Prompt cannot be blank.'); return; }
      setBusy(true); setError('');
      const input: RunInput = { prompt: prompt.trim(), ...(title.trim() ? { title: title.trim() } : {}), agent: agent.trim() || 'mock', ...(model.trim() ? { model: model.trim() } : {}), ...(role ? { role } : {}), ...(sessionId ? { sessionId } : {}) };
      try { await client.run(input); onStarted(); } catch (reason) { setError(errorMessage(reason)); } finally { setBusy(false); }
    }}>
      <label>Prompt<textarea required autoFocus value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder="What should the Agent do?" /></label>
      <div className="form-row"><label>Agent<input value={agent} onChange={(event) => setAgent(event.target.value)} placeholder="mock, codex, claude-code" /></label><label>Model<input value={model} onChange={(event) => setModel(event.target.value)} placeholder="Optional" /></label></div>
      <div className="form-row"><label>Role<select value={role} onChange={(event) => setRole(event.target.value)}><option value="">Default</option><option value="developer">Developer</option><option value="reviewer">Reviewer</option><option value="planner">Planner</option><option value="tester">Tester</option><option value="security">Security</option><option value="writer">Writer</option></select></label><label>Session<select value={sessionId} onChange={(event) => setSessionId(event.target.value)}><option value="">Create new session</option>{sessions.map((session) => <option key={session.id} value={session.id}>{session.title}</option>)}</select></label></div>
      <label>Title<input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Optional run title" /></label>
      {error && <p role="alert" className="form-error">{error}</p>}
      <div className="dialog-actions"><button type="button" className="secondary-button" disabled={busy} onClick={onClose}>Cancel</button><button type="submit" className="primary-button" disabled={busy}>{busy ? 'Starting…' : 'Run Agent →'}</button></div>
    </form>
  </Dialog>;
}

export function TaskDialog({ sessions, client, onCreated, onClose }: { sessions: Session[]; client: GatewayClient; onCreated: () => void; onClose: () => void }) {
  const [title, setTitle] = useState('');
  const [objective, setObjective] = useState('');
  const [mode, setMode] = useState<'code' | 'work'>('code');
  const [sessionId, setSessionId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return <Dialog title="Start a task" eyebrow="NEW WORK UNIT" onClose={onClose} busy={busy}>
    <form onSubmit={async (event) => { event.preventDefault(); if (busy) return; if (!title.trim() || !objective.trim()) { setError('Title and objective cannot be blank.'); return; } setBusy(true); setError(''); try { await client.createTask({ title: title.trim(), objective: objective.trim(), mode, sessionId }, sessions); onCreated(); } catch (reason) { setError(errorMessage(reason)); } finally { setBusy(false); } }}>
      <label>Title<input required value={title} onChange={(event) => setTitle(event.target.value)} placeholder="e.g. Review the release plan" /></label>
      <label>Objective<textarea required value={objective} onChange={(event) => setObjective(event.target.value)} placeholder="What should the agents accomplish?" /></label>
      <div className="form-row"><label>Mode<select value={mode} onChange={(event) => setMode(event.target.value as 'code' | 'work')}><option value="code">Code / vibe coding</option><option value="work">Work / office flow</option></select></label><label>Session<select value={sessionId} onChange={(event) => setSessionId(event.target.value)}><option value="">Create new session</option>{sessions.map((session) => <option key={session.id} value={session.id}>{session.title}</option>)}</select></label></div>
      {error && <p role="alert" className="form-error">{error}</p>}
      <div className="dialog-actions"><button type="button" className="secondary-button" disabled={busy} onClick={onClose}>Cancel</button><button type="submit" className="primary-button" disabled={busy}>{busy ? 'Creating…' : 'Create task →'}</button></div>
    </form>
  </Dialog>;
}
