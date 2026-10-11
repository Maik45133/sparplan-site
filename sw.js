/* Netz zuerst, Cache nur als Rettung ohne Empfang.
   So zeigt das iPhone nach jedem Push sofort den neuen Stand, ohne dass hier
   jemand eine Versionsnummer hochzählen muss. */
const V = 'bullnet-v23';
const HUELLE = ['./', './index.html', './assets/style.css', './assets/app.js', './manifest.webmanifest', './assets/icon-192.png', './assets/apple-touch-icon.png'];

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
  e.respondWith(
    fetch(e.request, { cache: 'no-cache' })
      .then(r => { if (r.ok) { const c = r.clone(); caches.open(V).then(x => x.put(e.request, c)); } return r; })
      .catch(() => caches.match(e.request).then(hit => hit || caches.match('./index.html')))
  );
});
