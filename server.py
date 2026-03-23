#!/usr/bin/env python3
"""Ghost Nav dev server with API proxies (fixes iOS mixed-content blocking)"""
import http.server
import urllib.request
import urllib.parse
import json
import os
import math
import time
import threading
import uuid
from datetime import datetime, timezone

# Weekly report module (optional — graceful fallback if jinja2 not installed)
try:
    from weekly_report import generate_weekly_report as _gen_weekly_report
    _WEEKLY_REPORT_AVAILABLE = True
except ImportError:
    _WEEKLY_REPORT_AVAILABLE = False

PORT = 8766
DIR = os.path.dirname(os.path.abspath(__file__))
VERSION = '1.0'
DATA_DIR = os.path.join(DIR, 'data')
REPORTED_CAMERAS_FILE = os.path.join(DATA_DIR, 'reported_cameras.json')
REPORTER_STATS_FILE   = os.path.join(DATA_DIR, 'reporter_stats.json')
GHOST_ADMIN_KEY = os.environ.get('GHOST_ADMIN_KEY', 'ghost-admin-secret')

# ─── Reporter stats helpers ────────────────────────────────────────────────────
_stats_lock = threading.Lock()

def _load_reporter_stats():
    """Load reporter stats from disk."""
    if not os.path.exists(REPORTER_STATS_FILE):
        return {}
    try:
        with open(REPORTER_STATS_FILE, 'r', encoding='utf-8') as f:
            return json.load(f)
    except Exception:
        return {}

def _save_reporter_stats(stats):
    """Save reporter stats to disk (caller must hold _stats_lock)."""
    os.makedirs(DATA_DIR, exist_ok=True)
    with open(REPORTER_STATS_FILE, 'w', encoding='utf-8') as f:
        json.dump(stats, f, indent=2)

def _upsert_reporter_stat(session_id, verified=False):
    """Thread-safe upsert of reporter stats."""
    if not session_id:
        return
    now_iso = datetime.now(timezone.utc).isoformat()
    with _stats_lock:
        stats = _load_reporter_stats()
        if session_id not in stats:
            stats[session_id] = {
                'display_name':   'Anonymous',
                'report_count':   0,
                'verified_count': 0,
                'first_report_at': now_iso,
                'last_report_at':  now_iso,
            }
        stats[session_id]['report_count'] += 1
        if verified:
            stats[session_id]['verified_count'] += 1
        stats[session_id]['last_report_at'] = now_iso
        _save_reporter_stats(stats)

# ─── Reported cameras helpers ──────────────────────────────────────────────────
_reported_lock = threading.Lock()

def _load_reported_cameras():
    """Load reported cameras from disk."""
    if not os.path.exists(REPORTED_CAMERAS_FILE):
        return []
    try:
        with open(REPORTED_CAMERAS_FILE, 'r', encoding='utf-8') as f:
            return json.load(f)
    except Exception:
        return []

def _save_reported_cameras(cameras_list):
    """Save reported cameras to disk (caller must hold _reported_lock)."""
    os.makedirs(DATA_DIR, exist_ok=True)
    with open(REPORTED_CAMERAS_FILE, 'w', encoding='utf-8') as f:
        json.dump(cameras_list, f, indent=2)

def _append_reported_camera(entry):
    """Thread-safe append to reported_cameras.json."""
    with _reported_lock:
        cameras_list = _load_reported_cameras()
        cameras_list.append(entry)
        _save_reported_cameras(cameras_list)

def _update_reported_camera_status(camera_id, new_status):
    """Thread-safe status update for a reported camera."""
    with _reported_lock:
        cameras_list = _load_reported_cameras()
        updated = False
        for cam in cameras_list:
            if cam.get('id') == camera_id:
                cam['status'] = new_status
                updated = True
                break
        if updated:
            _save_reported_cameras(cameras_list)
        return updated

def fetch_confirmed_reported_cameras():
    """Return all confirmed community-reported cameras."""
    with _reported_lock:
        cameras_list = _load_reported_cameras()
    return [c for c in cameras_list if c.get('status') == 'confirmed']

# ─── Camera cache (in-memory, keyed by bbox string) ───────────────────────────
_camera_cache = {}          # bbox_key → {'cameras': [...], 'ts': float}
_camera_cache_lock = threading.Lock()
CAMERA_CACHE_TTL = 300      # 5 minutes

def _bbox_key(min_lat, min_lon, max_lat, max_lon):
    return f'{min_lat:.4f},{min_lon:.4f},{max_lat:.4f},{max_lon:.4f}'

def fetch_cameras_cached(min_lat, min_lon, max_lat, max_lon):
    """Fetch cameras with short-lived in-memory cache."""
    key = _bbox_key(min_lat, min_lon, max_lat, max_lon)
    now = time.time()
    with _camera_cache_lock:
        entry = _camera_cache.get(key)
        if entry and now - entry['ts'] < CAMERA_CACHE_TTL:
            return entry['cameras']
    cameras = fetch_cameras_in_bbox(min_lat, min_lon, max_lat, max_lon)
    with _camera_cache_lock:
        _camera_cache[key] = {'cameras': cameras, 'ts': now}
    return cameras

def _total_cached_cameras():
    """Return total number of unique cameras currently in cache."""
    with _camera_cache_lock:
        seen = set()
        for entry in _camera_cache.values():
            for c in entry['cameras']:
                seen.add(c['id'])
        return len(seen)

# ─── Rate limiter (token bucket, 60 req/min per IP) ───────────────────────────
_rate_buckets = {}          # ip → {'tokens': float, 'last': float}
_rate_lock = threading.Lock()
RATE_LIMIT = 60             # tokens per minute
RATE_REFILL = RATE_LIMIT / 60.0  # tokens per second

def _check_rate_limit(ip):
    """Return True if request is allowed, False if rate-limited."""
    now = time.time()
    with _rate_lock:
        bucket = _rate_buckets.get(ip)
        if bucket is None:
            _rate_buckets[ip] = {'tokens': RATE_LIMIT - 1, 'last': now}
            return True
        elapsed = now - bucket['last']
        bucket['tokens'] = min(RATE_LIMIT, bucket['tokens'] + elapsed * RATE_REFILL)
        bucket['last'] = now
        if bucket['tokens'] >= 1:
            bucket['tokens'] -= 1
            return True
        return False

# ─── Geometry helpers ──────────────────────────────────────────────────────────

def decode_polyline6(encoded):
    """Decode OSRM polyline6 encoded string to list of [lon, lat]."""
    coords = []
    index = 0
    lat = 0
    lng = 0
    while index < len(encoded):
        b, shift, result = 0, 0, 0
        while True:
            b = ord(encoded[index]) - 63
            index += 1
            result |= (b & 0x1f) << shift
            shift += 5
            if b < 0x20:
                break
        dlat = ~(result >> 1) if (result & 1) else (result >> 1)
        lat += dlat

        result, shift = 0, 0
        while True:
            b = ord(encoded[index]) - 63
            index += 1
            result |= (b & 0x1f) << shift
            shift += 5
            if b < 0x20:
                break
        dlng = ~(result >> 1) if (result & 1) else (result >> 1)
        lng += dlng

        coords.append([lng / 1e6, lat / 1e6])
    return coords


def haversine(lat1, lon1, lat2, lon2):
    """Distance in meters between two lat/lon points."""
    R = 6371000
    d_lat = math.radians(lat2 - lat1)
    d_lon = math.radians(lon2 - lon1)
    a = (math.sin(d_lat / 2) ** 2 +
         math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) * math.sin(d_lon / 2) ** 2)
    return R * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))


def point_to_segment_dist(plat, plon, alat, alon, blat, blon):
    """Distance in meters from point P to segment A-B."""
    lat_scale = 111320.0
    lon_scale = 111320.0 * math.cos(math.radians((alat + blat) / 2))
    px = (plon - alon) * lon_scale
    py = (plat - alat) * lat_scale
    dx = (blon - alon) * lon_scale
    dy = (blat - alat) * lat_scale
    len_sq = dx * dx + dy * dy
    if len_sq == 0:
        return math.hypot(px, py)
    t = max(0.0, min(1.0, (px * dx + py * dy) / len_sq))
    return math.hypot(px - t * dx, py - t * dy)


def min_dist_to_polyline(coords, cam_lat, cam_lon):
    """Minimum distance from camera to route polyline (list of [lon, lat])."""
    min_d = float('inf')
    for i in range(len(coords) - 1):
        lon1, lat1 = coords[i]
        lon2, lat2 = coords[i + 1]
        d = point_to_segment_dist(cam_lat, cam_lon, lat1, lon1, lat2, lon2)
        if d < min_d:
            min_d = d
    return min_d


def route_bearing_at_camera(coords, cam_lat, cam_lon):
    """Find the bearing of the route segment closest to the camera."""
    min_d = float('inf')
    best_seg = 0
    for i in range(len(coords) - 1):
        lon1, lat1 = coords[i]
        lon2, lat2 = coords[i + 1]
        d = point_to_segment_dist(cam_lat, cam_lon, lat1, lon1, lat2, lon2)
        if d < min_d:
            min_d = d
            best_seg = i
    lon1, lat1 = coords[best_seg]
    lon2, lat2 = coords[min(best_seg + 1, len(coords) - 1)]
    dy = lat2 - lat1
    dx = (lon2 - lon1) * math.cos(math.radians((lat1 + lat2) / 2))
    return math.degrees(math.atan2(dx, dy)) % 360


def deduplicate_waypoints(waypoints, min_dist_m=200):
    """Remove waypoints that are too close to each other."""
    if not waypoints:
        return []
    deduped = [waypoints[0]]
    for wp in waypoints[1:]:
        last = deduped[-1]
        d = haversine(last['lat'], last['lon'], wp['lat'], wp['lon'])
        if d >= min_dist_m:
            deduped.append(wp)
    return deduped


def compute_score(ghost_dist, fastest_dist, cameras_avoided, total_cameras):
    """Compute a 0-100 privacy score for the ghost route."""
    if total_cameras == 0:
        return 100
    cam_score = int((cameras_avoided / total_cameras) * 60)
    dist_ratio = ghost_dist / fastest_dist if fastest_dist > 0 else 1.0
    if dist_ratio <= 1.1:
        dist_score = 40
    elif dist_ratio <= 1.5:
        dist_score = 30
    elif dist_ratio <= 2.0:
        dist_score = 15
    else:
        dist_score = 0
    return min(100, cam_score + dist_score)


# ─── OSRM helper ───────────────────────────────────────────────────────────────

OSRM_BASE = 'https://router.project-osrm.org'

def osrm_route(waypoints):
    """
    Call OSRM with a list of (lon, lat) tuples.
    Returns the first route dict or None on failure.
    """
    coord_str = ';'.join(f'{lon:.6f},{lat:.6f}' for lon, lat in waypoints)
    url = f'{OSRM_BASE}/route/v1/driving/{coord_str}?overview=full&geometries=polyline6'
    req = urllib.request.Request(url, headers={'User-Agent': 'GhostNav/1.0'})
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.loads(resp.read())
            if data.get('code') == 'Ok' and data.get('routes'):
                return data['routes'][0]
    except Exception as e:
        print(f'[OSRM] Error: {e}')
    return None


# ─── Overpass camera fetch ─────────────────────────────────────────────────────

OVERPASS_URL = 'https://overpass-api.de/api/interpreter'

def fetch_cameras_in_bbox(min_lat, min_lon, max_lat, max_lon):
    """Fetch ALPR cameras from Overpass within bbox.
    Query optimized via GHOST-RESEARCH-003: B_broad_surveillance won (54 nodes, score=52.50)
    vs A_narrow_alpr (44 nodes) — broad query captures more cameras including non-tagged ALPR.
    """
    bbox = f"{min_lat:.5f},{min_lon:.5f},{max_lat:.5f},{max_lon:.5f}"
    query = f'''[out:json][timeout:30];
(
  node["man_made"="surveillance"]({bbox});
  node["surveillance"="camera"]({bbox});
);
out body;'''
    body = ('data=' + urllib.parse.quote(query)).encode()
    req = urllib.request.Request(OVERPASS_URL, data=body, headers={
        'User-Agent': 'GhostNav/1.0',
        'Content-Type': 'application/x-www-form-urlencoded',
    })
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = json.loads(resp.read())
            return [
                {'lat': el['lat'], 'lon': el['lon'], 'id': el['id'], 'tags': el.get('tags', {})}
                for el in data.get('elements', [])
            ]
    except Exception as e:
        print(f'[Overpass] Error: {e}')
        return []


# ─── Ghost Route core algorithm ────────────────────────────────────────────────

CAMERA_PROXIMITY_M = 25   # Camera "on route" threshold — tuned via GHOST-RESEARCH-005 (was 30, optimal=25)
MAX_ROUTE_RATIO = 2.0      # Ghost must be < 2x fastest distance
CLUSTER_RADIUS_M = 400     # Cameras within this distance share a cluster


def cluster_cameras(camera_list):
    """Group nearby cameras into clusters. Returns list of cluster dicts."""
    clusters = []
    assigned = set()
    for i, ci in enumerate(camera_list):
        if i in assigned:
            continue
        group = [ci]
        assigned.add(i)
        for j, cj in enumerate(camera_list):
            if j in assigned:
                continue
            if haversine(ci['lat'], ci['lon'], cj['lat'], cj['lon']) <= CLUSTER_RADIUS_M:
                group.append(cj)
                assigned.add(j)
        center_lat = sum(c['lat'] for c in group) / len(group)
        center_lon = sum(c['lon'] for c in group) / len(group)
        clusters.append({'cameras': group, 'lat': center_lat, 'lon': center_lon})
    return clusters


def offset_point(lat, lon, bearing_deg, dist_m):
    """Move a lat/lon point by dist_m in bearing_deg direction."""
    R = 6371000.0
    d = dist_m / R
    b = math.radians(bearing_deg)
    lat1 = math.radians(lat)
    lon1 = math.radians(lon)
    lat2 = math.asin(math.sin(lat1) * math.cos(d) +
                     math.cos(lat1) * math.sin(d) * math.cos(b))
    lon2 = lon1 + math.atan2(math.sin(b) * math.sin(d) * math.cos(lat1),
                              math.cos(d) - math.sin(lat1) * math.sin(lat2))
    return math.degrees(lat2), math.degrees(lon2)


def osrm_route_with_alts(waypoints, alternatives=3):
    """
    Call OSRM requesting multiple alternative routes.
    Returns list of route dicts (fastest first), or [single] on failure.
    """
    coord_str = ';'.join(f'{lon:.6f},{lat:.6f}' for lon, lat in waypoints)
    url = (f'{OSRM_BASE}/route/v1/driving/{coord_str}'
           f'?overview=full&geometries=polyline6&alternatives={alternatives}')
    req = urllib.request.Request(url, headers={'User-Agent': 'GhostNav/1.0'})
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            data = json.loads(resp.read())
            if data.get('code') == 'Ok' and data.get('routes'):
                return data['routes']
    except Exception as e:
        print(f'[OSRM] Alts error: {e}')
    return []


def count_cameras_on_route(route_coords, cameras):
    """Count cameras within CAMERA_PROXIMITY_M of route."""
    return sum(1 for cam in cameras
               if min_dist_to_polyline(route_coords, cam['lat'], cam['lon']) <= CAMERA_PROXIMITY_M)


def build_bypass_waypoints(cluster, route_coords, offset_m=600):
    """
    For a camera cluster, generate bypass waypoints:
    - Find the closest point on the route to the cluster centroid
    - Place waypoints 400m before + after that point, offset 600m perpendicularly
    This forces OSRM to route AROUND the cluster zone.
    Returns list of (lon, lat) waypoints or empty list.
    """
    # Find closest segment to cluster center
    min_d = float('inf')
    best_seg = 0
    for i in range(len(route_coords) - 1):
        lon1, lat1 = route_coords[i]
        lon2, lat2 = route_coords[i + 1]
        d = point_to_segment_dist(cluster['lat'], cluster['lon'], lat1, lon1, lat2, lon2)
        if d < min_d:
            min_d = d
            best_seg = i

    # Route direction bearing at cluster
    lon1, lat1 = route_coords[best_seg]
    lon2, lat2 = route_coords[min(best_seg + 1, len(route_coords) - 1)]
    dy = lat2 - lat1
    dx = (lon2 - lon1) * math.cos(math.radians((lat1 + lat2) / 2))
    route_bearing = math.degrees(math.atan2(dx, dy)) % 360

    # Perpendicular bearing (try both sides, pick the one that feels right)
    perp_left  = (route_bearing - 90) % 360
    perp_right = (route_bearing + 90) % 360

    # Find which side of the road the cluster is on
    # Determine by checking which perpendicular points AWAY from cluster
    lat_left, lon_left   = offset_point(cluster['lat'], cluster['lon'], perp_left,  300)
    lat_right, lon_right = offset_point(cluster['lat'], cluster['lon'], perp_right, 300)
    d_left  = haversine(lat1, lon1, lat_left,  lon_left)
    d_right = haversine(lat1, lon1, lat_right, lon_right)

    # Avoid direction = move AWAY from cluster (opposite side from where cluster is)
    # We want to go on the opposite side of the road from the cluster
    # Cluster position relative to route:
    near_lon = lon1
    near_lat = lat1
    side_vec_x = (cluster['lon'] - near_lon) * math.cos(math.radians(near_lat)) * 111320
    side_vec_y = (cluster['lat'] - near_lat) * 111320
    route_vec_x = (lon2 - lon1) * math.cos(math.radians((lat1 + lat2) / 2)) * 111320
    route_vec_y = (lat2 - lat1) * 111320
    # Cross product: positive = cluster is on the left
    cross = route_vec_x * side_vec_y - route_vec_y * side_vec_x
    avoid_bearing = perp_right if cross > 0 else perp_left  # opposite of cluster side

    # Entry point: 400m before cluster along route, offset 600m sideways
    entry_on_route_lat, entry_on_route_lon = offset_point(
        cluster['lat'], cluster['lon'], (route_bearing + 180) % 360, 400
    )
    entry_lat, entry_lon = offset_point(entry_on_route_lat, entry_on_route_lon, avoid_bearing, offset_m)

    # Exit point: 400m after cluster along route, offset 600m sideways
    exit_on_route_lat, exit_on_route_lon = offset_point(
        cluster['lat'], cluster['lon'], route_bearing, 400
    )
    exit_lat, exit_lon = offset_point(exit_on_route_lat, exit_on_route_lon, avoid_bearing, offset_m)

    return [
        (entry_lon, entry_lat),
        (exit_lon,  exit_lat),
    ]


def ghost_route_fn(start_lon, start_lat, end_lon, end_lat):
    """
    Corridor-based ghost routing:
    1. Get fastest route + OSRM alternatives
    2. Find cameras within 50m of each route
    3. If any alternative has fewer cameras: use it
    4. Otherwise: cluster cameras on fastest, build bypass waypoints
    5. Fall back to fastest if ghost is >2x longer
    """
    start = (start_lon, start_lat)
    end   = (end_lon, end_lat)

    # Step 1: Get fastest + alternatives
    all_routes = osrm_route_with_alts([start, end], alternatives=3)
    if not all_routes:
        return {'error': 'OSRM route failed'}, 502

    fastest = all_routes[0]
    fastest_coords = decode_polyline6(fastest['geometry'])
    fastest_dist   = fastest['distance']
    fastest_dur    = fastest['duration']

    # Step 2: Fetch cameras along the route corridor (expanded bbox)
    lats = [c[1] for c in fastest_coords]
    lons = [c[0] for c in fastest_coords]
    pad = 0.02  # ~2km padding to catch cameras on nearby roads
    cameras = fetch_cameras_cached(
        min(lats) - pad, min(lons) - pad,
        max(lats) + pad, max(lons) + pad,
    )

    # Also merge confirmed community-reported cameras (same 50m radius penalty)
    confirmed_reported = fetch_confirmed_reported_cameras()
    if confirmed_reported:
        existing_ids = {c['id'] for c in cameras}
        for rc in confirmed_reported:
            if rc['id'] not in existing_ids:
                # Wrap in same shape as OSM cameras for count_cameras_on_route
                cameras.append({
                    'id':  rc['id'],
                    'lat': rc['lat'],
                    'lon': rc['lon'],
                    'tags': {
                        'man_made': 'surveillance',
                        'operator': rc.get('operator', 'Unknown'),
                        'note':     f"Community reported: {rc.get('type', 'Unknown')}",
                    },
                })
        if confirmed_reported:
            print(f'[Ghost] Merged {len(confirmed_reported)} confirmed community cameras')

    # Step 3: Score all routes by camera count
    def score_route(route):
        coords = decode_polyline6(route['geometry'])
        n = count_cameras_on_route(coords, cameras)
        return n, coords

    fastest_cam_count, fastest_coords = score_route(fastest)
    print(f'[Ghost] Fastest route: {fastest_cam_count} cameras, {fastest_dist:.0f}m, '
          f'{len(all_routes)} total routes available')

    fastest_route_out = {
        'geometry': fastest['geometry'],
        'coords':   [[c[1], c[0]] for c in fastest_coords],
        'distance': fastest_dist,
        'duration': fastest_dur,
        'cameras':  fastest_cam_count,
    }

    # No cameras at all → fastest IS ghost
    if fastest_cam_count == 0:
        return {
            'fastest_route': fastest_route_out,
            'ghost_route': {**fastest_route_out, 'note': 'Route already camera-free'},
            'cameras_avoided': 0,
            'score': 100,
            'fallback': False,
        }, 200

    # Step 4: Check OSRM alternatives (cheapest fix — no Overpass needed)
    best_alt_route  = None
    best_alt_cams   = fastest_cam_count
    best_alt_coords = None

    for alt in all_routes[1:]:
        n, alt_coords = score_route(alt)
        ratio = alt['distance'] / fastest_dist
        print(f'[Ghost] Alt route: {n} cameras, {alt["distance"]:.0f}m ({ratio:.2f}x fastest)')
        if n < best_alt_cams and ratio < MAX_ROUTE_RATIO:
            best_alt_cams   = n
            best_alt_route  = alt
            best_alt_coords = alt_coords

    if best_alt_route and best_alt_cams < fastest_cam_count:
        avoided  = fastest_cam_count - best_alt_cams
        score    = compute_score(best_alt_route['distance'], fastest_dist, avoided, fastest_cam_count)
        print(f'[Ghost] Using OSRM alternative: avoided {avoided} cameras')
        return {
            'fastest_route': fastest_route_out,
            'ghost_route': {
                'geometry': best_alt_route['geometry'],
                'coords':   [[c[1], c[0]] for c in best_alt_coords],
                'distance': best_alt_route['distance'],
                'duration': best_alt_route['duration'],
                'cameras':  best_alt_cams,
                'method':   'osrm_alternative',
            },
            'cameras_avoided': avoided,
            'score': score,
            'fallback': False,
        }, 200

    # Step 5: No good alternative — try geometric bypass via cluster waypoints
    print('[Ghost] No good OSRM alternative, trying geometric bypass')

    hit_cameras = [cam for cam in cameras
                   if min_dist_to_polyline(fastest_coords, cam['lat'], cam['lon']) <= CAMERA_PROXIMITY_M]
    clusters = cluster_cameras(hit_cameras)
    print(f'[Ghost] {len(hit_cameras)} cameras in {len(clusters)} clusters')

    best_ghost = None
    best_ghost_cams = fastest_cam_count

    # Try multiple offset distances
    for offset_m in [600, 1000, 1500]:
        all_bypass_wps = []
        for cluster in clusters:
            wps = build_bypass_waypoints(cluster, fastest_coords, offset_m=offset_m)
            all_bypass_wps.extend(wps)

        if not all_bypass_wps:
            continue

        # Sort by longitude (proxy for ordering along route in SC, going east)
        # Use a smarter ordering: project onto route direction
        route_bearing_overall = math.degrees(math.atan2(
            (end_lon - start_lon) * math.cos(math.radians((start_lat + end_lat) / 2)),
            end_lat - start_lat
        )) % 360
        # Sort waypoints by projected distance from start
        def proj_dist(wp):
            lon, lat = wp
            dy = (lat - start_lat) * 111320
            dx = (lon - start_lon) * 111320 * math.cos(math.radians(start_lat))
            b = math.radians(route_bearing_overall)
            return dy * math.cos(b) + dx * math.sin(b)  # dot product with route direction

        all_bypass_wps.sort(key=proj_dist)

        # Deduplicate (remove waypoints within 300m of each other)
        deduped_wps = []
        for wp in all_bypass_wps:
            if not deduped_wps:
                deduped_wps.append(wp)
                continue
            last = deduped_wps[-1]
            d = haversine(last[1], last[0], wp[1], wp[0])
            if d >= 300:
                deduped_wps.append(wp)

        print(f'[Ghost] Bypass attempt offset={offset_m}m: {len(deduped_wps)} waypoints')

        waypoints = [start] + deduped_wps + [end]
        ghost = osrm_route(waypoints)
        if not ghost:
            continue

        ghost_coords = decode_polyline6(ghost['geometry'])
        ghost_cams   = count_cameras_on_route(ghost_coords, cameras)
        ratio        = ghost['distance'] / fastest_dist
        print(f'[Ghost] Bypass result: {ghost_cams} cameras, {ghost["distance"]:.0f}m ({ratio:.2f}x)')

        if ghost_cams < best_ghost_cams and ratio < MAX_ROUTE_RATIO:
            best_ghost_cams = ghost_cams
            best_ghost = ghost
            best_ghost_coords = ghost_coords
            if best_ghost_cams == 0:
                break  # perfect

    if best_ghost and best_ghost_cams < fastest_cam_count:
        avoided = fastest_cam_count - best_ghost_cams
        score   = compute_score(best_ghost['distance'], fastest_dist, avoided, fastest_cam_count)
        print(f'[Ghost] Bypass route: avoided {avoided} cameras')
        return {
            'fastest_route': fastest_route_out,
            'ghost_route': {
                'geometry': best_ghost['geometry'],
                'coords':   [[c[1], c[0]] for c in best_ghost_coords],
                'distance': best_ghost['distance'],
                'duration': best_ghost['duration'],
                'cameras':  best_ghost_cams,
                'method':   'geometric_bypass',
            },
            'cameras_avoided': avoided,
            'score': score,
            'fallback': False,
        }, 200

    # Final fallback
    print('[Ghost] No improvement found, returning fastest as ghost with warning')
    return {
        'fastest_route':   fastest_route_out,
        'ghost_route': {
            **fastest_route_out,
            'note': f'No camera-free route found (cameras on all roads in area)',
            'method': 'fallback',
        },
        'cameras_avoided': 0,
        'score':           50,
        'fallback':        True,
    }, 200


# ─── HTTP Server ───────────────────────────────────────────────────────────────

class GhostHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=DIR, **kwargs)

    def log_message(self, format, *args):
        print(f'[{self.address_string()}] {format % args}')

    def _send_json(self, data, status=200):
        body = json.dumps(data, indent=2).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _proxy_get(self, url, timeout=15):
        try:
            req = urllib.request.Request(url, headers={
                'User-Agent': 'GhostNav/1.0 (privacy-navigation-research)'
            })
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                data = resp.read()
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Access-Control-Allow-Origin', '*')
                self.end_headers()
                self.wfile.write(data)
        except Exception as e:
            self.send_response(502)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps({'error': str(e)}).encode())

    def _proxy_post(self, url, body, content_type='application/x-www-form-urlencoded', timeout=30):
        try:
            req = urllib.request.Request(url, data=body, headers={
                'User-Agent': 'GhostNav/1.0 (privacy-navigation-research)',
                'Content-Type': content_type,
            })
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                data = resp.read()
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Access-Control-Allow-Origin', '*')
                self.end_headers()
                self.wfile.write(data)
        except Exception as e:
            self.send_response(502)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps({'error': str(e)}).encode())

    def _check_rate(self):
        """Return True (allowed) or send 429 and return False."""
        ip = self.client_address[0]
        if _check_rate_limit(ip):
            return True
        self._send_json({'error': 'Rate limit exceeded. Max 60 requests/min.'}, 429)
        return False

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.end_headers()

    def do_POST(self):
        content_length = int(self.headers.get('Content-Length', 0))
        body = self.rfile.read(content_length)

        # ── POST /api/v1/route ────────────────────────────────────────────────
        if self.path == '/api/v1/route':
            if not self._check_rate():
                return
            try:
                req_data = json.loads(body)
            except Exception:
                self._send_json({'error': 'Invalid JSON body'}, 400)
                return

            start = req_data.get('start')
            end   = req_data.get('end')
            mode  = req_data.get('mode', 'both')

            if (not isinstance(start, list) or len(start) != 2 or
                    not isinstance(end, list) or len(end) != 2):
                self._send_json({'error': 'start and end must be [lat, lon] arrays'}, 400)
                return
            if mode not in ('fastest', 'ghost', 'both'):
                self._send_json({'error': 'mode must be fastest, ghost, or both'}, 400)
                return

            start_lat, start_lon = float(start[0]), float(start[1])
            end_lat,   end_lon   = float(end[0]),   float(end[1])

            print(f'[API /route] {start_lat},{start_lon} → {end_lat},{end_lon} mode={mode}')
            result, status = ghost_route_fn(start_lon, start_lat, end_lon, end_lat)

            if 'error' in result:
                self._send_json(result, status)
                return

            # Build response in the v1 schema
            def _fmt_route(r):
                return {
                    'geometry':      r.get('geometry', ''),
                    'distance_m':    int(r.get('distance', 0)),
                    'duration_s':    int(r.get('duration', 0)),
                    'cameras':       r.get('cameras', 0),
                    'privacy_score': compute_score(
                        r.get('distance', 0),
                        result['fastest_route'].get('distance', 1),
                        result.get('cameras_avoided', 0),
                        result['fastest_route'].get('cameras', 0),
                    ) if r is not result['fastest_route'] else max(0, 100 - r.get('cameras', 0) * 10),
                }

            fastest_r = result['fastest_route']
            ghost_r   = result['ghost_route']
            fastest_fmt = _fmt_route(fastest_r)
            ghost_fmt   = _fmt_route(ghost_r)

            extra_dist = max(0, ghost_r.get('distance', 0) - fastest_r.get('distance', 0))
            extra_dur  = max(0, ghost_r.get('duration', 0) - fastest_r.get('duration', 0))

            if mode == 'fastest':
                out = {'fastest': fastest_fmt}
            elif mode == 'ghost':
                out = {
                    'ghost': ghost_fmt,
                    'cameras_avoided': result.get('cameras_avoided', 0),
                }
            else:  # both
                out = {
                    'fastest':         fastest_fmt,
                    'ghost':           ghost_fmt,
                    'cameras_avoided': result.get('cameras_avoided', 0),
                    'extra_distance_m': int(extra_dist),
                    'extra_duration_s': int(extra_dur),
                }

            self._send_json(out, 200)
            return

        if self.path.startswith('/proxy/overpass'):
            self._proxy_post('https://overpass-api.de/api/interpreter', body, timeout=30)
            return

        # ── POST /api/report-camera ───────────────────────────────────────────
        if self.path == '/api/report-camera':
            try:
                data = json.loads(body)
            except Exception:
                self._send_json({'error': 'Invalid JSON'}, 400)
                return

            lat = data.get('lat')
            lon = data.get('lon')

            # Validate lat/lon
            try:
                lat = float(lat)
                lon = float(lon)
            except (TypeError, ValueError):
                self._send_json({'error': 'lat and lon must be numbers'}, 400)
                return
            if not (-90 <= lat <= 90) or not (-180 <= lon <= 180):
                self._send_json({'error': 'lat/lon out of valid range'}, 400)
                return

            # Allowed values
            valid_types    = {'Flock', 'Genetec', 'Unknown'}
            valid_operators = {'Police', 'Private', 'HOA', 'Unknown'}
            valid_dirs     = {'N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW', 'Unknown'}

            cam_type  = str(data.get('type', 'Unknown'))
            operator  = str(data.get('operator', 'Unknown'))
            direction = str(data.get('direction', 'Unknown'))
            notes     = str(data.get('notes', ''))[:500]  # cap notes length

            if cam_type not in valid_types:
                cam_type = 'Unknown'
            if operator not in valid_operators:
                operator = 'Unknown'
            if direction not in valid_dirs:
                direction = 'Unknown'

            session_id = str(data.get('session_id', ''))[:64]  # cap length
            if not session_id:
                session_id = str(uuid.uuid4())  # anonymous fallback

            entry = {
                'id':           str(uuid.uuid4()),
                'lat':          lat,
                'lon':          lon,
                'type':         cam_type,
                'operator':     operator,
                'direction':    direction,
                'notes':        notes,
                'session_id':   session_id,
                'submitted_at': datetime.now(timezone.utc).isoformat(),
                'status':       'pending',
            }

            _append_reported_camera(entry)
            _upsert_reporter_stat(session_id)
            print(f'[Report] Camera reported at {lat},{lon} type={cam_type} operator={operator} session={session_id[:8]}…')
            self._send_json({'status': 'ok', 'message': 'Camera reported, thank you!'})
            return

        self.send_response(404)
        self.end_headers()

    def do_GET(self):
        # ── GET /share — route share card with OG meta tags ───────────────────
        if self.path.startswith('/share'):
            parsed   = urllib.parse.urlparse(self.path)
            params   = urllib.parse.parse_qs(parsed.query)

            def _p(key, default=''):
                vals = params.get(key)
                return vals[0] if vals else default

            slat  = _p('slat')
            slon  = _p('slon')
            elat  = _p('elat')
            elon  = _p('elon')
            try:
                cameras = int(_p('cam', '0'))
            except ValueError:
                cameras = 0
            try:
                saved = int(_p('saved', '0'))
            except ValueError:
                saved = 0

            # Privacy score: 100 at 0 cams, floors at 10
            privacy_score = max(10, 100 - cameras * 8)
            cameras_plural = 's' if cameras != 1 else ''

            # Build canonical URLs
            host = self.headers.get('Host', 'localhost:8766')
            scheme = 'http'
            base_url = f'{scheme}://{host}'
            share_url = f'{base_url}/share?slat={slat}&slon={slon}&elat={elat}&elon={elon}&cam={cameras}&saved={saved}'
            # View route URL: loads Ghost main page and restores route via query params
            view_route_url = (
                f'{base_url}/?slat={slat}&slon={slon}&elat={elat}&elon={elon}'
                f'&cam={cameras}&saved={saved}'
            )

            # Render share-card.html template
            card_path = os.path.join(DIR, 'share-card.html')
            try:
                with open(card_path, 'r', encoding='utf-8') as f:
                    template = f.read()
            except FileNotFoundError:
                self.send_response(500)
                self.end_headers()
                self.wfile.write(b'share-card.html not found')
                return

            html = template.format(
                cameras=cameras,
                cameras_plural=cameras_plural,
                privacy_score=privacy_score,
                saved=saved,
                base_url=base_url,
                share_url=share_url,
                view_route_url=view_route_url,
            )
            data = html.encode('utf-8')
            self.send_response(200)
            self.send_header('Content-Type', 'text/html; charset=utf-8')
            self.send_header('Content-Length', str(len(data)))
            self.send_header('Cache-Control', 'public, max-age=300')
            self.end_headers()
            self.wfile.write(data)
            return

        # ── GET /share-preview.png — static OG fallback image ─────────────────
        if self.path.split('?')[0] == '/share-preview.png':
            img_path = os.path.join(DIR, 'share-preview.png')
            try:
                with open(img_path, 'rb') as f:
                    data = f.read()
                self.send_response(200)
                self.send_header('Content-Type', 'image/png')
                self.send_header('Content-Length', str(len(data)))
                self.send_header('Cache-Control', 'public, max-age=86400')
                self.end_headers()
                self.wfile.write(data)
            except FileNotFoundError:
                self.send_response(404)
                self.end_headers()
            return

        # ── GET /api-docs ─────────────────────────────────────────────────────
        if self.path.split('?')[0] in ('/api-docs', '/api-docs/'):
            docs_path = os.path.join(DIR, 'api-docs.html')
            try:
                with open(docs_path, 'rb') as f:
                    data = f.read()
                self.send_response(200)
                self.send_header('Content-Type', 'text/html; charset=utf-8')
                self.send_header('Content-Length', str(len(data)))
                self.end_headers()
                self.wfile.write(data)
            except FileNotFoundError:
                self.send_response(404)
                self.end_headers()
            return

        # ── GET /api/v1/health ────────────────────────────────────────────────
        if self.path == '/api/v1/health':
            self._send_json({
                'status':         'ok',
                'cameras_cached': _total_cached_cameras(),
                'version':        VERSION,
            })
            return

        # ── GET /api/v1/score ─────────────────────────────────────────────────
        if self.path.startswith('/api/v1/score'):
            if not self._check_rate():
                return
            parsed = urllib.parse.urlparse(self.path)
            params = urllib.parse.parse_qs(parsed.query)

            try:
                lat      = float(params['lat'][0])
                lon      = float(params['lon'][0])
                radius_m = float(params.get('radius_m', ['1000'])[0])
            except (KeyError, ValueError):
                self._send_json({'error': 'Required: lat, lon (float). Optional: radius_m (default 1000)'}, 400)
                return

            # Convert radius to rough bbox
            deg_lat = radius_m / 111320.0
            deg_lon = radius_m / (111320.0 * math.cos(math.radians(lat)))
            cameras = fetch_cameras_cached(
                lat - deg_lat, lon - deg_lon,
                lat + deg_lat, lon + deg_lon,
            )

            # Filter to actual radius
            nearby = [
                c for c in cameras
                if haversine(lat, lon, c['lat'], c['lon']) <= radius_m
            ]

            area_km2 = math.pi * (radius_m / 1000.0) ** 2
            density  = round(len(nearby) / area_km2, 2) if area_km2 > 0 else 0.0
            # Privacy score: 100 at 0 cameras, drops linearly, floor 10
            privacy_score = max(10, 100 - int(len(nearby) * 10))

            cam_list = [
                {
                    'id':           c['id'],
                    'lat':          c['lat'],
                    'lon':          c['lon'],
                    'manufacturer': c['tags'].get('manufacturer', c['tags'].get('brand', 'Unknown')),
                    'operator':     c['tags'].get('operator', c['tags'].get('operator:short', 'Unknown')),
                }
                for c in nearby
            ]

            self._send_json({
                'lat':                  lat,
                'lon':                  lon,
                'radius_m':             radius_m,
                'camera_count':         len(nearby),
                'surveillance_density': density,
                'privacy_score':        privacy_score,
                'cameras':              cam_list,
            })
            return

        # ── Ghost route endpoint ──────────────────────────────────────────────
        if self.path.startswith('/api/ghost-route'):
            parsed = urllib.parse.urlparse(self.path)
            params = urllib.parse.parse_qs(parsed.query)

            def get_param(name):
                vals = params.get(name)
                return float(vals[0]) if vals else None

            start_lon = get_param('start_lon')
            start_lat = get_param('start_lat')
            end_lon   = get_param('end_lon')
            end_lat   = get_param('end_lat')

            if None in (start_lon, start_lat, end_lon, end_lat):
                self._send_json({'error': 'Missing required params: start_lon, start_lat, end_lon, end_lat'}, 400)
                return

            print(f'[GhostRoute] {start_lat},{start_lon} → {end_lat},{end_lon}')
            result, status = ghost_route_fn(start_lon, start_lat, end_lon, end_lat)
            self._send_json(result, status)
            return

        # ── Embed routes ──────────────────────────────────────────────────────
        _embed_base = self.path.split('?')[0]
        if _embed_base in ('/embed', '/embed/'):
            embed_path = os.path.join(DIR, 'embed.html')
            try:
                with open(embed_path, 'rb') as f:
                    data = f.read()
                self.send_response(200)
                self.send_header('Content-Type', 'text/html; charset=utf-8')
                self.send_header('Content-Length', str(len(data)))
                self.send_header('X-Frame-Options', 'ALLOWALL')
                self.end_headers()
                self.wfile.write(data)
            except FileNotFoundError:
                self.send_response(404)
                self.end_headers()
            return

        if self.path.split('?')[0] == '/embed.js':
            js_path = os.path.join(DIR, 'embed.js')
            try:
                with open(js_path, 'rb') as f:
                    data = f.read()
                self.send_response(200)
                self.send_header('Content-Type', 'application/javascript; charset=utf-8')
                self.send_header('Content-Length', str(len(data)))
                self.end_headers()
                self.wfile.write(data)
            except FileNotFoundError:
                self.send_response(404)
                self.end_headers()
            return

        # ── PWA: manifest.json ────────────────────────────────────────────────
        if self.path.split('?')[0] == '/manifest.json':
            manifest_path = os.path.join(DIR, 'manifest.json')
            try:
                with open(manifest_path, 'rb') as f:
                    data = f.read()
                self.send_response(200)
                self.send_header('Content-Type', 'application/manifest+json')
                self.send_header('Content-Length', str(len(data)))
                self.end_headers()
                self.wfile.write(data)
            except FileNotFoundError:
                self.send_response(404)
                self.end_headers()
            return

        # ── PWA: service worker (must serve from root scope) ──────────────────
        if self.path.split('?')[0] == '/sw.js':
            sw_path = os.path.join(DIR, 'sw.js')
            try:
                with open(sw_path, 'rb') as f:
                    data = f.read()
                self.send_response(200)
                self.send_header('Content-Type', 'application/javascript; charset=utf-8')
                self.send_header('Service-Worker-Allowed', '/')
                self.send_header('Content-Length', str(len(data)))
                self.end_headers()
                self.wfile.write(data)
            except FileNotFoundError:
                self.send_response(404)
                self.end_headers()
            return

        # ── Existing proxy routes ─────────────────────────────────────────────
        # ── GET /api/cameras/reported ─────────────────────────────────────────
        if self.path.split('?')[0] == '/api/cameras/reported':
            with _reported_lock:
                all_cams = _load_reported_cameras()
            visible = [c for c in all_cams if c.get('status') != 'rejected']
            self._send_json({'cameras': visible, 'count': len(visible)})
            return

        # ── GET /api/admin/pending ─────────────────────────────────────────────
        if self.path.startswith('/api/admin/pending') or self.path.startswith('/api/admin/confirm'):
            parsed  = urllib.parse.urlparse(self.path)
            params  = urllib.parse.parse_qs(parsed.query)
            key     = params.get('key', [''])[0]

            if key != GHOST_ADMIN_KEY:
                self._send_json({'error': 'Unauthorized'}, 403)
                return

            # /api/admin/confirm?key=...&id=...&status=confirmed|rejected
            if parsed.path == '/api/admin/confirm':
                camera_id  = params.get('id', [''])[0]
                new_status = params.get('status', ['confirmed'])[0]
                if new_status not in ('confirmed', 'rejected', 'pending'):
                    self._send_json({'error': 'status must be confirmed, rejected, or pending'}, 400)
                    return
                ok = _update_reported_camera_status(camera_id, new_status)
                if ok:
                    self._send_json({'status': 'ok', 'id': camera_id, 'new_status': new_status})
                else:
                    self._send_json({'error': 'Camera not found'}, 404)
                return

            # /api/admin/pending — list pending
            with _reported_lock:
                all_cams = _load_reported_cameras()
            pending = [c for c in all_cams if c.get('status') == 'pending']
            self._send_json({'cameras': pending, 'count': len(pending)})
            return

        # ── GET /api/leaderboard ──────────────────────────────────────────────
        if self.path.split('?')[0] == '/api/leaderboard':
            with _stats_lock:
                stats = _load_reporter_stats()
            with _reported_lock:
                all_cams = _load_reported_cameras()

            # Build sorted leaderboard
            entries = []
            for sid, s in stats.items():
                entries.append({
                    'session_id':    sid,
                    'display_name':  s.get('display_name', 'Anonymous'),
                    'report_count':  s.get('report_count', 0),
                    'verified_count': s.get('verified_count', 0),
                    'first_report_at': s.get('first_report_at', ''),
                    'last_report_at':  s.get('last_report_at', ''),
                })
            entries.sort(key=lambda x: x['report_count'], reverse=True)
            top20 = entries[:20]

            # Add rank and strip session_id from public output
            ranked = []
            for i, e in enumerate(top20):
                ranked.append({
                    'rank':          i + 1,
                    'display_name':  e['display_name'],
                    'report_count':  e['report_count'],
                    'verified_count': e['verified_count'],
                    'first_report_at': e['first_report_at'],
                    'session_id':    e['session_id'],  # needed for "your stats" matching
                })

            total_cameras  = len(all_cams)
            total_verified = sum(1 for c in all_cams if c.get('status') == 'confirmed')
            reporters_count = len(stats)

            self._send_json({
                'leaderboard': ranked,
                'totals': {
                    'total_cameras':  total_cameras,
                    'total_verified': total_verified,
                    'reporters_count': reporters_count,
                },
            })
            return

        if self.path.startswith('/proxy/nominatim?'):
            query = self.path.split('?', 1)[1]
            self._proxy_get(f'https://nominatim.openstreetmap.org/search?{query}')
            return

        if self.path.startswith('/proxy/census?'):
            query = self.path.split('?', 1)[1]
            self._proxy_get(f'https://geocoding.geo.census.gov/geocoder/locations/onelineaddress?{query}', timeout=10)
            return

        if self.path.startswith('/proxy/osrm/'):
            osrm_path = self.path.replace('/proxy/osrm/', '')
            self._proxy_get(f'https://router.project-osrm.org/{osrm_path}')
            return

        if self.path.startswith('/proxy/overpass?'):
            query = self.path.split('?', 1)[1]
            self._proxy_get(f'https://overpass-api.de/api/interpreter?{query}', timeout=30)
            return

        # ── GET /weekly-report ────────────────────────────────────────────────
        if self.path.startswith('/weekly-report'):
            parsed = urllib.parse.urlparse(self.path)
            params = urllib.parse.parse_qs(parsed.query)
            commute_filter = params.get('commute', [None])[0]

            if not _WEEKLY_REPORT_AVAILABLE:
                error_html = (
                    b'<html><body style="background:#0a0a0a;color:#e5e5e5;font-family:sans-serif;padding:2rem">'
                    b'<h1 style="color:#22c55e">Ghost Nav</h1>'
                    b'<p>Weekly report unavailable: jinja2 not installed.</p>'
                    b'<p>Run: <code>pip3 install jinja2</code></p>'
                    b'</body></html>'
                )
                self.send_response(503)
                self.send_header('Content-Type', 'text/html; charset=utf-8')
                self.send_header('Content-Length', str(len(error_html)))
                self.end_headers()
                self.wfile.write(error_html)
                return

            try:
                html = _gen_weekly_report(filter_name=commute_filter)
                data = html.encode('utf-8')
                self.send_response(200)
                self.send_header('Content-Type', 'text/html; charset=utf-8')
                self.send_header('Content-Length', str(len(data)))
                self.send_header('Cache-Control', 'no-cache')
                self.end_headers()
                self.wfile.write(data)
            except Exception as e:
                print(f'[weekly-report] Error: {e}')
                err = f'<html><body><pre>Weekly report error: {e}</pre></body></html>'.encode()
                self.send_response(500)
                self.send_header('Content-Type', 'text/html; charset=utf-8')
                self.send_header('Content-Length', str(len(err)))
                self.end_headers()
                self.wfile.write(err)
            return

        super().do_GET()


if __name__ == '__main__':
    server = http.server.HTTPServer(('0.0.0.0', PORT), GhostHandler)
    print(f'Ghost Nav server on http://0.0.0.0:{PORT}')
    server.serve_forever()
