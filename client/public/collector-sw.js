// Field Collector Mobile — Implementation Spec §19. Mirrors the exact
// architectural discipline of the existing Customer Portal precedent
// (public/sw.js) — a separate, staff-app-scoped service worker, not a
// modification of that file. Deliberately does NOT cache any API response.
// Every fetch to /api/v2/* (or anywhere else) passes straight through to
// the network — a structural, not just documented, guarantee: the fetch
// handler below only intercepts requests matching the static app-shell
// precache list; every other request is left completely unhandled.

// v2: the old cache-first shell served a stale /collector page (old manifest + icons)
// forever, so installs kept the old home-screen icon. Bumping the name purges it on activate.
const CACHE_NAME = 'gurmad-collector-shell-v2';
const APP_SHELL_URLS = [
  '/collector',
  '/collector-manifest.webmanifest',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL_URLS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  // Only intercept exact app-shell URLs — never /api/v2/*, never a JWT,
  // never customer/financial/sync-payload content, structurally.
  if (APP_SHELL_URLS.includes(url.pathname)) {
    event.respondWith(
      // network-first: always the latest shell/manifest when online, cache only as the offline fallback
      fetch(event.request)
        .then((res) => { const copy = res.clone(); caches.open(CACHE_NAME).then((c) => c.put(event.request, copy)).catch(() => {}); return res; })
        .catch(() => caches.match(event.request))
    );
  }
  // Every other request: no event.respondWith() call at all — falls
  // through to the browser's normal network fetch, untouched.
});
