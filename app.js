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

  // Init camera FOV layer (off by default — wired to toggle button)
  CameraFOVLayer.init(map);

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
      <div class="popup-row"><span>OSM:</span><a href="https://osm.org/node/${cam.id}" target="_blank" rel="noopener noreferrer">${cam.id}</a></div>
    `);

    cameraMarkers.push(marker);
  });

  const badge = document.getElementById('camera-count-badge');
  const num   = document.getElementById('camera-count-num');
  num.textContent = cameras.length;
  badge.classList.toggle('hidden', cameras.length === 0);

  // Update FOV cones with latest camera data
  CameraFOVLayer.update(cameras);
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
 * Build a camera-avoiding "Ghost Route" using corridor-based privacy routing.
 *
 * Algorithm (GHOST-ROUTE-002 — corridor approach, v2):
 *  1. Score all OSRM alternatives (already fetched with ?alternatives=3)
 *     by counting cameras within 50m of the route polyline.
 *  2. If any alternative has fewer cameras than the fastest route, use the best one.
 *  3. If no alternative beats the fastest, retry OSRM with alternatives=5 for more candidates.
 *  4. If still no strictly-better route, accept the best partial improvement (ties broken by distance).
 *  5. Apply loop-detection safety (2.5x detour ratio — relaxed from 3x):
 *     - No coordinate appears twice within 50m tolerance
 *     - Route distance is not >2.5x the direct start→end distance
 *     - If either check fails, skip that candidate and try the next.
 *  6. Never insert intermediate waypoints — rely entirely on OSRM native alternatives.
 */
async function buildGhostRoute(fastestCoords, onRouteCameras, altRoutes) {
  const fastestCamCount = countCamerasOnCoords(fastestCoords);

  try {
    // ── Step 1: Score OSRM alternatives ────────────────────────────────────
    console.log('[Ghost] Corridor mode: scoring', (altRoutes || []).length,
                'OSRM alternatives (fastest has', fastestCamCount, 'cameras)');

    const scoreAlts = (routes) => {
      const scored = [];
      for (const alt of (routes || [])) {
        const camCount = countCamerasOnCoords(alt.geometry.coordinates);
        const detourRatio = alt.distance / (altRoutes[0]?.distance || alt.distance);
        console.log('[Ghost] Candidate cameras:', camCount,
                    'dist:', Math.round(alt.distance) + 'm',
                    'detour-ratio:', detourRatio.toFixed(2) + 'x');
        scored.push({ alt, camCount });
      }
      // Sort: fewer cameras first, then shorter distance as tie-breaker
      scored.sort((a, b) =>
        a.camCount !== b.camCount
          ? a.camCount - b.camCount
          : a.alt.distance - b.alt.distance
      );
      return scored;
    };

    let scored = scoreAlts(altRoutes);

    // ── Step 2: Retry with alternatives=5 if none beat fastest ─────────────
    const anyBetter = scored.some(s => s.camCount < fastestCamCount);
    if (!anyBetter) {
      console.log('[Ghost] No strict improvement from 3 alternatives — retrying with alternatives=5');
      try {
        const s = startCoords;
        const e = endCoords;
        const url = `${OSRM_BASE}/${s.lng},${s.lat};${e.lng},${e.lat}` +
                    `?overview=full&geometries=geojson&alternatives=5`;
        const resp  = await fetch(url);
        if (resp.ok) {
          const data = await resp.json();
          if (data.code === 'Ok' && data.routes?.length > 1) {
            const newAlts = data.routes.slice(1);
            console.log('[Ghost] Extended fetch returned', newAlts.length, 'alternatives');
            scored = scoreAlts(newAlts);
          }
        }
      } catch (fetchErr) {
        console.warn('[Ghost] Extended alternative fetch failed:', fetchErr);
      }
    }

    // ── Step 3: Pick best candidate (strict improvement OR best partial) ───
    // Try strictly better first; fall back to best available (partial improvement)
    let bestEntry = scored.find(s => s.camCount < fastestCamCount) || scored[0] || null;

    if (!bestEntry) {
      console.log('[Ghost] No alternatives available at all, ghost route skipped');
      return null;
    }

    if (bestEntry.camCount >= fastestCamCount) {
      console.log('[Ghost] No alternative improves camera count',
                  `(best=${bestEntry.camCount}, fastest=${fastestCamCount}) — accepting best-effort`);
    }

    // ── Step 4: Loop-detection safety (try candidates in order) ────────────
    for (const entry of scored) {
      const validated = validateRoute(entry.alt, startCoords, endCoords);
      if (!validated) {
        console.warn('[Ghost] Candidate rejected by loop/detour check, trying next');
        continue;
      }
      const saved = fastestCamCount - entry.camCount;
      console.log('[Ghost] Ghost route accepted:', entry.camCount, 'cameras',
                  saved >= 0 ? `(saved ${saved} from ${fastestCamCount})` : `(no improvement, best available)`);
      return entry.alt;
    }

    console.warn('[Ghost] All candidates failed loop/detour validation — ghost route skipped');
    return null;

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

  // Check 2: route distance ≤ 2.5× straight-line distance (relaxed from 3x to surface more valid routes)
  const directDist = haversine(startCoords.lat, startCoords.lng, endCoords.lat, endCoords.lng);
  const MAX_DETOUR_RATIO = 2.5;
  if (directDist > 0 && route.distance > directDist * MAX_DETOUR_RATIO) {
    console.warn(`[Ghost] Excessive detour: route ${Math.round(route.distance)}m vs direct ${Math.round(directDist)}m (ratio ${(route.distance / directDist).toFixed(2)}x, limit ${MAX_DETOUR_RATIO}x)`);
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
      <a href="https://osm.org/node/${cam.id}" target="_blank" rel="noopener noreferrer" class="camera-alert-link">OSM ↗</a>
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

// ── GHOST-JURISDICTION: Init jurisdiction layer after map is ready ─────────────
document.addEventListener('DOMContentLoaded', () => {
  // Wait briefly for the map to initialize (map is created synchronously but
  // we defer to avoid race conditions with other DOMContentLoaded handlers)
  setTimeout(() => {
    if (typeof JurisdictionLayer !== 'undefined' && typeof map !== 'undefined') {
      JurisdictionLayer.init(map).catch(err =>
        console.warn('[Ghost] Jurisdiction layer init error:', err)
      );
    }
  }, 500);
});

// ═══════════════════════════════════════════════════════════════════════════════
// GHOST-PUSH-ALERTS — Proximity Alert Engine
// ═══════════════════════════════════════════════════════════════════════════════

(function GhostPushAlerts() {
  'use strict';

  // ─── Constants ──────────────────────────────────────────────────────────────
  const ALERT_DEBOUNCE_MS     = 60000;   // Don't re-alert same camera within 60s
  const GEOLOCATION_INTERVAL  = 5000;    // Poll every 5s during active navigation
  const PROXIMITY_ENDPOINT    = '/api/proximity-check';
  const SETTINGS_KEY          = 'ghost-alert-settings';
  const RECENT_ALERTS_MAX     = 5;

  // ─── State ──────────────────────────────────────────────────────────────────
  let _swRegistration       = null;
  let _watchId              = null;
  let _lastAlertedCameras   = {};   // camera_id → timestamp
  let _recentAlerts         = [];   // last N alerts for sidebar
  let _navigationActive     = false;
  let _lastPosition         = null;
  let _alertSettings        = loadAlertSettings();

  // ─── Settings ───────────────────────────────────────────────────────────────
  function defaultSettings() {
    return {
      threshold_meters:   250,
      silent_hours:       false,
      silent_start:       '22:00',
      silent_end:         '07:00',
      camera_type_filter: [],
    };
  }

  function loadAlertSettings() {
    try {
      const raw = localStorage.getItem(SETTINGS_KEY);
      if (raw) {
        return Object.assign(defaultSettings(), JSON.parse(raw));
      }
    } catch (e) { /* ignore */ }
    return defaultSettings();
  }

  function saveAlertSettings(settings) {
    _alertSettings = Object.assign(_alertSettings, settings);
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(_alertSettings));
    } catch (e) { /* ignore */ }
    // Also persist to server for validation (fire-and-forget)
    fetch('/api/alert-settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(_alertSettings),
    }).catch(() => {});
  }

  // ─── Silent hours check ──────────────────────────────────────────────────────
  function isSilentHours() {
    if (!_alertSettings.silent_hours) return false;
    const now   = new Date();
    const hh    = now.getHours();
    const mm    = now.getMinutes();
    const cur   = hh * 60 + mm;
    const [sh, sm] = (_alertSettings.silent_start || '22:00').split(':').map(Number);
    const [eh, em] = (_alertSettings.silent_end   || '07:00').split(':').map(Number);
    const start = sh * 60 + sm;
    const end   = eh * 60 + em;
    if (start <= end) return cur >= start && cur < end;
    return cur >= start || cur < end;   // wraps midnight
  }

  // ─── Service Worker registration ─────────────────────────────────────────────
  async function initServiceWorker() {
    if (!('serviceWorker' in navigator)) return null;
    try {
      _swRegistration = await navigator.serviceWorker.ready;
      return _swRegistration;
    } catch (e) {
      console.warn('[GhostAlerts] SW not ready:', e);
      return null;
    }
  }

  // ─── Notification permission ─────────────────────────────────────────────────
  async function requestNotificationPermission() {
    if (!('Notification' in window)) return 'unsupported';
    if (Notification.permission === 'granted') return 'granted';
    if (Notification.permission === 'denied')  return 'denied';
    const result = await Notification.requestPermission();
    updatePermissionUI(result);
    return result;
  }

  function updatePermissionUI(permission) {
    const btn = document.getElementById('ghost-notif-btn');
    if (!btn) return;
    if (permission === 'granted') {
      btn.textContent  = '🔔 Notifications ON';
      btn.style.color  = '#22c55e';
      btn.disabled     = true;
    } else if (permission === 'denied') {
      btn.textContent  = '🔕 Notifications blocked';
      btn.style.color  = '#ef4444';
      btn.disabled     = true;
    } else {
      btn.textContent  = '🔔 Enable Camera Alerts';
      btn.style.color  = '#facc15';
      btn.disabled     = false;
    }
  }

  // ─── Send notification via service worker or fallback ────────────────────────
  async function sendCameraNotification(camera) {
    if (Notification.permission !== 'granted') return;
    if (isSilentHours()) return;

    const title = '👻 Ghost — Camera Alert';
    const distStr = camera.distance_m < 1000
      ? `${Math.round(camera.distance_m)}m`
      : `${(camera.distance_m / 1000).toFixed(1)}km`;
    const body = [
      `${camera.camera_type || 'ALPR'} camera ${distStr} away`,
      `Operator: ${camera.operator || 'Unknown'}`,
      `Capture probability: ${Math.round((camera.capture_prob || 0.5) * 100)}%`,
    ].join(' · ');

    const payload = {
      title,
      body,
      camera_id:    String(camera.id),
      silent:       false,
      distance_m:   camera.distance_m,
      camera_type:  camera.camera_type,
      operator:     camera.operator,
      capture_prob: camera.capture_prob,
    };

    // Try via service worker message for best compatibility
    if (_swRegistration && navigator.serviceWorker.controller) {
      navigator.serviceWorker.controller.postMessage({
        type:    'SHOW_CAMERA_ALERT',
        payload: payload,
      });
    } else {
      // Fallback: direct Notification API
      try {
        new Notification(title, {
          body,
          icon: '/icon-192.png',
          tag:  `ghost-cam-${camera.id}`,
        });
      } catch (e) { /* ignore */ }
    }
  }

  // ─── Recent alerts log ────────────────────────────────────────────────────────
  function addRecentAlert(camera) {
    const alert = {
      id:          camera.id,
      time:        new Date().toLocaleTimeString(),
      camera_type: camera.camera_type || 'ALPR',
      operator:    camera.operator    || 'Unknown',
      distance_m:  camera.distance_m,
      capture_prob: camera.capture_prob,
    };
    _recentAlerts.unshift(alert);
    if (_recentAlerts.length > RECENT_ALERTS_MAX) {
      _recentAlerts = _recentAlerts.slice(0, RECENT_ALERTS_MAX);
    }
    renderRecentAlerts();
  }

  function renderRecentAlerts() {
    const container = document.getElementById('ghost-recent-alerts');
    if (!container) return;
    if (_recentAlerts.length === 0) {
      container.innerHTML = '<div class="ghost-no-alerts">No alerts yet</div>';
      return;
    }
    container.innerHTML = _recentAlerts.map(a => {
      const distStr = a.distance_m < 1000
        ? `${Math.round(a.distance_m)}m`
        : `${(a.distance_m / 1000).toFixed(1)}km`;
      const probPct = Math.round((a.capture_prob || 0.5) * 100);
      const color   = probPct >= 80 ? '#ef4444' : probPct >= 50 ? '#facc15' : '#22c55e';
      return `<div class="ghost-alert-item">
        <span class="ghost-alert-time">${a.time}</span>
        <span class="ghost-alert-type">${a.camera_type}</span>
        <span class="ghost-alert-dist">${distStr}</span>
        <span class="ghost-alert-prob" style="color:${color}">${probPct}%</span>
      </div>`;
    }).join('');
  }

  // ─── Proximity check ─────────────────────────────────────────────────────────
  async function checkProximity(lat, lon) {
    const threshold = _alertSettings.threshold_meters || 250;
    let data;
    try {
      const resp = await fetch(PROXIMITY_ENDPOINT, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ lat, lon, radius_meters: threshold }),
      });
      if (!resp.ok) return;
      data = await resp.json();
    } catch (e) {
      return;
    }

    const cameras = data.cameras || [];
    const now = Date.now();

    for (const cam of cameras) {
      const camId = String(cam.id);

      // Apply camera type filter if set
      const filter = _alertSettings.camera_type_filter || [];
      if (filter.length > 0 && !filter.includes(cam.camera_type)) continue;

      // Debounce: skip if alerted this camera within 60s
      const lastAlerted = _lastAlertedCameras[camId];
      if (lastAlerted && now - lastAlerted < ALERT_DEBOUNCE_MS) continue;

      // Record alert time
      _lastAlertedCameras[camId] = now;

      // Send notification
      await sendCameraNotification(cam);

      // Log to recent alerts
      addRecentAlert(cam);

      // Only alert the closest camera per check to avoid spam
      break;
    }

    // Update proximity status badge
    updateProximityBadge(cameras.length);
  }

  function updateProximityBadge(count) {
    const badge = document.getElementById('ghost-proximity-badge');
    if (!badge) return;
    if (count > 0) {
      badge.textContent  = `⚠️ ${count} camera${count > 1 ? 's' : ''} nearby`;
      badge.style.color  = '#ef4444';
      badge.style.display = 'inline-block';
    } else {
      badge.textContent  = '✅ No cameras in range';
      badge.style.color  = '#22c55e';
      badge.style.display = 'inline-block';
    }
  }

  // ─── Geolocation watching ─────────────────────────────────────────────────────
  function startLocationWatch() {
    if (!navigator.geolocation) {
      console.warn('[GhostAlerts] Geolocation not available');
      return;
    }
    if (_watchId !== null) return;  // already watching

    _navigationActive = true;
    updateNavigationUI(true);

    _watchId = navigator.geolocation.watchPosition(
      position => {
        const { latitude: lat, longitude: lon, accuracy } = position.coords;
        _lastPosition = { lat, lon, accuracy };
        checkProximity(lat, lon);
      },
      err => {
        console.warn('[GhostAlerts] Geolocation error:', err.message);
        if (err.code === err.PERMISSION_DENIED) {
          stopLocationWatch();
        }
      },
      {
        enableHighAccuracy: true,
        maximumAge:         GEOLOCATION_INTERVAL,
        timeout:            10000,
      }
    );
  }

  function stopLocationWatch() {
    if (_watchId !== null) {
      navigator.geolocation.clearWatch(_watchId);
      _watchId = null;
    }
    _navigationActive = false;
    updateNavigationUI(false);
    const badge = document.getElementById('ghost-proximity-badge');
    if (badge) badge.style.display = 'none';
  }

  function updateNavigationUI(active) {
    const btn = document.getElementById('ghost-nav-toggle');
    if (!btn) return;
    btn.textContent = active ? '🛑 Stop Live Alerts' : '📍 Start Live Alerts';
    btn.style.background = active ? 'rgba(239,68,68,0.15)' : 'rgba(34,197,94,0.15)';
  }

  // ─── Alert settings UI ────────────────────────────────────────────────────────
  function initAlertSettingsUI() {
    // Threshold slider
    const slider = document.getElementById('ghost-threshold-slider');
    const sliderVal = document.getElementById('ghost-threshold-value');
    if (slider && sliderVal) {
      slider.value   = _alertSettings.threshold_meters || 250;
      sliderVal.textContent = (slider.value) + 'm';
      slider.addEventListener('input', () => {
        sliderVal.textContent = slider.value + 'm';
      });
      slider.addEventListener('change', () => {
        saveAlertSettings({ threshold_meters: parseInt(slider.value) });
      });
    }

    // Silent hours toggle
    const silentToggle = document.getElementById('ghost-silent-toggle');
    if (silentToggle) {
      silentToggle.checked = !!_alertSettings.silent_hours;
      silentToggle.addEventListener('change', () => {
        saveAlertSettings({ silent_hours: silentToggle.checked });
        const silentPanel = document.getElementById('ghost-silent-hours-panel');
        if (silentPanel) {
          silentPanel.style.display = silentToggle.checked ? 'block' : 'none';
        }
      });
    }

    // Silent hours times
    const silentStart = document.getElementById('ghost-silent-start');
    const silentEnd   = document.getElementById('ghost-silent-end');
    if (silentStart) {
      silentStart.value = _alertSettings.silent_start || '22:00';
      silentStart.addEventListener('change', () => {
        saveAlertSettings({ silent_start: silentStart.value });
      });
    }
    if (silentEnd) {
      silentEnd.value = _alertSettings.silent_end || '07:00';
      silentEnd.addEventListener('change', () => {
        saveAlertSettings({ silent_end: silentEnd.value });
      });
    }

    // Silent hours panel visibility
    const silentPanel = document.getElementById('ghost-silent-hours-panel');
    if (silentPanel) {
      silentPanel.style.display = _alertSettings.silent_hours ? 'block' : 'none';
    }

    // Enable notification button
    const notifBtn = document.getElementById('ghost-notif-btn');
    if (notifBtn) {
      updatePermissionUI(Notification.permission);
      notifBtn.addEventListener('click', requestNotificationPermission);
    }

    // Nav toggle
    const navToggle = document.getElementById('ghost-nav-toggle');
    if (navToggle) {
      navToggle.addEventListener('click', () => {
        if (_navigationActive) {
          stopLocationWatch();
        } else {
          requestNotificationPermission().then(perm => {
            if (perm === 'granted') {
              startLocationWatch();
            }
          });
        }
      });
    }

    // Simulate alert button (dev/testing)
    const simBtn = document.getElementById('ghost-sim-alert-btn');
    if (simBtn) {
      simBtn.addEventListener('click', () => {
        const fakeCamera = {
          id:          'sim-' + Date.now(),
          camera_type: 'ALPR',
          operator:    'Flock Safety (Simulated)',
          distance_m:  Math.round(Math.random() * 200 + 30),
          capture_prob: 0.72,
          lat:         0,
          lon:         0,
        };
        sendCameraNotification(fakeCamera);
        addRecentAlert(fakeCamera);
      });
    }
  }

  // ─── Boot ─────────────────────────────────────────────────────────────────────
  async function init() {
    await initServiceWorker();
    updatePermissionUI(Notification.permission);

    document.addEventListener('DOMContentLoaded', () => {
      initAlertSettingsUI();
      renderRecentAlerts();
    });

    // If DOM already loaded
    if (document.readyState !== 'loading') {
      initAlertSettingsUI();
      renderRecentAlerts();
    }
  }

  init();

  // Expose for debugging
  window.GhostAlerts = {
    start:    startLocationWatch,
    stop:     stopLocationWatch,
    settings: _alertSettings,
    save:     saveAlertSettings,
    simulate: () => document.getElementById('ghost-sim-alert-btn') && document.getElementById('ghost-sim-alert-btn').click(),
  };

})();

// ─── GHOST-MULTISTOP: Multi-Stop Privacy Routing ──────────────────────────────
// TSP-style optimization with privacy cost function across multiple waypoints.
// Brute-force for N≤6 stops, nearest-neighbor heuristic for N>6.
// Cost = alpha * normalized_distance + beta * cameras_on_leg
// alpha + beta = 1, controlled by UI slider.
// ─────────────────────────────────────────────────────────────────────────────

(function() {
  'use strict';

  // ── State ──────────────────────────────────────────────────────────────────

  let _stops = [];          // Array of { id, name, coords: {lat, lng}, inputEl, dropdownEl }
  let _multiStopActive = false;
  let _multiAlpha = 0.5;    // Speed weight (0=all privacy, 1=all speed)
  let _multiBeta  = 0.5;    // Privacy weight
  let _fastestOrder = null; // Array of stop indices for fastest route
  let _privacyOrder = null; // Array of stop indices for privacy route
  let _multiRouteLayers = []; // Leaflet layers for multi-stop routes
  let _stopCounter = 0;     // For unique stop IDs

  // ── Helpers ────────────────────────────────────────────────────────────────

  /** Generate all permutations of an array. */
  function permutations(arr) {
    if (arr.length <= 1) return [arr.slice()];
    const result = [];
    for (let i = 0; i < arr.length; i++) {
      const rest = arr.slice(0, i).concat(arr.slice(i + 1));
      const perms = permutations(rest);
      for (const perm of perms) {
        result.push([arr[i], ...perm]);
      }
    }
    return result;
  }

  /** Nearest-neighbor heuristic TSP starting from index 0. */
  function nearestNeighborTSP(distMatrix, costMatrix) {
    const n = distMatrix.length;
    const visited = new Array(n).fill(false);
    const order = [0];
    visited[0] = true;

    for (let step = 1; step < n; step++) {
      const last = order[order.length - 1];
      let bestNext = -1;
      let bestCost = Infinity;
      for (let j = 0; j < n; j++) {
        if (!visited[j] && costMatrix[last][j] < bestCost) {
          bestCost = costMatrix[last][j];
          bestNext = j;
        }
      }
      if (bestNext === -1) break;
      visited[bestNext] = true;
      order.push(bestNext);
    }
    return order;
  }

  /** Haversine distance in meters between two {lat,lng} points. */
  function haversineM(a, b) {
    const R = 6371000;
    const dLat = (b.lat - a.lat) * Math.PI / 180;
    const dLng = (b.lng - a.lng) * Math.PI / 180;
    const sinLat = Math.sin(dLat / 2);
    const sinLng = Math.sin(dLng / 2);
    const c = sinLat * sinLat + Math.cos(a.lat * Math.PI / 180) *
              Math.cos(b.lat * Math.PI / 180) * sinLng * sinLng;
    return R * 2 * Math.atan2(Math.sqrt(c), Math.sqrt(1 - c));
  }

  /** Fetch an OSRM route between two coord pairs. Returns {distance, duration, coords}. */
  async function fetchLegRoute(from, to) {
    const url = `${OSRM_BASE}/${from.lng.toFixed(6)},${from.lat.toFixed(6)};${to.lng.toFixed(6)},${to.lat.toFixed(6)}?overview=full&geometries=geojson`;
    try {
      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`OSRM ${resp.status}`);
      const data = await resp.json();
      if (data.code !== 'Ok' || !data.routes?.length) throw new Error('No route');
      const route = data.routes[0];
      return {
        distance: route.distance,
        duration: route.duration,
        coords:   route.geometry.coordinates, // [lng,lat] pairs
        geometry: route.geometry,
      };
    } catch (err) {
      console.warn('[MultiStop] OSRM leg failed:', err);
      // Fallback: straight line estimate
      const d = haversineM(from, to);
      return {
        distance: d,
        duration: d / 13.9, // ~50 km/h
        coords:   [[from.lng, from.lat], [to.lng, to.lat]],
        geometry: { type: 'LineString', coordinates: [[from.lng, from.lat], [to.lng, to.lat]] },
      };
    }
  }

  /** Count cameras on a leg (using existing isCameraOnRoute). */
  function countCamerasOnLeg(coords) {
    if (typeof countCamerasNearRoute === 'function') {
      return countCamerasNearRoute(coords);
    }
    return 0;
  }

  /** Build distance and cost matrices for a set of stops. */
  async function buildMatrices(stopList) {
    const n = stopList.length;
    const distMatrix  = [];
    const camMatrix   = [];

    // Build matrices — fetch all legs in parallel rows
    for (let i = 0; i < n; i++) {
      distMatrix[i] = [];
      camMatrix[i]  = [];
      const rowPromises = [];
      for (let j = 0; j < n; j++) {
        if (i === j) {
          rowPromises.push(Promise.resolve({ distance: 0, duration: 0, coords: [], cameras: 0 }));
        } else {
          rowPromises.push(
            fetchLegRoute(stopList[i].coords, stopList[j].coords).then(leg => ({
              ...leg,
              cameras: countCamerasOnLeg(leg.coords),
            }))
          );
        }
      }
      const row = await Promise.all(rowPromises);
      for (let j = 0; j < n; j++) {
        distMatrix[i][j] = row[j].distance || 0;
        camMatrix[i][j]  = row[j].cameras  || 0;
      }
    }

    return { distMatrix, camMatrix };
  }

  /** Compute total cost for a given ordering. */
  function orderCost(order, distMatrix, camMatrix, alpha, beta, maxDist, maxCam) {
    let totalCost = 0;
    let totalDist = 0;
    let totalCams = 0;
    for (let i = 0; i < order.length - 1; i++) {
      const a = order[i];
      const b = order[i + 1];
      totalDist += distMatrix[a][b];
      totalCams += camMatrix[a][b];
    }
    // Normalize if possible
    const normDist = maxDist > 0 ? totalDist / maxDist : 0;
    const normCam  = maxCam  > 0 ? totalCams / maxCam  : 0;
    totalCost = alpha * normDist + beta * normCam;
    return { cost: totalCost, totalDist, totalCams };
  }

  /**
   * TSP optimization.
   * For N≤6 waypoints: brute force all permutations.
   * For N>6: nearest-neighbor heuristic (fast, good enough).
   *
   * The start point (index 0) is always fixed at position 0.
   * We optimize the ordering of intermediate stops (indices 1..n-2)
   * keeping start fixed. End destination (index n-1) is also fixed.
   */
  async function optimizeOrder(stopList, alpha, beta) {
    const n = stopList.length;

    if (n < 2) return { fastest: [0], privacy: [0], legs: {} };

    // Build matrices
    showMultiStopLoading('Building route matrix…');
    const { distMatrix, camMatrix } = await buildMatrices(stopList);

    // Find normalization factors
    let maxDist = 0, maxCam = 0;
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        if (distMatrix[i][j] > maxDist) maxDist = distMatrix[i][j];
        if (camMatrix[i][j] > maxCam)   maxCam  = camMatrix[i][j];
      }
    }

    const middleIndices = [];
    for (let i = 1; i < n - 1; i++) middleIndices.push(i);

    let fastestOrder = null;
    let fastestCost  = Infinity;
    let privacyOrder = null;
    let privacyCost  = Infinity;

    if (middleIndices.length === 0) {
      // Only 2 stops (start→end), no reordering possible
      fastestOrder = [0, n - 1];
      privacyOrder = [0, n - 1];
    } else if (middleIndices.length <= 5) {
      // Brute force permutations of middle stops (≤5 midpoints → ≤120 permutations)
      showMultiStopLoading(`Evaluating ${Math.min(720, permutations(middleIndices).length)} permutations…`);
      const perms = permutations(middleIndices);
      for (const perm of perms) {
        const order = [0, ...perm, n - 1];
        const { cost: spCost, totalDist } = orderCost(order, distMatrix, camMatrix, 1, 0, maxDist, maxCam);
        const { cost: prCost } = orderCost(order, distMatrix, camMatrix, alpha, beta, maxDist, maxCam);

        if (spCost < fastestCost) { fastestCost = spCost; fastestOrder = order.slice(); }
        if (prCost < privacyCost) { privacyCost = prCost; privacyOrder = order.slice(); }
      }
    } else {
      // Heuristic for N>6 waypoints
      showMultiStopLoading('Running heuristic optimization…');

      // Speed cost matrix: pure distance
      const speedCostMatrix = distMatrix.map((row, i) =>
        row.map((d, j) => (i === j ? Infinity : d / (maxDist || 1)))
      );
      // Privacy cost matrix: alpha*dist + beta*cams
      const privCostMatrix = distMatrix.map((row, i) =>
        row.map((d, j) => {
          if (i === j) return Infinity;
          return alpha * (d / (maxDist || 1)) + beta * (camMatrix[i][j] / (maxCam || 1));
        })
      );

      const speedNN = nearestNeighborTSP(distMatrix, speedCostMatrix);
      const privNN  = nearestNeighborTSP(distMatrix, privCostMatrix);

      fastestOrder = speedNN;
      privacyOrder = privNN;
    }

    return { fastestOrder, privacyOrder, distMatrix, camMatrix };
  }

  /**
   * Fetch detailed leg routes for a given stop ordering.
   */
  async function fetchOrderedLegs(stopList, order) {
    const legs = [];
    for (let i = 0; i < order.length - 1; i++) {
      const from = stopList[order[i]];
      const to   = stopList[order[i + 1]];
      const leg  = await fetchLegRoute(from.coords, to.coords);
      legs.push({
        fromName: from.name || `Stop ${order[i] + 1}`,
        toName:   to.name   || `Stop ${order[i + 1] + 1}`,
        distance: leg.distance,
        duration: leg.duration,
        coords:   leg.coords,
        geometry: leg.geometry,
        cameras:  countCamerasOnLeg(leg.coords),
      });
    }
    return legs;
  }

  // ── UI helpers ─────────────────────────────────────────────────────────────

  function showMultiStopLoading(msg) {
    const el = document.getElementById('multistop-results');
    if (el) {
      el.style.display = 'block';
      el.innerHTML = `<div style="font-size:11px;color:#8b949e;text-align:center;padding:12px">
        <div class="spinner" style="margin:0 auto 8px;width:16px;height:16px"></div>
        <div>${msg || 'Calculating…'}</div>
      </div>`;
    }
  }

  function fmtDist(m)  { return m >= 1000 ? `${(m/1000).toFixed(1)} km` : `${Math.round(m)} m`; }
  function fmtTime(s)  { const m = Math.round(s/60); return m < 60 ? `${m} min` : `${Math.floor(m/60)}h ${m%60}m`; }

  function renderLegList(legs, containerId) {
    const el = document.getElementById(containerId);
    if (!el) return;
    if (!legs || !legs.length) { el.innerHTML = ''; return; }

    const totalDist = legs.reduce((s, l) => s + l.distance, 0);
    const totalCams = legs.reduce((s, l) => s + l.cameras, 0);
    const totalTime = legs.reduce((s, l) => s + l.duration, 0);

    el.innerHTML = `
      <div style="font-size:10px;color:#6b7280;margin-bottom:4px">
        ${fmtDist(totalDist)} · ${fmtTime(totalTime)} · ${totalCams} camera${totalCams !== 1 ? 's' : ''} total
      </div>
      ${legs.map((leg, i) => `
        <div style="display:flex;align-items:center;gap:4px;font-size:10px;color:#9ca3af;padding:3px 0;border-bottom:1px solid rgba(255,255,255,0.04)">
          <span style="flex-shrink:0;width:14px;height:14px;border-radius:50%;background:${leg.cameras === 0 ? '#22c55e' : leg.cameras <= 2 ? '#eab308' : '#ef4444'};display:inline-block"></span>
          <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${leg.fromName} → ${leg.toName}</span>
          <span style="flex-shrink:0;color:${leg.cameras === 0 ? '#22c55e' : leg.cameras <= 2 ? '#eab308' : '#ef4444'};font-weight:600">${leg.cameras} 📷</span>
          <span style="flex-shrink:0;color:#4b5563">${fmtDist(leg.distance)}</span>
        </div>
      `).join('')}
    `;
  }

  function renderMultiStopResults(fastestLegs, privacyLegs, fastestOrder, privacyOrder, stops) {
    const el = document.getElementById('multistop-results');
    if (!el) return;
    el.style.display = 'block';

    const fDist = fastestLegs.reduce((s, l) => s + l.distance, 0);
    const fCams = fastestLegs.reduce((s, l) => s + l.cameras, 0);
    const fTime = fastestLegs.reduce((s, l) => s + l.duration, 0);

    const pDist = privacyLegs.reduce((s, l) => s + l.distance, 0);
    const pCams = privacyLegs.reduce((s, l) => s + l.cameras, 0);
    const pTime = privacyLegs.reduce((s, l) => s + l.duration, 0);

    const camsSaved = Math.max(0, fCams - pCams);
    const pctSaved  = fCams > 0 ? Math.round(camsSaved / fCams * 100) : 0;

    // Fastest card stats
    const fStats = document.getElementById('multistop-fastest-stats');
    if (fStats) fStats.innerHTML = `
      <span style="color:#9ca3af">${fmtDist(fDist)} · ${fmtTime(fTime)}</span> ·
      <span style="color:${fCams > 3 ? '#ef4444' : '#eab308'};font-weight:700">${fCams} cameras</span>
    `;

    // Privacy card stats
    const pStats = document.getElementById('multistop-privacy-stats');
    if (pStats) pStats.innerHTML = `
      <span style="color:#9ca3af">${fmtDist(pDist)} · ${fmtTime(pTime)}</span> ·
      <span style="color:${pCams === 0 ? '#22c55e' : pCams <= 2 ? '#eab308' : '#ef4444'};font-weight:700">${pCams} cameras</span>
    `;

    // Savings badge
    const badge = document.getElementById('multistop-savings-badge');
    if (badge) {
      if (camsSaved > 0) {
        badge.style.display = 'inline-block';
        badge.textContent = `-${camsSaved} cameras (${pctSaved}% fewer)`;
      } else {
        badge.style.display = 'none';
      }
    }

    // Reorder suggestion
    const reorderEl = document.getElementById('multistop-reorder-suggestion');
    const ordersMatch = JSON.stringify(fastestOrder) === JSON.stringify(privacyOrder);
    if (reorderEl) {
      if (!ordersMatch && camsSaved > 0) {
        const privacyRoute = privacyOrder.map(i => stops[i]?.name || `Stop ${i + 1}`).join(' → ');
        reorderEl.style.display = 'block';
        reorderEl.innerHTML = `
          <div style="font-weight:600;margin-bottom:4px">♻️ Suggested order:</div>
          <div style="color:#a7f3d0">${privacyRoute}</div>
          <div style="color:#4ade80;margin-top:4px">Saves ${camsSaved} camera${camsSaved !== 1 ? 's' : ''} (${pctSaved}% reduction)</div>
        `;
      } else if (ordersMatch) {
        reorderEl.style.display = 'block';
        reorderEl.innerHTML = `<div style="color:#6b7280">✓ Current order is already optimal for privacy.</div>`;
      } else {
        reorderEl.style.display = 'none';
      }
    }

    // Render leg lists
    renderLegList(fastestLegs, 'multistop-fastest-legs');
    renderLegList(privacyLegs, 'multistop-privacy-legs');

    // Restore results container (clear loading state)
    const resultsEl = document.getElementById('multistop-results');
    if (resultsEl) {
      // Re-show the cards that may have been replaced by loader
      const fastestCard = document.getElementById('multistop-fastest-card');
      const privacyCard = document.getElementById('multistop-privacy-card');
      if (fastestCard) fastestCard.style.display = 'block';
      if (privacyCard) privacyCard.style.display = 'block';
    }
  }

  // ── Stop management ────────────────────────────────────────────────────────

  function createStopElement(stopId, stopNum, label) {
    const div = document.createElement('div');
    div.id = `multistop-stop-${stopId}`;
    div.dataset.stopId = stopId;
    div.style.cssText = 'display:flex;align-items:center;gap:6px;padding:4px 0';

    const badge = document.createElement('span');
    badge.style.cssText = `flex-shrink:0;width:20px;height:20px;border-radius:50%;background:${label === 'S' ? '#22c55e' : label === 'E' ? '#ef4444' : '#6b7280'};display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:700;color:white`;
    badge.textContent = label;
    badge.className = 'stop-badge';

    const wrapper = document.createElement('div');
    wrapper.style.cssText = 'flex:1;position:relative';

    const input = document.createElement('input');
    input.type = 'text';
    input.placeholder = label === 'S' ? 'Start location…' : label === 'E' ? 'Final destination…' : `Waypoint ${stopNum}…`;
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.style.cssText = 'width:100%;box-sizing:border-box;background:#0d1117;border:1px solid #30363d;color:#e5e5e5;padding:5px 8px;border-radius:4px;font-size:11px;font-family:monospace';
    input.id = `multistop-input-${stopId}`;

    const dropdown = document.createElement('div');
    dropdown.id = `multistop-dropdown-${stopId}`;
    dropdown.className = 'search-dropdown hidden';
    dropdown.style.cssText = 'position:absolute;top:100%;left:0;right:0;z-index:2000;background:#0d1117;border:1px solid #30363d;border-radius:4px;max-height:160px;overflow-y:auto';

    wrapper.appendChild(input);
    wrapper.appendChild(dropdown);

    div.appendChild(badge);
    div.appendChild(wrapper);

    // Add drag handles and remove buttons for middle stops
    if (label !== 'S' && label !== 'E') {
      const upBtn = document.createElement('button');
      upBtn.textContent = '↑';
      upBtn.title = 'Move up';
      upBtn.style.cssText = 'background:none;border:1px solid #374151;color:#6b7280;padding:2px 5px;border-radius:3px;cursor:pointer;font-size:10px';
      upBtn.onclick = () => moveStop(stopId, -1);

      const downBtn = document.createElement('button');
      downBtn.textContent = '↓';
      downBtn.title = 'Move down';
      downBtn.style.cssText = 'background:none;border:1px solid #374151;color:#6b7280;padding:2px 5px;border-radius:3px;cursor:pointer;font-size:10px';
      downBtn.onclick = () => moveStop(stopId, 1);

      const removeBtn = document.createElement('button');
      removeBtn.textContent = '✕';
      removeBtn.title = 'Remove stop';
      removeBtn.style.cssText = 'background:none;border:1px solid #374151;color:#ef4444;padding:2px 5px;border-radius:3px;cursor:pointer;font-size:10px';
      removeBtn.onclick = () => removeStop(stopId);

      div.appendChild(upBtn);
      div.appendChild(downBtn);
      div.appendChild(removeBtn);
    }

    return { el: div, input, dropdown };
  }

  function rebuildStopsList() {
    const container = document.getElementById('multistop-stops-list');
    if (!container) return;
    container.innerHTML = '';

    const countEl = document.getElementById('multistop-count');
    if (countEl) countEl.textContent = Math.max(0, _stops.length - 2);

    _stops.forEach((stop, i) => {
      const label = i === 0 ? 'S' : (i === _stops.length - 1 ? 'E' : String(i));
      container.appendChild(stop.el);
    });
  }

  function addStop(afterIndex) {
    if (_stops.length >= 9) { // max 8 stops (2 fixed + 6 middle)
      showToast('Maximum 8 stops reached');
      return;
    }

    const id = ++_stopCounter;
    const num = _stops.length - 1; // Before end stop
    const { el, input, dropdown } = createStopElement(id, num, String(num));

    const stop = { id, name: '', coords: null, el, input, dropdown };

    // Insert before the last stop (end destination)
    _stops.splice(_stops.length - 1, 0, stop);

    // Setup geocoding for this input
    setupMultiStopInput(stop);
    rebuildStopsList();
    input.focus();
  }

  function removeStop(stopId) {
    const idx = _stops.findIndex(s => s.id === stopId);
    if (idx < 0 || idx === 0 || idx === _stops.length - 1) return; // Can't remove start/end
    _stops.splice(idx, 1);
    rebuildStopsList();
  }

  function moveStop(stopId, direction) {
    const idx = _stops.findIndex(s => s.id === stopId);
    if (idx < 0) return;
    const newIdx = idx + direction;
    if (newIdx <= 0 || newIdx >= _stops.length - 1) return; // Protect start/end

    const tmp = _stops[idx];
    _stops[idx] = _stops[newIdx];
    _stops[newIdx] = tmp;
    rebuildStopsList();
  }

  function setupMultiStopInput(stop) {
    const { input, dropdown } = stop;
    let timer = null;
    let currentResults = [];
    let focusedIdx = -1;

    function renderDropdown(items) {
      dropdown.innerHTML = '';
      focusedIdx = -1;
      if (!items.length) { dropdown.classList.add('hidden'); return; }
      items.forEach((item, i) => {
        const div = document.createElement('div');
        div.className = 'search-item';
        div.style.cssText = 'padding:8px 10px;cursor:pointer;border-bottom:1px solid #1a2030;font-size:11px';
        div.innerHTML = `<div style="font-weight:600;color:#e5e5e5">${item.name}</div><div style="color:#6b7280;font-size:10px">${item.address}</div>`;
        div.addEventListener('mousedown', (e) => {
          e.preventDefault();
          selectItem(item);
        });
        dropdown.appendChild(div);
      });
      dropdown.classList.remove('hidden');
    }

    function selectItem(item) {
      input.value = item.name + (item.address ? `, ${item.address.split(',')[0]}` : '');
      stop.name   = input.value;
      stop.coords = { lat: item.lat, lng: item.lng };
      dropdown.classList.add('hidden');
      dropdown.innerHTML = '';
      input.style.borderColor = '#22c55e';
    }

    input.addEventListener('input', () => {
      const q = input.value.trim();
      input.style.borderColor = '#30363d';
      stop.coords = null;
      if (!q || q.length < 2) { dropdown.classList.add('hidden'); return; }
      clearTimeout(timer);
      timer = setTimeout(async () => {
        const results = await geocodeSearch(q);
        currentResults = results.map(r => formatNominatimResult(r));
        renderDropdown(currentResults);
      }, 300);
    });

    input.addEventListener('blur', () => {
      setTimeout(() => dropdown.classList.add('hidden'), 200);
    });

    input.addEventListener('keydown', (e) => {
      const items = dropdown.querySelectorAll('.search-item');
      if (e.key === 'ArrowDown') {
        focusedIdx = Math.min(focusedIdx + 1, items.length - 1);
        items.forEach((el, i) => el.style.background = i === focusedIdx ? '#1a2030' : '');
        e.preventDefault();
      } else if (e.key === 'ArrowUp') {
        focusedIdx = Math.max(focusedIdx - 1, 0);
        items.forEach((el, i) => el.style.background = i === focusedIdx ? '#1a2030' : '');
        e.preventDefault();
      } else if (e.key === 'Enter' && focusedIdx >= 0 && currentResults[focusedIdx]) {
        selectItem(currentResults[focusedIdx]);
        e.preventDefault();
      } else if (e.key === 'Escape') {
        dropdown.classList.add('hidden');
      }
    });
  }

  // ── Map drawing ────────────────────────────────────────────────────────────

  function clearMultiRouteLayers() {
    _multiRouteLayers.forEach(l => {
      if (map && l) try { map.removeLayer(l); } catch(_) {}
    });
    _multiRouteLayers = [];
  }

  function drawMultiStopRoute(legs, color, weight, opacity, dashArray) {
    if (!map) return;
    const layerGroup = L.layerGroup();
    legs.forEach((leg, i) => {
      const latlngs = leg.coords.map(([lng, lat]) => [lat, lng]);
      const line = L.polyline(latlngs, {
        color, weight: weight || 5, opacity: opacity || 0.8,
        dashArray: dashArray || null,
      });
      line.bindTooltip(
        `Leg ${i + 1}: ${leg.fromName} → ${leg.toName}<br>${fmtDist(leg.distance)} · ${leg.cameras} cameras`,
        { sticky: true }
      );
      layerGroup.addLayer(line);

      // Add stop markers
      if (latlngs.length > 0) {
        const startLl = latlngs[0];
        const endLl   = latlngs[latlngs.length - 1];
        const isFirst = i === 0;
        const isLast  = i === legs.length - 1;
        if (isFirst) {
          layerGroup.addLayer(L.circleMarker(startLl, {
            radius: 8, fillColor: '#22c55e', color: 'white', weight: 2, fillOpacity: 1,
          }).bindTooltip(leg.fromName));
        }
        layerGroup.addLayer(L.circleMarker(endLl, {
          radius: isLast ? 8 : 6,
          fillColor: isLast ? '#ef4444' : '#6b7280',
          color: 'white', weight: 2, fillOpacity: 1,
        }).bindTooltip(leg.toName));
      }
    });
    layerGroup.addTo(map);
    _multiRouteLayers.push(layerGroup);

    // Fit map to all route points
    const allCoords = legs.flatMap(l => l.coords.map(([lng, lat]) => [lat, lng]));
    if (allCoords.length > 0) {
      try { map.fitBounds(L.latLngBounds(allCoords), { padding: [40, 40] }); } catch(_) {}
    }

    return layerGroup;
  }

  // ── Main flow ──────────────────────────────────────────────────────────────

  async function calculateMultiStop() {
    // Validate all stops have coordinates
    const missingIdx = _stops.findIndex(s => !s.coords);
    if (missingIdx >= 0) {
      const name = _stops[missingIdx].input?.placeholder || `Stop ${missingIdx + 1}`;
      showToast(`Please set location for: ${name}`);
      _stops[missingIdx].input?.focus();
      return;
    }

    if (_stops.length < 2) {
      showToast('Add at least a start and destination');
      return;
    }

    showMultiStopLoading('Optimizing route…');
    clearMultiRouteLayers();

    try {
      const { fastestOrder, privacyOrder, distMatrix, camMatrix } =
        await optimizeOrder(_stops, _multiAlpha, _multiBeta);

      _fastestOrder = fastestOrder;
      _privacyOrder = privacyOrder;

      showMultiStopLoading('Fetching route details…');
      const [fastestLegs, privacyLegs] = await Promise.all([
        fetchOrderedLegs(_stops, fastestOrder),
        fetchOrderedLegs(_stops, privacyOrder),
      ]);

      renderMultiStopResults(fastestLegs, privacyLegs, fastestOrder, privacyOrder, _stops);

      // Default: show privacy route on map
      clearMultiRouteLayers();
      drawMultiStopRoute(privacyLegs, '#22c55e', 6, 0.85);

    } catch (err) {
      console.error('[MultiStop] Error:', err);
      const el = document.getElementById('multistop-results');
      if (el) el.innerHTML = `<div style="color:#ef4444;font-size:11px;padding:8px">Error: ${err.message}</div>`;
    }
  }

  async function suggestReorder() {
    const missingIdx = _stops.findIndex(s => !s.coords);
    if (missingIdx >= 0) {
      showToast('Please set all stop locations first');
      return;
    }
    if (_stops.length < 3) {
      showToast('Add at least one waypoint between start and destination to reorder');
      return;
    }

    // Force privacy priority for suggestion
    await calculateMultiStop();
  }

  // ── UI initialization ──────────────────────────────────────────────────────

  function initMultiStopUI() {
    const toggle = document.getElementById('multistop-mode-toggle');
    if (!toggle) return;

    // Initialize with start + end stops
    function initStops() {
      _stops = [];
      _stopCounter = 0;

      const startId = ++_stopCounter;
      const endId   = ++_stopCounter;

      const startEl = createStopElement(startId, 0, 'S');
      const endEl   = createStopElement(endId,   0, 'E');

      const startStop = { id: startId, name: '', coords: null, ...startEl };
      const endStop   = { id: endId,   name: '', coords: null, ...endEl };

      // Pre-fill from existing startCoords/endCoords if available
      if (startCoords && document.getElementById('start-input')?.value) {
        startStop.coords = { ...startCoords };
        startStop.name   = document.getElementById('start-input').value;
        startEl.input.value = startStop.name;
        startEl.input.style.borderColor = '#22c55e';
      }
      if (endCoords && document.getElementById('end-input')?.value) {
        endStop.coords = { ...endCoords };
        endStop.name   = document.getElementById('end-input').value;
        endEl.input.value = endStop.name;
        endEl.input.style.borderColor = '#22c55e';
      }

      _stops = [startStop, endStop];
      setupMultiStopInput(startStop);
      setupMultiStopInput(endStop);
      rebuildStopsList();
    }

    toggle.addEventListener('change', (e) => {
      _multiStopActive = e.target.checked;
      const panel = document.getElementById('multistop-panel');
      if (panel) panel.style.display = _multiStopActive ? 'block' : 'none';

      if (_multiStopActive) {
        initStops();
      } else {
        clearMultiRouteLayers();
      }
    });

    // Add stop button
    const addBtn = document.getElementById('multistop-add-btn');
    if (addBtn) addBtn.addEventListener('click', () => addStop());

    // Calculate route button
    const routeBtn = document.getElementById('multistop-route-btn');
    if (routeBtn) routeBtn.addEventListener('click', calculateMultiStop);

    // Suggest reorder button
    const reorderBtn = document.getElementById('multistop-reorder-btn');
    if (reorderBtn) reorderBtn.addEventListener('click', suggestReorder);

    // Alpha/Beta slider
    const slider = document.getElementById('multistop-alpha-slider');
    const label  = document.getElementById('multistop-priority-label');
    if (slider) {
      slider.addEventListener('input', () => {
        const v = parseInt(slider.value, 10);
        // v=0 → all privacy (alpha=0, beta=1)
        // v=50 → balanced (alpha=0.5, beta=0.5)
        // v=100 → all speed (alpha=1, beta=0)
        _multiAlpha = v / 100;
        _multiBeta  = 1 - _multiAlpha;
        if (label) {
          if (v < 30)      label.textContent = '🔒 Privacy Priority';
          else if (v > 70) label.textContent = '⚡ Speed Priority';
          else             label.textContent = 'Balanced';
          label.style.color = v < 30 ? '#22c55e' : v > 70 ? '#eab308' : '#22c55e';
        }
      });
    }

    // Show fastest / Show privacy buttons
    document.addEventListener('click', async (e) => {
      if (e.target.id === 'multistop-show-fastest' && _fastestOrder) {
        clearMultiRouteLayers();
        showMultiStopLoading('Loading fastest route…');
        const legs = await fetchOrderedLegs(_stops, _fastestOrder);
        const el = document.getElementById('multistop-results');
        if (el) el.style.display = 'block'; // restore after loading replaced it
        drawMultiStopRoute(legs, '#6b7280', 5, 0.7, '8, 5');
        renderLegList(legs, 'multistop-fastest-legs');
      }
      if (e.target.id === 'multistop-show-privacy' && _privacyOrder) {
        clearMultiRouteLayers();
        showMultiStopLoading('Loading privacy route…');
        const legs = await fetchOrderedLegs(_stops, _privacyOrder);
        const el = document.getElementById('multistop-results');
        if (el) el.style.display = 'block';
        drawMultiStopRoute(legs, '#22c55e', 6, 0.85);
        renderLegList(legs, 'multistop-privacy-legs');
      }
    });
  }

  // Wait for DOM to be ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initMultiStopUI);
  } else {
    initMultiStopUI();
  }

  // Expose for debugging
  window.GhostMultiStop = {
    stops:      () => _stops,
    calculate:  calculateMultiStop,
    reorder:    suggestReorder,
    alpha:      () => _multiAlpha,
    beta:       () => _multiBeta,
  };

})();

// ─── CameraFOVLayer (ghost-fov-visualization) ────────────────────────────────
// Renders camera field-of-view cones on a Leaflet SVG overlay.
// - Hybrid SVG (< 50 cameras) / Canvas-backed approach
// - Color by camera type; full 360° ring for unknown direction
// - Hover brightens cone and shows tooltip
// - Off by default (performance)
// ─────────────────────────────────────────────────────────────────────────────

const CameraFOVLayer = (function() {
  'use strict';

  // ── Constants ──────────────────────────────────────────────────────────────
  const FOV_RADIUS_M      = 70;    // meters — cone length on ground
  const DEFAULT_FOV_DEG   = 60;    // default angle if camera:angle missing
  const CANVAS_THRESHOLD  = 50;    // switch to canvas path rendering above this count

  // Color map: category → { fill, opacity }
  const TYPE_COLORS = {
    anpr:       { fill: '#ff4444', opacity: 0.40 },
    automatic:  { fill: '#ff4444', opacity: 0.40 },
    public:     { fill: '#ff8800', opacity: 0.35 },
    city:       { fill: '#ff8800', opacity: 0.35 },
    private:    { fill: '#ffcc00', opacity: 0.30 },
    indoor:     { fill: '#ffcc00', opacity: 0.30 },
    unknown:    { fill: '#888888', opacity: 0.25 },
  };

  // ── State ──────────────────────────────────────────────────────────────────
  let _map          = null;
  let _visible      = false;
  let _svgLayer     = null;
  let _svgEl        = null;
  let _cameras      = [];
  let _tooltip      = null;
  let _coneEls      = [];      // rendered <path> elements

  // ── Helpers ────────────────────────────────────────────────────────────────

  function colorForCamera(cam) {
    const tags = cam.tags || {};
    const survType = (tags['surveillance:type'] || '').toLowerCase();
    const camType  = (tags['camera:type']        || '').toLowerCase();

    if (survType === 'anpr' || survType === 'alpr' || camType === 'automatic') {
      return TYPE_COLORS.anpr;
    }
    if (survType === 'public' || survType === 'city') {
      return TYPE_COLORS.public;
    }
    if (survType === 'private' || survType === 'indoor') {
      return TYPE_COLORS.private;
    }
    return TYPE_COLORS.unknown;
  }

  /**
   * Convert meters to degrees latitude (rough approximation for cone radius).
   * Used to estimate the pixel radius at a given map zoom.
   */
  function metersToPixels(map, lat, meters) {
    const R       = 6371000;
    const latRad  = lat * Math.PI / 180;
    const scale   = map.getZoomScale(map.getZoom(), 0);
    // Leaflet: at zoom 0, 1° ≈ 111320m ≈ 256px / 360deg
    // We use latLngToLayerPoint to get two close points and measure distance.
    const pt1 = map.latLngToLayerPoint([lat, 0]);
    const pt2 = map.latLngToLayerPoint([lat + (meters / 111320), 0]);
    return Math.abs(pt2.y - pt1.y);
  }

  /**
   * Build an SVG path string for a FOV cone (wedge/arc).
   * @param {L.Point} pt      - camera position in layer-point coords
   * @param {number}  bearing - compass bearing 0-360 (0 = north, 90 = east)
   * @param {number}  angle   - total FOV width in degrees
   * @param {number}  radius  - cone radius in pixels
   * @param {boolean} isDome  - if true, draw a full circle ring instead
   */
  function buildConePath(pt, bearing, angle, radius, isDome) {
    const x = pt.x;
    const y = pt.y;

    if (isDome) {
      // Full circle (360° dome)
      return [
        `M ${x - radius} ${y}`,
        `A ${radius} ${radius} 0 1 0 ${x + radius} ${y}`,
        `A ${radius} ${radius} 0 1 0 ${x - radius} ${y}`,
        'Z',
      ].join(' ');
    }

    // Convert bearing (clockwise from north) to SVG angle (clockwise from east, y-flipped)
    // SVG x-axis = east, y-axis = down
    // Bearing 0° = north = SVG -90°; bearing 90° = east = SVG 0°
    const halfAngle  = angle / 2;
    const startBear  = bearing - halfAngle;
    const endBear    = bearing + halfAngle;

    // Convert to radians from SVG's east-axis reference (right), y-flips map north
    function bearToRad(b) {
      return (b - 90) * Math.PI / 180;
    }

    const startRad = bearToRad(startBear);
    const endRad   = bearToRad(endBear);

    const x1 = x + radius * Math.cos(startRad);
    const y1 = y + radius * Math.sin(startRad);
    const x2 = x + radius * Math.cos(endRad);
    const y2 = y + radius * Math.sin(endRad);

    const largeArc = angle > 180 ? 1 : 0;

    return [
      `M ${x} ${y}`,
      `L ${x1.toFixed(2)} ${y1.toFixed(2)}`,
      `A ${radius.toFixed(2)} ${radius.toFixed(2)} 0 ${largeArc} 1 ${x2.toFixed(2)} ${y2.toFixed(2)}`,
      'Z',
    ].join(' ');
  }

  // ── Tooltip ────────────────────────────────────────────────────────────────

  function createTooltip() {
    if (_tooltip) return;
    _tooltip = document.createElement('div');
    _tooltip.className = 'ghost-fov-tooltip';
    _tooltip.style.cssText = 'position:fixed;z-index:9000;display:none';
    document.body.appendChild(_tooltip);
  }

  function showTooltipForCam(cam, x, y) {
    if (!_tooltip) return;
    const tags = cam.tags || {};
    const dir  = tags['camera:direction'] || tags.direction || '?';
    const type = tags['camera:type']       || tags['surveillance:type'] || 'Unknown';
    const op   = tags.operator            || 'Unknown operator';
    const angle = tags['camera:angle']     || DEFAULT_FOV_DEG + '°(default)';

    _tooltip.innerHTML = [
      `<b>📷 Camera FOV</b>`,
      `Type: ${type}`,
      `Direction: ${dir}°`,
      `FOV: ${angle}°`,
      `Operator: ${op}`,
    ].join('<br>');

    _tooltip.style.display = 'block';
    _tooltip.style.left    = (x + 14) + 'px';
    _tooltip.style.top     = (y - 10) + 'px';
  }

  function hideTooltip() {
    if (_tooltip) _tooltip.style.display = 'none';
  }

  // ── Rendering ──────────────────────────────────────────────────────────────

  function clearCones() {
    _coneEls.forEach(el => el.parentNode && el.parentNode.removeChild(el));
    _coneEls = [];
  }

  function renderCones() {
    if (!_map || !_visible || !_svgEl) return;

    clearCones();

    const useCanvas = _cameras.length > CANVAS_THRESHOLD;

    if (useCanvas) {
      renderConvasCanvas();
    } else {
      renderSVGCones();
    }
  }

  /**
   * SVG path rendering (< 50 cameras).
   * Creates one <path> per camera in the Leaflet SVG overlay.
   */
  function renderSVGCones() {
    const svgNS  = 'http://www.w3.org/2000/svg';
    const bounds = _map.getBounds();

    _cameras.forEach(cam => {
      if (!bounds.contains([cam.lat, cam.lon ?? cam.lng])) return;

      const latlng  = L.latLng(cam.lat, cam.lon ?? cam.lng);
      const pt      = _map.latLngToLayerPoint(latlng);
      const radius  = metersToPixels(_map, cam.lat, FOV_RADIUS_M);

      const tags    = cam.tags || {};
      const dirVal  = tags['camera:direction'] || tags.direction || null;
      const bearing = parseBearing(dirVal);
      const isDome  = bearing === null;

      const camType = (tags['camera:type'] || '').toLowerCase();
      const isDomeCam = camType === 'dome' || camType === 'ptz';
      const showRing  = isDome || isDomeCam;

      const fovAngle = parseFloat(tags['camera:angle']) || DEFAULT_FOV_DEG;
      const { fill, opacity } = colorForCamera(cam);

      const pathStr = buildConePath(pt, bearing ?? 0, fovAngle, radius, showRing);

      const path = document.createElementNS(svgNS, 'path');
      path.setAttribute('d',               pathStr);
      path.setAttribute('fill',            fill);
      path.setAttribute('fill-opacity',    String(opacity));
      path.setAttribute('stroke',          fill);
      path.setAttribute('stroke-opacity',  '0.6');
      path.setAttribute('stroke-width',    '1');
      path.setAttribute('class',           'ghost-fov-cone');
      path.setAttribute('data-cam-id',     String(cam.id));

      // Hover handlers
      path.addEventListener('mouseenter', (e) => {
        path.setAttribute('fill-opacity', String(Math.min(1, opacity + 0.3)));
        path.setAttribute('stroke-width', '2');
        showTooltipForCam(cam, e.clientX, e.clientY);
      });
      path.addEventListener('mousemove', (e) => {
        showTooltipForCam(cam, e.clientX, e.clientY);
      });
      path.addEventListener('mouseleave', () => {
        path.setAttribute('fill-opacity', String(opacity));
        path.setAttribute('stroke-width', '1');
        hideTooltip();
      });

      _svgEl.appendChild(path);
      _coneEls.push(path);
    });
  }

  /**
   * Canvas-backed rendering for dense camera sets (> 50).
   * Uses a hidden <canvas> composited over the SVG layer.
   */
  function renderConvasCanvas() {
    // Create a canvas sized to the map pane if not yet existing
    const mapPane = _map.getPanes().overlayPane;
    let canvas    = document.getElementById('ghost-fov-canvas');
    const size    = _map.getSize();

    if (!canvas) {
      canvas = document.createElement('canvas');
      canvas.id = 'ghost-fov-canvas';
      canvas.style.cssText = `
        position:absolute;top:0;left:0;pointer-events:none;z-index:300;
      `;
      mapPane.appendChild(canvas);
    }
    canvas.width  = size.x;
    canvas.height = size.y;

    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, size.x, size.y);

    const bounds = _map.getBounds();

    _cameras.forEach(cam => {
      if (!bounds.contains([cam.lat, cam.lon ?? cam.lng])) return;

      const latlng  = L.latLng(cam.lat, cam.lon ?? cam.lng);
      const pt      = _map.latLngToLayerPoint(latlng);
      const radius  = metersToPixels(_map, cam.lat, FOV_RADIUS_M);

      const tags    = cam.tags || {};
      const dirVal  = tags['camera:direction'] || tags.direction || null;
      const bearing = parseBearing(dirVal);

      const camType  = (tags['camera:type'] || '').toLowerCase();
      const isDomeCam = camType === 'dome' || camType === 'ptz' || bearing === null;

      const fovAngle = parseFloat(tags['camera:angle']) || DEFAULT_FOV_DEG;
      const { fill, opacity } = colorForCamera(cam);

      ctx.save();
      ctx.globalAlpha = opacity;
      ctx.fillStyle   = fill;
      ctx.strokeStyle = fill;
      ctx.lineWidth   = 1;
      ctx.globalCompositeOperation = 'source-over';

      if (isDomeCam) {
        // Full ring
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, radius, 0, Math.PI * 2);
        ctx.fill();
      } else {
        // Wedge
        const halfAngle = (fovAngle / 2) * Math.PI / 180;
        // Convert bearing to canvas angle: 0=north, clockwise
        // Canvas: 0=east, counter-clockwise from east
        const bearRad  = (bearing - 90) * Math.PI / 180;
        const startAng = bearRad - halfAngle;
        const endAng   = bearRad + halfAngle;

        ctx.beginPath();
        ctx.moveTo(pt.x, pt.y);
        ctx.arc(pt.x, pt.y, radius, startAng, endAng, false);
        ctx.closePath();
        ctx.fill();
      }
      ctx.restore();
    });

    // Store canvas ref for cleanup
    _coneEls.push({ parentNode: canvas.parentNode, remove: () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    }});
  }

  /**
   * Reposition SVG/canvas elements when the map moves (pan/zoom).
   * Leaflet does not auto-reproject SVG children.
   */
  function onMapViewChange() {
    if (!_visible) return;

    // For canvas mode, reposition the canvas element to the map's layer origin
    const canvas = document.getElementById('ghost-fov-canvas');
    if (canvas) {
      const origin = _map.getPixelOrigin();
      canvas.style.transform = `translate(${-origin.x}px, ${-origin.y}px)`;
    }

    renderCones();
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  function init(leafletMap) {
    _map = leafletMap;

    // Create a Leaflet SVG overlay layer
    _svgLayer = L.svg({ padding: 0.5 }).addTo(_map);
    // Access the raw SVG container from Leaflet
    _svgEl = _svgLayer._container;

    createTooltip();

    // Re-render on view changes
    _map.on('moveend zoomend', onMapViewChange);

    // Wire up toggle button
    const btn = document.getElementById('fov-toggle-btn');
    if (btn) {
      btn.addEventListener('click', toggle);
    }
  }

  function update(cameraList) {
    _cameras = cameraList || [];
    if (_visible) renderCones();
  }

  function toggle() {
    _visible = !_visible;
    const btn = document.getElementById('fov-toggle-btn');
    if (btn) btn.classList.toggle('active', _visible);

    if (_visible) {
      renderCones();
      if (map) showToast('👁 FOV cones enabled', 2000);
    } else {
      clearCones();
      // Remove canvas if in canvas mode
      const canvas = document.getElementById('ghost-fov-canvas');
      if (canvas) canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
      hideTooltip();
    }
  }

  function isVisible() { return _visible; }

  return { init, update, toggle, isVisible };

})();

// ─── GhostOfflineManager (GHOST-OFFLINE) ─────────────────────────────────────
// Handles: offline indicator, cache management, background sync, tile pre-warming
(function GhostOfflineManager() {
  'use strict';

  // ── State ────────────────────────────────────────────────────────────────────
  let _isOffline          = !navigator.onLine;
  let _sw                 = null;    // ServiceWorkerRegistration
  let _cacheSize          = null;    // bytes (null = unknown)
  let _tileCount          = 0;
  let _syncPending        = false;
  let _offlineCameraData  = null;    // { cameras, count, bbox, exported_at }

  // ── Constants ──────────────────────────────────────────────────────────────
  const CAMERA_CACHE_KEY  = 'ghost-offline-cameras';
  const CAMERA_META_KEY   = 'ghost-offline-meta';

  // ── Connectivity detection ─────────────────────────────────────────────────
  function setOffline(offline) {
    if (_isOffline === offline) return;
    _isOffline = offline;
    renderOfflineBanner();
    if (!offline) {
      // Back online — trigger background sync
      scheduleSync();
    }
  }

  window.addEventListener('online',  () => setOffline(false));
  window.addEventListener('offline', () => setOffline(true));

  // ── SW message listener ────────────────────────────────────────────────────
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', event => {
      const { type, bytes, tileCount, fetched, total } = event.data || {};
      switch (type) {
        case 'CACHE_SIZE_RESULT':
          _cacheSize  = bytes || 0;
          _tileCount  = tileCount || 0;
          renderCacheUI();
          break;
        case 'CACHE_REGION_START':
          updateDownloadProgress(0, total, 'Downloading tiles…');
          break;
        case 'CACHE_REGION_PROGRESS':
          updateDownloadProgress(fetched, total, 'Downloading tiles…');
          break;
        case 'CACHE_REGION_DONE':
          updateDownloadProgress(fetched, total, 'Done!');
          requestCacheSize();
          break;
        case 'OFFLINE_CACHE_CLEARED':
          _cacheSize = 0; _tileCount = 0;
          renderCacheUI();
          break;
        case 'GHOST_SYNC_START':
          showSyncStatus('🔄 Syncing camera data…');
          break;
        case 'GHOST_SYNC_DONE':
          showSyncStatus('✅ Camera data updated');
          loadOfflineCameraCache();
          break;
      }
    });
  }

  // ── Offline banner ─────────────────────────────────────────────────────────
  function renderOfflineBanner() {
    let banner = document.getElementById('ghost-offline-banner');
    if (!banner) return;
    if (_isOffline) {
      banner.style.display = 'flex';
      banner.textContent   = '📵 Offline — using cached map & camera data';
    } else {
      banner.style.display = 'none';
    }
  }

  // ── Sync status toast ──────────────────────────────────────────────────────
  function showSyncStatus(msg) {
    const el = document.getElementById('ghost-sync-status');
    if (!el) return;
    el.textContent   = msg;
    el.style.opacity = '1';
    setTimeout(() => { el.style.opacity = '0'; }, 3000);
  }

  // ── Request cache size from SW ─────────────────────────────────────────────
  function requestCacheSize() {
    if (!_sw || !_sw.active) return;
    _sw.active.postMessage({ type: 'GET_CACHE_SIZE' });
  }

  // ── Format bytes helper ────────────────────────────────────────────────────
  function fmtBytes(b) {
    if (b == null) return '—';
    if (b < 1024)        return b + ' B';
    if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
    return (b / (1024 * 1024)).toFixed(1) + ' MB';
  }

  // ── Render cache management UI ─────────────────────────────────────────────
  function renderCacheUI() {
    const sizeEl   = document.getElementById('ghost-cache-size');
    const countEl  = document.getElementById('ghost-tile-count');
    const metaEl   = document.getElementById('ghost-camera-meta');

    if (sizeEl)  sizeEl.textContent  = fmtBytes(_cacheSize);
    if (countEl) countEl.textContent = _tileCount + ' tiles';

    const meta = _offlineCameraData;
    if (metaEl && meta) {
      const ago = meta.exported_at
        ? Math.round((Date.now() - new Date(meta.exported_at).getTime()) / 60000) + 'm ago'
        : 'unknown';
      metaEl.textContent = `${meta.count || 0} cameras cached · ${ago}`;
    } else if (metaEl) {
      const stored = localStorage.getItem(CAMERA_META_KEY);
      if (stored) {
        try {
          const m = JSON.parse(stored);
          const ago = m.exported_at
            ? Math.round((Date.now() - new Date(m.exported_at).getTime()) / 60000) + 'm ago'
            : 'unknown';
          metaEl.textContent = `${m.count || 0} cameras cached · ${ago}`;
        } catch (_) {}
      }
    }
  }

  // ── Update tile download progress ──────────────────────────────────────────
  function updateDownloadProgress(fetched, total, msg) {
    const bar  = document.getElementById('ghost-download-bar');
    const prog = document.getElementById('ghost-download-progress');
    const lbl  = document.getElementById('ghost-download-label');
    if (lbl) lbl.textContent = msg;
    if (prog && total > 0) {
      const pct = Math.round((fetched / total) * 100);
      prog.style.width = pct + '%';
      prog.textContent = pct + '%';
    }
    if (bar) bar.style.display = total > 0 ? 'block' : 'none';
  }

  // ── Pre-warm tiles for bbox ────────────────────────────────────────────────
  function cacheRegion(minLat, minLon, maxLat, maxLon, minZoom, maxZoom) {
    if (!_sw || !_sw.active) return;
    _sw.active.postMessage({
      type: 'CACHE_REGION',
      payload: { minLat, minLon, maxLat, maxLon, minZoom, maxZoom },
    });
  }

  // ── Clear all offline caches ────────────────────────────────────────────────
  function clearOfflineCache() {
    if (_sw && _sw.active) {
      _sw.active.postMessage({ type: 'CLEAR_OFFLINE_CACHE' });
    }
    localStorage.removeItem(CAMERA_CACHE_KEY);
    localStorage.removeItem(CAMERA_META_KEY);
    _offlineCameraData = null;
    renderCacheUI();
  }

  // ── Load camera data into localStorage for offline use ────────────────────
  async function loadOfflineCameraCache() {
    try {
      const res = await fetch('/api/offline-cache');
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      // Store in localStorage (cameras as JSON, meta separately)
      localStorage.setItem(CAMERA_CACHE_KEY, JSON.stringify(data.cameras || []));
      localStorage.setItem(CAMERA_META_KEY, JSON.stringify({
        count:       data.count,
        bbox:        data.bbox,
        exported_at: data.exported_at,
      }));
      _offlineCameraData = data;
      renderCacheUI();
      showSyncStatus(`✅ ${data.count} cameras cached offline`);
    } catch (e) {
      console.warn('[GhostOffline] Camera cache load failed:', e);
    }
  }

  // ── Schedule background sync via SW ───────────────────────────────────────
  async function scheduleSync() {
    if (_syncPending) return;
    _syncPending = true;
    try {
      if (_sw && 'sync' in _sw) {
        await _sw.sync.register('ghost-camera-sync');
        console.log('[GhostOffline] Background sync registered');
      } else {
        // Fallback: load directly if sync API unavailable
        await loadOfflineCameraCache();
      }
    } catch (e) {
      console.warn('[GhostOffline] Sync registration failed, loading directly:', e);
      await loadOfflineCameraCache();
    }
    _syncPending = false;
  }

  // ── Cache current map view ─────────────────────────────────────────────────
  function cacheCurrentView() {
    if (typeof map === 'undefined') return;
    const bounds = map.getBounds();
    const pad    = 0.05;
    cacheRegion(
      bounds.getSouth() - pad,
      bounds.getWest()  - pad,
      bounds.getNorth() + pad,
      bounds.getEast()  + pad,
      map.getZoom() - 1 || 10,
      Math.min(map.getZoom() + 1, 16)
    );
  }

  // ── Init UI bindings ──────────────────────────────────────────────────────
  function bindUI() {
    // Clear cache button
    const clearBtn = document.getElementById('ghost-cache-clear-btn');
    if (clearBtn) {
      clearBtn.addEventListener('click', () => {
        if (confirm('Clear all cached map tiles and camera data?')) {
          clearOfflineCache();
        }
      });
    }

    // Download current view button
    const dlBtn = document.getElementById('ghost-cache-region-btn');
    if (dlBtn) {
      dlBtn.addEventListener('click', () => {
        cacheCurrentView();
        loadOfflineCameraCache();
      });
    }

    // Refresh camera cache button
    const refreshBtn = document.getElementById('ghost-camera-refresh-btn');
    if (refreshBtn) {
      refreshBtn.addEventListener('click', () => loadOfflineCameraCache());
    }
  }

  // ── Bootstrap ─────────────────────────────────────────────────────────────
  async function init() {
    // Wait for SW registration (already done by GhostAlerts module)
    if ('serviceWorker' in navigator) {
      try {
        _sw = await navigator.serviceWorker.ready;
        requestCacheSize();
      } catch (_) {}
    }

    renderOfflineBanner();
    renderCacheUI();

    // Load camera data when online
    if (!_isOffline) {
      // Delay to not compete with initial map load
      setTimeout(loadOfflineCameraCache, 5000);
    }

    // Bind UI after DOM is ready
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', bindUI);
    } else {
      bindUI();
    }
  }

  init();

  // Expose for debugging + external use
  window.GhostOffline = {
    cacheRegion,
    cacheCurrentView,
    clearCache:     clearOfflineCache,
    loadCameras:    loadOfflineCameraCache,
    scheduleSync,
    getCacheSize:   requestCacheSize,
    getLocalCameras: () => {
      try {
        return JSON.parse(localStorage.getItem(CAMERA_CACHE_KEY) || '[]');
      } catch (_) { return []; }
    },
    isOffline: () => _isOffline,
  };

})();

// ╔══════════════════════════════════════════════════════════════════════════════╗
// ║  GHOST-MOBILE-UX — Waze-style mobile navigation module                     ║
// ╚══════════════════════════════════════════════════════════════════════════════╝
(function GhostMobileUX() {
  'use strict';

  const isMobile = () => window.innerWidth <= 768;

  // ── Bottom Sheet state ────────────────────────────────────────────────────
  let sheetState = 'peek'; // 'peek' | 'open'
  let touchStartY = 0;
  let touchStartSheetY = 0;

  const sheet        = document.getElementById('ghost-bottom-sheet');
  const sheetToggle  = document.getElementById('bottom-sheet-toggle');
  const bsheetTitle  = document.getElementById('bsheet-title');
  const bsheetSub    = document.getElementById('bsheet-sub');
  const bsheetArrow  = document.getElementById('bsheet-arrow');
  const bsheetSummary = document.getElementById('bsheet-route-summary');

  function setSheetState(state) {
    sheetState = state;
    sheet.classList.remove('sheet-peek', 'sheet-open');
    sheet.classList.add(state === 'open' ? 'sheet-open' : 'sheet-peek');
    // Show/hide floating search preview
    const floatSearch = document.getElementById('ghost-mobile-search');
    if (floatSearch) {
      floatSearch.style.display = (isMobile() && state === 'peek') ? 'flex' : 'none';
    }
  }

  function toggleSheet() {
    setSheetState(sheetState === 'open' ? 'peek' : 'open');
  }

  if (sheetToggle) {
    sheetToggle.addEventListener('click', toggleSheet);
  }

  // Handle bar drag for sheet
  if (sheet) {
    const handleBar = sheet.querySelector('.bottom-sheet-handle-bar');
    if (handleBar) {
      handleBar.addEventListener('touchstart', (e) => {
        touchStartY = e.touches[0].clientY;
      }, { passive: true });

      handleBar.addEventListener('touchend', (e) => {
        const deltaY = e.changedTouches[0].clientY - touchStartY;
        if (deltaY < -40) {
          setSheetState('open');
        } else if (deltaY > 40) {
          setSheetState('peek');
        }
      }, { passive: true });
    }
  }

  // ── Mobile search sync with main inputs ──────────────────────────────────
  function syncMobileSearch() {
    const startMain  = document.getElementById('start-input');
    const endMain    = document.getElementById('end-input');
    const mobileFrom = document.getElementById('mobile-start-input');
    const mobileTo   = document.getElementById('mobile-end-input');
    const previewFrom = document.getElementById('mobile-search-from-preview');
    const previewTo  = document.getElementById('mobile-search-to-preview');

    if (!startMain || !endMain) return;

    function sync() {
      if (mobileFrom) mobileFrom.value  = startMain.value;
      if (mobileTo)   mobileTo.value    = endMain.value;
      if (previewFrom) previewFrom.value = startMain.value;
      if (previewTo)  previewTo.value   = endMain.value;
    }

    startMain.addEventListener('input', sync);
    endMain.addEventListener('input', sync);

    // Mirror mobile inputs back to main
    if (mobileFrom) {
      mobileFrom.addEventListener('input', () => {
        startMain.value = mobileFrom.value;
        startMain.dispatchEvent(new Event('input', { bubbles: true }));
      });
      mobileFrom.addEventListener('focus', () => {
        setSheetState('open');
      });
    }

    if (mobileTo) {
      mobileTo.addEventListener('input', () => {
        endMain.value = mobileTo.value;
        endMain.dispatchEvent(new Event('input', { bubbles: true }));
      });
      mobileTo.addEventListener('focus', () => {
        setSheetState('open');
      });
    }

    // Floating preview taps open sheet
    if (previewFrom) {
      previewFrom.addEventListener('click', () => setSheetState('open'));
    }
    if (previewTo) {
      previewTo.addEventListener('click', () => setSheetState('open'));
    }
  }

  // Swap button sync
  const mobileSwapBtn = document.getElementById('mobile-swap-btn');
  if (mobileSwapBtn) {
    mobileSwapBtn.addEventListener('click', () => {
      const swapMain = document.getElementById('swap-btn');
      if (swapMain) swapMain.click();
      // Sync values after swap
      setTimeout(syncMobileSearch, 50);
    });
  }

  // Mobile use-location button
  const mobileUseLoc = document.getElementById('mobile-use-location');
  if (mobileUseLoc) {
    mobileUseLoc.addEventListener('click', () => {
      const mainLocBtn = document.getElementById('use-location');
      if (mainLocBtn) mainLocBtn.click();
    });
  }

  // ── FAB button actions ────────────────────────────────────────────────────
  const fabStartRoute = document.getElementById('fab-start-route');
  const fabRecenter   = document.getElementById('fab-recenter');
  const fabShare      = document.getElementById('fab-share');

  if (fabStartRoute) {
    fabStartRoute.addEventListener('click', () => {
      // If route already calculated, start live navigation
      const routeResults = document.getElementById('bsheet-route-summary');
      if (routeResults && routeResults.style.display !== 'none') {
        startLiveNavigation();
      } else {
        // Otherwise trigger route calculation
        const startInput = document.getElementById('start-input');
        const endInput   = document.getElementById('end-input');
        if (startInput && startInput.value && endInput && endInput.value) {
          // Trigger route fetch by calling the global fetchRoutes if available
          if (typeof fetchRoutes === 'function') {
            fetchRoutes();
          }
        } else {
          // Open sheet to fill in addresses
          setSheetState('open');
          const mobileFrom = document.getElementById('mobile-start-input');
          if (mobileFrom) mobileFrom.focus();
        }
      }
    });
  }

  if (fabRecenter) {
    fabRecenter.addEventListener('click', () => {
      if (typeof map !== 'undefined' && map) {
        if (typeof startCoords !== 'undefined' && startCoords) {
          map.setView([startCoords.lat, startCoords.lng], 15, { animate: true });
        } else if (navigator.geolocation) {
          navigator.geolocation.getCurrentPosition((pos) => {
            map.setView([pos.coords.latitude, pos.coords.longitude], 15, { animate: true });
          });
        }
      }
    });
  }

  if (fabShare) {
    fabShare.addEventListener('click', () => {
      const shareBtn = document.getElementById('share-btn');
      if (shareBtn && !shareBtn.classList.contains('hidden')) {
        shareBtn.click();
      } else {
        // Copy current URL
        navigator.clipboard.writeText(window.location.href).catch(() => {});
        showMobileToast('🔗 Link copied!');
      }
    });
  }

  // ── Turn bar ──────────────────────────────────────────────────────────────
  const turnBar       = document.getElementById('ghost-turn-bar');
  const turnBarIcon   = document.getElementById('turn-bar-icon');
  const turnBarDist   = document.getElementById('turn-bar-distance');
  const turnBarStreet = document.getElementById('turn-bar-street');
  const turnBarClose  = document.getElementById('turn-bar-close');

  if (turnBarClose) {
    turnBarClose.addEventListener('click', () => {
      turnBar.classList.remove('visible');
      document.body.classList.remove('turn-bar-active');
      stopLiveNavigation();
    });
  }

  function showTurnBar(icon, distance, street) {
    if (!isMobile()) return;
    turnBarIcon.textContent   = icon || '↑';
    turnBarDist.textContent   = distance || '';
    turnBarStreet.textContent = street || '';
    turnBar.classList.add('visible');
    document.body.classList.add('turn-bar-active');
  }

  function hideTurnBar() {
    if (turnBar) {
      turnBar.classList.remove('visible');
      document.body.classList.remove('turn-bar-active');
    }
  }

  // ── ALPR alert banner ─────────────────────────────────────────────────────
  const alprAlert     = document.getElementById('ghost-alpr-alert');
  const alprAlertDist = document.getElementById('alpr-alert-dist');
  let alprAlertTimer  = null;

  function showAlprAlert(distanceM) {
    if (!isMobile()) return;
    const distLabel = distanceM < 1000
      ? Math.round(distanceM) + 'm'
      : (distanceM / 1000).toFixed(1) + 'km';
    alprAlertDist.textContent = distLabel;
    alprAlert.classList.add('visible');
    // Auto-hide after 8s
    clearTimeout(alprAlertTimer);
    alprAlertTimer = setTimeout(() => {
      alprAlert.classList.remove('visible');
    }, 8000);
  }

  function hideAlprAlert() {
    if (alprAlert) alprAlert.classList.remove('visible');
    clearTimeout(alprAlertTimer);
  }

  // ── Camera proximity check along active route ─────────────────────────────
  // Called when user's position or route changes; looks for cameras within 200m
  function checkAlprProximity(userLat, userLng) {
    if (!window.cameras || !window.cameras.length) return;
    let closestDist = Infinity;
    let closestCam = null;

    for (const cam of window.cameras) {
      if (!cam.lat || !cam.lon) continue;
      const dist = haversineSimple(userLat, userLng, cam.lat, cam.lon);
      if (dist < closestDist) {
        closestDist = dist;
        closestCam = cam;
      }
    }

    if (closestDist <= 200) {
      showAlprAlert(closestDist);
      // Add pulse class to nearby camera markers
      if (closestCam && window.cameraMarkers) {
        window.cameraMarkers.forEach((m) => {
          const pos = m.getLatLng();
          const d = haversineSimple(pos.lat, pos.lng, closestCam.lat, closestCam.lon);
          if (d < 50 && m._icon) {
            m._icon.classList.add('alpr-nearby-pulse');
          } else if (m._icon) {
            m._icon.classList.remove('alpr-nearby-pulse');
          }
        });
      }
    } else {
      hideAlprAlert();
    }
  }

  function haversineSimple(lat1, lon1, lat2, lon2) {
    const R = 6371000;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
              Math.sin(dLon/2) * Math.sin(dLon/2);
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  }

  // ── Live navigation mode ──────────────────────────────────────────────────
  let liveNavWatchId   = null;
  let liveNavActive    = false;
  let liveNavRouteCoords = [];

  function startLiveNavigation() {
    if (!navigator.geolocation) {
      showMobileToast('⚠ Location not available');
      return;
    }
    liveNavActive = true;
    fabStartRoute.textContent = '⏹';
    fabStartRoute.title = 'Stop navigation';
    showMobileToast('🟢 Live navigation started');
    showTurnBar('🧭', 'Locating…', 'Getting GPS…');

    // Capture current active route coords
    if (typeof routeLayers !== 'undefined' && routeLayers.length > 0) {
      const ghostLayer = routeLayers.find(r => r.type === 'ghost') || routeLayers[0];
      if (ghostLayer && ghostLayer.layer && ghostLayer.layer.getLatLngs) {
        liveNavRouteCoords = ghostLayer.layer.getLatLngs().map(ll => ({ lat: ll.lat, lng: ll.lng }));
      }
    }

    liveNavWatchId = navigator.geolocation.watchPosition(
      (pos) => {
        const { latitude: lat, longitude: lng, heading, speed } = pos.coords;

        // Check ALPR proximity
        checkAlprProximity(lat, lng);

        // Update turn bar with bearing info
        const icon = getBearingIcon(heading);
        const speedKph = speed ? Math.round(speed * 3.6) + ' km/h' : '';
        const nextStep = getNextTurnStep(lat, lng, liveNavRouteCoords);

        if (nextStep) {
          showTurnBar(nextStep.icon, nextStep.distLabel, nextStep.street);
        } else {
          showTurnBar(icon || '↑', speedKph, 'On route');
        }

        // Pan map to user position
        if (typeof map !== 'undefined' && map) {
          map.setView([lat, lng], Math.max(map.getZoom(), 16), { animate: true });
        }
      },
      (err) => {
        console.warn('[GhostMobileUX] Geolocation error:', err.message);
      },
      { enableHighAccuracy: true, maximumAge: 3000, timeout: 10000 }
    );
  }

  function stopLiveNavigation() {
    liveNavActive = false;
    if (liveNavWatchId !== null) {
      navigator.geolocation.clearWatch(liveNavWatchId);
      liveNavWatchId = null;
    }
    if (fabStartRoute) {
      fabStartRoute.textContent = '▶';
      fabStartRoute.title = 'Start route';
    }
    hideTurnBar();
    hideAlprAlert();
  }

  function getBearingIcon(heading) {
    if (heading === null || heading === undefined) return '↑';
    const h = ((heading % 360) + 360) % 360;
    if (h < 22.5 || h >= 337.5)  return '↑';
    if (h < 67.5)   return '↗';
    if (h < 112.5)  return '→';
    if (h < 157.5)  return '↘';
    if (h < 202.5)  return '↓';
    if (h < 247.5)  return '↙';
    if (h < 292.5)  return '←';
    return '↖';
  }

  function getNextTurnStep(userLat, userLng, routeCoords) {
    if (!routeCoords || routeCoords.length < 2) return null;
    // Find closest point on route
    let minDist = Infinity;
    let closestIdx = 0;
    for (let i = 0; i < routeCoords.length; i++) {
      const d = haversineSimple(userLat, userLng, routeCoords[i].lat, routeCoords[i].lng);
      if (d < minDist) {
        minDist = d;
        closestIdx = i;
      }
    }
    // Lookahead 200m for next significant turn
    let lookahead = closestIdx + 1;
    let cumDist = 0;
    while (lookahead < routeCoords.length - 1 && cumDist < 500) {
      cumDist += haversineSimple(
        routeCoords[lookahead-1].lat, routeCoords[lookahead-1].lng,
        routeCoords[lookahead].lat,   routeCoords[lookahead].lng
      );
      // Detect bearing change > 25deg as a turn
      if (lookahead + 1 < routeCoords.length) {
        const b1 = bearing(routeCoords[lookahead-1], routeCoords[lookahead]);
        const b2 = bearing(routeCoords[lookahead], routeCoords[lookahead+1]);
        const delta = Math.abs(b2 - b1);
        const turn = Math.min(delta, 360 - delta);
        if (turn > 25) {
          const icon = turn > 90 ? (b2 > b1 ? '↱' : '↰') : (b2 > b1 ? '↗' : '↖');
          const distLabel = cumDist < 1000
            ? Math.round(cumDist / 10) * 10 + ' m'
            : (cumDist / 1000).toFixed(1) + ' km';
          return { icon, distLabel, street: 'In ' + distLabel };
        }
      }
      lookahead++;
    }
    // Just show distance to end
    let remaining = 0;
    for (let i = closestIdx; i < routeCoords.length - 1; i++) {
      remaining += haversineSimple(routeCoords[i].lat, routeCoords[i].lng, routeCoords[i+1].lat, routeCoords[i+1].lng);
    }
    if (remaining < 50) return { icon: '🏁', distLabel: 'Arrive!', street: 'Destination' };
    const distLabel = remaining < 1000
      ? Math.round(remaining / 10) * 10 + ' m'
      : (remaining / 1000).toFixed(1) + ' km';
    return { icon: '↑', distLabel, street: 'Continue on route' };
  }

  function bearing(a, b) {
    const dLon = (b.lng - a.lng) * Math.PI / 180;
    const lat1 = a.lat * Math.PI / 180;
    const lat2 = b.lat * Math.PI / 180;
    const y = Math.sin(dLon) * Math.cos(lat2);
    const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
    return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
  }

  // ── Route summary in bottom sheet ────────────────────────────────────────
  // Hook into route calculation completion
  function updateBottomSheetRoute(fastestItem, ghostItem) {
    if (!isMobile() || !bsheetSummary) return;

    function fmtDist(m) {
      return m >= 1000 ? (m/1000).toFixed(1) + ' km' : Math.round(m) + ' m';
    }
    function fmtTime(s) {
      const m = Math.round(s / 60);
      return m >= 60 ? Math.floor(m/60) + 'h ' + (m%60) + 'min' : m + ' min';
    }

    let html = '';

    if (fastestItem) {
      const fc = fastestItem.cameras || 0;
      html += `
        <div class="bsheet-route-row">
          <div class="bsheet-route-label">⚡ FASTEST ROUTE</div>
          <div class="bsheet-route-stats">
            <div class="bsheet-stat">
              <div class="bsheet-stat-val">${fmtDist(fastestItem.distance || 0)}</div>
              <div class="bsheet-stat-label">Distance</div>
            </div>
            <div class="bsheet-stat">
              <div class="bsheet-stat-val">${fmtTime(fastestItem.duration || 0)}</div>
              <div class="bsheet-stat-label">Est. Time</div>
            </div>
            <div class="bsheet-stat">
              <div class="bsheet-stat-val bsheet-cam-val">${fc}</div>
              <div class="bsheet-stat-label">📷 Cameras</div>
            </div>
          </div>
        </div>`;
    }

    if (ghostItem) {
      const gc = ghostItem.cameras || 0;
      const saved = fastestItem ? Math.max(0, (fastestItem.cameras || 0) - gc) : 0;
      html += `
        <div class="bsheet-route-row bsheet-ghost">
          <div class="bsheet-route-label">👻 PRIVACY ROUTE${saved > 0 ? ' — ' + saved + ' fewer cameras' : ''}</div>
          <div class="bsheet-route-stats">
            <div class="bsheet-stat">
              <div class="bsheet-stat-val">${fmtDist(ghostItem.distance || 0)}</div>
              <div class="bsheet-stat-label">Distance</div>
            </div>
            <div class="bsheet-stat">
              <div class="bsheet-stat-val">${fmtTime(ghostItem.duration || 0)}</div>
              <div class="bsheet-stat-label">Est. Time</div>
            </div>
            <div class="bsheet-stat">
              <div class="bsheet-stat-val bsheet-cam-val ${gc <= 2 ? 'safe' : ''}">${gc}</div>
              <div class="bsheet-stat-label">📷 Cameras</div>
            </div>
          </div>
        </div>`;
    }

    if (html) {
      bsheetSummary.innerHTML = html;
      bsheetSummary.style.display = 'flex';
      if (bsheetTitle) bsheetTitle.textContent = ghostItem ? '👻 Route Ready' : '⚡ Route Ready';
      if (bsheetSub) {
        const gc = ghostItem ? ghostItem.cameras : (fastestItem ? fastestItem.cameras : 0);
        const saved = (fastestItem && ghostItem) ? Math.max(0, fastestItem.cameras - gc) : 0;
        bsheetSub.textContent = saved > 0
          ? `Privacy route avoids ${saved} camera${saved > 1 ? 's' : ''}`
          : `Tap ▶ to start navigation`;
      }
      // Peek the sheet to show summary
      setSheetState('peek');
      // Also enable the FAB start button
      if (fabStartRoute) {
        fabStartRoute.style.background = '#22c55e';
      }
    }
  }

  // ── Mobile toast notification ─────────────────────────────────────────────
  function showMobileToast(msg) {
    const existing = document.getElementById('ghost-mobile-toast');
    if (existing) existing.remove();
    const toast = document.createElement('div');
    toast.id = 'ghost-mobile-toast';
    toast.style.cssText = `
      position:fixed;bottom:90px;left:50%;transform:translateX(-50%);
      background:rgba(0,0,0,0.85);color:#22c55e;
      padding:8px 18px;border-radius:20px;font-family:monospace;
      font-size:13px;z-index:9999;pointer-events:none;
      animation: fadeInUp 0.2s ease forwards;
    `;
    toast.textContent = msg;
    document.body.appendChild(toast);
    setTimeout(() => { if (toast.parentNode) toast.remove(); }, 3000);
  }

  // ── Init ──────────────────────────────────────────────────────────────────
  function init() {
    if (!isMobile()) return;

    // Show sheet in peek state
    setSheetState('peek');

    // Show floating search when sheet is peeked
    const floatSearch = document.getElementById('ghost-mobile-search');
    if (floatSearch) {
      floatSearch.style.display = 'flex';
    }

    syncMobileSearch();

    // Listen for route calculation results to update bottom sheet
    // We observe #panel-results becoming visible (via MutationObserver)
    const panelResults = document.getElementById('panel-results');
    if (panelResults) {
      const observer = new MutationObserver(() => {
        if (!panelResults.classList.contains('hidden')) {
          // Extract route data from existing DOM for bottom sheet
          setTimeout(extractAndShowRouteInSheet, 200);
        }
      });
      observer.observe(panelResults, { attributes: true, attributeFilter: ['class'] });
    }

    // Watch for ALPR cameras via ghost-nav-toggle (live alerts)
    const navToggle = document.getElementById('ghost-nav-toggle');
    if (navToggle) {
      // Mirror live alert proximity badge text into ALPR banner
      const proximityBadge = document.getElementById('ghost-proximity-badge');
      if (proximityBadge) {
        const badgeObserver = new MutationObserver(() => {
          const txt = proximityBadge.textContent || '';
          if (txt.includes('camera') && !txt.includes('No cameras')) {
            // Extract distance if present
            const match = txt.match(/(\d+)m/);
            if (match) showAlprAlert(parseInt(match[1]));
          } else {
            hideAlprAlert();
          }
        });
        badgeObserver.observe(proximityBadge, { childList: true, characterData: true, subtree: true });
      }
    }

    // Recenter also recenters on geolocation
    if (fabRecenter) {
      // Track user position for recenter
      if (navigator.geolocation) {
        navigator.geolocation.getCurrentPosition((pos) => {
          fabRecenter._userPos = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        }, () => {}, { enableHighAccuracy: true });
      }
    }
  }

  function extractAndShowRouteInSheet() {
    // Pull data from the existing route-results DOM or RCP panel
    const rcpNormalDist  = document.getElementById('rcp-normal-distance');
    const rcpNormalTime  = document.getElementById('rcp-normal-time');
    const rcpNormalCams  = document.getElementById('rcp-normal-cameras');
    const rcpPrivDist    = document.getElementById('rcp-privacy-distance');
    const rcpPrivTime    = document.getElementById('rcp-privacy-time');
    const rcpPrivCams    = document.getElementById('rcp-privacy-cameras');

    let fastest = null;
    let ghost   = null;

    if (rcpNormalDist && rcpNormalDist.textContent !== '—') {
      // Parse from text
      const parseDist = (s) => {
        if (!s || s === '—') return 0;
        const km = s.match(/([\d.]+)\s*km/);
        const m  = s.match(/([\d.]+)\s*m/);
        return km ? parseFloat(km[1]) * 1000 : (m ? parseFloat(m[1]) : 0);
      };
      const parseTime = (s) => {
        if (!s || s === '—') return 0;
        const h = s.match(/(\d+)h/), min = s.match(/(\d+)\s*min/);
        return (h ? parseInt(h[1]) * 3600 : 0) + (min ? parseInt(min[1]) * 60 : 0);
      };
      const parseCams = (s) => parseInt(s) || 0;

      fastest = {
        distance: parseDist(rcpNormalDist.textContent),
        duration: parseTime(rcpNormalTime.textContent),
        cameras:  parseCams(rcpNormalCams ? rcpNormalCams.textContent : '0'),
      };

      if (rcpPrivDist && rcpPrivDist.textContent !== '—') {
        ghost = {
          distance: parseDist(rcpPrivDist.textContent),
          duration: parseTime(rcpPrivTime.textContent),
          cameras:  parseCams(rcpPrivCams ? rcpPrivCams.textContent : '0'),
        };
      }
    } else {
      // Fallback: look in route-cards
      const cards = document.querySelectorAll('.route-card');
      if (cards.length > 0) {
        const getStatVal = (card, idx) => {
          const vals = card.querySelectorAll('.stat-value');
          return vals[idx] ? vals[idx].textContent : '';
        };
        // Build minimal items from cards
        if (cards[0]) {
          fastest = { distance: 0, duration: 0, cameras: parseInt(getStatVal(cards[0], 2)) || 0 };
        }
        if (cards[1]) {
          ghost = { distance: 0, duration: 0, cameras: parseInt(getStatVal(cards[1], 2)) || 0 };
        }
      }
    }

    updateBottomSheetRoute(fastest, ghost);
  }

  // Expose updateBottomSheetRoute globally so displayRouteComparison can call it
  window.GhostMobileUX = {
    updateBottomSheetRoute,
    showAlprAlert,
    hideAlprAlert,
    showTurnBar,
    hideTurnBar,
    checkAlprProximity,
    startLiveNavigation,
    stopLiveNavigation,
    setSheetState,
    showMobileToast,
    isMobile,
  };

  // Wait for DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
