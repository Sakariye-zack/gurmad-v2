// Customer Portal Mobile App — Implementation Spec §11. Minimal service
// worker, existing ONLY to make the Customer Portal installable as a PWA.
//
// Deliberately does NOT cache any API response. Every fetch to
// /api/v2/customer-portal/* (or anywhere else) passes straight through to
// the network — this is a structural, not just documented, guarantee: the
// fetch handler below only intercepts requests whose URL matches the
// static app-shell precache list; every other request is left completely
// unhandled (falls through to the browser's normal network fetch).
//
// "Do not cache sensitive financial/customer data offline unless
// explicitly approved" — nothing was approved, so nothing beyond the
// static shell is cached.

const CACHE_NAME = 'gurmad-portal-shell-v1';
const APP_SHELL_URLS = [
  '/portal',
  '/manifest.webmanifest',
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

  // Never intercept API calls or anything outside the static shell list —
  // this is the enforcement of "app-shell caching only," not a comment.
  if (url.pathname.startsWith('/api/')) return;
  if (!APP_SHELL_URLS.includes(url.pathname)) return;

  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request))
  );
});
