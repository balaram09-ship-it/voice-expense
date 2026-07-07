/* Voice Expense — app-shell cache so the PWA opens with no network. */

const CACHE = 've-shell-v3';
const SHELL = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (ev) => {
  ev.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (ev) => {
  ev.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (ev) => {
  // Never intercept API posts — only cache same-origin GETs for the shell.
  if (ev.request.method !== 'GET') return;
  ev.respondWith(
    caches.match(ev.request).then((hit) => hit || fetch(ev.request))
  );
});
