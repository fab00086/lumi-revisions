// Service worker Lumi : rend l'app INSTALLABLE (PWA) et rapide a ouvrir.
// Cache l'interface ; les appels /api/* passent toujours par le reseau.
'use strict';

const CACHE = 'lumi-v14';
const SHELL = [
  '/',
  '/index.html',
  '/app.js',
  '/style.css',
  '/manifest.json',
  '/sound-check.wav',
  '/audio-ready.wav',
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

  // Les correctifs de l'interface doivent arriver dès la prochaine ouverture.
  // Le cache ne sert de secours que si le réseau est réellement indisponible.
  if (url.origin === location.origin &&
      (e.request.mode === 'navigate' || ['/app.js', '/style.css', '/index.html', '/'].includes(url.pathname))) {
    e.respondWith(fetch(e.request).then(async r => {
      if (r.ok) {
        const c = await caches.open(CACHE);
        await c.put(e.request, r.clone());
      }
      return r;
    }).catch(async () => {
      const hit = await caches.match(e.request, { ignoreSearch: true });
      return hit || new Response('Lumi est hors ligne. Reconnecte-toi puis recharge la page.',
        { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    }));
    return;
  }

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
