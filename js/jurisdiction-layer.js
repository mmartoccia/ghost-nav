/**
 * GHOST-JURISDICTION: Jurisdictional Privacy Law Overlay
 * Choropleth map layer showing ALPR legal protection levels by US state/jurisdiction.
 */

const JurisdictionLayer = (function () {
  // ── Color palette by protection level ────────────────────────────────────
  const COLORS = {
    strong:   '#22c55e',   // green  — strong legal protections
    moderate: '#eab308',   // yellow — moderate protections
    weak:     '#f97316',   // orange — weak protections
    none:     '#ef4444',   // red    — no protections
  };

  const LABELS = {
    strong:   '🟢 Strong',
    moderate: '🟡 Moderate',
    weak:     '🟠 Weak',
    none:     '🔴 None',
  };

  // ── Internal state ────────────────────────────────────────────────────────
  let _map          = null;
  let _geoLayer     = null;
  let _privacyData  = {};   // keyed by jurisdiction id
  let _visible      = false;
  let _initialized  = false;
  let _btn          = null;

  // ── Fetch jurisdiction data ───────────────────────────────────────────────
  async function _loadData() {
    const [privRes, geoRes] = await Promise.all([
      fetch('/api/jurisdiction-data'),
      fetch('/data/jurisdiction-boundaries.json'),
    ]);
    const privJson = await privRes.json();
    const geoJson  = await geoRes.json();

    // Index privacy data by id
    _privacyData = {};
    for (const j of (privJson.jurisdictions || [])) {
      _privacyData[j.id] = j;
    }

    return geoJson;
  }

  // ── Style each GeoJSON feature ────────────────────────────────────────────
  function _styleFeature(feature) {
    const id   = feature.properties && feature.properties.id;
    const info = _privacyData[id];
    const lvl  = info ? info.protection_level : 'none';
    return {
      fillColor:   COLORS[lvl] || COLORS.none,
      fillOpacity: 0.40,
      color:       '#1a1a2e',
      weight:      1.2,
      opacity:     0.8,
    };
  }

  // ── Build popup HTML ──────────────────────────────────────────────────────
  function _buildPopup(feature) {
    const id   = feature.properties && feature.properties.id;
    const info = _privacyData[id];
    if (!info) {
      return `<div style="font-family:monospace;font-size:12px;color:#ccc">
        <b>${feature.properties.name || id}</b><br>No data available.</div>`;
    }

    const lvl          = info.protection_level;
    const retention    = info.retention_days != null
      ? (info.retention_days < 1 ? `${Math.round(info.retention_days * 1440)} min` : `${info.retention_days} days`)
      : 'No limit set';
    const warrant      = info.warrant_required ? '✅ Yes' : '❌ No';
    const banned       = info.ban ? '🚫 Banned' : '—';
    const statuteLink  = info.statute_url
      ? `<a href="${info.statute_url}" target="_blank" rel="noopener" style="color:#22c55e">📜 View Statute</a>`
      : '<span style="color:#666">No statute URL</span>';

    return `
<div style="font-family:monospace;font-size:12px;color:#e5e7eb;min-width:220px">
  <div style="font-size:14px;font-weight:bold;color:#fff;margin-bottom:6px">
    ${info.name}
    <span style="font-size:10px;color:#9ca3af;margin-left:4px">(${info.type})</span>
  </div>
  <div style="margin-bottom:8px">
    <span style="background:${COLORS[lvl]};color:#000;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:bold">
      ${LABELS[lvl]}
    </span>
  </div>
  <table style="border-collapse:collapse;width:100%">
    <tr>
      <td style="color:#9ca3af;padding:2px 0">Retention limit</td>
      <td style="padding:2px 0 2px 8px;color:#fff">${retention}</td>
    </tr>
    <tr>
      <td style="color:#9ca3af;padding:2px 0">Warrant required</td>
      <td style="padding:2px 0 2px 8px">${warrant}</td>
    </tr>
    <tr>
      <td style="color:#9ca3af;padding:2px 0">ALPR ban</td>
      <td style="padding:2px 0 2px 8px">${banned}</td>
    </tr>
  </table>
  <div style="margin-top:6px;padding-top:6px;border-top:1px solid #374151;font-size:11px;color:#9ca3af">
    ${info.notes || ''}
  </div>
  <div style="margin-top:6px">${statuteLink}</div>
</div>`;
  }

  // ── Build the choropleth layer ────────────────────────────────────────────
  function _buildLayer(geoJson) {
    return L.geoJSON(geoJson, {
      style: _styleFeature,
      onEachFeature: function (feature, layer) {
        layer.bindPopup(_buildPopup(feature), {
          maxWidth: 300,
          className: 'ghost-jurisdiction-popup',
        });
        layer.on('mouseover', function () {
          layer.setStyle({ fillOpacity: 0.65, weight: 2 });
        });
        layer.on('mouseout', function () {
          layer.setStyle({ fillOpacity: 0.40, weight: 1.2 });
        });
      },
    });
  }

  // ── Legend control ────────────────────────────────────────────────────────
  function _buildLegend() {
    const ctrl = L.control({ position: 'bottomleft' });
    ctrl.onAdd = function () {
      const div = L.DomUtil.create('div', 'ghost-jurisdiction-legend');
      div.style.cssText = [
        'background:rgba(0,0,0,0.82)',
        'color:#e5e7eb',
        'padding:10px 14px',
        'border-radius:6px',
        'font-family:monospace',
        'font-size:11px',
        'pointer-events:none',
        'min-width:180px',
        'border:1px solid rgba(255,255,255,0.1)',
      ].join(';');

      div.innerHTML = `
        <div style="font-size:12px;font-weight:bold;color:#22c55e;margin-bottom:6px">
          ⚖️ ALPR Privacy Law
        </div>
        ${Object.entries(LABELS).map(([k, v]) =>
          `<div style="margin-bottom:3px">
            <span style="display:inline-block;width:12px;height:12px;background:${COLORS[k]};border-radius:2px;margin-right:6px;vertical-align:middle"></span>
            ${v}
          </div>`
        ).join('')}
        <div style="margin-top:6px;color:#6b7280;font-size:10px">
          Click a state for details
        </div>`;
      return div;
    };
    return ctrl;
  }

  // ── Route legal summary ───────────────────────────────────────────────────
  /**
   * Given an array of [lat, lng] coords, returns a text summary of which
   * jurisdictions the route passes through and their protection levels.
   * Uses a simple bounding box approach against the loaded GeoJSON.
   *
   * @param {Array<[number,number]>} routeCoords - Array of [lat, lng] pairs
   * @returns {string} Human-readable legal summary
   */
  function getLegalSummary(routeCoords) {
    if (!_initialized || !routeCoords || routeCoords.length === 0) {
      return 'Jurisdiction data not loaded.';
    }

    const crossed = new Set();
    const levels  = {};

    // For each route point, check which state feature contains it (simplified)
    if (_geoLayer) {
      _geoLayer.eachLayer(function (layer) {
        const feature = layer.feature;
        const id = feature.properties && feature.properties.id;
        if (!id) return;

        const bounds = layer.getBounds();
        for (const [lat, lng] of routeCoords) {
          if (bounds.contains([lat, lng])) {
            crossed.add(id);
            break;
          }
        }
      });
    }

    if (crossed.size === 0) {
      return 'No jurisdiction data available for this route.';
    }

    // Collect info
    const jurisdictions = [];
    for (const id of crossed) {
      const info = _privacyData[id];
      if (info) {
        jurisdictions.push(info);
        levels[info.protection_level] = (levels[info.protection_level] || 0) + 1;
      }
    }

    jurisdictions.sort((a, b) => {
      const order = { none: 0, weak: 1, moderate: 2, strong: 3 };
      return order[a.protection_level] - order[b.protection_level];
    });

    let summary = `Your route crosses ${jurisdictions.length} jurisdiction(s):\n\n`;
    for (const j of jurisdictions) {
      const lvl  = j.protection_level.toUpperCase();
      const ret  = j.retention_days != null ? `${j.retention_days}d retention` : 'no retention limit';
      const warr = j.warrant_required ? ', warrant required' : '';
      summary += `• ${j.name}: ${lvl} (${ret}${warr})\n`;
    }

    const worst = jurisdictions[0];
    if (worst && worst.protection_level === 'none') {
      summary += `\n⚠️ Warning: ${worst.name} has NO ALPR privacy protections. Your plate may be stored indefinitely.`;
    } else if (worst && worst.protection_level === 'weak') {
      summary += `\n⚠️ Note: ${worst.name} has weak ALPR protections.`;
    } else if (levels.strong === jurisdictions.length) {
      summary += `\n✅ All jurisdictions on this route have strong ALPR privacy protections.`;
    }

    return summary;
  }

  // ── Toggle layer visibility ───────────────────────────────────────────────
  function _toggleLayer() {
    if (!_map) return;
    _visible = !_visible;

    if (_visible) {
      if (_geoLayer) _geoLayer.addTo(_map);
      if (_btn) {
        _btn.classList.add('active');
        _btn.title = 'Hide jurisdiction privacy layer';
      }
    } else {
      if (_geoLayer) _map.removeLayer(_geoLayer);
      if (_btn) {
        _btn.classList.remove('active');
        _btn.title = 'Show jurisdiction privacy layer';
      }
    }
  }

  // ── Public init ───────────────────────────────────────────────────────────
  async function init(map) {
    _map = map;

    try {
      const geoJson = await _loadData();
      _geoLayer     = _buildLayer(geoJson);
      _legend       = _buildLegend();
      _initialized  = true;

      // Wire button
      _btn = document.getElementById('jurisdiction-btn');
      if (_btn) {
        _btn.addEventListener('click', function () {
          _toggleLayer();
          // Also toggle legend
          if (_visible) {
            _legend.addTo(_map);
          } else {
            _legend.remove();
          }
        });
      }

      console.log('[Ghost] JurisdictionLayer initialized with', Object.keys(_privacyData).length, 'jurisdictions');
    } catch (err) {
      console.error('[Ghost] JurisdictionLayer init failed:', err);
    }
  }

  // ── Expose public API ─────────────────────────────────────────────────────
  return {
    init,
    getLegalSummary,
    toggle: _toggleLayer,
    isVisible: function () { return _visible; },
  };
})();

// ── Popup style injection ─────────────────────────────────────────────────────
(function () {
  const style = document.createElement('style');
  style.textContent = `
    .ghost-jurisdiction-popup .leaflet-popup-content-wrapper {
      background: #111827;
      border: 1px solid rgba(255,255,255,0.1);
      border-radius: 8px;
      box-shadow: 0 4px 20px rgba(0,0,0,0.5);
    }
    .ghost-jurisdiction-popup .leaflet-popup-tip {
      background: #111827;
    }
    .ghost-jurisdiction-popup .leaflet-popup-close-button {
      color: #9ca3af;
    }
  `;
  document.head.appendChild(style);
})();
