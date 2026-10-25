import { useEffect, useState } from 'react';
import type { GatewayClient, UsageRecord, UsageSummary } from '../api.js';

export function UsagePanel({ client, visible }: { client: GatewayClient; visible: boolean }) {
  const [summary, setSummary] = useState<UsageSummary[]>([]);
  const [calls, setCalls] = useState<UsageRecord[]>([]);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!visible) return;
    let disposed = false;
    Promise.all([client.usageSummary(), client.usageCalls(50)]).then(([summaryResult, callsResult]) => {
      if (disposed) return;
      setSummary(summaryResult.summary);
      setCalls(callsResult.calls);
      setError('');
    }).catch((reason: unknown) => { if (!disposed) setError(reason instanceof Error ? reason.message : String(reason)); });
    return () => { disposed = true; };
  }, [client, visible]);
  return <section className="panel usage-panel" aria-labelledby="usage-title">
    <div className="panel-head"><div><div className="eyebrow">OBSERVABILITY</div><h2 id="usage-title">Model and tool calls</h2></div><span className="muted panel-hint">Token counts never include prompt bodies</span></div>
    {error ? <div className="empty-state">{error}</div> : <>
      <div className="usage-summary">{summary.length ? summary.map((item) => <article className="usage-card" key={`${item.kind}:${item.toolId}:${item.model ?? ''}`}>
        <div className="task-title">{item.toolId}{item.model ? ` · ${item.model}` : ''}</div>
        <div className="task-objective">{item.kind} · {item.calls} calls · {item.succeeded} succeeded · {item.failed} failed</div>
        <div className="task-meta">{item.totalTokens.toLocaleString()} tokens{item.estimatedCalls ? ` · ${item.estimatedCalls} estimated` : ''}</div>
      </article>) : <div className="empty-state">No invocation records yet.</div>}</div>
      <div className="eyebrow usage-log-label">RECENT INVOCATIONS</div>
      <div className="usage-log">{calls.length ? calls.map((call) => <article className="event-row" key={call.id}>
        <span className={`event-dot ${call.status === 'failed' ? 'error' : ''}`} aria-hidden="true" />
        <div><div className="event-type">{call.kind} · {call.toolId}{call.model ? ` · ${call.model}` : ''}</div><div className="event-time"><time dateTime={call.startedAt}>{new Date(call.startedAt).toLocaleString()}</time> · {call.status} · {call.totalTokens ?? 0} tokens</div>{call.error && <div className="task-objective">{call.error}</div>}</div>
      </article>) : <div className="empty-state">No recent calls.</div>}</div>
    </>}
  </section>;
}
