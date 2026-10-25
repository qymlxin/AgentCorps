import { beforeEach, describe, expect, it, vi } from 'vitest';
import { connectEvents } from './events.js';
import { connection, event, FakeWebSocket } from './test/fixtures.js';

beforeEach(() => {
  FakeWebSocket.instances = [];
  vi.stubGlobal('WebSocket', FakeWebSocket);
  vi.useFakeTimers();
});

describe('event connection lifecycle', () => {
  it('authenticates using a subprotocol and replays from the last event after reconnect', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    const receive = vi.fn();
    const status = vi.fn();
    const dispose = connectEvents(connection, receive, status);
    const first = FakeWebSocket.instances[0]!;
    expect(first.url).toBe('ws://127.0.0.1:43210/ws');
    expect(first.protocols).toEqual(['agentcorps.v1', `bearer.${btoa(connection.token).replace(/=/g, '')}`]);
    expect(first.url).not.toContain(connection.token);
    first.open();
    first.message({ type: 'ready' });
    first.message({ event: event() });
    first.message({ event: { id: 'malformed' } });
    expect(receive).toHaveBeenCalledTimes(1);
    first.close();
    await vi.advanceTimersByTimeAsync(1000);
    expect(FakeWebSocket.instances[1]!.url).toContain('lastEventId=event-1');
    expect(status).toHaveBeenCalledWith('live');
    dispose();
    expect(FakeWebSocket.instances[1]!.closed).toBe(true);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it('uses authenticated SSE when WebSocket fails and parses split CRLF frames', async () => {
    let stream!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({ start(controller) { stream = controller; } });
    const fetcher = vi.fn().mockResolvedValue(new Response(body));
    vi.stubGlobal('fetch', fetcher);
    const receive = vi.fn();
    const status = vi.fn();
    const dispose = connectEvents(connection, receive, status);
    FakeWebSocket.instances[0]!.close();
    await vi.advanceTimersByTimeAsync(0);
    const encoder = new TextEncoder();
    stream.enqueue(encoder.encode(`data: ${JSON.stringify(event())}\r`));
    await vi.advanceTimersByTimeAsync(0);
    stream.enqueue(encoder.encode('\n\r'));
    await vi.advanceTimersByTimeAsync(0);
    stream.enqueue(encoder.encode('\n'));
    await vi.advanceTimersByTimeAsync(0);
    expect(receive).toHaveBeenCalledWith(event());
    expect(fetcher.mock.calls[0]![1].headers.authorization).toBe('Bearer test-token');
    expect(status).toHaveBeenCalledWith('polling');
    await vi.advanceTimersByTimeAsync(1000);
    FakeWebSocket.instances[1]!.close();
    expect(status).toHaveBeenLastCalledWith('polling');
    const signal = fetcher.mock.calls[0]![1].signal as AbortSignal;
    dispose();
    expect(signal.aborted).toBe(true);
  });

  it('falls back when a WebSocket handshake stalls and cancels pending retries on disposal', async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error('offline'));
    vi.stubGlobal('fetch', fetcher);
    const dispose = connectEvents(connection, vi.fn(), vi.fn());
    await vi.advanceTimersByTimeAsync(5000);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(FakeWebSocket.instances[0]!.closed).toBe(true);
    dispose();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it('aborts the fallback when WebSocket recovers', async () => {
    const body = new ReadableStream<Uint8Array>();
    const fetcher = vi.fn().mockResolvedValue(new Response(body));
    vi.stubGlobal('fetch', fetcher);
    const dispose = connectEvents(connection, vi.fn(), vi.fn());
    FakeWebSocket.instances[0]!.close();
    await vi.advanceTimersByTimeAsync(1000);
    FakeWebSocket.instances[1]!.open();
    expect((fetcher.mock.calls[0]![1].signal as AbortSignal).aborted).toBe(true);
    dispose();
  });
});
