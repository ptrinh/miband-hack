// Precaches the whole site when installed, so the page and the demo apps open offline from the first visit.
// The build fills in VERSION (a hash of dist) and PRECACHE (every file in dist): each deploy is a new service
// worker with its own cache, and the old cache is dropped when it takes over. Online, requests still go to the
// network first so the page is always fresh. /api/* (Xiaomi key lookup) is never cached.
const VERSION = 'dev';
const PRECACHE = [];
const CACHE = `miband-hack-${VERSION}`;

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(['./', ...PRECACHE].map((p) => new Request(p, { cache: 'reload' }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  // Hashed build files never change: serve them from the cache. ignoreVary: the page asks for them with an
  // Origin header (crossorigin) that the precache request did not send, and the server answers Vary: Origin.
  if (url.pathname.startsWith('/assets/')) {
    e.respondWith(caches.match(e.request, { ignoreVary: true }).then((r) => r || fetch(e.request)));
    return;
  }
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return res;
      })
      .catch(() =>
        // ?companion=ios and the like are the same page.
        caches.match(e.request, { ignoreVary: true, ignoreSearch: e.request.mode === 'navigate' })
          .then((r) => r || (e.request.mode === 'navigate' ? caches.match('./', { ignoreVary: true }) : Response.error())),
      ),
  );
});
