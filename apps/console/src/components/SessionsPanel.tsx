import { useEffect, useState } from 'react';
import type { GatewayClient, Session, SessionMessage, SessionSearchResult } from '../api.js';
import { errorMessage } from '../useDashboard.js';

export function SessionsPanel({ sessions, client, visible }: { sessions: Session[]; client: GatewayClient; visible: boolean }) {
  const [selected, setSelected] = useState('');
  const [messages, setMessages] = useState<SessionMessage[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<SessionSearchResult[]>([]);
  const [searchError, setSearchError] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [searching, setSearching] = useState(false);
  const sessionId = sessions.some((session) => session.id === selected) ? selected : sessions[0]?.id ?? '';
  const updatedAt = sessions.find((session) => session.id === sessionId)?.updatedAt;
  useEffect(() => {
    if (!visible || !sessionId) { setMessages([]); return; }
    const abort = new AbortController();
    setLoading(true); setError(''); setMessages([]);
    void client.session(sessionId, abort.signal).then((result) => { if (!abort.signal.aborted) setMessages(result.messages); }).catch((reason: unknown) => { if (!abort.signal.aborted) setError(errorMessage(reason)); })
      .finally(() => { if (!abort.signal.aborted) setLoading(false); });
    return () => abort.abort();
  }, [client, sessionId, updatedAt, visible]);

  const search = async (event: React.FormEvent) => {
    event.preventDefault();
    const query = searchQuery.trim();
    if (!query) { setSearchResults([]); setSearchError('Enter a phrase to search session messages.'); return; }
    setSearching(true); setSearchError('');
    try { setSearchResults((await client.searchSessions(query)).results); }
    catch (reason) { setSearchError(errorMessage(reason)); }
    finally { setSearching(false); }
  };

  return <section className="panel sessions-panel" aria-labelledby="sessions-title">
    <div className="panel-head"><div><div className="eyebrow">SHARED CONTEXT</div><h2 id="sessions-title">Sessions</h2></div><span className="muted panel-hint">{sessions.length} shared threads</span></div>
    <form className="session-search" onSubmit={search}><label htmlFor="session-search-query" className="eyebrow">SEARCH MESSAGES</label><div><input id="session-search-query" value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} placeholder="Find a phrase across sessions" /><button className="secondary-button" disabled={searching || !searchQuery.trim()}>Search →</button></div></form>
    {searchError && <p role="alert" className="form-error session-search-error">{searchError}</p>}
    {searchResults.length > 0 && <div className="session-search-results" aria-label="Session search results"><div className="eyebrow">{searchResults.length} MATCHES</div>{searchResults.map((result) => <button className="session-search-result" key={result.message.id} onClick={() => setSelected(result.session.id)}><strong>{result.session.title}</strong><small>{result.session.workspaceId} · {result.message.role}</small><span>{result.message.content}</span></button>)}</div>}
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
