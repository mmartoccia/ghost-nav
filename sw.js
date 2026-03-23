// Ghost Nav Service Worker
const CACHE_NAME = 'ghost-nav-v1';
const APP_SHELL = [
  '/',
  '/index.html',
  '/manifest.json',
  '/icon-192.png',
];

// API hosts that should use network-first strategy
const API_HOSTS = [
  'overpass-api.de',
  'router.project-osrm.org',
  'nominatim.openstreetmap.org',
  'geocoding.geo.census.gov',
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      return cache.addAll(APP_SHELL);
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Network-first for API calls (Overpass, OSRM, proxies)
  const isApiCall = API_HOSTS.some(h => url.hostname === h) ||
                    url.pathname.startsWith('/api/') ||
                    url.pathname.startsWith('/proxy/');

  if (isApiCall) {
    event.respondWith(
      fetch(event.request)
        .then(response => {
          // Cache successful API responses as fallback
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
          }
          return response;
        })
        .catch(() => caches.match(event.request))
    );
    return;
  }

  // Cache-first for app shell
  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;
      return fetch(event.request).then(response => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return response;
      });
    })
  );
});
