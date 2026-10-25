const CACHE = 'agentcorps-console-react-__BUILD_ID__';
const ROOT = new URL('./', self.registration.scope);
const SHELL = new URL('index.html', ROOT).href;
const MANIFEST = new URL('manifest.webmanifest', ROOT).href;
const ASSETS = new URL('assets/', ROOT).pathname;

self.addEventListener('install', (event) => event.waitUntil((async () => {
  const cache = await caches.open(CACHE);
  const response = await fetch(SHELL, { cache: 'reload' });
  if (!response.ok) throw new Error('Console shell unavailable');
  const html = await response.clone().text();
  const assets = [...html.matchAll(/(?:src|href)="([^"\s]+\.(?:js|css))"/g)]
    .map((match) => new URL(match[1], ROOT))
    .filter((url) => url.origin === ROOT.origin && url.pathname.startsWith(ASSETS));
  await cache.put(SHELL, response);
  await cache.addAll([MANIFEST, ...assets.map((url) => url.href)]);
  await self.skipWaiting();
})()));

self.addEventListener('activate', (event) => event.waitUntil((async () => {
  const keys = await caches.keys();
  await Promise.all(keys.filter((key) => key.startsWith('agentcorps-console-') && key !== CACHE).map((key) => caches.delete(key)));
  await self.clients.claim();
})()));

// Cache only the application shell and hashed assets, never gateway data or tokens.
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== ROOT.origin || event.request.headers.has('authorization')) return;
  if (event.request.mode === 'navigate' && (url.pathname === ROOT.pathname || url.href === SHELL)) {
    event.respondWith(fetch(event.request).catch(() => caches.match(SHELL)));
  } else if (url.pathname.startsWith(ASSETS) || url.href === MANIFEST) {
    // Vite/static hosts may send Vary: Origin. Anonymous module requests carry
    // Origin while cache.addAll does not; hashed same-origin assets are identical.
    event.respondWith(caches.match(event.request, { ignoreVary: true }).then((cached) => cached || fetch(event.request)));
  }
});
