/**
 * Ghost — Privacy-Aware Navigation
 * app.js — All application logic
 *
 * Tech: Leaflet.js + OSRM demo server + OpenStreetMap Overpass API
 */

'use strict';

// ─── Constants ───────────────────────────────────────────────────────────────

const SUMMERVILLE = [33.0185, -80.1762];
const OSRM_BASE   = 'https://router.project-osrm.org/route/v1/driving';
const OVERPASS_URL= 'https://overpass-api.de/api/interpreter';
const CAMERA_PROXIMITY_M = 50; // meters

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
let clickState    = 'start'; // 'start' | 'end' | 'done'
let cameras       = [];      // array of { lat, lon, tags }
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

  map.on('click', onMapClick);
  map.on('moveend zoomend', debounce(fetchCameras, 600));

  // Initial camera fetch after a short delay (map tiles need to settle)
  setTimeout(fetchCameras, 800);
}

// ─── Click handling ───────────────────────────────────────────────────────────

function onMapClick(e) {
  const { lat, lng } = e.latlng;

  if (clickState === 'start') {
    placeStartMarker(lat, lng);
    clickState = 'end';
    setHint('👆 Click to set <strong>end point</strong>');
  } else if (clickState === 'end') {
    placeEndMarker(lat, lng);
    clickState = 'done';
    setHint('⏳ Fetching routes…');
    fetchRoutes();
  }
  // If 'done', clicking does nothing until Clear
}

function placeStartMarker(lat, lng) {
  if (startMarker) map.removeLayer(startMarker);
  startMarker = L.marker([lat, lng], { icon: pinIcon('#22c55e', 'S') })
    .addTo(map)
    .bindPopup('<div class="popup-title">🟢 Start</div>');
}

function placeEndMarker(lat, lng) {
  if (endMarker) map.removeLayer(endMarker);
  endMarker = L.marker([lat, lng], { icon: pinIcon('#ef4444', 'E') })
    .addTo(map)
    .bindPopup('<div class="popup-title">🔴 End</div>');
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
    html: svg,
    className: '',
    iconSize:   [28, 36],
    iconAnchor: [14, 36],
    popupAnchor:[0, -36],
  });
}

function cameraIcon(direction) {
  // Arrow direction: bearing in degrees (optional)
  const arrow = direction != null ? arrowSvg(direction) : '';
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 20 20">
      <circle cx="10" cy="10" r="8" fill="#ef4444" stroke="rgba(0,0,0,0.4)" stroke-width="1.5"
              fill-opacity="0.85"/>
      <text x="10" y="14" text-anchor="middle" font-size="10" fill="white">📷</text>
      ${arrow}
    </svg>`;
  return L.divIcon({
    html: svg,
    className: '',
    iconSize:   [20, 20],
    iconAnchor: [10, 10],
    popupAnchor:[0, -12],
  });
}

function arrowSvg(bearing) {
  // Render small direction arrow around the camera dot
  const rad   = (bearing - 90) * Math.PI / 180;
  const r     = 13;
  const x     = 10 + r * Math.cos(rad);
  const y     = 10 + r * Math.sin(rad);
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
      method: 'POST',
      body:   'data=' + encodeURIComponent(query),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    if (!resp.ok) throw new Error(`Overpass HTTP ${resp.status}`);
    const data = await resp.json();

    processCameras(data.elements || []);
  } catch (err) {
    console.warn('Overpass fetch failed:', err);
    // Silently fail — cameras are best-effort
  }
}

function processCameras(elements) {
  // Clear existing camera markers
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

    // Popup content
    const mfr  = cam.tags.manufacturer    || cam.tags.brand   || 'Unknown';
    const op   = cam.tags.operator        || cam.tags['operator:short'] || 'Unknown';
    const dir  = cam.tags.direction       || cam.tags['camera:direction'] || 'Unknown';
    const model= cam.tags['camera:model'] || cam.tags.model   || '';

    marker.bindPopup(`
      <div class="popup-title">📷 ALPR Camera</div>
      <div class="popup-row"><span>Manufacturer:</span><strong>${escHtml(mfr)}</strong></div>
      <div class="popup-row"><span>Operator:</span><strong>${escHtml(op)}</strong></div>
      <div class="popup-row"><span>Direction:</span><strong>${escHtml(dir)}</strong></div>
      ${model ? `<div class="popup-row"><span>Model:</span><strong>${escHtml(model)}</strong></div>` : ''}
    `);

    cameraMarkers.push(marker);
  });

  // Update badge
  const badge = document.getElementById('camera-count-badge');
  const num   = document.getElementById('camera-count-num');
  num.textContent = cameras.length;
  badge.classList.toggle('hidden', cameras.length === 0);
}

function parseBearing(val) {
  if (!val) return null;
  // Support compass headings: N=0, NE=45, E=90, …
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

  const s = startMarker.getLatLng();
  const e = endMarker.getLatLng();

  const url = `${OSRM_BASE}/${s.lng},${s.lat};${e.lng},${e.lat}` +
              `?overview=full&geometries=geojson&alternatives=3`;

  try {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`OSRM HTTP ${resp.status}`);
    const data = await resp.json();

    if (data.code !== 'Ok' || !data.routes?.length) {
      throw new Error(data.message || 'No routes returned');
    }

    processRoutes(data.routes);
  } catch (err) {
    console.error('OSRM error:', err);
    showError('Could not fetch routes. Check your connection or try different points.');
  }
}

function processRoutes(routes) {
  // Clear old route layers
  clearRouteLayers();

  // Score each route by camera exposure
  const scored = routes.map((route, idx) => {
    const coords     = route.geometry.coordinates; // [[lon, lat], ...]
    const cameraHits = countCamerasNearRoute(coords);
    const duration   = route.duration; // seconds
    const distance   = route.distance; // meters

    return { idx, route, coords, cameraHits, duration, distance };
  });

  // Sort by camera count (asc) then duration (asc)
  scored.sort((a, b) => a.cameraHits - b.cameraHits || a.duration - b.duration);

  // Assign ranks: best=0, middle=1, worst=2
  const ranked = scored.map((item, rank) => ({ ...item, rank }));

  // Draw routes (draw worst first so best is on top)
  const drawOrder = [...ranked].sort((a, b) => b.rank - a.rank);
  drawOrder.forEach(item => drawRoute(item));

  // Render side panel
  renderRoutePanel(ranked);
  showPanel('results');
  setHint('✅ Routes calculated — click a route to highlight');
  clickState = 'done';
}

function countCamerasNearRoute(coords) {
  // coords: [[lon, lat], ...]
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
    // Check camera proximity to segment
    const d = pointToSegmentDistance(cam.lat, cam.lon, lat1, lon1, lat2, lon2);
    if (d <= CAMERA_PROXIMITY_M) return true;
  }
  return false;
}

// ─── Geometry helpers ─────────────────────────────────────────────────────────

/**
 * Haversine distance between two lat/lon points (meters)
 */
function haversine(lat1, lon1, lat2, lon2) {
  const R  = 6371000; // Earth radius in meters
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat/2)**2 +
            Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function toRad(deg) { return deg * Math.PI / 180; }

/**
 * Minimum distance from point P to line segment AB (all in lat/lon, result in meters)
 * Uses planar approximation valid for short segments.
 */
function pointToSegmentDistance(pLat, pLon, aLat, aLon, bLat, bLon) {
  // Convert to approximate meters using equirectangular
  const latScale  = 111320;
  const lonScale  = 111320 * Math.cos(toRad((aLat + bLat) / 2));

  const px = (pLon - aLon) * lonScale;
  const py = (pLat - aLat) * latScale;
  const dx = (bLon - aLon) * lonScale;
  const dy = (bLat - aLat) * latScale;

  const lenSq = dx*dx + dy*dy;
  if (lenSq === 0) return Math.hypot(px, py);

  const t = Math.max(0, Math.min(1, (px*dx + py*dy) / lenSq));
  const nearX = t * dx;
  const nearY = t * dy;
  return Math.hypot(px - nearX, py - nearY);
}

// ─── Route drawing ────────────────────────────────────────────────────────────

function drawRoute(item) {
  const { idx, rank, coords, route } = item;
  const rankKey = ROUTE_RANK_LABEL[rank] || 'worst';
  const style   = ROUTE_COLORS[rankKey];

  // Convert [lon, lat] → [lat, lon] for Leaflet
  const latlngs = coords.map(([lon, lat]) => [lat, lon]);

  const layer = L.polyline(latlngs, {
    color:   style.color,
    weight:  style.weight,
    opacity: style.opacity,
    lineJoin:'round',
    lineCap: 'round',
  }).addTo(map);

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

  // Highlight card
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
    card.className  = `route-card ${rankKey}`;
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
  if (hits === 0)         return '🟢';
  if (max === 0)          return '🟢';
  const ratio = hits / max;
  if (ratio <= 0.33)      return '🟢';
  if (ratio <= 0.66)      return '🟡';
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

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('close-camera-detail').addEventListener('click', () => {
    document.getElementById('camera-detail-panel').classList.add('hidden');
  });
});

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
  clearRouteLayers();
  clickState = 'start';
  showPanel('idle');
  setHint('👆 Click to set <strong>start point</strong>');
  document.getElementById('camera-detail-panel').classList.add('hidden');
}

// ─── Boot ─────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  initMap();

  document.getElementById('clear-btn').addEventListener('click', clearAll);

  // Fit map to window on resize
  window.addEventListener('resize', () => map.invalidateSize());
});
