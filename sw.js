/* Huelle aus dem Cache, Daten immer frisch. Bei jedem Deploy V hochzaehlen. */
const V = 'sparplan-v3';
const HUELLE = ['./', './index.html', './assets/style.css', './assets/app.js',
                './assets/holo-core.js', './manifest.webmanifest'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(V).then(c => c.addAll(HUELLE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(k => Promise.all(k.filter(x => x !== V).map(x => caches.delete(x))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin) return;

  // Daten: Netz zuerst, Cache nur als Rettung bei Funkloch.
  if (u.pathname.includes('/data/')) {
    e.respondWith(
      fetch(e.request)
        .then(r => { const c = r.clone(); caches.open(V).then(x => x.put(e.request, c)); return r; })
        .catch(() => caches.match(e.request))
    );
    return;
  }

  // Huelle: Cache zuerst, im Hintergrund erneuern.
  e.respondWith(caches.match(e.request).then(hit => hit || fetch(e.request)));
});
