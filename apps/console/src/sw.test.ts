import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

function worker() {
  const listeners = new Map<string, (event: unknown) => void>();
  const match = vi.fn().mockResolvedValue(new Response('cached'));
  const fetcher = vi.fn().mockRejectedValue(new Error('offline'));
  runInNewContext(readFileSync(resolve('public/sw.js'), 'utf8'), {
    URL, self: { registration: { scope: 'http://localhost:4173/console/' }, addEventListener: (type: string, listener: (event: unknown) => void) => listeners.set(type, listener) },
    caches: { match }, fetch: fetcher,
  });
  return { listeners, match, fetcher };
}

function request(url: string, options: { method?: string; mode?: string; headers?: Record<string, string> } = {}) {
  return { url, method: options.method ?? 'GET', mode: options.mode ?? 'cors', headers: new Headers(options.headers) };
}

describe('production offline cache', () => {
  it('ignores Vary: Origin for immutable assets so anonymous module requests work offline', async () => {
    const { listeners, match, fetcher } = worker();
    let response!: Promise<Response>;
    const asset = request('http://localhost:4173/console/assets/index-hash.js', { headers: { Origin: 'http://localhost:4173' } });
    listeners.get('fetch')!({ request: asset, respondWith: (value: Promise<Response>) => { response = value; } });
    expect(await (await response).text()).toBe('cached');
    expect(match).toHaveBeenCalledWith(asset, { ignoreVary: true });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('falls back to the scoped shell when navigation is offline', async () => {
    const { listeners, match } = worker();
    let response!: Promise<Response>;
    listeners.get('fetch')!({ request: request('http://localhost:4173/console/', { mode: 'navigate' }), respondWith: (value: Promise<Response>) => { response = value; } });
    expect(await (await response).text()).toBe('cached');
    expect(match).toHaveBeenCalledWith('http://localhost:4173/console/index.html');
  });

  it('leaves authenticated requests, gateway data, external origins and writes uncached', () => {
    const { listeners, match } = worker();
    for (const value of [
      request('http://localhost:4173/console/assets/private.js', { headers: { Authorization: 'Bearer secret' } }),
      request('http://localhost:4173/tasks'),
      request('http://localhost:43210/tasks'),
      request('http://localhost:4173/console/assets/index.js', { method: 'POST' }),
    ]) {
      const respondWith = vi.fn();
      listeners.get('fetch')!({ request: value, respondWith });
      expect(respondWith).not.toHaveBeenCalled();
    }
    expect(match).not.toHaveBeenCalled();
  });
});
