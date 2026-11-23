// Lets the app be installed on phones and open quickly. Always tries the network first, so updates show up
// right away; the saved copy is only used to open the app when the connection drops. Data is never cached.
const CACHE = 'reorder-shell-v8';
self.addEventListener('install', e => { self.skipWaiting(); e.waitUntil(caches.open(CACHE).then(c => c.addAll(['./', 'index.html', 'app.js', 'config.js', 'manifest.webmanifest', 'icon-192.png', 'mark.svg', 'fonts.css', 'suite.css', 'fields.css']).catch(() => {}))); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if(e.request.method !== 'GET' || u.origin !== location.origin) return;     // API, sign-in and drug lookups go straight to the network
  e.respondWith(fetch(e.request).then(r => { if(r.ok){ const c = r.clone(); caches.open(CACHE).then(x => x.put(e.request, c)); } return r; })
    .catch(() => caches.match(e.request).then(r => r || caches.match('index.html'))));
});
