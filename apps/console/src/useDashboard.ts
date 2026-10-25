import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, GatewayClient, type Approval, type Connection, type Session, type Task, type TaskEvent } from './api.js';
import { connectEvents, type LiveStatus } from './events.js';

interface Dashboard {
  tasks: Task[];
  sessions: Session[];
  approvals: Approval[];
  events: TaskEvent[];
  eventCount: number;
  loading: boolean;
  error: string;
  approvalError: string;
  live: LiveStatus;
}
const initial: Dashboard = { tasks: [], sessions: [], approvals: [], events: [], eventCount: 0, loading: true, error: '', approvalError: '', live: 'connecting' };
export const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);

export function useDashboard(connection: Connection) {
  const client = useMemo(() => new GatewayClient(connection), [connection]);
  const [data, setData] = useState<Dashboard>(initial);
  const refreshRef = useRef<() => Promise<void>>(async () => undefined);
  const refresh = useCallback(() => refreshRef.current(), []);

  useEffect(() => {
    let disposed = false;
    let pendingRefresh = false;
    let inFlight: Promise<void> | undefined;
    let eventTimer: ReturnType<typeof setTimeout> | undefined;
    const abort = new AbortController();
    const eventIds = new Set<string>();
    let eventCount = 0;
    let eventBuffer: TaskEvent[] = [];
    setData(initial);

    const load = (): Promise<void> => {
      if (disposed) return Promise.resolve();
      if (inFlight) { pendingRefresh = true; return inFlight; }
      inFlight = (async () => {
        try {
          const [tasks, sessions, approvals] = await Promise.all([
            client.tasks(abort.signal), client.sessions(abort.signal),
            client.approvals(abort.signal).then((result) => ({ approvals: result.approvals, error: '' })).catch((error: unknown) => ({
              approvals: [] as Approval[], error: error instanceof ApiError && error.status === 503 ? 'Approvals are not enabled on this gateway.' : `Approvals unavailable: ${errorMessage(error)}`,
            })),
          ]);
          if (!disposed) setData((current) => ({ ...current, tasks: tasks.tasks, sessions: sessions.sessions, approvals: approvals.approvals, approvalError: approvals.error, loading: false, error: '' }));
        } catch (error) {
          if (!disposed) setData((current) => ({ ...current, loading: false, error: errorMessage(error) }));
        } finally {
          inFlight = undefined;
          if (pendingRefresh && !disposed) { pendingRefresh = false; void load(); }
        }
      })();
      return inFlight;
    };
    refreshRef.current = load;
    void load();
    const poll = setInterval(() => { void load(); }, 5000);
    const disconnect = connectEvents(connection, (event) => {
      if (eventIds.has(event.id)) return;
      eventIds.add(event.id);
      eventCount++;
      // Reconnect replay is deduplicated without retaining an unbounded ID history.
      if (eventIds.size > 5000) eventIds.delete(eventIds.values().next().value!);
      eventBuffer.push(event);
      if (!eventTimer) eventTimer = setTimeout(() => {
        eventTimer = undefined;
        if (disposed) return;
        const batch = eventBuffer;
        eventBuffer = [];
        setData((current) => ({
          ...current, eventCount,
          events: [...current.events, ...batch].sort((a, b) => a.occurredAt.localeCompare(b.occurredAt)).slice(-200),
        }));
        if (batch.some((entry) => entry.type === 'task.created' || entry.type === 'task.status_changed')) void load();
      }, 100);
    }, (live) => { if (!disposed) setData((current) => ({ ...current, live })); });

    return () => {
      disposed = true;
      abort.abort();
      disconnect();
      clearInterval(poll);
      if (eventTimer) clearTimeout(eventTimer);
      refreshRef.current = async () => undefined;
    };
  }, [client, connection]);

  return { ...data, client, refresh };
}
