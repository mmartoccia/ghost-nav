/**
 * Ghost — Privacy-Aware Navigation
 * app.js — All application logic
 *
 * Tech: Leaflet.js + OSRM demo server + OpenStreetMap Overpass API
 *       Geocoding: Nominatim (free, no API key required)
 */

'use strict';

// ─── Constants ───────────────────────────────────────────────────────────────

const SUMMERVILLE         = [33.0185, -80.1762];
const OSRM_BASE           = '/proxy/osrm/route/v1/driving';
const OSRM_NEAREST_BASE   = '/proxy/osrm/nearest/v1/driving';
const OVERPASS_URL        = '/proxy/overpass';
const NOMINATIM_BASE      = '/proxy/nominatim';
const CAMERA_PROXIMITY_M  = 50;    // meters — camera "on route" threshold
const GEOCODE_DEBOUNCE    = 300;   // ms
const CLUSTER_RADIUS_M    = 200;   // cameras within this distance share a cluster
const GHOST_AVOIDANCE_M   = 320;   // perpendicular offset for avoidance waypoints (m)
const MAX_GHOST_WAYPOINTS = 5;     // cap to avoid OSRM failures
const GHOST_TIME_WARNING  = 2.0;   // warn if ghost route > this × fastest duration

const ROUTE_COLORS = {
  fastest: { color: '#3b82f6', weight: 6, opacity: 0.9 },
  ghost:   { color: '#22c55e', weight: 6, opacity: 0.9 },
  alt:     { color: '#94a3b8', weight: 4, opacity: 0.55 },
};

// ─── State ────────────────────────────────────────────────────────────────────

let map;
let startMarker    = null;
let endMarker      = null;
let startCoords    = null; // { lat, lng }
let endCoords      = null; // { lat, lng }
let cameras        = [];
let cameraMarkers  = [];
let routeLayers    = [];   // { id, layer, type, rank }
let activeRouteId  = null;
let preferGhost    = localStorage.getItem('ghost-prefer-ghost') === 'true';

// ─── Map init ─────────────────────────────────────────────────────────────────

function initMap() {
  map = L.map('map', {
    center: SUMMERVILLE,
    zoom: 13,
    zoomControl: true,
  });

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© <a href="https://openstreetmap.org">OpenStreetMap</a> contributors',
    maxZoom: 19,
  }).addTo(map);

  map.on('moveend zoomend', debounce(fetchCameras, 600));
  setTimeout(fetchCameras, 800);
}

// ─── Geocoding (Nominatim) ────────────────────────────────────────────────────

async function geocodeSearch(query) {
  const nominatimParams = new URLSearchParams({
    q:              query,
    format:         'json',
    addressdetails: '1',
    limit:          '5',
    countrycodes:   'us',
  });

  try {
    const resp = await fetch(`${NOMINATIM_BASE}?${nominatimParams.toString()}`);
    if (resp.ok) {
      const results = await resp.json();
      if (results.length > 0) return results;
    }
  } catch (err) {
    console.warn('[Geocode] Nominatim failed:', err);
  }

  // Fallback: US Census geocoder
  const censusParams = new URLSearchParams({
    address:   query,
    benchmark: 'Public_AR_Current',
    format:    'json',
  });

  try {
    const resp = await fetch(`/proxy/census?${censusParams.toString()}`);
    if (resp.ok) {
      const data = await resp.json();
      const matches = data?.result?.addressMatches || [];
      return matches.map(m => ({
        display_name: m.matchedAddress,
        lat: String(m.coordinates.y),
        lon: String(m.coordinates.x),
        address: {
          road:         m.addressComponents?.streetName || '',
          house_number: m.addressComponents?.fromAddress || '',
          city:         m.addressComponents?.city || '',
          state:        m.addressComponents?.state || '',
          postcode:     m.addressComponents?.zip || '',
        },
        type: 'census',
      }));
    }
  } catch (err) {
    console.warn('[Geocode] Census failed:', err);
  }

  return [];
}

function formatNominatimResult(result) {
  const addr = result.address || {};
  let primary = result.name || result.display_name.split(',')[0].trim();
  let secondary = [];

  if (addr.road) secondary.push(addr.road);
  if (addr.city || addr.town || addr.village) {
    secondary.push(addr.city || addr.town || addr.village);
  }
  if (addr.state) secondary.push(addr.state);

  if (addr.house_number && addr.road && primary === addr.road) {
    primary = `${addr.house_number} ${addr.road}`;
  }

  return {
    name:    primary,
    address: secondary.filter(Boolean).join(', '),
    lat:     parseFloat(result.lat),
    lng:     parseFloat(result.lon),
    display: result.display_name,
  };
}

// ─── Search input setup ───────────────────────────────────────────────────────

function setupSearchInput(inputId, dropdownId, onSelect) {
  const input    = document.getElementById(inputId);
  const dropdown = document.getElementById(dropdownId);

  let debounceTimer  = null;
  let currentResults = [];
  let focusedIdx     = -1;

  function showDropdown(items) {
    dropdown.innerHTML = '';
    focusedIdx = -1;

    if (!items) {
      dropdown.innerHTML = `
        <div class="dropdown-searching">
          <div class="mini-spinner"></div>
          Searching…
        </div>`;
      dropdown.classList.remove('hidden');
      return;
    }

    if (items.length === 0) {
      dropdown.innerHTML = `<div class="dropdown-no-results">No results found</div>`;
      dropdown.classList.remove('hidden');
      return;
    }

    items.forEach((item, i) => {
      const el = document.createElement('div');
      el.className = 'dropdown-item';
      el.innerHTML = `
        <div class="dropdown-item-name">${escHtml(item.name)}</div>
        ${item.address ? `<div class="dropdown-item-address">${escHtml(item.address)}</div>` : ''}
      `;
      el.addEventListener('mousedown', (e) => {
        e.preventDefault();
        selectResult(item);
      });
      dropdown.appendChild(el);
    });

    dropdown.classList.remove('hidden');
    currentResults = items;
  }

  function hideDropdown() {
    dropdown.classList.add('hidden');
    focusedIdx = -1;
  }

  function selectResult(item) {
    input.value = item.address ? `${item.name}, ${item.address}` : item.name;
    input.classList.add('has-value');
    hideDropdown();
    onSelect(item);
  }

  function moveFocus(delta) {
    const items = dropdown.querySelectorAll('.dropdown-item');
    if (!items.length) return;
    items[focusedIdx]?.classList.remove('focused');
    focusedIdx = Math.max(0, Math.min(items.length - 1, focusedIdx + delta));
    items[focusedIdx]?.classList.add('focused');
  }

  input.addEventListener('input', () => {
    const q = input.value.trim();
    input.classList.remove('has-value');
    if (!q) { hideDropdown(); return; }
    showDropdown(null);
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(async () => {
      try {
        const raw     = await geocodeSearch(q);
        const results = raw.map(formatNominatimResult);
        showDropdown(results);
      } catch (err) {
        console.warn('[Search] Geocode error:', err);
        showDropdown([]);
      }
    }, GEOCODE_DEBOUNCE);
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault(); moveFocus(1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault(); moveFocus(-1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const items = dropdown.querySelectorAll('.dropdown-item');
      if (focusedIdx >= 0 && items[focusedIdx]) selectResult(currentResults[focusedIdx]);
      else if (currentResults.length > 0) selectResult(currentResults[0]);
    } else if (e.key === 'Escape') {
      hideDropdown();
    }
  });

  input.addEventListener('blur', () => setTimeout(hideDropdown, 150));

  return {
    reset() {
      input.value = '';
      input.classList.remove('has-value');
      hideDropdown();
    },
    setValue(text) {
      input.value = text;
      input.classList.add('has-value');
      hideDropdown();
    },
  };
}

// ─── Marker placement ─────────────────────────────────────────────────────────

function placeStartMarker(lat, lng) {
  if (startMarker) map.removeLayer(startMarker);
  startMarker = L.marker([lat, lng], { icon: pinIcon('#22c55e', 'S') })
    .addTo(map)
    .bindPopup('<div class="popup-title">🟢 Start</div>');
  startCoords = { lat, lng };
}

function placeEndMarker(lat, lng) {
  if (endMarker) map.removeLayer(endMarker);
  endMarker = L.marker([lat, lng], { icon: pinIcon('#ef4444', 'E') })
    .addTo(map)
    .bindPopup('<div class="popup-title">🔴 End</div>');
  endCoords = { lat, lng };
}

// ─── Custom marker icons ──────────────────────────────────────────────────────

function pinIcon(color, letter) {
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="28" height="36" viewBox="0 0 28 36">
      <path d="M14 0C6.268 0 0 6.268 0 14c0 9.333 14 22 14 22S28 23.333 28 14C28 6.268 21.732 0 14 0z"
            fill="${color}" stroke="rgba(0,0,0,0.3)" stroke-width="1.5"/>
      <circle cx="14" cy="14" r="7" fill="rgba(0,0,0,0.25)"/>
      <text x="14" y="19" text-anchor="middle" font-family="system-ui,sans-serif"
            font-size="10" font-weight="700" fill="white">${letter}</text>
    </svg>`;
  return L.divIcon({
    html:       svg,
    className:  '',
    iconSize:   [28, 36],
    iconAnchor: [14, 36],
    popupAnchor:[0, -36],
  });
}

function cameraIcon(direction) {
  const arrow = direction != null ? arrowSvg(direction) : '';
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 20 20">
      <circle cx="10" cy="10" r="8" fill="#ef4444" stroke="rgba(0,0,0,0.4)" stroke-width="1.5"
              fill-opacity="0.85"/>
      <text x="10" y="14" text-anchor="middle" font-size="10" fill="white">📷</text>
      ${arrow}
    </svg>`;
  return L.divIcon({
    html:       svg,
    className:  '',
    iconSize:   [20, 20],
    iconAnchor: [10, 10],
    popupAnchor:[0, -12],
  });
}

function arrowSvg(bearing) {
  const rad = (bearing - 90) * Math.PI / 180;
  const r   = 13;
  const x   = 10 + r * Math.cos(rad);
  const y   = 10 + r * Math.sin(rad);
  return `<line x1="10" y1="10" x2="${x.toFixed(1)}" y2="${y.toFixed(1)}"
                stroke="white" stroke-width="1.5" stroke-linecap="round" opacity="0.8"/>`;
}

// ─── Overpass camera fetch ────────────────────────────────────────────────────

async function fetchCameras() {
  const bounds = map.getBounds();
  const s = bounds.getSouth().toFixed(5);
  const w = bounds.getWest().toFixed(5);
  const n = bounds.getNorth().toFixed(5);
  const e = bounds.getEast().toFixed(5);

  const query = `[out:json][timeout:30];
node["man_made"="surveillance"]["surveillance:type"="ALPR"](${s},${w},${n},${e});
out body;`;

  try {
    const resp = await fetch(OVERPASS_URL, {
      method:  'POST',
      body:    'data=' + encodeURIComponent(query),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    if (!resp.ok) throw new Error(`Overpass HTTP ${resp.status}`);
    const data = await resp.json();
    processCameras(data.elements || []);
  } catch (err) {
    console.warn('Overpass fetch failed:', err);
  }
}

function processCameras(elements) {
  cameraMarkers.forEach(m => map.removeLayer(m));
  cameraMarkers = [];

  cameras = elements.map(el => ({
    lat:  el.lat,
    lon:  el.lon,
    id:   el.id,
    tags: el.tags || {},
  }));

  cameras.forEach(cam => {
    const bearing = parseBearing(cam.tags.direction || cam.tags['camera:direction']);
    const marker  = L.marker([cam.lat, cam.lon], { icon: cameraIcon(bearing) })
      .addTo(map)
      .on('click', () => showCameraDetail(cam));

    const mfr   = cam.tags.manufacturer    || cam.tags.brand                    || 'Unknown';
    const op    = cam.tags.operator        || cam.tags['operator:short']         || 'Unknown';
    const dir   = cam.tags.direction       || cam.tags['camera:direction']       || 'Unknown';
    const model = cam.tags['camera:model'] || cam.tags.model                    || '';

    marker.bindPopup(`
      <div class="popup-title">📷 ALPR Camera</div>
      <div class="popup-row"><span>Manufacturer:</span><strong>${escHtml(mfr)}</strong></div>
      <div class="popup-row"><span>Operator:</span><strong>${escHtml(op)}</strong></div>
      <div class="popup-row"><span>Direction:</span><strong>${escHtml(dir)}</strong></div>
      ${model ? `<div class="popup-row"><span>Model:</span><strong>${escHtml(model)}</strong></div>` : ''}
    `);

    cameraMarkers.push(marker);
  });

  const badge = document.getElementById('camera-count-badge');
  const num   = document.getElementById('camera-count-num');
  num.textContent = cameras.length;
  badge.classList.toggle('hidden', cameras.length === 0);
}

function parseBearing(val) {
  if (!val) return null;
  const compass = { N:0, NNE:22.5, NE:45, ENE:67.5, E:90, ESE:112.5, SE:135,
    SSE:157.5, S:180, SSW:202.5, SW:225, WSW:247.5, W:270, WNW:292.5, NW:315, NNW:337.5 };
  const upper = String(val).trim().toUpperCase();
  if (compass[upper] !== undefined) return compass[upper];
  const n = parseFloat(val);
  return isNaN(n) ? null : n;
}

// ─── OSRM routing ─────────────────────────────────────────────────────────────

async function fetchRoutes() {
  showPanel('loading');
  setHint('⏳ Fetching routes…');

  const s = startCoords;
  const e = endCoords;

  const url = `${OSRM_BASE}/${s.lng},${s.lat};${e.lng},${e.lat}` +
              `?overview=full&geometries=geojson&alternatives=3`;

  try {
    console.log('[OSRM] Fetching routes:', url);
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`OSRM HTTP ${resp.status}`);
    const data = await resp.json();
    console.log('[OSRM] Response:', data.code, 'routes:', data.routes?.length);

    if (data.code !== 'Ok' || !data.routes?.length) {
      throw new Error(data.message || 'No routes returned');
    }

    await processRoutes(data.routes);
  } catch (err) {
    console.error('[OSRM] Error:', err);
    showError('Could not fetch routes. Check your connection or try different points.');
  }
}

async function processRoutes(routes) {
  clearRouteLayers();
  console.log('[Routes] Processing', routes.length, 'routes');

  // ── Fetch cameras along entire route corridor ──
  let minLat = 90, maxLat = -90, minLon = 180, maxLon = -180;
  routes.forEach(route => {
    route.geometry.coordinates.forEach(([lon, lat]) => {
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
      if (lon < minLon) minLon = lon;
      if (lon > maxLon) maxLon = lon;
    });
  });
  minLat -= 0.01; maxLat += 0.01;
  minLon -= 0.01; maxLon += 0.01;

  const query = `[out:json][timeout:30];node["man_made"="surveillance"]["surveillance:type"="ALPR"](${minLat.toFixed(5)},${minLon.toFixed(5)},${maxLat.toFixed(5)},${maxLon.toFixed(5)});out body;`;
  let routeCameras = [];
  try {
    const resp = await fetch(OVERPASS_URL, {
      method: 'POST',
      body:   'data=' + encodeURIComponent(query),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    if (resp.ok) {
      const data = await resp.json();
      routeCameras = (data.elements || []).map(el => ({
        lat: el.lat, lon: el.lon, id: el.id,
        tags: el.tags || {},
        manufacturer: el.tags?.manufacturer || 'Unknown',
        operator:     el.tags?.operator     || 'Unknown',
        direction:    el.tags?.direction    || el.tags?.['camera:direction'] || '?',
      }));
      // Merge with viewport cameras (dedup by id)
      const existingIds = new Set(cameras.map(c => c.id));
      routeCameras.forEach(c => {
        if (!existingIds.has(c.id)) { cameras.push(c); existingIds.add(c.id); }
      });
      processCameras(data.elements || []);
    }
  } catch (err) {
    console.warn('[Routes] Camera fetch failed:', err);
  }

  // ── Score original OSRM routes ──
  const fastest = routes[0]; // OSRM always returns fastest first
  const alts    = routes.slice(1);

  const fastestCamHits = countCamerasNearRoute(fastest.geometry.coordinates);

  const scoredAlts = alts.map((route, i) => ({
    id:         `alt-${i}`,
    route,
    coords:     route.geometry.coordinates,
    cameraHits: countCamerasNearRoute(route.geometry.coordinates),
    duration:   route.duration,
    distance:   route.distance,
    type:       'alt',
  }));

  // ── Build Ghost Route ──
  setHint('👻 Building ghost route…');
  const onFastestCameras = routeCameras.filter(cam =>
    isCameraOnRoute(cam, fastest.geometry.coordinates)
  );

  console.log('[Ghost] Cameras on fastest route:', onFastestCameras.length);

  let ghostResult = null;
  if (onFastestCameras.length > 0) {
    ghostResult = await buildGhostRoute(fastest.geometry.coordinates, onFastestCameras);
  } else {
    console.log('[Ghost] No cameras on fastest route, ghost route not needed');
  }

  // ── Assemble display items ──
  const fastestItem = {
    id:         'fastest',
    route:      fastest,
    coords:     fastest.geometry.coordinates,
    cameraHits: fastestCamHits,
    duration:   fastest.duration,
    distance:   fastest.distance,
    type:       'fastest',
  };

  let ghostItem = null;
  if (ghostResult) {
    const ghostCamHits = countCamerasNearRoute(ghostResult.geometry.coordinates);
    ghostItem = {
      id:         'ghost',
      route:      ghostResult,
      coords:     ghostResult.geometry.coordinates,
      cameraHits: ghostCamHits,
      duration:   ghostResult.duration,
      distance:   ghostResult.distance,
      type:       'ghost',
    };
    console.log('[Ghost] Ghost route cameras:', ghostCamHits, 'vs fastest:', fastestCamHits);
  }

  // ── Draw routes (worst layering: draw alts first, then ghost, then fastest) ──
  scoredAlts.forEach(item => drawRouteItem(item));
  if (ghostItem) drawRouteItem(ghostItem);
  drawRouteItem(fastestItem);

  // ── Fit map ──
  if (routeLayers.length > 0) {
    const group = L.featureGroup(routeLayers.map(r => r.layer));
    map.fitBounds(group.getBounds(), { padding: [40, 40] });
  }

  // ── Render panel ──
  renderDualRoutePanel(fastestItem, ghostItem, scoredAlts);
  showPanel('results');
  setHint('✅ Routes calculated — click a route to highlight');

  // ── Auto-select preferred route ──
  const defaultId = (preferGhost && ghostItem) ? 'ghost' : 'fastest';
  activateRoute(defaultId);
}

// ─── Ghost route engine ───────────────────────────────────────────────────────

/**
 * Cluster cameras that are within CLUSTER_RADIUS_M of each other.
 * Returns array of cluster objects with centroid lat/lon.
 */
function clusterCameras(cameraList) {
  const clusters = [];
  const assigned = new Set();

  for (let i = 0; i < cameraList.length; i++) {
    if (assigned.has(i)) continue;
    const cluster = [cameraList[i]];
    assigned.add(i);

    for (let j = i + 1; j < cameraList.length; j++) {
      if (assigned.has(j)) continue;
      const ci = cameraList[i];
      const cj = cameraList[j];
      const d  = haversine(ci.lat, ci.lon, cj.lat, cj.lon);
      if (d <= CLUSTER_RADIUS_M) {
        cluster.push(cj);
        assigned.add(j);
      }
    }

    const centerLat = cluster.reduce((s, c) => s + c.lat, 0) / cluster.length;
    const centerLon = cluster.reduce((s, c) => s + c.lon,  0) / cluster.length;
    clusters.push({ cameras: cluster, lat: centerLat, lon: centerLon, size: cluster.length });
  }

  return clusters;
}

/**
 * Find the closest point on a route (array of [lon, lat] coords) to a given point.
 * Returns { segIdx, nearPt: [lon, lat], dist }.
 */
function closestRoutePoint(routeCoords, lat, lon) {
  let minDist = Infinity;
  let bestSeg = 0;
  let bestNear = null;

  const latScale = 111320;

  for (let i = 0; i < routeCoords.length - 1; i++) {
    const [lon1, lat1] = routeCoords[i];
    const [lon2, lat2] = routeCoords[i + 1];

    const midLat  = (lat1 + lat2) / 2;
    const lonScale = 111320 * Math.cos(toRad(midLat));

    const px = (lon - lon1) * lonScale;
    const py = (lat - lat1) * latScale;
    const dx = (lon2 - lon1) * lonScale;
    const dy = (lat2 - lat1) * latScale;
    const lenSq = dx * dx + dy * dy;

    let t = 0;
    if (lenSq > 0) t = Math.max(0, Math.min(1, (px * dx + py * dy) / lenSq));

    const nearLon = lon1 + t * (lon2 - lon1);
    const nearLat = lat1 + t * (lat2 - lat1);
    const d = haversine(lat, lon, nearLat, nearLon);

    if (d < minDist) {
      minDist  = d;
      bestSeg  = i;
      bestNear = [nearLon, nearLat];
    }
  }

  return { segIdx: bestSeg, nearPt: bestNear, dist: minDist };
}

/**
 * Compute a waypoint GHOST_AVOIDANCE_M perpendicular to the route, on the
 * opposite side from the camera cluster.
 */
function computePerpendicularWaypoint(cluster, routeCoords) {
  const { segIdx, nearPt } = closestRoutePoint(routeCoords, cluster.lat, cluster.lon);
  if (!nearPt) return null;

  const [lon1, lat1] = routeCoords[segIdx];
  const [lon2, lat2] = routeCoords[Math.min(segIdx + 1, routeCoords.length - 1)];

  const midLat   = (lat1 + lat2) / 2;
  const latScale = 111320;
  const lonScale = 111320 * Math.cos(toRad(midLat));

  // Unit vector along the road segment
  const dx = (lon2 - lon1) * lonScale;
  const dy = (lat2 - lat1) * latScale;
  const len = Math.hypot(dx, dy);
  if (len < 0.01) return null;

  const ux = dx / len;
  const uy = dy / len;

  // Two perpendicular unit vectors (left and right of travel direction)
  const perpLeft  = { x: -uy, y:  ux }; // rotate 90° CCW
  const perpRight = { x:  uy, y: -ux }; // rotate 90° CW

  // Determine which side of the road the camera is on
  const camOffX = (cluster.lon - nearPt[0]) * lonScale;
  const camOffY = (cluster.lat - nearPt[1]) * latScale;

  // Dot product with perpLeft — positive means camera is on the left side of road
  const dotLeft = camOffX * perpLeft.x + camOffY * perpLeft.y;

  // Choose avoidance direction = OPPOSITE side from camera
  const avoidDir = (dotLeft > 0) ? perpRight : perpLeft;

  // Project the waypoint from the nearest-on-route point
  const waypointLon = nearPt[0] + (GHOST_AVOIDANCE_M * avoidDir.x) / lonScale;
  const waypointLat = nearPt[1] + (GHOST_AVOIDANCE_M * avoidDir.y) / latScale;

  return { lat: waypointLat, lon: waypointLon, segIdx };
}

/**
 * Snap a lat/lon to the nearest road via OSRM /nearest.
 */
async function snapToNearestRoad(lat, lon) {
  const url = `${OSRM_NEAREST_BASE}/${lon.toFixed(6)},${lat.toFixed(6)}?number=1`;
  try {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    if (data.code === 'Ok' && data.waypoints?.length) {
      const [snapLon, snapLat] = data.waypoints[0].location;
      return { lat: snapLat, lon: snapLon };
    }
  } catch (err) {
    console.warn('[Snap] Nearest road failed:', err);
  }
  return { lat, lon }; // fallback to raw coordinates
}

/**
 * Build a camera-avoiding "Ghost Route" using OSRM waypoints.
 *
 * Algorithm:
 *  1. Cluster cameras on the fastest route
 *  2. For each cluster, compute perpendicular avoidance waypoint
 *  3. Snap waypoints to nearest road
 *  4. Sort waypoints by position along original route
 *  5. Request OSRM route through those waypoints
 */
async function buildGhostRoute(fastestCoords, onRouteCameras) {
  try {
    // 1. Cluster
    const clusters = clusterCameras(onRouteCameras);
    console.log('[Ghost] Clusters:', clusters.length, clusters.map(c => c.size));

    // Sort clusters by size descending (prioritize dense clusters)
    clusters.sort((a, b) => b.size - a.size);

    // 2. Compute raw avoidance waypoints
    const rawWaypoints = [];
    for (const cluster of clusters) {
      const wp = computePerpendicularWaypoint(cluster, fastestCoords);
      if (wp) rawWaypoints.push(wp);
      if (rawWaypoints.length >= MAX_GHOST_WAYPOINTS) break;
    }

    if (rawWaypoints.length === 0) {
      console.log('[Ghost] No valid waypoints computed');
      return null;
    }

    // 3. Sort waypoints by segment index so we visit them in route order
    rawWaypoints.sort((a, b) => a.segIdx - b.segIdx);

    // 4. Snap each waypoint to nearest road
    const snapped = await Promise.all(
      rawWaypoints.map(wp => snapToNearestRoad(wp.lat, wp.lon))
    );

    console.log('[Ghost] Waypoints (snapped):', snapped);

    // 5. Build OSRM URL: start → waypoints → end
    const s = startCoords;
    const e = endCoords;
    const waypointStr = snapped.map(w => `${w.lon.toFixed(6)},${w.lat.toFixed(6)}`).join(';');
    const url = `${OSRM_BASE}/${s.lng.toFixed(6)},${s.lat.toFixed(6)};${waypointStr};${e.lng.toFixed(6)},${e.lat.toFixed(6)}?overview=full&geometries=geojson`;

    console.log('[Ghost] Requesting ghost route:', url);
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`OSRM HTTP ${resp.status}`);
    const data = await resp.json();

    if (data.code !== 'Ok' || !data.routes?.length) {
      throw new Error(data.message || 'No ghost routes returned');
    }

    return data.routes[0];

  } catch (err) {
    console.warn('[Ghost] Ghost route build failed:', err);
    return null;
  }
}

// ─── Geometry helpers ─────────────────────────────────────────────────────────

function haversine(lat1, lon1, lat2, lon2) {
  const R    = 6371000;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat/2)**2 +
            Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function toRad(deg) { return deg * Math.PI / 180; }

function pointToSegmentDistance(pLat, pLon, aLat, aLon, bLat, bLon) {
  const latScale = 111320;
  const lonScale = 111320 * Math.cos(toRad((aLat + bLat) / 2));

  const px = (pLon - aLon) * lonScale;
  const py = (pLat - aLat) * latScale;
  const dx = (bLon - aLon) * lonScale;
  const dy = (bLat - aLat) * latScale;

  const lenSq = dx*dx + dy*dy;
  if (lenSq === 0) return Math.hypot(px, py);

  const t    = Math.max(0, Math.min(1, (px*dx + py*dy) / lenSq));
  const nearX = t * dx;
  const nearY = t * dy;
  return Math.hypot(px - nearX, py - nearY);
}

function countCamerasNearRoute(coords) {
  if (!cameras.length) return 0;
  let count = 0;
  for (const cam of cameras) {
    if (isCameraOnRoute(cam, coords)) count++;
  }
  return count;
}

function isCameraOnRoute(cam, coords) {
  const camLon = cam.lon ?? cam.lng;
  for (let i = 0; i < coords.length - 1; i++) {
    const [lon1, lat1] = coords[i];
    const [lon2, lat2] = coords[i + 1];
    const d = pointToSegmentDistance(cam.lat, camLon, lat1, lon1, lat2, lon2);
    if (d <= CAMERA_PROXIMITY_M) return true;
  }
  return false;
}

// ─── Route drawing ────────────────────────────────────────────────────────────

function drawRouteItem(item) {
  const { id, coords, type } = item;
  const style = ROUTE_COLORS[type] || ROUTE_COLORS.alt;

  // OSRM returns [lng, lat] — Leaflet polyline needs [lat, lng]
  const latlngs = coords.map(([lon, lat]) => [lat, lon]);

  const layer = L.polyline(latlngs, {
    color:    style.color,
    weight:   style.weight,
    opacity:  style.opacity,
    lineJoin: 'round',
    lineCap:  'round',
  }).addTo(map);

  layer.on('click', () => activateRoute(id));
  routeLayers.push({ id, layer, type });
}

function activateRoute(id) {
  activeRouteId = id;

  routeLayers.forEach(({ layer, id: rId, type }) => {
    const style = ROUTE_COLORS[type] || ROUTE_COLORS.alt;
    if (rId === id) {
      layer.setStyle({ weight: style.weight + 3, opacity: 1 });
      layer.bringToFront();
    } else {
      layer.setStyle({ weight: style.weight, opacity: style.opacity * 0.4 });
    }
  });

  document.querySelectorAll('.route-card').forEach(card => {
    card.classList.toggle('active', card.dataset.id === id);
  });
}

function clearRouteLayers() {
  routeLayers.forEach(({ layer }) => map.removeLayer(layer));
  routeLayers  = [];
  activeRouteId = null;
}

// ─── Panel rendering ──────────────────────────────────────────────────────────

function renderDualRoutePanel(fastestItem, ghostItem, altItems) {
  const container = document.getElementById('route-cards');
  container.innerHTML = '';

  // ── Ghost preference toggle ──
  const toggleRow = document.createElement('div');
  toggleRow.className = 'ghost-pref-row';
  toggleRow.innerHTML = `
    <label class="ghost-toggle-label">
      <input type="checkbox" id="ghost-pref-toggle" ${preferGhost ? 'checked' : ''}/>
      <span class="ghost-toggle-text">👻 Always prefer Ghost Route</span>
    </label>
  `;
  container.appendChild(toggleRow);

  toggleRow.querySelector('#ghost-pref-toggle').addEventListener('change', (e) => {
    preferGhost = e.target.checked;
    localStorage.setItem('ghost-prefer-ghost', preferGhost ? 'true' : 'false');
    if (fastestItem || ghostItem) {
      const defaultId = (preferGhost && ghostItem) ? 'ghost' : 'fastest';
      activateRoute(defaultId);
    }
  });

  // ── Time-savings warning ──
  if (ghostItem) {
    const ratio = ghostItem.duration / fastestItem.duration;
    if (ratio > GHOST_TIME_WARNING) {
      const warn = document.createElement('div');
      warn.className = 'ghost-time-warning';
      warn.innerHTML = `⚠️ Ghost route adds significant time (+${Math.round((ratio - 1) * 100)}%)`;
      container.appendChild(warn);
    }
  }

  // ── Fastest card ──
  if (fastestItem) {
    container.appendChild(buildRouteCard(fastestItem, '⚡ Fastest', 'fastest'));
  }

  // ── Ghost route card ──
  if (ghostItem) {
    const savedCams = fastestItem.cameraHits - ghostItem.cameraHits;
    container.appendChild(buildRouteCard(ghostItem, '👻 Ghost Route', 'ghost', savedCams));
  } else if (fastestItem.cameraHits === 0) {
    const noGhostNote = document.createElement('div');
    noGhostNote.className = 'ghost-no-cameras';
    noGhostNote.innerHTML = `<span>🟢 Route is already camera-free — no ghost detour needed.</span>`;
    container.appendChild(noGhostNote);
  } else {
    const noGhostNote = document.createElement('div');
    noGhostNote.className = 'ghost-unavailable';
    noGhostNote.innerHTML = `<span>👻 Ghost route unavailable for this trip.</span>`;
    container.appendChild(noGhostNote);
  }

  // ── Alternatives (collapsible) ──
  if (altItems.length > 0) {
    const altSection = document.createElement('div');
    altSection.className = 'alt-section';
    altSection.innerHTML = `
      <button class="alt-toggle-btn" id="alt-toggle">
        🛣️ ${altItems.length} alternative route${altItems.length > 1 ? 's' : ''}
        <span class="alt-chevron">▼</span>
      </button>
      <div class="alt-cards hidden" id="alt-cards"></div>
    `;
    container.appendChild(altSection);

    const altCards  = altSection.querySelector('#alt-cards');
    const altToggle = altSection.querySelector('#alt-toggle');
    const chevron   = altSection.querySelector('.alt-chevron');

    altToggle.addEventListener('click', () => {
      const hidden = altCards.classList.toggle('hidden');
      chevron.textContent = hidden ? '▼' : '▲';
    });

    // Sort alternatives by camera count
    const sortedAlts = [...altItems].sort((a, b) =>
      a.cameraHits - b.cameraHits || a.duration - b.duration
    );
    sortedAlts.forEach((item, i) => {
      altCards.appendChild(buildRouteCard(item, `Route ${i + 1}`, 'alt'));
    });
  }

  // ── Legend ──
  const legend = document.getElementById('legend');
  if (legend) {
    legend.innerHTML = `
      <div class="legend-item"><span class="legend-dot" style="background:#3b82f6"></span> Fastest route</div>
      <div class="legend-item"><span class="legend-dot" style="background:#22c55e"></span> Ghost (camera-avoiding)</div>
      <div class="legend-item"><span class="legend-dot" style="background:#94a3b8"></span> Alternatives</div>
    `;
  }
}

function buildRouteCard(item, label, type, savedCams) {
  const { id, cameraHits, duration, distance } = item;
  const mins = Math.round(duration / 60);
  const km   = (distance / 1000).toFixed(1);

  const card = document.createElement('div');
  card.className   = `route-card route-card--${type}`;
  card.dataset.id  = id;

  const camSavingHtml = (savedCams > 0)
    ? `<span class="cam-saved">−${savedCams} vs fastest</span>`
    : '';

  const privacyClass = cameraHits === 0
    ? 'camera-stat safe'
    : (type === 'ghost' ? 'camera-stat warn' : 'camera-stat');

  card.innerHTML = `
    <div class="route-card-header">
      <span class="route-label">${escHtml(label)}</span>
      <span class="route-type-badge route-type-badge--${type}">${type === 'fastest' ? '⚡' : type === 'ghost' ? '👻' : '🛣️'}</span>
    </div>
    <div class="route-stats">
      <div class="stat">
        <span class="stat-label">Duration</span>
        <span class="stat-value">${mins}<span class="stat-unit">min</span></span>
      </div>
      <div class="stat">
        <span class="stat-label">Distance</span>
        <span class="stat-value">${km}<span class="stat-unit">km</span></span>
      </div>
      <div class="stat ${privacyClass}">
        <span class="stat-label">ALPR Cameras</span>
        <span class="stat-value">${cameraHits}<span class="stat-unit">hits</span>${camSavingHtml}</span>
      </div>
      <div class="stat">
        <span class="stat-label">Privacy</span>
        <span class="stat-value" style="font-size:16px">${privacyEmojiSingle(cameraHits)}</span>
      </div>
    </div>
  `;

  card.addEventListener('click', () => activateRoute(id));
  return card;
}

function privacyEmojiSingle(hits) {
  if (hits === 0)  return '🟢';
  if (hits <= 2)   return '🟡';
  return '🔴';
}

// ─── Camera detail (side panel) ───────────────────────────────────────────────

function showCameraDetail(cam) {
  const { tags } = cam;
  const fields = [
    ['Manufacturer', tags.manufacturer || tags.brand],
    ['Operator',     tags.operator || tags['operator:short']],
    ['Direction',    tags.direction || tags['camera:direction']],
    ['Model',        tags['camera:model'] || tags.model],
    ['Mount',        tags['camera:mount']],
    ['Type',         tags['surveillance:type']],
    ['Ref',          tags.ref],
    ['Note',         tags.note],
  ].filter(([, v]) => v);

  const content = document.getElementById('camera-detail-content');
  content.innerHTML = fields.length
    ? fields.map(([k, v]) =>
        `<div class="detail-row"><span class="detail-key">${escHtml(k)}</span>
         <span class="detail-val">${escHtml(String(v))}</span></div>`
      ).join('')
    : '<p style="color:var(--text-secondary)">No metadata available.</p>';

  document.getElementById('camera-detail-panel').classList.remove('hidden');
}

// ─── UI helpers ───────────────────────────────────────────────────────────────

function showPanel(state) {
  ['idle', 'loading', 'results', 'error'].forEach(s => {
    document.getElementById(`panel-${s}`).classList.toggle('hidden', s !== state);
  });
}

function showError(msg) {
  document.getElementById('error-message').textContent = msg;
  showPanel('error');
  setHint('⚠️ Routing failed — try different points');
}

function setHint(html) {
  document.getElementById('hint-text').innerHTML = html;
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function debounce(fn, ms) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

// ─── Clear / Reset ────────────────────────────────────────────────────────────

function clearAll() {
  if (startMarker) { map.removeLayer(startMarker); startMarker = null; }
  if (endMarker)   { map.removeLayer(endMarker);   endMarker   = null; }
  startCoords = null;
  endCoords   = null;

  clearRouteLayers();
  showPanel('idle');
  setHint('Enter start and destination to compare routes');
  document.getElementById('camera-detail-panel').classList.add('hidden');

  startInputCtrl.reset();
  endInputCtrl.reset();
}

// ─── Boot ─────────────────────────────────────────────────────────────────────

let startInputCtrl;
let endInputCtrl;

document.addEventListener('DOMContentLoaded', () => {
  initMap();

  startInputCtrl = setupSearchInput('start-input', 'start-dropdown', (item) => {
    placeStartMarker(item.lat, item.lng);
    map.setView([item.lat, item.lng], Math.max(map.getZoom(), 14));
    maybeCalculateRoutes();
  });

  endInputCtrl = setupSearchInput('end-input', 'end-dropdown', (item) => {
    placeEndMarker(item.lat, item.lng);
    map.setView([item.lat, item.lng], Math.max(map.getZoom(), 14));
    maybeCalculateRoutes();
  });

  // Swap button
  document.getElementById('swap-btn').addEventListener('click', () => {
    if (!startCoords && !endCoords) return;

    const tempCoords  = startCoords;
    const tempMarker  = startMarker;
    const tempVal     = document.getElementById('start-input').value;

    startCoords = endCoords;
    endCoords   = tempCoords;
    startMarker = endMarker;
    endMarker   = tempMarker;

    if (startMarker) {
      const latlng = startMarker.getLatLng();
      map.removeLayer(startMarker);
      startMarker = L.marker(latlng, { icon: pinIcon('#22c55e', 'S') })
        .addTo(map)
        .bindPopup('<div class="popup-title">🟢 Start</div>');
    }
    if (endMarker) {
      const latlng = endMarker.getLatLng();
      map.removeLayer(endMarker);
      endMarker = L.marker(latlng, { icon: pinIcon('#ef4444', 'E') })
        .addTo(map)
        .bindPopup('<div class="popup-title">🔴 End</div>');
    }

    const endVal = document.getElementById('end-input').value;
    document.getElementById('start-input').value = endVal;
    document.getElementById('end-input').value   = tempVal;
    document.getElementById('start-input').classList.toggle('has-value', !!endVal);
    document.getElementById('end-input').classList.toggle('has-value',   !!tempVal);

    if (startCoords && endCoords) {
      clearRouteLayers();
      fetchRoutes();
    }
  });

  document.getElementById('clear-btn').addEventListener('click', clearAll);
  document.getElementById('close-camera-detail').addEventListener('click', () => {
    document.getElementById('camera-detail-panel').classList.add('hidden');
  });

  window.addEventListener('resize', () => map.invalidateSize());
});

function maybeCalculateRoutes() {
  if (startCoords && endCoords) {
    clearRouteLayers();
    fetchRoutes();
  } else {
    setHint(startCoords ? 'Now enter your destination' : 'Enter your start location');
  }
}
