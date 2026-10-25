import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useDashboard } from './useDashboard.js';
import { connection, event, FakeWebSocket } from './test/fixtures.js';

beforeEach(() => {
  FakeWebSocket.instances = [];
  vi.stubGlobal('WebSocket', FakeWebSocket);
});

describe('dashboard snapshots and event batching', () => {
  it('deduplicates replayed events and batches task refreshes', async () => {
    const fetcher = vi.fn(async () => Response.json({ tasks: [], sessions: [], approvals: [] }));
    vi.stubGlobal('fetch', fetcher);
    const { result, unmount } = renderHook(() => useDashboard(connection));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(fetcher).toHaveBeenCalledTimes(3);
    act(() => {
      const socket = FakeWebSocket.instances[0]!;
      socket.open();
      socket.message({ event: event('event-1', 'task.created') });
      socket.message({ event: event('event-1', 'task.created') });
      socket.message({ event: event('event-2', 'task.status_changed') });
    });
    await waitFor(() => expect(result.current.eventCount).toBe(2));
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(6));
    expect(result.current.events).toHaveLength(2);
    unmount();
    expect(FakeWebSocket.instances[0]!.closed).toBe(true);
  });

  it('coalesces concurrent refresh requests and aborts pending fetches on unmount', async () => {
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => { finish = resolve; });
    const signals: AbortSignal[] = [];
    const fetcher = vi.fn(async (_url: string, init: RequestInit) => {
      signals.push(init.signal as AbortSignal);
      await gate;
      return Response.json({ tasks: [], sessions: [], approvals: [] });
    });
    vi.stubGlobal('fetch', fetcher);
    const { result, unmount } = renderHook(() => useDashboard(connection));
    act(() => { void result.current.refresh(); void result.current.refresh(); void result.current.refresh(); });
    expect(fetcher).toHaveBeenCalledTimes(3);
    await act(async () => { finish(); });
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(6));
    unmount();
    expect(signals.every((signal) => signal.aborted)).toBe(true);
  });
});
