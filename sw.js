/* České vtipy – service worker: makes the app installable and work offline. */
const VERSION = 'vtipy-v5';
const SHELL = [
  './', 'index.html', 'styles.css?v=5', 'app.js?v=5', 'config.js?v=5', 'manifest.webmanifest', 'favicon.ico',
  'icons/logo-64.png', 'icons/icon-192.png',
  'fonts/big-shoulders-display-latin-600-normal.woff2', 'fonts/big-shoulders-display-latin-800-normal.woff2',
  'fonts/big-shoulders-display-latin-900-normal.woff2', 'fonts/big-shoulders-display-latin-ext-600-normal.woff2',
  'fonts/big-shoulders-display-latin-ext-800-normal.woff2', 'fonts/big-shoulders-display-latin-ext-900-normal.woff2',
  'fonts/literata-latin-opsz-normal.woff2', 'fonts/literata-latin-ext-opsz-normal.woff2',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// Same-origin files: serve from cache, refresh in the background. The jokes come from the
// backend and are cached by the page itself, so other origins are left alone.
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith(caches.open(VERSION).then(async (cache) => {
    const hit = await cache.match(e.request, { ignoreSearch: true });
    const net = fetch(e.request).then((res) => { if (res.ok) cache.put(e.request, res.clone()); return res; }).catch(() => hit);
    return hit || net;
  }));
});
