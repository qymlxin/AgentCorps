import { memo } from 'react';
import type { Approval, ApprovalAction, Task, TaskAction, TaskEvent } from '../api.js';

export const TasksPanel = memo(function TasksPanel({ tasks, loading, busy, onAction, onRefresh }: {
  tasks: Task[]; loading: boolean; busy: ReadonlySet<string>; onAction: (id: string, action: TaskAction) => void; onRefresh: () => void;
}) {
  return <section className="panel tasks-panel" aria-labelledby="tasks-title">
    <div className="panel-head"><div><div className="eyebrow">CURRENT RUNS</div><h2 id="tasks-title">Tasks in motion</h2></div><button className="text-button" onClick={onRefresh}>Refresh ↗</button></div>
    <div className="tasks-list">{loading ? <div className="empty-state">Loading the local runtime…</div> : tasks.length === 0 ? <div className="empty-state">No tasks yet. Create the first work unit.</div> : [...tasks].reverse().map((task) => {
      const action: TaskAction | undefined = task.status === 'queued' ? 'run' : ['running', 'waiting_approval'].includes(task.status) ? 'cancel' : ['failed', 'cancelled'].includes(task.status) ? 'retry' : undefined;
      return <article className="task-card" key={task.id}>
        <span className={`status-bar ${task.status}`} aria-hidden="true" />
        <div><div className="task-title">{task.title}</div><div className="task-objective">{task.objective}</div></div>
        <div className="task-meta"><div className="task-status">{task.status.replaceAll('_', ' ')}</div><div>{task.mode} · {task.id.slice(-8)}</div>
          {action && <button className="text-button task-action" disabled={busy.has(task.id)} onClick={() => onAction(task.id, action)} aria-label={`${action} ${task.title}`}>{busy.has(task.id) ? 'Working…' : `${action[0]!.toUpperCase()}${action.slice(1)} →`}</button>}
        </div>
      </article>;
    })}</div>
  </section>;
});

export const EventsPanel = memo(function EventsPanel({ events, live }: { events: TaskEvent[]; live: boolean }) {
  return <section className="panel activity-panel" aria-labelledby="events-title">
    <div className="panel-head"><div><div className="eyebrow">EVENT HISTORY</div><h2 id="events-title">Recent events</h2></div><span className={`live-tag ${live ? '' : 'muted'}`}><span className={live ? 'tiny-dot' : 'pulse'} />{live ? 'LIVE' : 'RECONNECTING'}</span></div>
    <div className="events-list">{events.length ? events.slice(-40).reverse().map((event) => <article className="event-row" key={event.id}>
      <span className="event-dot" aria-hidden="true" /><div><div className="event-type">{event.type}</div><div className="event-time"><time dateTime={event.occurredAt}>{new Date(event.occurredAt).toLocaleTimeString()}</time> · {event.aggregateId.slice(-8)}</div></div>
    </article>) : <div className="empty-state">Waiting for events…</div>}</div>
  </section>;
});

export const ApprovalsPanel = memo(function ApprovalsPanel({ approvals, error, busy, onDecision }: {
  approvals: Approval[]; error: string; busy: ReadonlySet<string>; onDecision: (id: string, action: ApprovalAction) => void;
}) {
  return <section className="panel approvals-panel" aria-labelledby="approvals-title">
    <div className="panel-head"><div><div className="eyebrow">DECISIONS</div><h2 id="approvals-title">Approval queue</h2></div><span className="muted panel-hint">Policy-backed, one-time decisions</span></div>
    <div className="approvals-list">{error ? <div className="empty-state">{error}</div> : approvals.length ? [...approvals].reverse().map((approval) => <article className="approval-row" key={approval.id}>
      <div><div className="task-title">{approval.request.capability}</div><div className="task-objective">{approval.reason}</div>{approval.request.command && <code className="approval-command">{approval.request.command}</code>}</div>
      <div className="task-meta"><div className="task-status">{approval.status}</div><div>{approval.id.slice(-8)}</div>{approval.status === 'pending' && <div className="approval-actions">
        <button className="text-button" disabled={busy.has(approval.id)} onClick={() => onDecision(approval.id, 'approve')}>Approve</button>
        <button className="text-button deny-button" disabled={busy.has(approval.id)} onClick={() => onDecision(approval.id, 'deny')}>Deny</button>
      </div>}</div>
    </article>) : <div className="empty-state">No approvals awaiting a decision.</div>}</div>
  </section>;
});
