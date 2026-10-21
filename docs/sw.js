/* Centinela-IA SST · SkyNet Genesis · contacto@skynetgenesis.com · WhatsApp 304 437 5758
   Permite instalar la aplicación en el celular. Los datos siempre se piden al servidor; solo se guarda la pantalla. */
const CACHE = 'centinela-ia-v5';
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(['./', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png'])).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin) return; // el servidor de datos y Bold no se guardan
  e.respondWith(fetch(e.request).then(r => { if (r.ok) { const c = r.clone(); caches.open(CACHE).then(k => k.put(e.request, c)); } return r; })
    .catch(() => caches.match(e.request).then(r => r || (e.request.mode === 'navigate' ? caches.match('./') : Response.error()))));
});
