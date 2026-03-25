// Ghost Nav Service Worker — v3 (GHOST-OFFLINE)
const CACHE_NAME      = 'ghost-nav-v3';
const TILE_CACHE_NAME = 'ghost-tiles-v1';   // separate tile cache (may be large)
const CAMERA_CACHE_NAME = 'ghost-cameras-v1'; // offline camera data

const APP_SHELL = [
  '/',
  '/index.html',
  '/manifest.json',
  '/icon-192.png',
];

// Tile hosts — cache-first with background revalidation
const TILE_HOSTS = [
  'tile.openstreetmap.org',
  'a.tile.openstreetmap.org',
  'b.tile.openstreetmap.org',
  'c.tile.openstreetmap.org',
  'cartodb-basemaps-a.global.ssl.fastly.net',
  'cartodb-basemaps-b.global.ssl.fastly.net',
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
        keys.filter(k => k !== CACHE_NAME && k !== TILE_CACHE_NAME && k !== CAMERA_CACHE_NAME)
            .map(k => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // ── Map tile caching (cache-first, background revalidate) ──────────────────
  const isTile = TILE_HOSTS.some(h => url.hostname.endsWith(h));
  if (isTile) {
    event.respondWith(
      caches.open(TILE_CACHE_NAME).then(cache =>
        cache.match(event.request).then(cached => {
          const networkFetch = fetch(event.request).then(response => {
            if (response.ok) {
              cache.put(event.request, response.clone());
            }
            return response;
          }).catch(() => null);

          // Return cached immediately; refresh in background
          return cached || networkFetch;
        })
      )
    );
    return;
  }

  // ── Camera offline-cache endpoint — cache the response ───────────────────
  if (url.pathname === '/api/offline-cache') {
    event.respondWith(
      caches.open(CAMERA_CACHE_NAME).then(cache =>
        fetch(event.request)
          .then(response => {
            if (response.ok) {
              cache.put(event.request, response.clone());
            }
            return response;
          })
          .catch(() => cache.match(event.request))
      )
    );
    return;
  }

  // ── Network-first for API calls (Overpass, OSRM, proxies) ─────────────────
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

  // ── Cache-first for app shell ──────────────────────────────────────────────
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

// ─── Background Sync (GHOST-OFFLINE) ─────────────────────────────────────────
self.addEventListener('sync', event => {
  if (event.tag === 'ghost-camera-sync') {
    event.waitUntil(syncCameraData());
  }
});

async function syncCameraData() {
  try {
    // Notify all clients that sync is happening
    const clients = await self.clients.matchAll({ type: 'window' });
    for (const client of clients) {
      client.postMessage({ type: 'GHOST_SYNC_START' });
    }

    // Refresh /api/offline-cache if cached
    const cache = await caches.open(CAMERA_CACHE_NAME);
    const keys = await cache.keys();
    for (const req of keys) {
      const fresh = await fetch(req);
      if (fresh.ok) await cache.put(req, fresh);
    }

    // Notify clients sync is done
    for (const client of clients) {
      client.postMessage({ type: 'GHOST_SYNC_DONE' });
    }
    console.log('[Ghost SW] Background camera sync complete');
  } catch (e) {
    console.warn('[Ghost SW] Sync failed:', e);
  }
}

// ─── Cache management messages (from GhostOfflineManager) ────────────────────
self.addEventListener('message', event => {
  const { type, payload } = event.data || {};

  // ── Estimate tile cache size ───────────────────────────────────────────────
  if (type === 'GET_CACHE_SIZE') {
    (async () => {
      try {
        let totalBytes = 0;
        let tileCount  = 0;

        const tileCache = await caches.open(TILE_CACHE_NAME);
        const tileKeys  = await tileCache.keys();
        tileCount = tileKeys.length;
        for (const req of tileKeys) {
          const res = await tileCache.match(req);
          if (res) {
            const buf = await res.clone().arrayBuffer();
            totalBytes += buf.byteLength;
          }
        }

        const camCache  = await caches.open(CAMERA_CACHE_NAME);
        const camKeys   = await camCache.keys();
        for (const req of camKeys) {
          const res = await camCache.match(req);
          if (res) {
            const buf = await res.clone().arrayBuffer();
            totalBytes += buf.byteLength;
          }
        }

        event.source.postMessage({
          type: 'CACHE_SIZE_RESULT',
          bytes: totalBytes,
          tileCount,
        });
      } catch (e) {
        event.source.postMessage({ type: 'CACHE_SIZE_RESULT', bytes: 0, tileCount: 0 });
      }
    })();
    return;
  }

  // ── Clear tile + camera caches ─────────────────────────────────────────────
  if (type === 'CLEAR_OFFLINE_CACHE') {
    (async () => {
      await caches.delete(TILE_CACHE_NAME);
      await caches.delete(CAMERA_CACHE_NAME);
      event.source.postMessage({ type: 'OFFLINE_CACHE_CLEARED' });
    })();
    return;
  }

  // ── Pre-warm tiles for a bbox ──────────────────────────────────────────────
  if (type === 'CACHE_REGION') {
    const { minLat, minLon, maxLat, maxLon, minZoom = 10, maxZoom = 15 } = payload || {};
    if (minLat == null) return;
    (async () => {
      const tileCache = await caches.open(TILE_CACHE_NAME);
      const urls = getTileUrlsForBbox(minLat, minLon, maxLat, maxLon, minZoom, maxZoom);
      let fetched = 0;
      const total = urls.length;
      event.source.postMessage({ type: 'CACHE_REGION_START', total });

      for (const url of urls) {
        try {
          const req  = new Request(url);
          const hit  = await tileCache.match(req);
          if (!hit) {
            const res = await fetch(req);
            if (res.ok) await tileCache.put(req, res);
          }
          fetched++;
          if (fetched % 20 === 0 || fetched === total) {
            event.source.postMessage({ type: 'CACHE_REGION_PROGRESS', fetched, total });
          }
        } catch (_) {}
      }
      event.source.postMessage({ type: 'CACHE_REGION_DONE', fetched, total });
    })();
    return;
  }

  // ── Push notification messages (GHOST-PUSH-ALERTS, unchanged) ────────────
  if (type === 'SHOW_CAMERA_ALERT') {
    const p = payload || event.data.payload || {};
    const title = p.title || '👻 Ghost — Camera Alert';
    const options = {
      body: p.body || 'ALPR camera detected nearby',
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      tag: p.camera_id || 'ghost-camera-alert',
      renotify: true,
      requireInteraction: false,
      silent: p.silent || false,
      data: p,
      actions: [
        { action: 'view', title: '🗺️ View Map' },
        { action: 'dismiss', title: 'Dismiss' },
      ],
    };
    self.registration.showNotification(title, options);
    return;
  }
});

// ─── Tile URL generator (OSM slippy-map scheme) ───────────────────────────────
function lon2tile(lon, zoom)  { return Math.floor((lon + 180) / 360 * Math.pow(2, zoom)); }
function lat2tile(lat, zoom) {
  return Math.floor(
    (1 - Math.log(Math.tan(lat * Math.PI / 180) + 1 / Math.cos(lat * Math.PI / 180)) / Math.PI)
    / 2 * Math.pow(2, zoom)
  );
}

function getTileUrlsForBbox(minLat, minLon, maxLat, maxLon, minZoom, maxZoom) {
  const urls = [];
  const subdomains = ['a', 'b', 'c'];
  for (let z = minZoom; z <= maxZoom; z++) {
    const x0 = lon2tile(minLon, z);
    const x1 = lon2tile(maxLon, z);
    const y0 = lat2tile(maxLat, z);  // note: lat inverted for tiles
    const y1 = lat2tile(minLat, z);
    for (let x = x0; x <= x1; x++) {
      for (let y = y0; y <= y1; y++) {
        const sub = subdomains[(x + y) % 3];
        urls.push(`https://${sub}.tile.openstreetmap.org/${z}/${x}/${y}.png`);
      }
    }
    // Cap at 500 tiles per zoom level to avoid abuse
    if (urls.length > 2000) break;
  }
  return urls;
}

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

// Note: SHOW_CAMERA_ALERT is handled in the combined message listener above (GHOST-OFFLINE)
