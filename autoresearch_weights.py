#!/usr/bin/env python3
"""
GHOST-RESEARCH-002: Autoresearch — Tune Camera Penalty Weights for Ghost Routing
Tests 5 Summerville/Charleston area routes and scores weight variants.
Scoring metric: cameras_avoided / max(extra_travel_time_seconds, 1) — maximize

Since the Ghost server uses a proximity-threshold approach rather than 
multiplicative penalty weights, we map the task's weight variants to the
corresponding server constants:
  camera_facing   → primary bypass influence (conceptual)
  camera_not_facing → secondary bypass influence (conceptual)
  radius_m        → CAMERA_PROXIMITY_M (actual server constant)

We test the live server with the current CAMERA_PROXIMITY_M=50, then simulate
what different radius values would produce using the raw route data and
re-scoring camera counts at different proximity thresholds.
"""

import json
import math
import urllib.request
import urllib.error
import time

API_BASE = "http://localhost:8766"

# Weight variants: (camera_facing, camera_not_facing, radius_m)
# radius_m maps directly to CAMERA_PROXIMITY_M in server.py
WEIGHT_VARIANTS = [
    (4.0, 1.5, 50),    # current baseline
    (6.0, 2.0, 75),    # wider radius, stronger facing penalty
    (3.0, 1.2, 30),    # tighter radius, lighter penalties
    (8.0, 3.0, 100),   # very wide radius, heavy penalties
    (4.0, 1.0, 50),    # same radius, very low non-facing penalty
    (5.0, 2.5, 60),    # moderate increase across the board
]

# Test routes: (name, origin_lat, origin_lng, dest_lat, dest_lng)
TEST_ROUTES = [
    ("Home Depot Summerville → Sandy Bend Ln",  33.0307, -80.1614, 33.0771, -80.1219),
    ("Summerville Downtown → Carnes Crossroads", 33.0176, -80.1757, 33.0621, -80.1052),
    ("Walmart Summerville → Pine Forest",        33.0082, -80.1889, 33.0493, -80.1543),
    ("Azalea Square → Ladson",                   33.0145, -80.1623, 32.9876, -80.1234),
    ("North Summerville → Jedburg",              33.0532, -80.1834, 33.0234, -80.2345),
]


def call_route(origin_lat, origin_lng, dest_lat, dest_lng, retries=3):
    """Call Ghost routing API. Returns response dict or None."""
    payload = json.dumps({
        "start": [origin_lat, origin_lng],
        "end":   [dest_lat,   dest_lng],
    }).encode()
    req = urllib.request.Request(
        f"{API_BASE}/api/v1/route",
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                return json.loads(resp.read())
        except urllib.error.HTTPError as e:
            body = e.read().decode()
            print(f"  [HTTP {e.code}] {body[:200]}")
            return None
        except Exception as e:
            print(f"  [Error attempt {attempt+1}] {e}")
            if attempt < retries - 1:
                time.sleep(2)
    return None


def haversine(lat1, lon1, lat2, lon2):
    """Distance in meters between two lat/lon points."""
    R = 6371000
    d_lat = math.radians(lat2 - lat1)
    d_lon = math.radians(lon2 - lon1)
    a = (math.sin(d_lat / 2) ** 2 +
         math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) * math.sin(d_lon / 2) ** 2)
    return R * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))


def decode_polyline6(encoded):
    """Decode OSRM polyline6 to list of [lon, lat]."""
    coords = []
    index = lat = lng = 0
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


def point_to_segment_dist(plat, plon, alat, alon, blat, blon):
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
    min_d = float('inf')
    for i in range(len(coords) - 1):
        lon1, lat1 = coords[i]
        lon2, lat2 = coords[i + 1]
        d = point_to_segment_dist(cam_lat, cam_lon, lat1, lon1, lat2, lon2)
        if d < min_d:
            min_d = d
    return min_d


def simulate_cameras_on_route(route_geometry, cameras, proximity_m):
    """Re-score camera count for a route at a given proximity threshold."""
    if not route_geometry or not cameras:
        return 0
    try:
        coords = decode_polyline6(route_geometry)
    except Exception:
        return 0
    return sum(1 for cam in cameras
               if min_dist_to_polyline(coords, cam['lat'], cam['lon']) <= proximity_m)


def fetch_cameras_near_route(origin_lat, origin_lng, dest_lat, dest_lng):
    """Use the /api/v1/score endpoint to get cameras in a bounding area."""
    # Compute center
    center_lat = (origin_lat + dest_lat) / 2
    center_lng = (origin_lng + dest_lng) / 2
    dist = haversine(origin_lat, origin_lng, dest_lat, dest_lng)
    radius = max(dist * 0.6, 2000)  # at least 2km radius

    url = f"{API_BASE}/api/v1/score?lat={center_lat}&lon={center_lng}&radius_m={radius}"
    try:
        with urllib.request.urlopen(url, timeout=30) as resp:
            data = json.loads(resp.read())
            return data.get("cameras", [])
    except Exception as e:
        print(f"  [score API error] {e}")
        return []


def main():
    print("=" * 60)
    print("GHOST-RESEARCH-002: Camera Penalty Weight Autoresearch")
    print("=" * 60)
    print(f"\nTesting {len(TEST_ROUTES)} routes × {len(WEIGHT_VARIANTS)} weight variants")
    print("Scoring metric: cameras_avoided / max(extra_seconds, 1)\n")

    # ─── Step 1: Fetch baseline route data for all test routes ───────────────
    print("Phase 1: Fetching baseline routes from live server...")
    baseline_results = []

    for route_name, olat, olng, dlat, dlng in TEST_ROUTES:
        print(f"\n  Route: {route_name}")
        print(f"  ({olat},{olng}) → ({dlat},{dlng})")

        resp = call_route(olat, olng, dlat, dlng)
        if not resp:
            print("  ✗ Route failed, skipping")
            baseline_results.append(None)
            continue

        fastest = resp.get("fastest", {})
        ghost   = resp.get("ghost", {})
        cameras_avoided = resp.get("cameras_avoided", 0)
        extra_dist = resp.get("extra_distance_m", 0)
        extra_dur  = resp.get("extra_duration_s", 0)

        print(f"  Fastest: {fastest.get('distance_m',0)}m, {fastest.get('duration_s',0)}s, "
              f"{fastest.get('cameras',0)} cameras")
        print(f"  Ghost:   {ghost.get('distance_m',0)}m, {ghost.get('duration_s',0)}s, "
              f"{ghost.get('cameras',0)} cameras")
        print(f"  Avoided: {cameras_avoided} cameras, +{extra_dur}s extra")

        # Fetch cameras in the area for re-simulation
        cameras = fetch_cameras_near_route(olat, olng, dlat, dlng)
        print(f"  Area cameras fetched: {len(cameras)}")

        baseline_results.append({
            "route":            route_name,
            "origin":           [olat, olng],
            "dest":             [dlat, dlng],
            "fastest":          fastest,
            "ghost":            ghost,
            "cameras_avoided":  cameras_avoided,
            "extra_distance_m": extra_dist,
            "extra_duration_s": extra_dur,
            "area_cameras":     cameras,
        })
        time.sleep(1)  # be polite to OSRM/Overpass

    # ─── Step 2: Score each weight variant ────────────────────────────────────
    print("\n\nPhase 2: Scoring weight variants via simulation...")
    print("(radius_m → CAMERA_PROXIMITY_M; camera_facing/not_facing → bypass aggressiveness)\n")

    variant_scores = []

    for cf, cnf, radius_m in WEIGHT_VARIANTS:
        total_cams_avoided = 0
        total_extra_seconds = 0
        route_details = []

        for data in baseline_results:
            if data is None:
                continue

            fastest = data["fastest"]
            ghost   = data["ghost"]
            cameras = data["area_cameras"]

            f_geom = fastest.get("geometry", "")
            g_geom = ghost.get("geometry", "")

            # Re-score at this radius
            f_cams_at_r = simulate_cameras_on_route(f_geom, cameras, radius_m)
            g_cams_at_r = simulate_cameras_on_route(g_geom, cameras, radius_m)

            # cameras_avoided = what the ghost route avoids vs fastest at this radius
            avoided_r = max(0, f_cams_at_r - g_cams_at_r)

            # Extra seconds stays the same (route geometry doesn't change)
            extra_s = data.get("extra_duration_s", 0)

            # Apply camera_facing multiplier as a conceptual penalty amplifier:
            # Higher camera_facing weight = we "care more" about facing cameras
            # We simulate this by weighting cameras based on tags
            facing_cameras = [c for c in cameras
                              if c.get("tags", {}).get("direction") or
                                 c.get("tags", {}).get("camera:direction")]
            non_facing_cameras = [c for c in cameras
                                  if c not in facing_cameras]

            # Re-score with weighted camera importance
            f_weighted = (
                simulate_cameras_on_route(f_geom, facing_cameras, radius_m) * cf +
                simulate_cameras_on_route(f_geom, non_facing_cameras, radius_m) * cnf
            )
            g_weighted = (
                simulate_cameras_on_route(g_geom, facing_cameras, radius_m) * cf +
                simulate_cameras_on_route(g_geom, non_facing_cameras, radius_m) * cnf
            )
            avoided_weighted = max(0.0, f_weighted - g_weighted)

            total_cams_avoided += avoided_r
            total_extra_seconds += extra_s

            route_details.append({
                "route":            data["route"],
                "fastest_cams_at_radius": f_cams_at_r,
                "ghost_cams_at_radius":   g_cams_at_r,
                "avoided_at_radius":      avoided_r,
                "extra_seconds":          extra_s,
                "weighted_avoided":       round(avoided_weighted, 2),
            })

        score = total_cams_avoided / max(total_extra_seconds, 1)
        variant_scores.append({
            "camera_facing":     cf,
            "camera_not_facing": cnf,
            "radius_m":          radius_m,
            "total_cameras_avoided": total_cams_avoided,
            "total_extra_seconds":   total_extra_seconds,
            "score":             round(score, 6),
            "route_details":     route_details,
        })

        print(f"  ({cf}, {cnf}, {radius_m}m): avoided={total_cams_avoided}, "
              f"extra={total_extra_seconds}s, score={score:.6f}")

    # ─── Step 3: Find winner ──────────────────────────────────────────────────
    variant_scores.sort(key=lambda x: x["score"], reverse=True)
    winner = variant_scores[0]

    print(f"\n{'='*60}")
    print("RESULTS:")
    print(f"  Winner: camera_facing={winner['camera_facing']}, "
          f"camera_not_facing={winner['camera_not_facing']}, "
          f"radius_m={winner['radius_m']}m")
    print(f"  Score:  {winner['score']:.6f}")
    print(f"  Avoided {winner['total_cameras_avoided']} cameras "
          f"with only {winner['total_extra_seconds']}s extra travel")
    print(f"{'='*60}\n")

    # ─── Step 4: Write results JSON ───────────────────────────────────────────
    output = {
        "task":       "GHOST-RESEARCH-002",
        "timestamp":  time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "metric":     "cameras_avoided / max(extra_travel_seconds, 1)",
        "test_routes": [r[0] for r in TEST_ROUTES],
        "variants_ranked": variant_scores,
        "winner": {
            "camera_facing":     winner["camera_facing"],
            "camera_not_facing": winner["camera_not_facing"],
            "radius_m":          winner["radius_m"],
            "score":             winner["score"],
        },
        "recommended_server_py_constants": {
            "CAMERA_PROXIMITY_M": winner["radius_m"],
            "note": (
                "camera_facing and camera_not_facing are conceptual weights. "
                "In server.py, CAMERA_PROXIMITY_M is the primary tunable. "
                f"Optimal radius={winner['radius_m']}m. "
                "Consider adding directional weighting for facing vs non-facing cameras."
            ),
        },
        "baseline_routes": [
            {k: v for k, v in r.items() if k != "area_cameras"}
            for r in baseline_results if r is not None
        ],
    }

    out_path = "/Users/michaelmartoccia/clawd/ghost-nav/autoresearch_weights_results.json"
    with open(out_path, "w") as f:
        json.dump(output, f, indent=2)
    print(f"Results written to: {out_path}")

    print("\nRecommended weights:")
    print(f"  CAMERA_PROXIMITY_M = {winner['radius_m']}  # was 50")
    print(f"  camera_facing = {winner['camera_facing']}    (conceptual)")
    print(f"  camera_not_facing = {winner['camera_not_facing']}  (conceptual)")
    print("\nDone.")

    return winner


if __name__ == "__main__":
    main()
