import { useEffect, useState } from 'react';
import type { GatewayClient, Session, SessionMessage } from '../api.js';
import { errorMessage } from '../useDashboard.js';

export function SessionsPanel({ sessions, client, visible }: { sessions: Session[]; client: GatewayClient; visible: boolean }) {
  const [selected, setSelected] = useState('');
  const [messages, setMessages] = useState<SessionMessage[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const sessionId = sessions.some((session) => session.id === selected) ? selected : sessions[0]?.id ?? '';
  const updatedAt = sessions.find((session) => session.id === sessionId)?.updatedAt;
  useEffect(() => {
    if (!visible || !sessionId) { setMessages([]); return; }
    const abort = new AbortController();
    setLoading(true); setError(''); setMessages([]);
    void client.session(sessionId, abort.signal).then((result) => {
      if (!abort.signal.aborted) setMessages(result.messages);
    }).catch((reason: unknown) => { if (!abort.signal.aborted) setError(errorMessage(reason)); })
      .finally(() => { if (!abort.signal.aborted) setLoading(false); });
    return () => abort.abort();
  }, [client, sessionId, updatedAt, visible]);

  return <section className="panel sessions-panel" aria-labelledby="sessions-title">
    <div className="panel-head"><div><div className="eyebrow">SHARED CONTEXT</div><h2 id="sessions-title">Sessions</h2></div><span className="muted panel-hint">{sessions.length} shared threads</span></div>
    {sessions.length ? <div className="session-layout">
      <div className="session-list" aria-label="Session list">{sessions.map((session) => <button key={session.id} className={`session-item ${sessionId === session.id ? 'active' : ''}`} aria-pressed={sessionId === session.id} onClick={() => setSelected(session.id)}>
        <strong>{session.title}</strong><span>{session.mode} · {session.workspaceId}</span>
      </button>)}</div>
      <div className="session-messages">{loading ? <div className="empty-state">Loading messages…</div> : error ? <p role="alert" className="form-error">{error}</p> : messages.length ? messages.map((message) => <article className="session-message" key={message.id}>
        <div className="eyebrow">{message.role} · <time dateTime={message.createdAt}>{new Date(message.createdAt).toLocaleString()}</time></div><p>{message.content}</p>
      </article>) : <div className="empty-state">No messages in this session yet.</div>}</div>
    </div> : <div className="empty-state">Create a task to start a shared session.</div>}
  </section>;
}
