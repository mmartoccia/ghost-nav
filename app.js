/**
 * Ghost — Privacy-Aware Navigation
 * app.js — All application logic
 *
 * Tech: Leaflet.js + OSRM demo server + OpenStreetMap Overpass API
 *       Geocoding: Nominatim (free, no API key required)
 */

'use strict';

// ─── Constants ───────────────────────────────────────────────────────────────

const SUMMERVILLE        = [33.0185, -80.1762];
const OSRM_BASE          = 'https://router.project-osrm.org/route/v1/driving';
const OVERPASS_URL       = 'https://overpass-api.de/api/interpreter';
const NOMINATIM_BASE     = 'https://nominatim.openstreetmap.org/search';
// NOTE: No custom headers — browser fetch with User-Agent triggers CORS preflight that Nominatim rejects
const CAMERA_PROXIMITY_M = 50; // meters
const GEOCODE_DEBOUNCE   = 300; // ms

const ROUTE_COLORS = {
  best:   { color: '#22c55e', weight: 5, opacity: 0.85 },
  middle: { color: '#eab308', weight: 4, opacity: 0.75 },
  worst:  { color: '#ef4444', weight: 4, opacity: 0.75 },
};

const ROUTE_RANK_LABEL  = ['best', 'middle', 'worst'];
const ROUTE_BADGE_LABEL = ['Best', 'Mid', 'Worst'];

// ─── State ────────────────────────────────────────────────────────────────────

let map;
let startMarker   = null;
let endMarker     = null;
let startCoords   = null; // { lat, lng }
let endCoords     = null; // { lat, lng }
let cameras       = [];
let cameraMarkers = [];
let routeLayers   = [];
let activeRouteIdx = null;

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

  // Initial camera fetch after tiles settle
  setTimeout(fetchCameras, 800);
}

// ─── Geocoding (Nominatim) ────────────────────────────────────────────────────

/**
 * Search Nominatim for a query. Returns array of result objects.
 * NOTE: No custom headers — browser User-Agent triggers CORS preflight which Nominatim rejects.
 */
async function geocodeSearch(query) {
  const params = new URLSearchParams({
    q:              query,
    format:         'json',
    addressdetails: '1',
    limit:          '5',
    countrycodes:   'us',
  });

  const url = `${NOMINATIM_BASE}?${params.toString()}`;
  console.log('[Geocode] Fetching:', url);

  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Nominatim HTTP ${resp.status}`);
  const results = await resp.json();
  console.log('[Geocode] Results:', results.length, results);
  return results;
}

/**
 * Format a Nominatim result into a human-readable label.
 */
function formatNominatimResult(result) {
  // Build a short name: use display_name but trim it
  const addr = result.address || {};

  // Prefer: name > house_number + road > display_name short
  let primary = result.name || result.display_name.split(',')[0].trim();
  let secondary = [];

  if (addr.road)         secondary.push(addr.road);
  if (addr.city || addr.town || addr.village) {
    secondary.push(addr.city || addr.town || addr.village);
  }
  if (addr.state)        secondary.push(addr.state);

  // If primary is same as road, show house number too
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

  let debounceTimer = null;
  let currentResults = [];
  let focusedIdx = -1;

  function showDropdown(items) {
    dropdown.innerHTML = '';
    focusedIdx = -1;

    if (!items) {
      // Show searching state
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
        e.preventDefault(); // prevent blur before click
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
    // Set input value to formatted address
    input.value = item.address
      ? `${item.name}, ${item.address}`
      : item.name;
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

    if (!q) {
      hideDropdown();
      return;
    }

    // Show searching immediately
    showDropdown(null);

    clearTimeout(debounceTimer);
    console.log('[Search] Debounce queued for:', q);
    debounceTimer = setTimeout(async () => {
      console.log('[Search] Debounce fired, querying:', q);
      try {
        const raw     = await geocodeSearch(q);
        const results = raw.map(formatNominatimResult);
        console.log('[Search] Formatted results:', results.length);
        showDropdown(results);
      } catch (err) {
        console.warn('[Search] Geocode error:', err);
        showDropdown([]);
      }
    }, GEOCODE_DEBOUNCE);
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      moveFocus(1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      moveFocus(-1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const items = dropdown.querySelectorAll('.dropdown-item');
      if (focusedIdx >= 0 && items[focusedIdx]) {
        selectResult(currentResults[focusedIdx]);
      } else if (currentResults.length > 0) {
        selectResult(currentResults[0]);
      }
    } else if (e.key === 'Escape') {
      hideDropdown();
    }
  });

  input.addEventListener('blur', () => {
    // Delay to allow mousedown on dropdown item to fire first
    setTimeout(hideDropdown, 150);
  });

  // Expose a reset function
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
    console.log('[OSRM] Response received:', data.code, 'routes:', data.routes?.length);

    if (data.code !== 'Ok' || !data.routes?.length) {
      throw new Error(data.message || 'No routes returned');
    }

    processRoutes(data.routes);
  } catch (err) {
    console.error('[OSRM] Error:', err);
    showError('Could not fetch routes. Check your connection or try different points.');
  }
}

function processRoutes(routes) {
  clearRouteLayers();

  console.log('[Routes] Processing', routes.length, 'routes');

  const scored = routes.map((route, idx) => {
    const coords     = route.geometry.coordinates;
    console.log('[Routes] Route', idx, '— coord count:', coords.length, 'first coord:', coords[0]);
    const cameraHits = countCamerasNearRoute(coords);
    const duration   = route.duration;
    const distance   = route.distance;
    return { idx, route, coords, cameraHits, duration, distance };
  });

  scored.sort((a, b) => a.cameraHits - b.cameraHits || a.duration - b.duration);

  const ranked = scored.map((item, rank) => ({ ...item, rank }));

  // Draw worst first so best appears on top
  const drawOrder = [...ranked].sort((a, b) => b.rank - a.rank);
  drawOrder.forEach(item => drawRoute(item));

  console.log('[Routes] Route layer count:', routeLayers.length);

  // Fit map to show all routes
  if (routeLayers.length > 0) {
    const group = L.featureGroup(routeLayers.map(r => r.layer));
    map.fitBounds(group.getBounds(), { padding: [40, 40] });
    console.log('[Routes] Map fitted to route bounds');
  }

  renderRoutePanel(ranked);
  showPanel('results');
  setHint('✅ Routes calculated — click a route to highlight');
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
  for (let i = 0; i < coords.length - 1; i++) {
    const [lon1, lat1] = coords[i];
    const [lon2, lat2] = coords[i + 1];
    const d = pointToSegmentDistance(cam.lat, cam.lon, lat1, lon1, lat2, lon2);
    if (d <= CAMERA_PROXIMITY_M) return true;
  }
  return false;
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

// ─── Route drawing ────────────────────────────────────────────────────────────

function drawRoute(item) {
  const { idx, rank, coords } = item;
  const rankKey = ROUTE_RANK_LABEL[rank] || 'worst';
  const style   = ROUTE_COLORS[rankKey];

  // OSRM returns [lng, lat] — Leaflet polyline needs [lat, lng]
  const latlngs = coords.map(([lon, lat]) => [lat, lon]);

  console.log('[Routes] Adding route', idx, 'to map —', latlngs.length, 'points, color:', style.color);

  const layer = L.polyline(latlngs, {
    color:   style.color,
    weight:  style.weight,
    opacity: style.opacity,
    lineJoin:'round',
    lineCap: 'round',
  }).addTo(map);

  console.log('[Routes] Route', idx, 'layer added to map');
  layer.on('click', () => activateRoute(idx));
  routeLayers.push({ idx, layer, rank, rankKey });
}

function activateRoute(idx) {
  activeRouteIdx = idx;

  routeLayers.forEach(({ layer, idx: rIdx, rankKey }) => {
    const style = ROUTE_COLORS[rankKey];
    if (rIdx === idx) {
      layer.setStyle({ weight: style.weight + 3, opacity: 1 });
      layer.bringToFront();
    } else {
      layer.setStyle({ weight: style.weight, opacity: style.opacity * 0.5 });
    }
  });

  document.querySelectorAll('.route-card').forEach(card => {
    card.classList.toggle('active', parseInt(card.dataset.idx) === idx);
  });
}

function clearRouteLayers() {
  routeLayers.forEach(({ layer }) => map.removeLayer(layer));
  routeLayers = [];
  activeRouteIdx = null;
}

// ─── Panel rendering ──────────────────────────────────────────────────────────

function renderRoutePanel(ranked) {
  const container = document.getElementById('route-cards');
  container.innerHTML = '';

  ranked.forEach((item, displayRank) => {
    const { idx, cameraHits, duration, distance, rank } = item;
    const rankKey   = ROUTE_RANK_LABEL[rank];
    const badgeText = ROUTE_BADGE_LABEL[rank];
    const mins      = Math.round(duration / 60);
    const km        = (distance / 1000).toFixed(1);

    const card = document.createElement('div');
    card.className   = `route-card ${rankKey}`;
    card.dataset.idx = idx;

    card.innerHTML = `
      <div class="route-card-header">
        <span class="route-label">Route ${displayRank + 1}</span>
        <span class="route-badge ${rankKey}">${badgeText}</span>
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
        <div class="stat ${cameraHits === 0 ? 'camera-stat safe' : 'camera-stat'}">
          <span class="stat-label">ALPR Cameras</span>
          <span class="stat-value">${cameraHits}<span class="stat-unit">hits</span></span>
        </div>
        <div class="stat">
          <span class="stat-label">Privacy</span>
          <span class="stat-value" style="font-size:16px">${privacyEmoji(cameraHits, ranked)}</span>
        </div>
      </div>
    `;

    card.addEventListener('click', () => activateRoute(idx));
    container.appendChild(card);
  });
}

function privacyEmoji(hits, ranked) {
  const max = Math.max(...ranked.map(r => r.cameraHits));
  if (hits === 0)       return '🟢';
  if (max === 0)        return '🟢';
  const ratio = hits / max;
  if (ratio <= 0.33)    return '🟢';
  if (ratio <= 0.66)    return '🟡';
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

  // Wire up search inputs
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

    // Swap coords
    startCoords = endCoords;
    endCoords   = tempCoords;

    // Swap marker layers
    startMarker = endMarker;
    endMarker   = tempMarker;

    // Update marker icons
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

    // Swap input text values
    const endVal = document.getElementById('end-input').value;
    document.getElementById('start-input').value = endVal;
    document.getElementById('end-input').value   = tempVal;

    // Sync has-value class
    document.getElementById('start-input').classList.toggle('has-value', !!endVal);
    document.getElementById('end-input').classList.toggle('has-value', !!tempVal);

    // Recalculate if both set
    if (startCoords && endCoords) {
      clearRouteLayers();
      fetchRoutes();
    }
  });

  // Clear button
  document.getElementById('clear-btn').addEventListener('click', clearAll);

  // Camera detail close
  document.getElementById('close-camera-detail').addEventListener('click', () => {
    document.getElementById('camera-detail-panel').classList.add('hidden');
  });

  // Fit map on resize
  window.addEventListener('resize', () => map.invalidateSize());
});

/**
 * If both start and end are set, auto-calculate routes.
 */
function maybeCalculateRoutes() {
  if (startCoords && endCoords) {
    clearRouteLayers();
    fetchRoutes();
  } else {
    setHint(startCoords
      ? 'Now enter your destination'
      : 'Enter your start location');
  }
}
