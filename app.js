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
const CAMERA_PROXIMITY_M  = 25;    // meters — camera "on route" threshold — tuned via GHOST-RESEARCH-005 (was 50, optimal=25)
const GEOCODE_DEBOUNCE    = 300;   // ms
const CLUSTER_RADIUS_M    = 200;   // cameras within this distance share a cluster
const GHOST_AVOIDANCE_M   = 800;   // perpendicular offset for avoidance waypoints (m)
const MAX_GHOST_WAYPOINTS = 5;     // cap to avoid OSRM failures
const GHOST_TIME_WARNING  = 2.0;   // warn if ghost route > this × fastest duration
const AVOIDANCE_DISTANCES = [800, 1500, 2500]; // retry distances for ghost route

const ROUTE_COLORS = {
  fastest: { color: '#6b7280', weight: 4, opacity: 0.65, dashArray: '8, 5' },          // dashed gray (normal route)
  ghost:   { color: '#22c55e', weight: 7, opacity: 0.92 },                              // solid green, thick (privacy route)
  alt:     { color: '#94a3b8', weight: 4, opacity: 0.4 },
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

// ─── Report-camera state ──────────────────────────────────────────────────────
let reportMode          = false;
let reportMarker        = null;
let reportedCamMarkers  = [];

// ─── Privacy/Tor state ────────────────────────────────────────────────────────
let privacyModeEnabled  = localStorage.getItem('ghost-privacy-mode') === 'true';
let privacyStatus       = {
  tor_available: false,
  proxy_configured: false,
  mode: 'disabled',
};

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

  // Load community-reported cameras on init
  fetchReportedCameras();
  
  // Check privacy status on init
  checkPrivacyStatus();

  // Handle map clicks for report mode
  map.on('click', (e) => {
    if (!reportMode) return;
    const { lat, lng } = e.latlng;

    // Place a temporary orange marker
    if (reportMarker) map.removeLayer(reportMarker);
    reportMarker = L.marker([lat, lng], {
      icon: L.divIcon({
        html:       `<div style="color:#f97316;font-size:22px;text-shadow:1px 1px 3px black">📷</div>`,
        className:  '',
        iconSize:   [24, 24],
        iconAnchor: [12, 12],
      }),
    }).addTo(map);

    disableReportMode();
    showReportForm(lat, lng);
  });

  // Inject report camera FAB button
  const fab = document.createElement('button');
  fab.id        = 'report-camera-btn';
  fab.title     = 'Report a camera';
  fab.innerHTML = '📷';
  fab.setAttribute('aria-label', 'Report a camera');
  document.body.appendChild(fab);

  fab.addEventListener('click', () => {
    if (reportMode) {
      disableReportMode();
    } else {
      enableReportMode();
    }
  });
  
  // Inject privacy mode toggle UI
  const privacyContainer = document.createElement('div');
  privacyContainer.id = 'privacy-mode-container';
  privacyContainer.innerHTML = `
    <div class="privacy-controls">
      <label class="privacy-toggle-label">
        <input type="checkbox" id="privacy-mode-toggle" ${privacyModeEnabled ? 'checked' : ''}/>
        <span class="privacy-toggle-text">Privacy Mode</span>
      </label>
      <div id="privacy-status-indicator" class="privacy-status-indicator status-off">🔒 Privacy OFF</div>
    </div>
  `;
  document.body.appendChild(privacyContainer);
  
  document.getElementById('privacy-mode-toggle').addEventListener('change', (e) => {
    togglePrivacyMode(e.target.checked);
  });
}

// ─── Privacy Mode (Tor/VPN) ───────────────────────────────────────────────────

async function checkPrivacyStatus() {
  try {
    const resp = await fetch('/api/privacy-status');
    if (resp.ok) {
      privacyStatus = await resp.json();
      updatePrivacyUI();
    }
  } catch (err) {
    console.warn('[Privacy] Failed to fetch status:', err);
  }
}

async function togglePrivacyMode(enabled) {
  privacyModeEnabled = enabled;
  localStorage.setItem('ghost-privacy-mode', enabled ? 'true' : 'false');
  
  try {
    const resp = await fetch('/api/privacy-mode', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled }),
    });
    if (resp.ok) {
      const data = await resp.json();
      privacyStatus = {
        tor_available: data.tor_available,
        proxy_configured: data.proxy_configured,
        mode: data.mode || 'disabled',
      };
      updatePrivacyUI();
      console.log('[Privacy] Mode toggled:', enabled, data);
    }
  } catch (err) {
    console.error('[Privacy] Failed to toggle mode:', err);
    privacyModeEnabled = !enabled;  // Revert on failure
  }
}

function updatePrivacyUI() {
  const toggle = document.getElementById('privacy-mode-toggle');
  const status = document.getElementById('privacy-status-indicator');
  
  if (!toggle || !status) return;
  
  toggle.checked = privacyModeEnabled;
  
  let statusText = '🔒 Privacy OFF';
  let statusClass = 'status-off';
  
  if (privacyModeEnabled) {
    if (privacyStatus.tor_available) {
      statusText = '🛡️ Tor Connected';
      statusClass = 'status-tor';
    } else if (privacyStatus.proxy_configured) {
      statusText = '🔐 Proxy Connected';
      statusClass = 'status-proxy';
    } else {
      statusText = '⚠️ Privacy Mode (No Tor/VPN)';
      statusClass = 'status-warning';
    }
  }
  
  status.textContent = statusText;
  status.className = `privacy-status-indicator ${statusClass}`;
  
  // Show warning if privacy enabled but no proxy
  if (privacyModeEnabled && !privacyStatus.tor_available && !privacyStatus.proxy_configured) {
    status.title = 'Privacy mode enabled but Tor/VPN not available. Queries sent in cleartext. Install Tor for full privacy.';
  }
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

// ─── User location icon ───────────────────────────────────────────────────────

const userIcon = L.divIcon({
  html: `<div style="
    width:20px;height:20px;
    background:#3b82f6;
    border:3px solid white;
    border-radius:50%;
    box-shadow:0 0 0 3px rgba(59,130,246,0.4);
  "></div>`,
  className:   '',
  iconSize:    [20, 20],
  iconAnchor:  [10, 10],
  popupAnchor: [0, -14],
});

function operatorColor(type) {
  return { police: '#3366cc', government: '#6600cc', private: '#cc6600', unknown: '#888' }[type] || '#888';
}

function cameraIcon(cam, bearing) {
  const opType = (cam && cam.tags && cam.tags['operator:type']) || 'unknown';
  const color  = operatorColor(opType);
  const arrow  = bearing !== null && bearing !== undefined
    ? `<div style="transform:rotate(${bearing}deg);font-size:16px;line-height:1">→</div>`
    : '<div style="font-size:14px;line-height:1">📷</div>';
  const isMobile = window.matchMedia('(max-width: 768px)').matches;
  const sz = isMobile ? 28 : 20;
  const anchor = isMobile ? 14 : 10;
  return L.divIcon({
    html:        `<div style="color:${color};text-shadow:1px 1px 2px black;font-size:${isMobile ? '20px' : '16px'}">${arrow}</div>`,
    className:   '',
    iconSize:    [sz, sz],
    iconAnchor:  [anchor, anchor],
    popupAnchor: [0, -12],
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

// ─── Reported camera icon (orange) ───────────────────────────────────────────

function reportedCameraIcon() {
  return L.divIcon({
    html:        `<div style="color:#f97316;text-shadow:1px 1px 2px black;font-size:18px;line-height:1">📷</div>`,
    className:   '',
    iconSize:    [22, 22],
    iconAnchor:  [11, 11],
    popupAnchor: [0, -13],
  });
}

// ─── Fetch + render community-reported cameras ────────────────────────────────

async function fetchReportedCameras() {
  try {
    const resp = await fetch('/api/cameras/reported');
    if (!resp.ok) return;
    const data = await resp.json();
    const cams = data.cameras || [];

    // Clear existing reported markers
    reportedCamMarkers.forEach(m => map.removeLayer(m));
    reportedCamMarkers = [];

    cams.forEach(cam => {
      const date = cam.submitted_at ? cam.submitted_at.slice(0, 10) : 'Unknown';
      const marker = L.marker([cam.lat, cam.lon], { icon: reportedCameraIcon() })
        .addTo(map)
        .bindTooltip(`Community reported - ${cam.type || 'Unknown'} - ${date}`, { permanent: false })
        .bindPopup(`
          <div class="popup-title">📷 Community Reported</div>
          <div class="popup-detail"><b>Type:</b> ${cam.type || 'Unknown'}</div>
          <div class="popup-detail"><b>Operator:</b> ${cam.operator || 'Unknown'}</div>
          <div class="popup-detail"><b>Direction:</b> ${cam.direction || 'Unknown'}</div>
          ${cam.notes ? `<div class="popup-detail"><b>Notes:</b> ${cam.notes}</div>` : ''}
          <div class="popup-detail"><b>Status:</b> ${cam.status}</div>
          <div class="popup-detail"><b>Submitted:</b> ${date}</div>
        `);
      reportedCamMarkers.push(marker);
    });

    console.log(`[ReportedCams] Loaded ${cams.length} community cameras`);
  } catch (err) {
    console.warn('[ReportedCams] Failed to load:', err);
  }
}

// ─── Report camera mode ───────────────────────────────────────────────────────

function enableReportMode() {
  reportMode = true;
  map.getContainer().style.cursor = 'crosshair';
  const btn = document.getElementById('report-camera-btn');
  if (btn) {
    btn.style.background = '#dc2626';
    btn.title = 'Click on map to place camera…';
  }
  showToast('Click on the map to mark a camera location');
}

function disableReportMode() {
  reportMode = false;
  map.getContainer().style.cursor = '';
  const btn = document.getElementById('report-camera-btn');
  if (btn) {
    btn.style.background = '#ef4444';
    btn.title = 'Report a camera';
  }
  if (reportMarker) {
    map.removeLayer(reportMarker);
    reportMarker = null;
  }
}

function showReportForm(lat, lng) {
  // Remove any existing form
  const existing = document.getElementById('report-camera-overlay');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.id = 'report-camera-overlay';
  overlay.innerHTML = `
    <div id="report-camera-form">
      <div class="report-form-header">
        <span>📷 Report Camera</span>
        <button id="report-form-close" title="Cancel">✕</button>
      </div>
      <div class="report-form-body">
        <div class="report-form-coords">📍 ${lat.toFixed(5)}, ${lng.toFixed(5)}</div>
        <label>Type
          <select id="report-type">
            <option value="Unknown">Unknown</option>
            <option value="Flock">Flock</option>
            <option value="Genetec">Genetec</option>
          </select>
        </label>
        <label>Operator
          <select id="report-operator">
            <option value="Unknown">Unknown</option>
            <option value="Police">Police</option>
            <option value="Private">Private</option>
            <option value="HOA">HOA</option>
          </select>
        </label>
        <label>Direction
          <select id="report-direction">
            <option value="Unknown">Unknown</option>
            <option value="N">N</option>
            <option value="NE">NE</option>
            <option value="E">E</option>
            <option value="SE">SE</option>
            <option value="S">S</option>
            <option value="SW">SW</option>
            <option value="W">W</option>
            <option value="NW">NW</option>
          </select>
        </label>
        <label>Notes (optional)
          <textarea id="report-notes" rows="2" maxlength="500" placeholder="Any details…"></textarea>
        </label>
        <button id="report-submit-btn">Submit Report</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  document.getElementById('report-form-close').addEventListener('click', () => {
    overlay.remove();
    disableReportMode();
  });

  document.getElementById('report-submit-btn').addEventListener('click', async () => {
    // Get or generate persistent session_id for contributor tracking
    let sessionId = localStorage.getItem('ghost_session');
    if (!sessionId) {
      sessionId = crypto.randomUUID();
      localStorage.setItem('ghost_session', sessionId);
    }

    const payload = {
      lat:        lat,
      lon:        lng,
      type:       document.getElementById('report-type').value,
      operator:   document.getElementById('report-operator').value,
      direction:  document.getElementById('report-direction').value,
      notes:      document.getElementById('report-notes').value.trim(),
      session_id: sessionId,
    };

    const submitBtn = document.getElementById('report-submit-btn');
    submitBtn.disabled = true;
    submitBtn.textContent = 'Submitting…';

    try {
      const resp = await fetch('/api/report-camera', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(payload),
      });
      const result = await resp.json();
      if (resp.ok && result.status === 'ok') {
        overlay.remove();
        disableReportMode();
        showToast('✅ Camera reported — thank you!');
        fetchReportedCameras(); // Refresh orange markers
      } else {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Submit Report';
        showToast('❌ Error: ' + (result.error || 'Unknown error'));
      }
    } catch (err) {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Submit Report';
      showToast('❌ Network error, try again');
    }
  });
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
    const marker  = L.marker([cam.lat, cam.lon], { icon: cameraIcon(cam, bearing) })
      .addTo(map)
      .on('click', () => showCameraDetail(cam));

    const mfr    = cam.tags.manufacturer    || cam.tags.brand                    || 'Unknown';
    const op     = cam.tags.operator        || cam.tags['operator:short']         || 'Unknown';
    const opType = cam.tags['operator:type']                                      || 'Unknown';
    const dir    = cam.tags.direction       || cam.tags['camera:direction']       || 'Unknown';
    const model  = cam.tags['camera:model'] || cam.tags.model                    || '';

    marker.bindPopup(`
      <div class="popup-title">📷 ALPR Camera</div>
      <div class="popup-row"><span>Manufacturer:</span><strong>${escHtml(mfr)}</strong></div>
      <div class="popup-row"><span>Operator:</span><strong>${escHtml(op)}</strong></div>
      <div class="popup-row"><span>Type:</span><strong>${escHtml(opType)}</strong></div>
      <div class="popup-row"><span>Direction:</span><strong>${escHtml(dir)}°</strong></div>
      ${model ? `<div class="popup-row"><span>Model:</span><strong>${escHtml(model)}</strong></div>` : ''}
      <div class="popup-row"><span>OSM:</span><a href="https://osm.org/node/${cam.id}" target="_blank">${cam.id}</a></div>
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
    ghostResult = await buildGhostRoute(fastest.geometry.coordinates, onFastestCameras, alts);
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

  // ── Draw routes: alts first (bottom), then fastest (blue, semi-transparent), then ghost (green, solid, on top) ──
  scoredAlts.forEach(item => drawRouteItem(item));
  drawRouteItem(fastestItem);          // blue underneath
  if (ghostItem) drawRouteItem(ghostItem); // green dashed on top

  // ── Fit map ──
  if (routeLayers.length > 0) {
    const group = L.featureGroup(routeLayers.map(r => r.layer));
    map.fitBounds(group.getBounds(), { padding: [40, 40] });
  }

  // ── Render panel ──
  renderDualRoutePanel(fastestItem, ghostItem, scoredAlts);
  showPanel('results');
  setHint('✅ Routes calculated — click a route to highlight');

  // ── Show route comparison overlay ──
  displayRouteComparison(fastest, ghostItem ? ghostItem.route : null);

  // ── Show bottom comparison panel (side-by-side stats) ──
  renderRouteComparisonPanel(fastestItem, ghostItem);

  // ── Auto-select preferred route ──
  const defaultId = (preferGhost && ghostItem) ? 'ghost' : 'fastest';
  activateRoute(defaultId);

  // ── Encode state into query-string share URL ──
  const startInput = document.getElementById('start-input').value;
  const endInput   = document.getElementById('end-input').value;
  if (startCoords && endCoords) {
    const camCount     = ghostItem ? ghostItem.cameraHits : fastestCamHits;
    const savedCount   = ghostItem ? Math.max(0, fastestCamHits - ghostItem.cameraHits) : 0;
    encodeRouteHash(startInput, endInput, startCoords, endCoords, camCount, savedCount);
    const shareBtn = document.getElementById('share-btn');
    if (shareBtn) shareBtn.classList.remove('hidden');
  }
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
 * Compute a waypoint perpendicular to the route, on the opposite side from the camera.
 * @param {object} cluster - camera cluster with lat/lon
 * @param {Array}  routeCoords - [lon, lat] pairs
 * @param {number} avoidDist - avoidance distance in meters (default GHOST_AVOIDANCE_M)
 * @param {boolean} invertDir - if true, flip the chosen perpendicular direction
 */
function computePerpendicularWaypoint(cluster, routeCoords, avoidDist = GHOST_AVOIDANCE_M, invertDir = false) {
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

  // Choose avoidance direction = OPPOSITE side from camera (or same side if inverted)
  let avoidDir;
  if (!invertDir) {
    avoidDir = (dotLeft > 0) ? perpRight : perpLeft;
  } else {
    // Inverted: try the SAME side as the camera (in case opposite was wrong)
    avoidDir = (dotLeft > 0) ? perpLeft : perpRight;
  }

  // Project the waypoint from the nearest-on-route point
  const waypointLon = nearPt[0] + (avoidDist * avoidDir.x) / lonScale;
  const waypointLat = nearPt[1] + (avoidDist * avoidDir.y) / latScale;

  return { lat: waypointLat, lon: waypointLon, segIdx };
}

/**
 * Snap a lat/lon to the nearest road via OSRM /nearest.
 * Uses number=3 to get multiple candidates, picks the one farthest from original.
 */
async function snapToNearestRoad(lat, lon, originalRouteCoords) {
  const url = `${OSRM_NEAREST_BASE}/${lon.toFixed(6)},${lat.toFixed(6)}?number=3`;
  try {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    if (data.code === 'Ok' && data.waypoints?.length) {
      // If we have the original route, try to pick a waypoint on a DIFFERENT road
      if (originalRouteCoords && data.waypoints.length > 1) {
        // Find the waypoint that is farthest from the original route
        let bestWp = null;
        let bestDist = -1;
        for (const wp of data.waypoints) {
          const [wLon, wLat] = wp.location;
          // Compute minimum distance from this waypoint to the original route
          let minDistToRoute = Infinity;
          for (let i = 0; i < originalRouteCoords.length - 1; i++) {
            const [rLon1, rLat1] = originalRouteCoords[i];
            const [rLon2, rLat2] = originalRouteCoords[i + 1];
            const d = pointToSegmentDistance(wLat, wLon, rLat1, rLon1, rLat2, rLon2);
            if (d < minDistToRoute) minDistToRoute = d;
          }
          if (minDistToRoute > bestDist) {
            bestDist = minDistToRoute;
            bestWp = wp;
          }
        }
        if (bestWp) {
          const [snapLon, snapLat] = bestWp.location;
          console.log('[Snap] Picked alternate road wp, dist from original route:', Math.round(bestDist), 'm');
          return { lat: snapLat, lon: snapLon };
        }
      }
      // Fallback: use the first (nearest) result
      const [snapLon, snapLat] = data.waypoints[0].location;
      return { lat: snapLat, lon: snapLon };
    }
  } catch (err) {
    console.warn('[Snap] Nearest road failed:', err);
  }
  return { lat, lon }; // fallback to raw coordinates
}

/**
 * Build a camera-avoiding "Ghost Route" using corridor-based privacy routing.
 *
 * Algorithm (GHOST-ROUTE-002 — corridor approach):
 *  1. Score all OSRM alternatives (already fetched with ?alternatives=3)
 *     by counting cameras within 50m of the route polyline.
 *  2. If any alternative has fewer cameras than the fastest route, use the best one.
 *  3. Apply loop-detection safety:
 *     - No coordinate appears twice within 50m tolerance
 *     - Route distance is not >3x the direct start→end distance
 *     - If either check fails, fall back to fastest route (no ghost).
 *  4. Never insert intermediate waypoints — rely entirely on OSRM native alternatives.
 */
async function buildGhostRoute(fastestCoords, onRouteCameras, altRoutes) {
  const fastestCamCount = countCamerasOnCoords(fastestCoords);

  try {
    // ── Step 1: Score OSRM alternatives ────────────────────────────────────
    console.log('[Ghost] Corridor mode: scoring', (altRoutes || []).length, 'OSRM alternatives');

    let bestAlt    = null;
    let bestCams   = fastestCamCount;

    if (altRoutes && altRoutes.length > 0) {
      for (const alt of altRoutes) {
        const camCount = countCamerasOnCoords(alt.geometry.coordinates);
        console.log('[Ghost] Alt route cameras:', camCount, 'vs fastest:', fastestCamCount,
                    'dist:', Math.round(alt.distance), 'm');
        if (camCount < bestCams) {
          bestCams = camCount;
          bestAlt  = alt;
        }
      }
    }

    if (!bestAlt) {
      console.log('[Ghost] No alternative reduces camera count, ghost route skipped');
      return null;
    }

    // ── Step 2: Loop-detection safety ──────────────────────────────────────
    const validated = validateRoute(bestAlt, startCoords, endCoords);
    if (!validated) {
      console.warn('[Ghost] Loop detection failed on best alternative — falling back to null');
      return null;
    }

    console.log('[Ghost] Corridor ghost route selected:', bestCams, 'cameras',
                '(saved', (fastestCamCount - bestCams), 'from', fastestCamCount, ')');
    return bestAlt;

  } catch (err) {
    console.warn('[Ghost] Ghost route build failed:', err);
    return null;
  }
}

/**
 * Validate a candidate route for loops and excessive detour.
 *
 * Checks:
 *  1. No coordinate appears twice within 50m (loop detection)
 *  2. Route distance ≤ 3× direct straight-line distance between start and end
 *
 * @param {object} route      - OSRM route object with .geometry.coordinates and .distance
 * @param {object} startCoords - { lat, lng } of start
 * @param {object} endCoords   - { lat, lng } of end
 * @returns {boolean} true if route passes validation, false if it should be rejected
 */
function validateRoute(route, startCoords, endCoords) {
  const coords = route.geometry.coordinates; // [lon, lat] pairs

  // Check 1: no repeated coordinates within 50m
  const LOOP_TOLERANCE_M = 50;
  for (let i = 0; i < coords.length; i++) {
    for (let j = i + 2; j < coords.length; j++) {
      const d = haversine(coords[i][1], coords[i][0], coords[j][1], coords[j][0]);
      if (d < LOOP_TOLERANCE_M) {
        console.warn(`[Ghost] Loop detected: coord ${i} and ${j} are ${Math.round(d)}m apart`);
        return false;
      }
    }
  }

  // Check 2: route distance ≤ 3× straight-line distance
  const directDist = haversine(startCoords.lat, startCoords.lng, endCoords.lat, endCoords.lng);
  const MAX_DETOUR_RATIO = 3.0;
  if (directDist > 0 && route.distance > directDist * MAX_DETOUR_RATIO) {
    console.warn(`[Ghost] Excessive detour: route ${Math.round(route.distance)}m vs direct ${Math.round(directDist)}m (ratio ${(route.distance / directDist).toFixed(2)}x)`);
    return false;
  }

  return true;
}

/** Count cameras on a coordinate array (internal helper) */
function countCamerasOnCoords(coords) {
  if (!cameras.length) return 0;
  let count = 0;
  for (const cam of cameras) {
    if (isCameraOnRoute(cam, coords)) count++;
  }
  return count;
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

// ─── Route comparison panel ───────────────────────────────────────────────────

/**
 * Count cameras within CAMERA_PROXIMITY_M of any segment in a GeoJSON geometry.
 * @param {object} geometry - GeoJSON LineString geometry { type, coordinates: [[lon,lat],...] }
 * @param {Array}  cams     - array of camera objects with lat/lon
 * @returns {number} integer count
 */
function countCamerasOnRoute(geometry, cams) {
  if (!cams || !cams.length || !geometry) return 0;
  const coords = geometry.coordinates;
  let count = 0;
  for (const cam of cams) {
    if (isCameraOnRoute(cam, coords)) count++;
  }
  return count;
}

/**
 * Display the route comparison overlay panel (top-right of map).
 * @param {object} fastest - OSRM route object with .geometry, .distance, .duration
 * @param {object} ghost   - OSRM route object or null
 */
function displayRouteComparison(fastest, ghost) {
  const panel = document.getElementById('route-results');
  if (!panel) return;

  const fastCams = countCamerasOnRoute(fastest.geometry, cameras);
  const fastScore = Math.max(0, 100 - fastCams * 8);
  const fastMins = Math.round(fastest.duration / 60);
  const fastKm   = (fastest.distance / 1000).toFixed(1);

  document.getElementById('fastest-stats').innerHTML =
    `<b style="color:#ff6666">Fastest Route</b><br>` +
    `${fastKm} km | ${fastMins} min<br>` +
    `Cameras: ${fastCams} | Score: <b>${fastScore}/100</b>`;

  if (ghost) {
    const ghostCams  = countCamerasOnRoute(ghost.geometry, cameras);
    const ghostScore = Math.max(0, 100 - ghostCams * 8);
    const ghostMins  = Math.round(ghost.duration / 60);
    const ghostKm    = (ghost.distance / 1000).toFixed(1);
    const distRatio  = (ghost.distance / fastest.distance * 100 - 100).toFixed(0);
    const timeExtra  = Math.round((ghost.duration - fastest.duration) / 60);
    const avoided    = Math.max(0, fastCams - ghostCams);

    document.getElementById('ghost-stats').innerHTML =
      `<b style="color:#00ff88">Ghost Route</b><br>` +
      `${ghostKm} km | ${ghostMins} min<br>` +
      `Cameras: ${ghostCams} | Score: <b>${ghostScore}/100</b>`;

    document.getElementById('delta-stats').innerHTML =
      `<b>Avoided:</b> ${avoided} camera${avoided !== 1 ? 's' : ''}<br>` +
      `<b>Extra time:</b> +${timeExtra} min | +${distRatio}%`;
  } else {
    document.getElementById('ghost-stats').innerHTML =
      `<span style="color:#888">Ghost Route: not available</span>`;
    document.getElementById('delta-stats').innerHTML = '';
  }

  panel.style.display = 'block';
}

// ─── Route Comparison Panel (GHOST-COMPARE-001) ───────────────────────────────

/**
 * Render the side-by-side comparison panel below the map.
 * Shows fastest vs privacy route with stats and "Show on Map" buttons.
 */
function renderRouteComparisonPanel(fastestItem, ghostItem) {
  const panel = document.getElementById('route-comparison-panel');
  if (!panel) return;

  if (!fastestItem) { panel.classList.add('hidden'); return; }

  // ── Helpers ──
  function fmtDist(meters) {
    const mi = meters / 1609.34;
    return mi >= 1 ? `${mi.toFixed(1)} mi` : `${Math.round(meters)} m`;
  }
  function fmtTime(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.round((seconds % 3600) / 60);
    return h > 0 ? `${h}h ${m}m` : `${m} min`;
  }
  function privacyScore(hits) {
    return Math.max(0, Math.min(100, Math.round(100 - hits * 7)));
  }
  function scoreColor(score) {
    if (score >= 70) return '#22c55e';
    if (score >= 40) return '#eab308';
    return '#ef4444';
  }

  // ── Fastest (normal) card ──
  const fCams  = fastestItem.cameraHits;
  const fScore = privacyScore(fCams);
  document.getElementById('rcp-normal-distance').textContent = fmtDist(fastestItem.distance);
  document.getElementById('rcp-normal-time').textContent     = fmtTime(fastestItem.duration);
  document.getElementById('rcp-normal-cameras').textContent  = String(fCams);
  const fScoreEl = document.getElementById('rcp-normal-score');
  fScoreEl.textContent = `${fScore}/100`;
  fScoreEl.style.color = scoreColor(fScore);

  // ── Privacy (ghost) card ──
  const rcpPrivacyCard = document.getElementById('rcp-privacy');
  const rcpRecommended = document.getElementById('rcp-recommended');
  const savingsBadge   = document.getElementById('rcp-savings-badge');
  const savingsText    = document.getElementById('rcp-savings-text');

  if (ghostItem) {
    const gCams    = ghostItem.cameraHits;
    const gScore   = privacyScore(gCams);
    const distPct  = ((ghostItem.distance / fastestItem.distance - 1) * 100).toFixed(0);
    const timeExtraMin = Math.round((ghostItem.duration - fastestItem.duration) / 60);
    const saved    = Math.max(0, fCams - gCams);

    const distLabel = distPct > 0
      ? `${fmtDist(ghostItem.distance)} <small style="color:#8892a4">(+${distPct}%)</small>`
      : fmtDist(ghostItem.distance);
    const timeLabel = timeExtraMin > 0
      ? `${fmtTime(ghostItem.duration)} <small style="color:#8892a4">(+${timeExtraMin} min)</small>`
      : fmtTime(ghostItem.duration);

    document.getElementById('rcp-privacy-distance').innerHTML = distLabel;
    document.getElementById('rcp-privacy-time').innerHTML     = timeLabel;
    document.getElementById('rcp-privacy-cameras').textContent = String(gCams);
    const gScoreEl = document.getElementById('rcp-privacy-score');
    gScoreEl.textContent = `${gScore}/100`;
    gScoreEl.style.color = scoreColor(gScore);

    // Show recommended badge if ghost is clearly better
    if (gCams < fCams) {
      rcpRecommended.classList.remove('hidden');
    } else {
      rcpRecommended.classList.add('hidden');
    }

    // Camera savings badge
    if (saved > 0) {
      savingsText.textContent = `👁 You'll pass ${saved} fewer camera${saved !== 1 ? 's' : ''} on the Ghost Route`;
      savingsBadge.classList.remove('hidden');
    } else {
      savingsBadge.classList.add('hidden');
    }
  } else {
    // No ghost route available
    document.getElementById('rcp-privacy-distance').textContent = '—';
    document.getElementById('rcp-privacy-time').textContent     = '—';
    document.getElementById('rcp-privacy-cameras').textContent  = 'N/A';
    document.getElementById('rcp-privacy-score').textContent    = '—';
    rcpRecommended.classList.add('hidden');
    savingsBadge.classList.add('hidden');
    rcpPrivacyCard.style.opacity = '0.5';
  }

  // ── Show/Map buttons ──
  const normalShowBtn  = document.getElementById('rcp-normal-show');
  const privacyShowBtn = document.getElementById('rcp-privacy-show');

  if (normalShowBtn) {
    normalShowBtn.onclick = () => {
      activateRoute('fastest');
      highlightRcpCard('normal');
    };
  }
  if (privacyShowBtn) {
    privacyShowBtn.onclick = () => {
      if (ghostItem) {
        activateRoute('ghost');
        highlightRcpCard('privacy');
      }
    };
    privacyShowBtn.disabled = !ghostItem;
  }

  // ── Close button ──
  const closeBtn = document.getElementById('rcp-close-btn');
  if (closeBtn) closeBtn.onclick = () => panel.classList.add('hidden');

  panel.classList.remove('hidden');
}

function highlightRcpCard(which) {
  document.getElementById('rcp-normal').classList.toggle('rcp-active', which === 'normal');
  document.getElementById('rcp-privacy').classList.toggle('rcp-active', which === 'privacy');
}

// ─── Route drawing ────────────────────────────────────────────────────────────

function drawRouteItem(item) {
  const { id, coords, type } = item;
  const style = ROUTE_COLORS[type] || ROUTE_COLORS.alt;

  // OSRM returns [lng, lat] — Leaflet polyline needs [lat, lng]
  const latlngs = coords.map(([lon, lat]) => [lat, lon]);

  const options = {
    color:    style.color,
    weight:   style.weight,
    opacity:  style.opacity,
    lineJoin: 'round',
    lineCap:  'round',
  };
  if (style.dashArray) options.dashArray = style.dashArray;

  const layer = L.polyline(latlngs, options).addTo(map);

  layer.on('click', () => activateRoute(id));
  routeLayers.push({ id, layer, type });
}

function activateRoute(id) {
  activeRouteId = id;

  routeLayers.forEach(({ layer, id: rId, type }) => {
    const style = ROUTE_COLORS[type] || ROUTE_COLORS.alt;
    if (rId === id) {
      const activeStyle = { weight: style.weight + 2, opacity: 1 };
      if (style.dashArray) activeStyle.dashArray = style.dashArray;
      layer.setStyle(activeStyle);
      layer.bringToFront();
    } else {
      const inactiveStyle = { weight: style.weight, opacity: style.opacity * 0.45 };
      if (style.dashArray) inactiveStyle.dashArray = style.dashArray;
      layer.setStyle(inactiveStyle);
    }
  });

  // Keep ghost always visually above fastest
  const ghostLayer = routeLayers.find(r => r.type === 'ghost');
  if (ghostLayer) ghostLayer.layer.bringToFront();

  document.querySelectorAll('.route-card').forEach(card => {
    card.classList.toggle('active', card.dataset.id === id);
  });

  // Sync comparison panel card highlights
  if (id === 'fastest') highlightRcpCard('normal');
  else if (id === 'ghost') highlightRcpCard('privacy');
}

function clearRouteLayers() {
  routeLayers.forEach(({ layer }) => map.removeLayer(layer));
  routeLayers  = [];
  activeRouteId = null;
}

// ─── Panel rendering ──────────────────────────────────────────────────────────

// ─── Ghost Privacy Score Panel (GHOST-RESEARCH-004: plain_english winner) ─────
// Winning copy format: plain_english (avg score 14.7/15)
// "This route passes 7 surveillance cameras. A privacy-optimized route exists
//  that avoids 4 of them, adding 3 minutes."
function renderGhostScorePanel(fastestItem, ghostItem) {
  const panel = document.getElementById('ghost-score-panel');
  if (!panel) return;

  const fastCams = fastestItem ? fastestItem.cameraHits : 0;

  if (fastCams === 0) {
    panel.className = 'ghost-score-panel ghost-score-panel--clean';
    panel.innerHTML = `<div class="score-line score-line--alt">🟢 This route passes no surveillance cameras.</div>`;
    panel.classList.remove('hidden');
    return;
  }

  let html = `<div class="score-line">👁 This route passes <strong>${fastCams}</strong> surveillance camera${fastCams !== 1 ? 's' : ''}.</div>`;

  if (ghostItem && ghostItem.cameraHits < fastCams) {
    const avoided  = fastCams - ghostItem.cameraHits;
    const extraMin = Math.round((ghostItem.duration - fastestItem.duration) / 60);
    const timeStr  = extraMin > 0 ? `, adding ${extraMin} minute${extraMin !== 1 ? 's' : ''}` : ' with no extra time';
    html += `<div class="score-line score-line--alt">👻 A privacy-optimized route exists that avoids <strong>${avoided}</strong> of them${timeStr}.</div>`;
  } else if (ghostItem) {
    html += `<div class="score-line score-line--alt">👻 Ghost route found — no additional cameras avoided on this trip.</div>`;
  }

  panel.className = 'ghost-score-panel';
  panel.innerHTML = html;
  panel.classList.remove('hidden');
}

function renderDualRoutePanel(fastestItem, ghostItem, altItems) {
  const container = document.getElementById('route-cards');
  container.innerHTML = '';

  // ── Ghost Privacy Score Panel (plain_english format) ──
  renderGhostScorePanel(fastestItem, ghostItem);

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

  // ── Save as My Commute button ──
  const commute = loadCommute();
  if (!commute) {
    // No saved commute — show the save button
    showSaveCommuteBtn(true);
  } else {
    // Commute already saved — hide save button
    showSaveCommuteBtn(false);
  }

  // ── Commute stats (if in commute mode) ──
  updateCommuteStats(fastestItem, ghostItem, altItems);
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

function showToast(msg, durationMs = 3000) {
  let toastEl = document.getElementById('ghost-toast');
  if (!toastEl) {
    toastEl = document.createElement('div');
    toastEl.id = 'ghost-toast';
    document.body.appendChild(toastEl);
  }
  toastEl.textContent = msg;
  toastEl.classList.add('ghost-toast-visible');
  clearTimeout(toastEl._hideTimer);
  toastEl._hideTimer = setTimeout(() => toastEl.classList.remove('ghost-toast-visible'), durationMs);
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
  document.getElementById('commute-stats-panel').classList.add('hidden');
  document.getElementById('save-commute-row').classList.add('hidden');
  isCommuteMode = false;
  const routeResultsPanel = document.getElementById('route-results');
  if (routeResultsPanel) routeResultsPanel.style.display = 'none';

  startInputCtrl.reset();
  endInputCtrl.reset();

  // Clear URL hash and hide share button
  history.replaceState(null, '', window.location.pathname + window.location.search);
  const shareBtn = document.getElementById('share-btn');
  if (shareBtn) shareBtn.classList.add('hidden');
}

// ─── Share / URL ─────────────────────────────────────────────────────────────

/**
 * Encode current route state as a query-string /share URL.
 * Sets window.location.hash for backward compat AND stores the share URL
 * so the share button can copy it.
 *
 * @param {string} originText
 * @param {string} destinationText
 * @param {{lat:number,lng:number}} originCoords
 * @param {{lat:number,lng:number}} destCoords
 * @param {number} [camCount=0]   - cameras on the displayed route
 * @param {number} [savedCount=0] - cameras avoided vs. fastest route
 */
function encodeRouteHash(originText, destinationText, originCoords, destCoords, camCount = 0, savedCount = 0) {
  try {
    const params = new URLSearchParams({
      slat:  originCoords.lat.toFixed(6),
      slon:  originCoords.lng.toFixed(6),
      elat:  destCoords.lat.toFixed(6),
      elon:  destCoords.lng.toFixed(6),
      cam:   camCount,
      saved: savedCount,
    });
    // Store the shareable /share URL so the share button can copy it
    const shareUrl = `${window.location.origin}/share?${params.toString()}`;
    window._ghostShareUrl = shareUrl;

    // Also push a clean query-string state to the browser so the page URL
    // reflects the route without the ugly hash fragment.
    const appParams = new URLSearchParams({
      slat:  originCoords.lat.toFixed(6),
      slon:  originCoords.lng.toFixed(6),
      elat:  destCoords.lat.toFixed(6),
      elon:  destCoords.lng.toFixed(6),
      cam:   camCount,
      saved: savedCount,
    });
    history.replaceState(null, '', `/?${appParams.toString()}`);
  } catch (e) {
    console.warn('[Share] Could not encode share URL:', e);
  }
}

/**
 * Decode route state from the current page URL.
 * Supports both:
 *   - New query-string format: /?slat=X&slon=Y&elat=Z&elon=W&cam=N&saved=M
 *   - Legacy hash format:      /#<base64(JSON)>
 * Returns parsed state object or null.
 */
function decodeRouteHash() {
  // 1. Try query-string params first (new format)
  const sp = new URLSearchParams(window.location.search);
  if (sp.get('slat') && sp.get('elat')) {
    return {
      origin:      sp.get('origin') || '',
      destination: sp.get('dest')   || '',
      oLat:        parseFloat(sp.get('slat')),
      oLng:        parseFloat(sp.get('slon')),
      dLat:        parseFloat(sp.get('elat')),
      dLng:        parseFloat(sp.get('elon')),
      cam:         parseInt(sp.get('cam')   || '0', 10),
      saved:       parseInt(sp.get('saved') || '0', 10),
    };
  }
  // 2. Fallback: legacy base64 hash
  const hash = window.location.hash.slice(1);
  if (!hash) return null;
  try {
    return JSON.parse(atob(hash));
  } catch (e) {
    console.warn('[Share] Could not decode hash:', e);
    return null;
  }
}

/**
 * Show the "Link copied!" toast for 2 seconds.
 */
function showCopyToast() {
  const toast = document.getElementById('share-toast');
  if (!toast) return;
  toast.style.opacity = '1';
  setTimeout(() => { toast.style.opacity = '0'; }, 2000);
}

// ─── My Commute ───────────────────────────────────────────────────────────────

const COMMUTE_KEY              = 'ghost_commute';
const COMMUTE_HISTORY_KEY      = 'ghost_commute_history';
const MAX_COMMUTE_HISTORY      = 7;
const COMMUTE_CAMERA_IDS_KEY   = 'ghostCommuteCameraIds';
const COMMUTE_CAMERA_COUNT_KEY = 'ghostCommuteCameraCount';
const COMMUTE_SAVED_AT_KEY     = 'ghostCommuteSavedAt';
const COMMUTE_PAGELOADS_KEY    = 'ghostCommutePageLoads';
const COMMUTE_PREV_COUNT_KEY   = 'ghostCommutePrevCameraCount';
const COMMUTE_PREV_WEEK_KEY    = 'ghostCommutePrevWeekSavedAt';

let isCommuteMode = false; // true when current route was loaded from saved commute

/**
 * Load saved commute from localStorage.
 * Returns { home, work, homeName, workName } or null.
 */
function loadCommute() {
  try {
    const raw = localStorage.getItem(COMMUTE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
}

/**
 * Save current origin/destination as "My Commute".
 */
async function saveCommute() {
  const commute = {
    home:     { ...startCoords },
    work:     { ...endCoords },
    homeName: document.getElementById('start-input').value,
    workName: document.getElementById('end-input').value,
    savedAt:  Date.now(),
  };
  localStorage.setItem(COMMUTE_KEY, JSON.stringify(commute));
  isCommuteMode = true;
  showCommuteBanner(commute, null); // camera count will update after route calc
  showSaveCommuteBtn(false);
  // flash confirm
  setHint('🏠 Commute saved! It will appear on your next visit.');
  setTimeout(() => setHint('✅ Routes calculated — click a route to highlight'), 2500);

  // Store camera fingerprint for future diff comparisons
  await storeCommuteCameraFingerprint(commute);
}

/**
 * Fetch cameras for a commute route and store fingerprint in localStorage.
 * @param {object} commute - saved commute with home/work coords
 */
async function storeCommuteCameraFingerprint(commute) {
  try {
    const routeCams = await fetchCamerasForCommute(commute);
    const ids = routeCams.map(c => c.id).sort();
    localStorage.setItem(COMMUTE_CAMERA_IDS_KEY,   JSON.stringify(ids));
    localStorage.setItem(COMMUTE_CAMERA_COUNT_KEY, String(ids.length));
    localStorage.setItem(COMMUTE_SAVED_AT_KEY,     new Date().toISOString());
    console.log('[Commute] Camera fingerprint stored:', ids.length, 'cameras');
  } catch (err) {
    console.warn('[Commute] Failed to store camera fingerprint:', err);
  }
}

/**
 * Fetch ALPR cameras along the bounding box of a home→work commute.
 * @param {object} commute - { home: {lat,lng}, work: {lat,lng} }
 * @returns {Array} camera objects
 */
async function fetchCamerasForCommute(commute) {
  const { home, work } = commute;
  const minLat = Math.min(home.lat, work.lat) - 0.02;
  const maxLat = Math.max(home.lat, work.lat) + 0.02;
  const minLon = Math.min(home.lng, work.lng) - 0.02;
  const maxLon = Math.max(home.lng, work.lng) + 0.02;

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
    lat:      el.lat,
    lon:      el.lon,
    id:       el.id,
    tags:     el.tags || {},
    operator: el.tags?.operator || el.tags?.['operator:short'] || null,
  }));
}

/**
 * On page load: diff current cameras against stored fingerprint.
 * Shows alert banner if new cameras are detected.
 * Updates fingerprint + page load counter.
 */
async function runCommuteCameraDiff(commute) {
  const storedIdsRaw = localStorage.getItem(COMMUTE_CAMERA_IDS_KEY);
  if (!storedIdsRaw) {
    // No fingerprint yet — store one now
    await storeCommuteCameraFingerprint(commute);
    return;
  }

  let storedIds;
  try {
    storedIds = JSON.parse(storedIdsRaw);
  } catch (e) {
    storedIds = [];
  }

  // Increment page load counter
  const loads = parseInt(localStorage.getItem(COMMUTE_PAGELOADS_KEY) || '0', 10) + 1;
  localStorage.setItem(COMMUTE_PAGELOADS_KEY, String(loads));

  try {
    const freshCams = await fetchCamerasForCommute(commute);
    const freshIds  = new Set(freshCams.map(c => c.id));
    const storedSet = new Set(storedIds);

    const newIds = [...freshIds].filter(id => !storedSet.has(id));

    if (newIds.length > 0) {
      const newCams = freshCams.filter(c => newIds.includes(c.id));
      const savedAt = localStorage.getItem(COMMUTE_SAVED_AT_KEY);
      const savedDate = savedAt ? new Date(savedAt).toLocaleDateString() : 'last check';
      showCameraAlertBanner(newCams, savedDate);
    }

    // Update fingerprint
    const allIds = [...freshIds].sort();
    localStorage.setItem(COMMUTE_CAMERA_IDS_KEY,   JSON.stringify(allIds));
    localStorage.setItem(COMMUTE_CAMERA_COUNT_KEY, String(allIds.length));
    localStorage.setItem(COMMUTE_SAVED_AT_KEY,     new Date().toISOString());

  } catch (err) {
    console.warn('[Commute] Camera diff failed:', err);
  }
}

/**
 * Show the camera alert banner when new cameras are detected.
 * @param {Array} newCams - array of new camera objects
 * @param {string} sinceDate - human-readable date of last fingerprint
 */
function showCameraAlertBanner(newCams, sinceDate) {
  const banner  = document.getElementById('camera-alert-banner');
  const title   = document.getElementById('camera-alert-title');
  const details = document.getElementById('camera-alert-details');

  if (!banner) return;

  title.textContent = `⚠️ ${newCams.length} new camera${newCams.length !== 1 ? 's' : ''} detected on your commute since ${sinceDate}`;

  details.innerHTML = newCams.map(cam => {
    const op  = cam.operator || cam.tags?.operator || cam.tags?.['operator:short'] || 'Unknown operator';
    const lat = cam.lat.toFixed(5);
    const lon = cam.lon.toFixed(5);
    return `<div class="camera-alert-item">
      📷 <strong>${escHtml(op)}</strong> — ${lat}, ${lon}
      <a href="https://osm.org/node/${cam.id}" target="_blank" class="camera-alert-link">OSM ↗</a>
    </div>`;
  }).join('');

  banner.classList.remove('hidden');

  document.getElementById('camera-alert-dismiss').onclick = () => {
    banner.classList.add('hidden');
  };
}

/**
 * Render the Weekly Summary panel (shown after 7+ days of data).
 * @param {object} fastestItem - fastest route item
 * @param {object|null} ghostItem - ghost route item
 */
function renderWeeklySummary(fastestItem, ghostItem) {
  const panel = document.getElementById('weekly-summary-panel');
  if (!panel) return;

  let history = [];
  try {
    const raw = localStorage.getItem(COMMUTE_HISTORY_KEY);
    history = raw ? JSON.parse(raw) : [];
  } catch (e) {
    history = [];
  }

  // Show panel if we have 7 days of history OR if we're testing (mock mode)
  const hasFullWeek = history.length >= MAX_COMMUTE_HISTORY;
  // Allow override for testing: ?weekly=1 in URL or localStorage.ghostWeeklyTest=1
  const testMode = new URLSearchParams(window.location.search).get('weekly') === '1'
    || localStorage.getItem('ghostWeeklyTest') === '1';

  if (!hasFullWeek && !testMode) {
    panel.classList.add('hidden');
    return;
  }

  panel.classList.remove('hidden');

  // Total surveillance events this week: sum of (cameras * page loads per day)
  const pageLoads  = parseInt(localStorage.getItem(COMMUTE_PAGELOADS_KEY) || '1', 10);
  const camCount   = parseInt(localStorage.getItem(COMMUTE_CAMERA_COUNT_KEY) || '0', 10);
  const weekEvents = hasFullWeek
    ? history.reduce((sum, h) => sum + Math.round((100 - h.score) / 8), 0) // reverse-engineer cam count from score
    : pageLoads * camCount;
  document.getElementById('weekly-stat-events').textContent = weekEvents;

  // Camera count trend
  const prevCount = parseInt(localStorage.getItem(COMMUTE_PREV_COUNT_KEY) || '0', 10);
  const trendEl   = document.getElementById('weekly-stat-trend');
  const delta     = camCount - prevCount;
  if (prevCount === 0) {
    trendEl.textContent = 'No previous data';
    trendEl.style.color = '#8b949e';
  } else if (delta > 0) {
    trendEl.textContent = `▲ Up ${delta} camera${delta !== 1 ? 's' : ''} since last week`;
    trendEl.style.color = '#ef4444';
  } else if (delta < 0) {
    trendEl.textContent = `▼ Down ${Math.abs(delta)} camera${Math.abs(delta) !== 1 ? 's' : ''} since last week`;
    trendEl.style.color = '#22c55e';
  } else {
    trendEl.textContent = '✓ No change since last week';
    trendEl.style.color = '#22c55e';
  }

  // Ghost route savings
  const ghostSavingsEl = document.getElementById('weekly-stat-ghost-savings');
  if (ghostItem && fastestItem) {
    const saved = Math.max(0, fastestItem.cameraHits - ghostItem.cameraHits);
    ghostSavingsEl.textContent = saved;
    ghostSavingsEl.nextElementSibling && (ghostSavingsEl.nextElementSibling.textContent =
      `cameras avoided daily (${saved * 5} this week)`);
  } else {
    ghostSavingsEl.textContent = '—';
  }

  // Store current count as prev (for next week comparison) — only once per week
  const prevWeekSavedAt = localStorage.getItem(COMMUTE_PREV_WEEK_KEY);
  const now = Date.now();
  const oneWeekMs = 7 * 24 * 60 * 60 * 1000;
  if (!prevWeekSavedAt || (now - parseInt(prevWeekSavedAt, 10)) > oneWeekMs) {
    localStorage.setItem(COMMUTE_PREV_COUNT_KEY, String(camCount));
    localStorage.setItem(COMMUTE_PREV_WEEK_KEY,  String(now));
  }
}

/**
 * Clear saved commute from localStorage.
 */
function clearCommute() {
  localStorage.removeItem(COMMUTE_KEY);
  localStorage.removeItem(COMMUTE_HISTORY_KEY);
  clearCommuteMonitoringData();
  isCommuteMode = false;
  document.getElementById('commute-banner').classList.add('hidden');
  document.getElementById('commute-stats-panel').classList.add('hidden');
  document.getElementById('camera-alert-banner').classList.add('hidden');
  document.getElementById('save-commute-row').classList.remove('hidden');
}

/**
 * Clear all commute monitoring/fingerprint data from localStorage.
 * Used by both clearCommute() and the "Clear commute data" button.
 */
function clearCommuteMonitoringData() {
  localStorage.removeItem(COMMUTE_CAMERA_IDS_KEY);
  localStorage.removeItem(COMMUTE_CAMERA_COUNT_KEY);
  localStorage.removeItem(COMMUTE_SAVED_AT_KEY);
  localStorage.removeItem(COMMUTE_PAGELOADS_KEY);
  localStorage.removeItem(COMMUTE_PREV_COUNT_KEY);
  localStorage.removeItem(COMMUTE_PREV_WEEK_KEY);
  console.log('[Commute] Monitoring data cleared');
}

/**
 * Show/hide the "Save as My Commute" button.
 */
function showSaveCommuteBtn(show) {
  const row = document.getElementById('save-commute-row');
  if (show) {
    row.classList.remove('hidden');
  } else {
    row.classList.add('hidden');
  }
}

/**
 * Show the commute banner with camera count.
 * @param {object} commute - saved commute object
 * @param {number|null} cameraCount - number of cameras on route (null = unknown)
 */
function showCommuteBanner(commute, cameraCount) {
  const banner = document.getElementById('commute-banner');
  const msg    = document.getElementById('commute-banner-msg');

  const camTxt = (cameraCount !== null && cameraCount !== undefined)
    ? `Your commute passes <strong>${cameraCount}</strong> camera${cameraCount !== 1 ? 's' : ''} today.`
    : `Your commute is saved.`;

  msg.innerHTML = `Welcome back. ${camTxt}`;
  banner.classList.remove('hidden');
}

/**
 * Run the saved commute in privacy mode (auto-loads and calculates route).
 */
async function runSavedCommute(commute) {
  isCommuteMode = true;
  showSaveCommuteBtn(false);

  startCoords = { ...commute.home };
  endCoords   = { ...commute.work };

  placeStartMarker(startCoords.lat, startCoords.lng);
  placeEndMarker(endCoords.lat, endCoords.lng);

  startInputCtrl.setValue(commute.homeName || 'Home');
  endInputCtrl.setValue(commute.workName   || 'Work');

  map.setView(
    [(startCoords.lat + endCoords.lat) / 2, (startCoords.lng + endCoords.lng) / 2],
    13
  );

  clearRouteLayers();
  await fetchRoutes();
}

/**
 * Update commute stats panel with route data.
 * @param {object} fastestItem - fastest route item
 * @param {object|null} ghostItem - ghost route item (or null)
 * @param {Array} altItems - alternative route items
 */
function updateCommuteStats(fastestItem, ghostItem, altItems) {
  if (!isCommuteMode) return;

  const panel = document.getElementById('commute-stats-panel');
  panel.classList.remove('hidden');

  // Daily camera exposure (cameras/km on the displayed route = ghost if available else fastest)
  const displayRoute = ghostItem || fastestItem;
  const routeKm = displayRoute.distance / 1000;
  const camsPerKm = routeKm > 0 ? (displayRoute.cameraHits / routeKm).toFixed(2) : '0.00';
  document.getElementById('commute-stat-density').textContent = camsPerKm;

  // Privacy score for today's commute
  const score = Math.max(0, 100 - displayRoute.cameraHits * 8);
  document.getElementById('commute-stat-score').textContent = score;

  // Best alternative saved vs fastest
  const allAlt = altItems || [];
  const allRoutes = [fastestItem, ghostItem, ...allAlt].filter(Boolean);
  const bestAlt = allRoutes.reduce((best, r) => {
    if (r === fastestItem) return best;
    if (!best || r.cameraHits < best.cameraHits) return r;
    return best;
  }, null);
  const savedVsFastest = bestAlt ? Math.max(0, fastestItem.cameraHits - bestAlt.cameraHits) : 0;
  document.getElementById('commute-stat-alt-saved').textContent = savedVsFastest;

  // Store today's score in history
  storeCommuteHistory(score);

  // Render sparkline
  renderSparkline();

  // Render weekly summary (shown after 7 days)
  renderWeeklySummary(fastestItem, ghostItem);

  // Wire up the "Clear commute data" button
  const clearDataBtn = document.getElementById('clear-commute-data-btn');
  if (clearDataBtn) {
    clearDataBtn.onclick = () => {
      clearCommuteMonitoringData();
      localStorage.removeItem(COMMUTE_HISTORY_KEY);
      document.getElementById('camera-alert-banner').classList.add('hidden');
      document.getElementById('weekly-summary-panel').classList.add('hidden');
      document.getElementById('commute-sparkline').innerHTML =
        '<span class="sparkline-empty">Data cleared — run your commute daily to rebuild trend.</span>';
      clearDataBtn.textContent = '✓ Cleared';
      clearDataBtn.disabled = true;
      setTimeout(() => {
        clearDataBtn.textContent = '🗑️ Clear commute data';
        clearDataBtn.disabled = false;
      }, 2000);
    };
  }

  // Update banner with camera count
  const commute = loadCommute();
  if (commute) {
    showCommuteBanner(commute, fastestItem.cameraHits);
  }
}

/**
 * Store today's privacy score in 7-day history.
 * Deduplicates by date (only one entry per day).
 */
function storeCommuteHistory(score) {
  let history = [];
  try {
    const raw = localStorage.getItem(COMMUTE_HISTORY_KEY);
    history = raw ? JSON.parse(raw) : [];
  } catch (e) {
    history = [];
  }

  const today = new Date().toISOString().slice(0, 10);

  // Update or add today's entry
  const existingIdx = history.findIndex(h => h.date === today);
  if (existingIdx >= 0) {
    history[existingIdx].score = score;
  } else {
    history.push({ date: today, score });
  }

  // Keep only last 7 days
  history.sort((a, b) => a.date.localeCompare(b.date));
  if (history.length > MAX_COMMUTE_HISTORY) {
    history = history.slice(-MAX_COMMUTE_HISTORY);
  }

  localStorage.setItem(COMMUTE_HISTORY_KEY, JSON.stringify(history));
}

/**
 * Render the 7-day sparkline from history.
 */
function renderSparkline() {
  const container = document.getElementById('commute-sparkline');
  if (!container) return;

  let history = [];
  try {
    const raw = localStorage.getItem(COMMUTE_HISTORY_KEY);
    history = raw ? JSON.parse(raw) : [];
  } catch (e) {
    history = [];
  }

  if (history.length === 0) {
    container.innerHTML = `<span class="sparkline-empty">No history yet — run your commute daily to build a trend.</span>`;
    return;
  }

  // Fill gaps: build a 7-slot array ending today
  const today = new Date();
  const slots = [];
  for (let i = MAX_COMMUTE_HISTORY - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const dateStr = d.toISOString().slice(0, 10);
    const entry   = history.find(h => h.date === dateStr);
    slots.push({ date: dateStr, score: entry ? entry.score : null });
  }

  const maxScore = 100;
  const minScore = 0;

  container.innerHTML = slots.map(slot => {
    if (slot.score === null) {
      return `<div class="sparkline-bar" style="background:var(--border);opacity:0.3;height:4px" data-tip="${slot.date}: no data"></div>`;
    }
    const pct    = Math.round(((slot.score - minScore) / (maxScore - minScore)) * 100);
    const height = Math.max(4, Math.round((pct / 100) * 36));
    const color  = slot.score >= 80 ? '#22c55e'
                 : slot.score >= 50 ? '#eab308'
                 : '#ef4444';
    const isToday = slot.date === today.toISOString().slice(0, 10);
    const border  = isToday ? `box-shadow:0 0 0 1px ${color};` : '';
    return `<div class="sparkline-bar" style="background:${color};height:${height}px;${border}" data-tip="${slot.date}: ${slot.score}/100"></div>`;
  }).join('');
}

/**
 * Check on page load if a commute is saved, and show the banner.
 * Also runs camera diff to detect new cameras since last visit.
 */
function initCommuteBanner() {
  const commute = loadCommute();
  if (!commute) return;

  showCommuteBanner(commute, null);

  document.getElementById('commute-view-btn').addEventListener('click', () => {
    runSavedCommute(commute);
  });

  document.getElementById('commute-clear-btn').addEventListener('click', () => {
    clearCommute();
  });

  // Run camera diff in background (non-blocking)
  runCommuteCameraDiff(commute).catch(err =>
    console.warn('[Commute] Background diff error:', err)
  );
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

  // Save commute button
  document.getElementById('save-commute-btn').addEventListener('click', () => {
    if (!startCoords || !endCoords) return;
    saveCommute();
    // Re-wire the banner buttons since commute was just saved
    document.getElementById('commute-view-btn').onclick = () => {
      const c = loadCommute();
      if (c) runSavedCommute(c);
    };
    document.getElementById('commute-clear-btn').onclick = () => clearCommute();
  });

  // Init commute banner on load
  initCommuteBanner();

  // ── Geolocation: Use My Location ──
  const useLocationBtn = document.getElementById('use-location');
  if (useLocationBtn) {
    useLocationBtn.addEventListener('click', () => {
      if (!navigator.geolocation) {
        alert('Geolocation is not supported by your browser.');
        return;
      }
      useLocationBtn.textContent = '⏳ Locating…';
      useLocationBtn.disabled = true;
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          const { latitude, longitude } = pos.coords;
          useLocationBtn.textContent = '📍 Use My Location';
          useLocationBtn.disabled = false;

          // Fill start input
          const startInput = document.getElementById('start-input');
          startInput.value = `${latitude.toFixed(5)}, ${longitude.toFixed(5)}`;
          startInput.classList.add('has-value');

          // Place user marker on map
          L.marker([latitude, longitude], { icon: userIcon })
            .addTo(map)
            .bindPopup('<div class="popup-title">📍 You are here</div>')
            .openPopup();

          // Set start coords and pan map
          placeStartMarker(latitude, longitude);
          // Override the start input text back (placeStartMarker doesn't touch input)
          startInput.value = `${latitude.toFixed(5)}, ${longitude.toFixed(5)}`;
          startInput.classList.add('has-value');

          map.setView([latitude, longitude], Math.max(map.getZoom(), 14));
          maybeCalculateRoutes();
        },
        (err) => {
          useLocationBtn.textContent = '📍 Use My Location';
          useLocationBtn.disabled = false;
          alert('Location access denied or unavailable. Please enable location services.');
          console.warn('[Geolocation] Error:', err.message);
        },
        { timeout: 10000, maximumAge: 60000 }
      );
    });
  }

  // Share button — copy the /share OG link (or fall back to current href)
  document.getElementById('share-btn').addEventListener('click', () => {
    const shareUrl = window._ghostShareUrl || window.location.href;
    navigator.clipboard.writeText(shareUrl)
      .then(() => showCopyToast())
      .catch(() => {
        // Fallback for browsers without clipboard API
        prompt('Copy this link:', shareUrl);
      });
  });

  // ── Restore from URL hash ──
  const hashState = decodeRouteHash();
  if (hashState && hashState.oLat && hashState.dLat) {
    console.log('[Share] Restoring route from URL hash:', hashState);

    const originItem = {
      name: hashState.origin,
      address: '',
      lat: hashState.oLat,
      lng: hashState.oLng,
    };
    const destItem = {
      name: hashState.destination,
      address: '',
      lat: hashState.dLat,
      lng: hashState.dLng,
    };

    startInputCtrl.setValue(hashState.origin);
    endInputCtrl.setValue(hashState.destination);

    placeStartMarker(originItem.lat, originItem.lng);
    placeEndMarker(destItem.lat, destItem.lng);

    // Center map between both points
    map.setView(
      [(originItem.lat + destItem.lat) / 2, (originItem.lng + destItem.lng) / 2],
      13
    );

    // Auto-calculate route
    setTimeout(() => {
      clearRouteLayers();
      fetchRoutes();
    }, 500);
  }

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

// ─── City Surveillance Heatmap ────────────────────────────────────────────────

let heatmapActive    = false;
let heatLayer        = null;
let heatCameras      = [];  // cameras fetched for heatmap
let heatClickHandler = null;

/**
 * Toggle the heatmap on/off.
 */
async function toggleHeatmap() {
  const btn = document.getElementById('heatmap-btn');
  if (!heatmapActive) {
    heatmapActive = true;
    btn.classList.add('active');
    btn.textContent = '🔥 Heatmap ON';
    document.getElementById('heatmap-legend').style.display = 'block';
    await refreshHeatmap();
    map.on('moveend zoomend', debounce(refreshHeatmap, 800));
    // Add click handler for surveillance score popup
    heatClickHandler = onHeatmapClick;
    map.on('click', heatClickHandler);
  } else {
    heatmapActive = false;
    btn.classList.remove('active');
    btn.textContent = '🔥 Heatmap';
    document.getElementById('heatmap-legend').style.display = 'none';
    document.getElementById('heatmap-spinner').style.display = 'none';
    if (heatLayer) {
      map.removeLayer(heatLayer);
      heatLayer = null;
    }
    heatCameras = [];
    if (heatClickHandler) {
      map.off('click', heatClickHandler);
      heatClickHandler = null;
    }
    map.off('moveend zoomend', debounce(refreshHeatmap, 800));
  }
}

/**
 * Fetch ALPR cameras for the current map bbox and render heatmap layer.
 */
async function refreshHeatmap() {
  if (!heatmapActive) return;

  const spinner = document.getElementById('heatmap-spinner');
  spinner.style.display = 'block';

  const bounds = map.getBounds();
  const s = bounds.getSouth().toFixed(5);
  const w = bounds.getWest().toFixed(5);
  const n = bounds.getNorth().toFixed(5);
  const e = bounds.getEast().toFixed(5);

  const query = `[out:json]; node["surveillance:type"="ALPR"](${s},${w},${n},${e}); out;`;

  try {
    const resp = await fetch(OVERPASS_URL, {
      method:  'POST',
      body:    'data=' + encodeURIComponent(query),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });

    if (!resp.ok) throw new Error(`Overpass HTTP ${resp.status}`);
    const data = await resp.json();
    heatCameras = (data.elements || []).map(el => ({
      lat:  el.lat,
      lon:  el.lon,
      id:   el.id,
      tags: el.tags || {},
    }));

    renderHeatLayer();
  } catch (err) {
    console.warn('[Heatmap] Overpass fetch failed:', err);
  } finally {
    spinner.style.display = 'none';
  }
}

/**
 * Build / rebuild the Leaflet.heat layer from heatCameras.
 * Weight each point by local camera density to create a proper gradient.
 */
function renderHeatLayer() {
  if (heatLayer) {
    map.removeLayer(heatLayer);
    heatLayer = null;
  }

  if (heatCameras.length === 0) return;

  // Calculate intensity for each camera based on local density (cameras within 1km)
  const DENSITY_RADIUS_KM = 1;
  const points = heatCameras.map(cam => {
    // Count how many other cameras are within DENSITY_RADIUS_KM
    let density = 0;
    for (const other of heatCameras) {
      const dist = haversine(cam.lat, cam.lon, other.lat, other.lon);
      if (dist <= DENSITY_RADIUS_KM * 1000) density++;
    }
    // Normalize density: scale 0-20 cameras to 0.0-1.0 intensity
    // With 20+ cameras in 1km radius = full red
    const intensity = Math.min(1.0, density / 20);
    return [cam.lat, cam.lon, intensity];
  });

  heatLayer = L.heatLayer(points, {
    radius:  50,
    blur:    35,
    max:     1.0,
    minOpacity: 0.1,
    gradient: {
      0.0:  '#00ff00',  // green — camera-free
      0.25: '#ccff00',  // lime
      0.4:  '#ffff00',  // yellow
      0.6:  '#ff8800',  // orange
      0.8:  '#ff4400',  // dark orange
      1.0:  '#ff0000',  // red — heavy surveillance clusters
    },
  }).addTo(map);
}

/**
 * Handle map click: count cameras within 500m and show surveillance score popup.
 */
function onHeatmapClick(e) {
  const { lat, lng } = e.latlng;

  // Count cameras within 500m of click point
  const RADIUS_M = 500;
  let count = 0;
  for (const cam of heatCameras) {
    const d = haversine(lat, lng, cam.lat, cam.lon);
    if (d <= RADIUS_M) count++;
  }

  // Score: 0 cameras → 100/100, scales down linearly, floor at 0
  // Use a scale where ~20 cameras = score 0
  const score = Math.max(0, Math.round(100 - (count / 20) * 100));

  const popup = L.popup()
    .setLatLng(e.latlng)
    .setContent(`
      <div style="font-family:monospace;font-size:13px;min-width:200px">
        <div style="font-weight:700;color:#00ff88;margin-bottom:6px">📍 Surveillance Score</div>
        <div style="margin-bottom:4px">
          <strong>${count}</strong> camera${count !== 1 ? 's' : ''} within 500m
        </div>
        <div>
          Surveillance score: <strong style="color:${score >= 70 ? '#22c55e' : score >= 40 ? '#eab308' : '#ef4444'}">${score}/100</strong>
        </div>
        <div style="margin-top:6px;font-size:11px;color:#8b949e">
          ${score >= 70 ? '🟢 Low surveillance zone' : score >= 40 ? '🟡 Moderate surveillance' : '🔴 Heavy surveillance zone'}
        </div>
      </div>
    `)
    .openOn(map);
}

// Wire up heatmap button in DOMContentLoaded (appended to existing boot logic)
document.addEventListener('DOMContentLoaded', () => {
  const heatBtn = document.getElementById('heatmap-btn');
  if (heatBtn) {
    heatBtn.addEventListener('click', toggleHeatmap);
  }
});
