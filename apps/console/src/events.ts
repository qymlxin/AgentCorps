import type { Connection, TaskEvent } from './api.js';

export type LiveStatus = 'connecting' | 'live' | 'reconnecting' | 'polling';

function encodeToken(value: string): string {
  let binary = '';
  for (const byte of new TextEncoder().encode(value)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function isTaskEvent(value: unknown): value is TaskEvent {
  if (!value || typeof value !== 'object') return false;
  const event = value as Partial<TaskEvent>;
  return typeof event.id === 'string' && typeof event.type === 'string' && typeof event.aggregateId === 'string'
    && typeof event.occurredAt === 'string' && event.payload !== undefined;
}

/** A single connection lifecycle owns its socket, authenticated SSE fallback, and retry timer. */
export function connectEvents(connection: Connection, onEvent: (event: TaskEvent) => void, onStatus: (status: LiveStatus) => void): () => void {
  let disposed = false;
  let socket: WebSocket | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let handshake: ReturnType<typeof setTimeout> | undefined;
  let fallback: AbortController | undefined;
  let fallbackLive = false;
  let socketLive = false;
  let lastEventId = '';
  let attempts = 0;
  const deliver = (event: unknown): void => {
    if (!disposed && isTaskEvent(event)) {
      lastEventId = event.id;
      onEvent(event);
    }
  };
  const streamUrl = (path: string): URL => {
    const url = new URL(`${connection.apiBase}${path}`);
    if (lastEventId) url.searchParams.set('lastEventId', lastEventId);
    return url;
  };

  const startFallback = async (): Promise<void> => {
    if (disposed || fallback) return;
    const controller = new AbortController();
    fallback = controller;
    try {
      const response = await fetch(streamUrl('/events'), {
        headers: connection.token ? { authorization: `Bearer ${connection.token}` } : {},
        signal: controller.signal, cache: 'no-store',
      });
      if (!response.ok || !response.body) throw new Error('SSE unavailable');
      if (disposed || controller.signal.aborted) { await response.body.cancel(); return; }
      fallbackLive = true;
      onStatus('polling');
      const reader = response.body.getReader();
      const cancelReader = () => { void reader.cancel().catch(() => undefined); };
      controller.signal.addEventListener('abort', cancelReader, { once: true });
      if (controller.signal.aborted) cancelReader();
      const decoder = new TextDecoder();
      let buffer = '';
      try {
        while (!disposed && !controller.signal.aborted) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer = (buffer + decoder.decode(value, { stream: true })).replace(/\r\n/g, '\n');
          if (buffer.length > 8 * 1024 * 1024) throw new Error('SSE frame too large');
          let boundary: number;
          while ((boundary = buffer.indexOf('\n\n')) >= 0) {
            const frame = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            const data = frame.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
            if (data) { try { deliver(JSON.parse(data)); } catch { /* ignore malformed events */ } }
          }
        }
      } finally {
        controller.signal.removeEventListener('abort', cancelReader);
        await reader.cancel().catch(() => undefined);
      }
    } catch { /* HTTP snapshots continue while the stream reconnects. */ }
    finally {
      if (fallback === controller) {
        fallback = undefined;
        fallbackLive = false;
        if (!disposed && !socketLive) onStatus('reconnecting');
      }
    }
  };

  const schedule = (): void => {
    if (disposed || retry) return;
    if (handshake) clearTimeout(handshake);
    socketLive = false;
    onStatus(fallbackLive ? 'polling' : 'reconnecting');
    void startFallback();
    retry = setTimeout(() => { retry = undefined; open(); }, Math.min(1000 * 2 ** attempts++, 15_000));
  };
  const open = (): void => {
    if (disposed) return;
    const url = streamUrl('/ws');
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    const protocols = ['agentcorps.v1'];
    if (connection.token) protocols.push(`bearer.${encodeToken(connection.token)}`);
    try {
      const current = new WebSocket(url, protocols);
      socket = current;
      handshake = setTimeout(() => {
        if (!disposed && socket === current) { current.close(); schedule(); }
      }, 5000);
      current.onopen = () => {
        if (disposed || socket !== current) return;
        if (handshake) clearTimeout(handshake);
        attempts = 0;
        socketLive = true;
        fallback?.abort();
        onStatus('live');
      };
      current.onmessage = (message) => {
        if (disposed || socket !== current) return;
        try { deliver((JSON.parse(String(message.data)) as { event?: unknown }).event); } catch { /* malformed event */ }
      };
      current.onerror = () => current.close();
      current.onclose = () => { if (socket === current) schedule(); };
    } catch { schedule(); }
  };
  onStatus('connecting');
  open();
  return () => {
    disposed = true;
    if (retry) clearTimeout(retry);
    if (handshake) clearTimeout(handshake);
    fallback?.abort();
    if (socket) {
      socket.onopen = socket.onmessage = socket.onerror = socket.onclose = null;
      socket.close();
    }
  };
}
