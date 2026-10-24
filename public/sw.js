// Service worker Savika : rend l'app INSTALLABLE (PWA) et rapide a ouvrir.
// Cache l'interface ; les appels /api/* passent toujours par le reseau.
'use strict';

const CACHE = 'lumi-v75';
const SHELL = [
  '/',
  '/index.html',
  '/app',
  '/app/',
  '/app/index.html',
  '/app.js',
  '/app/app.js',
  '/update.js',
  '/app/update.js',
  '/style.css',
  '/app/style.css',
  '/manifest.json',
  '/app/manifest.json',
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
    // Un fichier après l'autre : evite les rafales de requetes qui declenchent
    // la protection anti-flood de l'hebergeur (erreurs 429 sur les ressources).
    caches.open(CACHE)
      .then(async c => { for (const u of SHELL) { try { await c.add(u); } catch {} } })
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
  if (url.pathname.startsWith('/profs')) {
    e.respondWith(fetch(e.request).catch(async () => (await caches.match(e.request, { ignoreSearch: true })) || new Response('Hors ligne', { status: 503 })));
    return;
  }
  if (e.request.method !== 'GET') return;
  // Opening Admin must reach the server to require a fresh password.
  if (url.origin === location.origin && ['/admin', '/admin.html'].includes(url.pathname)) {
    e.respondWith(fetch(e.request));
    return;
  }

  // Les correctifs de l'interface doivent arriver dès la prochaine ouverture.
  // Le cache ne sert de secours que si le réseau est réellement indisponible.
  if (url.origin === location.origin &&
      (e.request.mode === 'navigate' || ['/app.js', '/update.js', '/admin.js', '/admin.html', '/style.css', '/index.html', '/', '/app', '/app/', '/app/index.html', '/app/app.js', '/app/update.js', '/app/style.css'].includes(url.pathname))) {
    e.respondWith(fetch(e.request).then(async r => {
      if (r.ok) {
        const c = await caches.open(CACHE);
        await c.put(e.request, r.clone());
      }
      return r;
    }).catch(async () => {
      const hit = await caches.match(e.request, { ignoreSearch: true })
        || await caches.match('/app')
        || await caches.match('/app/')
        || await caches.match('/index.html');
      return hit || new Response('Savika est hors ligne. Reconnecte-toi puis recharge la page.',
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
