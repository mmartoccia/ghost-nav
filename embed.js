/**
 * Ghost Nav — Embed Widget
 * embed.js — Lightweight privacy route checker (no map, no Leaflet)
 *
 * Features:
 *  - Geocodes origin + destination via Nominatim proxy
 *  - Fetches ALPR cameras via Overpass proxy
 *  - Calls OSRM for fastest + alternative routes via proxy
 *  - Counts cameras within 50m of each route
 *  - Displays privacy scores and ghost route savings
 *  - Supports ?origin=X&destination=Y URL params for pre-filling
 */

'use strict';

// ─── Constants ────────────────────────────────────────────────────────────────

const NOMINATIM_BASE     = '/proxy/nominatim';
const OVERPASS_URL       = '/proxy/overpass';
const OSRM_BASE          = '/proxy/osrm/route/v1/driving';
const CAMERA_PROXIMITY_M = 50;
const MAX_ROUTE_RATIO    = 2.0;

// ─── DOM refs ─────────────────────────────────────────────────────────────────

const originInput = document.getElementById('embed-origin');
const destInput   = document.getElementById('embed-dest');
const checkBtn    = document.getElementById('embed-btn');
const resultPanel = document.getElementById('embed-result');

// ─── Geometry helpers ─────────────────────────────────────────────────────────

function toRad(deg) { return deg * Math.PI / 180; }

function haversine(lat1, lon1, lat2, lon2) {
  const R    = 6371000;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a    = Math.sin(dLat / 2) ** 2 +
               Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function pointToSegmentDist(pLat, pLon, aLat, aLon, bLat, bLon) {
  const latScale = 111320;
  const lonScale = 111320 * Math.cos(toRad((aLat + bLat) / 2));
  const px = (pLon - aLon) * lonScale;
  const py = (pLat - aLat) * latScale;
  const dx = (bLon - aLon) * lonScale;
  const dy = (bLat - aLat) * latScale;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(px, py);
  const t = Math.max(0, Math.min(1, (px * dx + py * dy) / lenSq));
  return Math.hypot(px - t * dx, py - t * dy);
}

function countCamerasOnRoute(coords, cameras) {
  // coords: [[lon, lat], ...]  (GeoJSON / OSRM format)
  let count = 0;
  for (const cam of cameras) {
    for (let i = 0; i < coords.length - 1; i++) {
      const [lon1, lat1] = coords[i];
      const [lon2, lat2] = coords[i + 1];
      const d = pointToSegmentDist(cam.lat, cam.lon, lat1, lon1, lat2, lon2);
      if (d <= CAMERA_PROXIMITY_M) { count++; break; }
    }
  }
  return count;
}

function routeBbox(routes) {
  let minLat = 90, maxLat = -90, minLon = 180, maxLon = -180;
  for (const r of routes) {
    for (const [lon, lat] of r.geometry.coordinates) {
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
      if (lon < minLon) minLon = lon;
      if (lon > maxLon) maxLon = lon;
    }
  }
  // 0.02° padding ~2 km
  return { minLat: minLat - 0.02, maxLat: maxLat + 0.02,
           minLon: minLon - 0.02, maxLon: maxLon + 0.02 };
}

function privacyScore(camerasOnRoute, totalCameras, ghostDist, fastestDist) {
  if (totalCameras === 0) return 100;
  const avoided   = Math.max(0, totalCameras - camerasOnRoute);
  const camScore  = Math.round((avoided / totalCameras) * 60);
  const ratio     = fastestDist > 0 ? ghostDist / fastestDist : 1;
  const distScore = ratio <= 1.1 ? 40 : ratio <= 1.5 ? 30 : ratio <= 2.0 ? 15 : 0;
  return Math.min(100, camScore + distScore);
}

// ─── Geocoding ────────────────────────────────────────────────────────────────

async function geocode(query) {
  const params = new URLSearchParams({
    q: query, format: 'json', limit: '1', countrycodes: 'us',
  });
  const resp = await fetch(`${NOMINATIM_BASE}?${params}`);
  if (!resp.ok) throw new Error(`Geocode HTTP ${resp.status}`);
  const results = await resp.json();
  if (!results.length) throw new Error(`No results for "${query}"`);
  const r = results[0];
  return { lat: parseFloat(r.lat), lon: parseFloat(r.lon), name: r.display_name };
}

// ─── Overpass cameras ─────────────────────────────────────────────────────────

async function fetchCameras(bbox) {
  const { minLat, maxLat, minLon, maxLon } = bbox;
  const query = `[out:json][timeout:30];
node["man_made"="surveillance"]["surveillance:type"="ALPR"](${minLat.toFixed(5)},${minLon.toFixed(5)},${maxLat.toFixed(5)},${maxLon.toFixed(5)});
out body;`;
  const resp = await fetch(OVERPASS_URL, {
    method:  'POST',
    body:    'data=' + encodeURIComponent(query),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });
  if (!resp.ok) throw new Error(`Overpass HTTP ${resp.status}`);
  const data = await resp.json();
  return (data.elements || []).map(el => ({
    lat: el.lat, lon: el.lon, id: el.id,
  }));
}

// ─── OSRM routing ─────────────────────────────────────────────────────────────

async function fetchOSRMRoutes(oLon, oLat, dLon, dLat) {
  const url = `${OSRM_BASE}/${oLon.toFixed(6)},${oLat.toFixed(6)};${dLon.toFixed(6)},${dLat.toFixed(6)}` +
              `?overview=full&geometries=geojson&alternatives=3`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`OSRM HTTP ${resp.status}`);
  const data = await resp.json();
  if (data.code !== 'Ok' || !data.routes?.length) throw new Error('OSRM returned no routes');
  return data.routes; // fastest first
}

// ─── UI helpers ───────────────────────────────────────────────────────────────

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function setResult(html) {
  resultPanel.innerHTML = html;
}

function scoreClass(s) {
  return s >= 70 ? 'score-high' : s >= 40 ? 'score-mid' : 'score-low';
}

function scoreBadge(score) {
  return `<span class="score-badge ${scoreClass(score)}">Score ${score}/100</span>`;
}

function privacyEmoji(hits) {
  return hits === 0 ? '🟢' : hits <= 3 ? '🟡' : '🔴';
}

function renderResults(fastest, ghost, cameras, fastestScore, ghostScore) {
  const fMin    = Math.round(fastest.duration / 60);
  const fKm     = (fastest.distance / 1000).toFixed(1);
  const fCams   = countCamerasOnRoute(fastest.geometry.coordinates, cameras);

  let ghostHtml = '';
  let savingsHtml = '';

  if (ghost) {
    const gMin   = Math.round(ghost.duration / 60);
    const gKm    = (ghost.distance / 1000).toFixed(1);
    const gCams  = countCamerasOnRoute(ghost.geometry.coordinates, cameras);
    const avoided = Math.max(0, fCams - gCams);
    const extraMin = Math.round((ghost.duration - fastest.duration) / 60);
    const ratio   = ghost.distance / fastest.distance;

    ghostHtml = `
      <div class="route-card ghost-card">
        <div class="route-card-label">👻 Ghost Route</div>
        <div class="route-stat"><span>Distance</span><strong>${gKm} km</strong></div>
        <div class="route-stat"><span>Duration</span><strong>${gMin} min</strong></div>
        <div class="route-stat"><span>ALPR Cameras</span><strong>${privacyEmoji(gCams)} ${gCams}</strong></div>
        ${scoreBadge(ghostScore)}
      </div>`;

    const timeVal  = extraMin > 0 ? `+${extraMin} min` : '±0 min';
    const timeClass = extraMin > 5 ? 'red' : extraMin > 0 ? 'yellow' : 'green';
    const avoidClass = avoided > 0 ? 'green' : 'yellow';

    if (ghost.note) {
      savingsHtml = `<p class="no-ghost-note">ℹ️ ${escHtml(ghost.note)}</p>`;
    } else {
      savingsHtml = `
        <div class="savings-bar">
          <div class="savings-item">
            <div class="label">Cameras avoided</div>
            <div class="value ${avoidClass}">${avoided} camera${avoided !== 1 ? 's' : ''}</div>
          </div>
          <div class="savings-item">
            <div class="label">Extra travel time</div>
            <div class="value ${timeClass}">${timeVal}</div>
          </div>
          <div class="savings-item">
            <div class="label">Distance ratio</div>
            <div class="value">${ratio.toFixed(2)}×</div>
          </div>
        </div>`;
    }
  } else {
    ghostHtml = `<div class="route-card ghost-card">
      <div class="route-card-label">👻 Ghost Route</div>
      <p style="color:#8b949e;font-size:12px;margin-top:4px">
        ${fCams === 0 ? '🟢 Route is already camera-free!' : 'No camera-avoiding route found.'}
      </p>
    </div>`;
  }

  setResult(`
    <div class="route-grid">
      <div class="route-card fastest-card">
        <div class="route-card-label">⚡ Fastest Route</div>
        <div class="route-stat"><span>Distance</span><strong>${fKm} km</strong></div>
        <div class="route-stat"><span>Duration</span><strong>${fMin} min</strong></div>
        <div class="route-stat"><span>ALPR Cameras</span><strong>${privacyEmoji(fCams)} ${fCams}</strong></div>
        ${scoreBadge(fastestScore)}
      </div>
      ${ghostHtml}
    </div>
    ${savingsHtml}
  `);
}

// ─── Core check logic ─────────────────────────────────────────────────────────

async function runPrivacyCheck() {
  const originQ = originInput.value.trim();
  const destQ   = destInput.value.trim();

  if (!originQ || !destQ) {
    setResult(`<div class="state-error"><span class="icon">⚠️</span><p>Please enter both origin and destination.</p></div>`);
    return;
  }

  checkBtn.disabled = true;
  setResult(`<div class="state-loading"><div class="spinner"></div><span>Geocoding addresses…</span></div>`);

  try {
    // 1. Geocode
    const [origin, dest] = await Promise.all([geocode(originQ), geocode(destQ)]);

    setResult(`<div class="state-loading"><div class="spinner"></div><span>Fetching routes…</span></div>`);

    // 2. Fetch routes (fastest + alternatives)
    const routes = await fetchOSRMRoutes(origin.lon, origin.lat, dest.lon, dest.lat);
    const fastest = routes[0];
    const alts    = routes.slice(1);

    setResult(`<div class="state-loading"><div class="spinner"></div><span>Checking ALPR cameras…</span></div>`);

    // 3. Fetch cameras in route corridor
    const bbox    = routeBbox(routes);
    const cameras = await fetchCameras(bbox);

    // 4. Score fastest route
    const fastestCams  = countCamerasOnRoute(fastest.geometry.coordinates, cameras);
    const fastestScore = Math.max(0, 100 - fastestCams * 8);

    // 5. Find best ghost route (OSRM alternative with fewer cameras)
    let bestGhost     = null;
    let bestGhostCams = fastestCams;

    for (const alt of alts) {
      const n     = countCamerasOnRoute(alt.geometry.coordinates, cameras);
      const ratio = alt.distance / fastest.distance;
      if (n < bestGhostCams && ratio < MAX_ROUTE_RATIO) {
        bestGhostCams = n;
        bestGhost     = alt;
      }
    }

    // 6. Compute ghost score
    let ghostRoute  = null;
    let ghostScore  = 0;

    if (fastestCams === 0) {
      // Already clean — fastest IS the ghost route
      ghostRoute = { ...fastest, note: 'Route is already camera-free — no detour needed.' };
      ghostScore = 100;
    } else if (bestGhost) {
      ghostRoute = bestGhost;
      ghostScore = privacyScore(bestGhostCams, fastestCams, bestGhost.distance, fastest.distance);
    } else {
      // No better alternative found
      ghostRoute = null;
      ghostScore = 0;
    }

    // 7. Render
    renderResults(fastest, ghostRoute, cameras, fastestScore, ghostScore);

  } catch (err) {
    console.error('[GhostEmbed]', err);
    setResult(`<div class="state-error">
      <span class="icon">⚠️</span>
      <p>${escHtml(err.message || 'Something went wrong. Please try again.')}</p>
    </div>`);
  } finally {
    checkBtn.disabled = false;
  }
}

// ─── URL param pre-fill ───────────────────────────────────────────────────────

function initFromParams() {
  const params = new URLSearchParams(window.location.search);
  const origin = params.get('origin');
  const dest   = params.get('destination');

  if (origin) {
    originInput.value = origin;
    originInput.classList.add('has-value');
  }
  if (dest) {
    destInput.value = dest;
    destInput.classList.add('has-value');
  }

  // Auto-run if both are provided
  if (origin && dest) {
    // Slight delay so the DOM settles
    setTimeout(runPrivacyCheck, 300);
  }
}

// ─── Event wiring ─────────────────────────────────────────────────────────────

checkBtn.addEventListener('click', runPrivacyCheck);

originInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { destInput.focus(); }
});
destInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { runPrivacyCheck(); }
});

// Boot
document.addEventListener('DOMContentLoaded', initFromParams);
