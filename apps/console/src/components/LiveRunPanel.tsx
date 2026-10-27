import { memo } from 'react';
import type { Task, TaskEvent } from '../api.js';

export const LiveRunPanel = memo(function LiveRunPanel({ tasks, events }: { tasks: Task[]; events: TaskEvent[] }) {
  const outputEvents = events.filter((event): event is Extract<TaskEvent, { type: 'run.output' }> => event.type === 'run.output');
  const active = tasks.find((task) => ['queued', 'running', 'waiting_approval'].includes(task.status)) ?? (outputEvents.length ? tasks.find((task) => task.id === outputEvents.at(-1)?.aggregateId) : undefined);
  const taskEvents = active ? outputEvents.filter((event) => event.aggregateId === active.id) : outputEvents.slice(-1);
  const output = taskEvents.map((event) => event.payload.text).join('');
  const status = active?.status ?? (outputEvents.length ? 'recent output' : 'idle');
  return <section className="panel live-run-panel" aria-labelledby="live-run-title">
    <div className="panel-head"><div><div className="eyebrow">ACTIVE CONTEXT</div><h2 id="live-run-title">Agent output</h2></div><span className={`live-tag ${status === 'waiting_approval' ? 'approval-tag' : ''}`}><span className="tiny-dot" />{status.replaceAll('_', ' ')}</span></div>
    <div className="live-run-body">
      {active && <div className="live-run-meta"><strong>{active.title}</strong><span>{active.objective}</span><code>{active.id}</code></div>}
      {output ? <pre aria-label="Agent output">{output}</pre> : <div className="empty-state">Run an Agent to see its response stream here.</div>}
    </div>
  </section>;
});
