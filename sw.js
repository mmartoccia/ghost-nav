// Ghost Nav Service Worker — v2 (GHOST-PUSH-ALERTS)
const CACHE_NAME = 'ghost-nav-v2';
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

// ─── Push Notifications (GHOST-PUSH-ALERTS) ──────────────────────────────────

self.addEventListener('push', event => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch (e) {
    payload = { title: 'Ghost Alert', body: event.data ? event.data.text() : 'Camera nearby' };
  }

  const title = payload.title || '👻 Ghost — Camera Alert';
  const options = {
    body: payload.body || 'ALPR camera detected nearby',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    tag: payload.camera_id || 'ghost-camera-alert',
    renotify: true,
    requireInteraction: false,
    silent: payload.silent || false,
    data: payload,
    actions: [
      { action: 'view', title: '🗺️ View Map' },
      { action: 'dismiss', title: 'Dismiss' },
    ],
  };

  event.waitUntil(
    self.registration.showNotification(title, options)
  );
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  if (event.action === 'dismiss') return;

  // Focus or open the app
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clientList => {
      for (const client of clientList) {
        if (client.url.includes(self.location.origin) && 'focus' in client) {
          return client.focus();
        }
      }
      if (clients.openWindow) {
        return clients.openWindow('/');
      }
    })
  );
});

// ─── Message from app: show local notification directly ──────────────────────
self.addEventListener('message', event => {
  if (event.data && event.data.type === 'SHOW_CAMERA_ALERT') {
    const payload = event.data.payload || {};
    const title = payload.title || '👻 Ghost — Camera Alert';
    const options = {
      body: payload.body || 'ALPR camera detected nearby',
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      tag: payload.camera_id || 'ghost-camera-alert',
      renotify: true,
      requireInteraction: false,
      silent: payload.silent || false,
      data: payload,
      actions: [
        { action: 'view', title: '🗺️ View Map' },
        { action: 'dismiss', title: 'Dismiss' },
      ],
    };
    self.registration.showNotification(title, options);
  }
});
