#!/usr/bin/env python3
"""
GHOST-RESEARCH-005: Autoresearch — optimize camera penalty radius
Karpathy-style: vary one param, score outcomes, use AI judge.

Camera penalty radius R: any camera within R meters of a road segment
triggers route avoidance. 
  - Too small R → cameras slip through (privacy fails)
  - Too large R → excessive detours (route unusable)

Simulation model:
  1. Place synthetic cameras along route (Gaussian offset, mean=40m, std=35m)
  2. For each radius R:
     a. Cameras within R = "detected" = ghost router will avoid these roads
     b. Estimate ghost route cameras: cameras that are within SAFETY_DIST (50m)
        of the ghost route ≈ cameras NOT within R of direct route but still
        near alternate roads (modeled as a fraction of non-penalized cameras)
     c. Detour cost: each avoided cluster requires a detour, length scales with R
  3. Score = privacy_gain / (1 + detour_factor)
"""

import json
import math
import os
import random
import sys
import urllib.request
import urllib.parse
import time
import re

# ─── Config ───────────────────────────────────────────────────────────────────

RADIUS_VARIANTS = [25, 50, 75, 100, 150]  # meters

TEST_ROUTES = [
    {"from": [40.7128, -74.0060], "to": [40.7580, -73.9855], "label": "NYC midtown"},
    {"from": [34.0522, -118.2437], "to": [34.0195, -118.4912], "label": "LA"},
    {"from": [38.9072, -77.0369], "to": [38.8977, -77.0366], "label": "DC"},
    {"from": [41.8827, -87.6233], "to": [41.8781, -87.6298], "label": "Chicago"},
    {"from": [37.7749, -122.4194], "to": [37.7749, -122.4312], "label": "SF"},
]

# Urban surveillance density — cameras per km of road (published estimates)
# NYC: ~60-80/km dense urban, LA: ~30-40/km, others: ~40-55/km
CITY_PARAMS = {
    "NYC midtown":  {"density_per_km": 70, "urban_density": 0.95},  # very dense grid
    "LA":           {"density_per_km": 35, "urban_density": 0.60},  # spread out
    "DC":           {"density_per_km": 55, "urban_density": 0.85},  # dense govt area
    "Chicago":      {"density_per_km": 50, "urban_density": 0.80},
    "SF":           {"density_per_km": 60, "urban_density": 0.85},
}

# Safety threshold: minimum distance for a camera to NOT capture plate clearly
# ALPR effective range: ~30-60m. We use 50m as reference safety distance.
SAFETY_DIST_M = 50

OSRM_BASE = "https://router.project-osrm.org"
OVERPASS_URL = "https://overpass-api.de/api/interpreter"
RESULTS_FILE = os.path.join(os.path.dirname(__file__), "autoresearch_penalty_radius_results.json")


# ─── Geometry ─────────────────────────────────────────────────────────────────

def haversine(lat1, lon1, lat2, lon2):
    R = 6_371_000
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi, dlam = math.radians(lat2 - lat1), math.radians(lon2 - lon1)
    a = math.sin(dphi/2)**2 + math.cos(phi1)*math.cos(phi2)*math.sin(dlam/2)**2
    return 2 * R * math.asin(math.sqrt(a))


def decode_polyline6(encoded):
    coords = []
    index = lat = lon = 0
    while index < len(encoded):
        result = 1; shift = 0
        while True:
            b = ord(encoded[index]) - 63 - 1; index += 1
            result += b << shift; shift += 5
            if b < 0x1F: break
        lat += (~result >> 1) if (result & 1) else (result >> 1)
        result = 1; shift = 0
        while True:
            b = ord(encoded[index]) - 63 - 1; index += 1
            result += b << shift; shift += 5
            if b < 0x1F: break
        lon += (~result >> 1) if (result & 1) else (result >> 1)
        coords.append([lon / 1e6, lat / 1e6])
    return coords


def point_to_segment_dist(cam_lat, cam_lon, lat1, lon1, lat2, lon2):
    lat_scale = 111_320
    lon_scale = 111_320 * math.cos(math.radians((lat1 + lat2) / 2))
    px = (cam_lon - lon1) * lon_scale; py = (cam_lat - lat1) * lat_scale
    dx = (lon2 - lon1) * lon_scale;  dy = (lat2 - lat1) * lat_scale
    seg_len2 = dx*dx + dy*dy
    if seg_len2 == 0: return math.sqrt(px*px + py*py)
    t = max(0, min(1, (px*dx + py*dy) / seg_len2))
    return math.sqrt((px - t*dx)**2 + (py - t*dy)**2)


def min_dist_to_route(cam_lat, cam_lon, coords):
    min_d = float("inf")
    for i in range(len(coords) - 1):
        lon1, lat1 = coords[i]; lon2, lat2 = coords[i+1]
        d = point_to_segment_dist(cam_lat, cam_lon, lat1, lon1, lat2, lon2)
        if d < min_d: min_d = d
    return min_d


def route_length_km(coords):
    total = 0.0
    for i in range(len(coords) - 1):
        lon1, lat1 = coords[i]; lon2, lat2 = coords[i+1]
        total += haversine(lat1, lon1, lat2, lon2)
    return total / 1000


# ─── OSRM ─────────────────────────────────────────────────────────────────────

def osrm_route(from_ll, to_ll):
    frm = f"{from_ll[1]:.6f},{from_ll[0]:.6f}"
    to  = f"{to_ll[1]:.6f},{to_ll[0]:.6f}"
    url = f"{OSRM_BASE}/route/v1/driving/{frm};{to}?overview=full&geometries=polyline6&alternatives=false"
    req = urllib.request.Request(url, headers={"User-Agent": "GhostNav/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.loads(resp.read())
        if data.get("code") != "Ok" or not data.get("routes"): return None, 0
        route = data["routes"][0]
        return decode_polyline6(route["geometry"]), route.get("distance", 0)
    except Exception as e:
        print(f"  [OSRM error] {e}"); return None, 0


# ─── Camera simulation ────────────────────────────────────────────────────────

def synthesize_cameras(coords, label, route_km, seed=42):
    """
    Generate realistic camera placement along a route.
    
    Camera offset distribution (meters from road centerline):
    - ~30% within 0-25m: intersection cameras, road-mounted ALPR
    - ~40% within 25-75m: sidewalk poles, building-mounted near corner
    - ~20% within 75-150m: building security, parking structures
    - ~10% beyond 150m: background cameras unlikely to capture route
    """
    rng = random.Random(seed + hash(label) % 10000)
    params = CITY_PARAMS.get(label, {"density_per_km": 50, "urban_density": 0.80})
    n_cams = max(10, int(route_km * params["density_per_km"]))
    cameras = []
    
    for _ in range(n_cams):
        # Pick random point on route
        seg_idx = rng.randint(0, max(0, len(coords) - 2))
        t = rng.random()
        lon1, lat1 = coords[seg_idx]
        lon2, lat2 = coords[min(seg_idx+1, len(coords)-1)]
        base_lat = lat1 + t*(lat2-lat1)
        base_lon = lon1 + t*(lon2-lon1)
        
        # Camera offset: mixture of near/far
        r = rng.random()
        if r < 0.30:
            offset_m = rng.uniform(2, 25)    # close: intersection, road-mounted
        elif r < 0.70:
            offset_m = rng.uniform(25, 75)   # mid: sidewalk, building facade
        elif r < 0.90:
            offset_m = rng.uniform(75, 150)  # far: parking, building security
        else:
            offset_m = rng.uniform(150, 300) # very far: background
        
        # Random perpendicular direction
        angle_rad = math.radians(rng.uniform(0, 360))
        lat_scale = 111_320
        lon_scale = 111_320 * math.cos(math.radians(base_lat))
        cam_lat = base_lat + (offset_m * math.cos(angle_rad)) / lat_scale
        cam_lon = base_lon + (offset_m * math.sin(angle_rad)) / lon_scale
        
        cameras.append({
            "lat": cam_lat, "lon": cam_lon,
            "offset_m": round(offset_m, 1),
            "synthetic": True
        })
    
    return cameras


# ─── Scoring model ────────────────────────────────────────────────────────────

def simulate_ghost_route_quality(cameras, coords, radius_m, route_km, urban_density):
    """
    Simulate ghost route quality for a given penalty radius.
    
    Model:
    - Cameras within radius_m of direct route = "penalty cameras" 
      → ghost router avoids roads near these cameras
    - Ghost route successfully avoids all penalty cameras
    - But: some non-penalty cameras may still be on ghost route
      → slipthrough_rate = fraction of non-penalty cameras that end up on ghost route
      → in dense urban areas this is higher (fewer alternate roads)
    - Detour cost per avoided cluster scales with radius and urban density
    
    Returns: (cameras_on_ghost, cameras_avoided, extra_km_estimate)
    """
    n_penalty = sum(
        1 for cam in cameras
        if min_dist_to_route(cam["lat"], cam["lon"], coords) <= radius_m
    )
    n_nonpenalty = len(cameras) - n_penalty
    
    # Cameras that "slip through" on the ghost route:
    # - cameras NOT in penalty zone but still near alternate roads
    # - urban density factor: denser = fewer alternates = more slipthrough
    # - radius factor: larger R means alternate roads also near cameras
    slipthrough_base = 0.15 + 0.35 * urban_density  # 15-50% base rate
    # Larger radius → alternate roads are also penalized → fewer true escapes
    radius_factor = min(1.0, radius_m / 100.0)  # scales from 0.25x at 25m to 1.5x at 150m
    slipthrough = min(0.95, slipthrough_base * radius_factor)
    
    cameras_slipthrough = int(n_nonpenalty * slipthrough)
    cameras_avoided = len(cameras) - cameras_slipthrough  # total cameras NOT on ghost route
    cameras_on_ghost = cameras_slipthrough
    
    # Detour estimate: each penalty camera cluster requires a detour
    # Detour length ≈ 2 * radius_m * (number of clusters) 
    # Clusters ≈ penalty cameras / clustering_factor
    clustering_factor = max(1, radius_m / 30.0)  # larger radius merges more into clusters
    n_clusters = max(0, int(n_penalty / clustering_factor))
    
    # Each cluster detour: 2 * radius on both sides + urban navigation penalty
    detour_per_cluster_m = 2.2 * radius_m * (1 + 0.5 * urban_density)
    total_detour_km = (n_clusters * detour_per_cluster_m) / 1000
    
    # Cap at 3x original route length (sanity check)
    total_detour_km = min(total_detour_km, route_km * 3)
    
    # Privacy score component: fraction of area cameras avoided
    if len(cameras) > 0:
        privacy_ratio = cameras_avoided / len(cameras)
    else:
        privacy_ratio = 1.0
    
    # Practicality component: penalize excessive detours
    extra_ratio = total_detour_km / max(route_km, 0.1)
    
    # Composite score
    composite = privacy_ratio / (1.0 + extra_ratio)
    
    return {
        "composite_score": round(composite, 4),
        "cameras_on_ghost": cameras_on_ghost,
        "cameras_avoided": cameras_avoided,
        "n_penalty": n_penalty,
        "n_clusters": n_clusters,
        "extra_km": round(total_detour_km, 3),
        "privacy_ratio": round(privacy_ratio, 4),
        "extra_ratio": round(extra_ratio, 4),
    }


# ─── Overpass (with rate-limit handling) ─────────────────────────────────────

def fetch_cameras_overpass(coords, retries=2):
    min_lat = min(c[1] for c in coords) - 0.005
    min_lon = min(c[0] for c in coords) - 0.005
    max_lat = max(c[1] for c in coords) + 0.005
    max_lon = max(c[0] for c in coords) + 0.005
    query = f"""[out:json][timeout:30];
(
  node["man_made"="surveillance"]({min_lat},{min_lon},{max_lat},{max_lon});
  node["surveillance:type"="ALPR"]({min_lat},{min_lon},{max_lat},{max_lon});
);
out body;"""
    data = ("data=" + urllib.parse.quote(query)).encode()
    req = urllib.request.Request(OVERPASS_URL, data=data,
        headers={"Content-Type": "application/x-www-form-urlencoded",
                 "User-Agent": "GhostNav/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=35) as resp:
            result = json.loads(resp.read())
        return [{"lat": el["lat"], "lon": el["lon"]} for el in result.get("elements", [])]
    except Exception as e:
        print(f"  [Overpass: {type(e).__name__}]")
        return None


# ─── AI Judge ─────────────────────────────────────────────────────────────────

def call_ai_judge(ranked, anthropic_key, together_key):
    top2 = ranked[:2]
    prompt = f"""I ran an autoresearch experiment for GhostNav, a privacy-routing app that routes drivers around surveillance cameras (ALPR/Flock Safety).

The "camera penalty radius" (R) controls how far from a camera a road must be to avoid penalty. I tested 5 values: 25m, 50m, 75m, 100m, 150m.

My simulation model:
- Cameras placed at realistic offsets from roads (30% at 2-25m, 40% at 25-75m, 20% at 75-150m)  
- Ghost router avoids all cameras within R of direct route
- Cameras outside R may still appear on ghost route (urban density limits alternate roads)
- Detour cost scales with radius and number of avoidance maneuvers

All 5 results (ranked by composite score = privacy_ratio / (1 + detour_ratio)):
""" + "\n".join([
    f"- {r['radius_m']}m: score={r['avg_score']:.4f}, cams_on_ghost={r['avg_cameras_on_route']:.1f}, avoided={r['avg_cameras_avoided']:.1f}, extra_detour={r['avg_extra_km_estimate']:.2f}km"
    for r in ranked
]) + f"""

Top 2 in detail:

#{1} Radius {top2[0]['radius_m']}m (score {top2[0]['avg_score']:.4f}):
  - Avg cameras on ghost route: {top2[0]['avg_cameras_on_route']:.1f}
  - Avg cameras successfully avoided: {top2[0]['avg_cameras_avoided']:.1f}
  - Avg extra detour: {top2[0]['avg_extra_km_estimate']:.2f} km

#{2} Radius {top2[1]['radius_m']}m (score {top2[1]['avg_score']:.4f}):
  - Avg cameras on ghost route: {top2[1]['avg_cameras_on_route']:.1f}
  - Avg cameras successfully avoided: {top2[1]['avg_cameras_avoided']:.1f}
  - Avg extra detour: {top2[1]['avg_extra_km_estimate']:.2f} km

Context:
- ALPR cameras (Flock Safety) have effective read range of ~30-60m
- Most surveillance cameras are 10-80m from road centerline
- App users are privacy-conscious but will abandon it for extreme detours
- Current default is 50m

Which radius strikes the best balance? Consider: a radius too small lets cameras through; too large makes routes impractical in dense cities.

Respond exactly with: WINNER: [X]m
Then 2-3 sentences of reasoning."""

    # Try Anthropic
    if anthropic_key and len(anthropic_key) > 20:
        payload = json.dumps({
            "model": "claude-sonnet-4-6",
            "max_tokens": 350,
            "messages": [{"role": "user", "content": prompt}],
        }).encode()
        req = urllib.request.Request(
            "https://api.anthropic.com/v1/messages", data=payload,
            headers={"x-api-key": anthropic_key, "anthropic-version": "2023-06-01",
                     "content-type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                r = json.loads(resp.read())
            return r["content"][0]["text"], "claude-sonnet-4-6"
        except Exception as e:
            print(f"  [Anthropic: {e}]")

    # Try Together (Llama-3)
    if together_key:
        payload = json.dumps({
            "model": "meta-llama/Llama-3.3-70B-Instruct-Turbo",
            "max_tokens": 350,
            "messages": [{"role": "user", "content": prompt}],
        }).encode()
        req = urllib.request.Request(
            "https://api.together.xyz/v1/chat/completions", data=payload,
            headers={"Authorization": f"Bearer {together_key}",
                     "content-type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                r = json.loads(resp.read())
            return r["choices"][0]["message"]["content"], "meta-llama/Llama-3.3-70B (Together)"
        except Exception as e:
            print(f"  [Together: {e}]")

    # Rule-based fallback
    winner = ranked[0]
    verdict = (
        f"WINNER: {winner['radius_m']}m\n\n"
        f"A {winner['radius_m']}m radius achieves the best score ({winner['avg_score']:.4f}) "
        f"in our simulation, balancing {winner['avg_cameras_avoided']:.0f} cameras avoided "
        f"against {winner['avg_extra_km_estimate']:.2f}km avg detour. "
        f"This aligns with ALPR effective range (30-60m) while keeping detours practical "
        f"in dense urban grids where larger radii rapidly saturate alternate roads."
    )
    return verdict, "rule-based-fallback"


# ─── Main ─────────────────────────────────────────────────────────────────────

def main():
    print("=" * 60)
    print("GHOST-RESEARCH-005: Camera Penalty Radius Autoresearch")
    print("=" * 60)

    # Fetch routes
    print("\n[1/3] Fetching routes via OSRM...")
    route_data = []
    overpass_available = False

    for i, r in enumerate(TEST_ROUTES):
        print(f"  {i+1}/5 {r['label']}")
        coords, dist_m = osrm_route(r["from"], r["to"])
        if coords is None:
            print(f"       SKIP")
            continue
        route_km = dist_m / 1000
        print(f"       {route_km:.2f}km, {len(coords)} pts")

        # Try Overpass for first route only
        cameras = None
        if i == 0 and not overpass_available:
            cameras = fetch_cameras_overpass(coords)
            if cameras is not None:
                overpass_available = True

        if cameras is None:
            params = CITY_PARAMS.get(r["label"], {"density_per_km": 50})
            cameras = synthesize_cameras(coords, r["label"], route_km, seed=i*17+42)

        print(f"       {len(cameras)} cameras ({'overpass' if overpass_available and i==0 else 'synthetic'})")
        route_data.append({
            "label": r["label"],
            "coords": coords,
            "route_km": route_km,
            "cameras": cameras,
            "urban_density": CITY_PARAMS.get(r["label"], {"urban_density": 0.75})["urban_density"],
        })
        time.sleep(0.2)

    if not route_data:
        print("ERROR: No routes loaded"); sys.exit(1)

    data_source = "overpass+synthetic" if overpass_available else "synthetic"

    # Evaluate each radius
    print(f"\n[2/3] Scoring {len(RADIUS_VARIANTS)} radius variants...")
    radius_results = {}

    for radius in RADIUS_VARIANTS:
        all_scores, all_ghost_cams, all_avoided, all_extra = [], [], [], []
        per_route = []

        for rd in route_data:
            q = simulate_ghost_route_quality(
                rd["cameras"], rd["coords"], radius,
                rd["route_km"], rd["urban_density"]
            )
            all_scores.append(q["composite_score"])
            all_ghost_cams.append(q["cameras_on_ghost"])
            all_avoided.append(q["cameras_avoided"])
            all_extra.append(q["extra_km"])
            per_route.append({
                "label": rd["label"],
                "cameras_on_ghost_route": q["cameras_on_ghost"],
                "cameras_avoided": q["cameras_avoided"],
                "n_penalty_triggers": q["n_penalty"],
                "extra_km": q["extra_km"],
                "score": q["composite_score"],
            })

        avg_score = round(sum(all_scores)/len(all_scores), 4)
        avg_ghost = round(sum(all_ghost_cams)/len(all_ghost_cams), 1)
        avg_avoided = round(sum(all_avoided)/len(all_avoided), 1)
        avg_extra = round(sum(all_extra)/len(all_extra), 3)

        radius_results[radius] = {
            "radius_m": radius,
            "avg_score": avg_score,
            "avg_cameras_on_route": avg_ghost,    # ghost route cameras
            "avg_cameras_avoided": avg_avoided,
            "avg_extra_km_estimate": avg_extra,
            "per_route": per_route,
        }
        print(f"  {radius:>4}m | score={avg_score:.4f} | ghost_cams={avg_ghost:.0f} | avoided={avg_avoided:.0f} | +{avg_extra:.2f}km detour")

    ranked = sorted(radius_results.values(), key=lambda x: x["avg_score"], reverse=True)
    winner_algo = ranked[0]

    print(f"\n  Rankings:")
    for i, r in enumerate(ranked):
        m = " 🏆" if i==0 else ("  ✓" if i==1 else "")
        print(f"  #{i+1}{m} {r['radius_m']}m — score={r['avg_score']:.4f}")

    # AI Judge
    print("\n[3/3] Calling AI judge...")
    anthropic_key = os.environ.get("ANTHROPIC_API_KEY", "")
    together_key = os.environ.get("TOGETHER_API_KEY", "")
    verdict, judge_model = call_ai_judge(ranked, anthropic_key, together_key)
    print(f"  Model: {judge_model}")
    print(f"  Verdict: {verdict[:200]}...")

    # Parse judge winner
    judge_winner_m = None
    for line in verdict.split("\n"):
        m = re.search(r"WINNER:\s*(\d+)m", line)
        if m:
            judge_winner_m = int(m.group(1))
            break

    final_winner_m = judge_winner_m if judge_winner_m in RADIUS_VARIANTS else winner_algo["radius_m"]
    print(f"\n  Algo winner: {winner_algo['radius_m']}m | Judge: {judge_winner_m}m | FINAL: {final_winner_m}m")

    # Write results
    results = {
        "experiment": "GHOST-RESEARCH-005",
        "methodology": "Karpathy autoresearch — vary penalty radius, simulate ghost route quality",
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "winner_radius_m": final_winner_m,
        "algorithmic_winner_m": winner_algo["radius_m"],
        "judge_winner_m": judge_winner_m,
        "winner_score": radius_results[final_winner_m]["avg_score"],
        "ranking": ranked,
        "judge_verdict": verdict,
        "judge_model": judge_model,
        "test_routes": [r["label"] for r in TEST_ROUTES],
        "routes_evaluated": len(route_data),
        "data_source": data_source,
        "scoring_formula": "privacy_ratio / (1 + detour_ratio), where privacy_ratio = avoided_cams / total_cams",
        "camera_model": "Synthetic: 30% at 2-25m, 40% at 25-75m, 20% at 75-150m, city-specific density",
        "safety_distance_m": SAFETY_DIST_M,
    }

    with open(RESULTS_FILE, "w") as f:
        json.dump(results, f, indent=2)

    print(f"\n✅ Results: {RESULTS_FILE}")
    print(f"🏆 WINNER: {final_winner_m}m")
    return final_winner_m


if __name__ == "__main__":
    main()
