// Service worker Lumi : rend l'app INSTALLABLE (PWA) et rapide a ouvrir.
// Cache l'interface ; les appels /api/* passent toujours par le reseau.
'use strict';

const CACHE = 'lumi-v1';
const SHELL = [
  '/',
  '/index.html',
  '/app.js',
  '/style.css',
  '/manifest.json',
  '/icon.svg',
  '/icon-192.png',
  '/icon-512.png',
  '/katex/katex.min.css',
  '/katex/katex.min.js',
  '/katex/fonts/KaTeX_Main-Regular.woff2',
  '/katex/fonts/KaTeX_Main-Regular.woff',
  '/katex/fonts/KaTeX_Math-Italic.woff2',
  '/katex/fonts/KaTeX_Size1-Regular.woff2',
  '/katex/fonts/KaTeX_Size2-Regular.woff2',
  '/katex/fonts/KaTeX_Size3-Regular.woff2',
  '/katex/fonts/KaTeX_Size4-Regular.woff2'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then(c => Promise.allSettled(SHELL.map(u => c.add(u))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  // L'IA, les donnees et le quiz : toujours le reseau, jamais de cache
  if (url.pathname.startsWith('/api/')) return;
  if (e.request.method !== 'GET') return;

  // Interface : cache d'abord (ouverture instantanee), reseau ensuite
  e.respondWith(
    caches.match(e.request, { ignoreSearch: true }).then(hit => {
      const net = fetch(e.request).then(r => {
        if (r && r.ok && url.origin === location.origin) {
          const copy = r.clone();
          caches.open(CACHE).then(c => c.put(e.request, copy));
        }
        return r;
      }).catch(() => hit);
      return hit || net;
    })
  );
});