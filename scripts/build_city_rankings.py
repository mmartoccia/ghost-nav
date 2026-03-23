#!/usr/bin/env python3
"""
GHOST-CITY-002: Build city surveillance rankings from Overpass API
Queries ALPR camera count for 25 US cities, calculates density, writes JSON.
"""
import json
import math
import time
import urllib.request
import urllib.parse
import os

OUTPUT_FILE = os.path.expanduser("~/clawd/ghost-nav/data/city-rankings.json")
OVERPASS_URL = "https://overpass-api.de/api/interpreter"

# City bounding boxes: [south, west, north, east]
CITIES = [
    {"name": "New York City",    "state": "NY", "bbox": [40.477, -74.259, 40.917, -73.700]},
    {"name": "Los Angeles",      "state": "CA", "bbox": [33.703, -118.668, 34.337, -118.155]},
    {"name": "Chicago",          "state": "IL", "bbox": [41.644, -87.940, 42.023, -87.524]},
    {"name": "Houston",          "state": "TX", "bbox": [29.523, -95.789, 30.110, -95.015]},
    {"name": "Phoenix",          "state": "AZ", "bbox": [33.290, -112.324, 33.920, -111.926]},
    {"name": "Atlanta",          "state": "GA", "bbox": [33.647, -84.552, 33.888, -84.289]},
    {"name": "Washington DC",    "state": "DC", "bbox": [38.791, -77.120, 38.995, -76.910]},
    {"name": "Miami",            "state": "FL", "bbox": [25.709, -80.320, 25.856, -80.144]},
    {"name": "Denver",           "state": "CO", "bbox": [39.614, -105.110, 39.914, -104.600]},
    {"name": "Seattle",          "state": "WA", "bbox": [47.491, -122.459, 47.734, -122.224]},
    {"name": "Boston",           "state": "MA", "bbox": [42.227, -71.191, 42.396, -70.986]},
    {"name": "San Francisco",    "state": "CA", "bbox": [37.708, -122.514, 37.833, -122.357]},
    {"name": "Las Vegas",        "state": "NV", "bbox": [36.088, -115.381, 36.355, -115.062]},
    {"name": "Portland",         "state": "OR", "bbox": [45.432, -122.836, 45.653, -122.475]},
    {"name": "Nashville",        "state": "TN", "bbox": [36.000, -87.100, 36.400, -86.516]},
    {"name": "Austin",           "state": "TX", "bbox": [30.098, -97.934, 30.516, -97.570]},
    {"name": "Dallas",           "state": "TX", "bbox": [32.618, -97.019, 32.990, -96.546]},
    {"name": "Detroit",          "state": "MI", "bbox": [42.255, -83.287, 42.450, -82.910]},
    {"name": "Baltimore",        "state": "MD", "bbox": [39.197, -76.712, 39.372, -76.529]},
    {"name": "Memphis",          "state": "TN", "bbox": [35.004, -90.075, 35.274, -89.725]},
    {"name": "Indianapolis",     "state": "IN", "bbox": [39.632, -86.328, 39.928, -85.944]},
    {"name": "Sacramento",       "state": "CA", "bbox": [38.440, -121.561, 38.700, -121.363]},
    {"name": "Tucson",           "state": "AZ", "bbox": [32.060, -111.045, 32.370, -110.764]},
    {"name": "Albuquerque",      "state": "NM", "bbox": [34.996, -107.010, 35.220, -106.470]},
    {"name": "New Orleans",      "state": "LA", "bbox": [29.885, -90.140, 30.070, -89.625]},
]


def bbox_area_sqkm(south, west, north, east):
    """Calculate approximate bounding box area in square kilometers."""
    lat_mid = math.radians((south + north) / 2)
    km_per_deg_lat = 111.32
    km_per_deg_lon = 111.32 * math.cos(lat_mid)
    height = (north - south) * km_per_deg_lat
    width = (east - west) * km_per_deg_lon
    return height * width


def query_overpass(bbox):
    """Query Overpass API for surveillance nodes in bounding box."""
    s, w, n, e = bbox
    bbox_str = f"{s},{w},{n},{e}"
    query = f"""[out:json][timeout:30];
(
  node["surveillance:type"="ALPR"]({bbox_str});
  node["man_made"="surveillance"]({bbox_str});
);
out count;"""
    
    data = urllib.parse.urlencode({"data": query}).encode()
    req = urllib.request.Request(
        OVERPASS_URL,
        data=data,
        headers={"User-Agent": "GhostNav/1.0 (privacy research)"}
    )
    
    with urllib.request.urlopen(req, timeout=60) as resp:
        result = json.loads(resp.read().decode())
    
    # Overpass "out count;" returns elements with a "count" tag
    elements = result.get("elements", [])
    if elements and elements[0].get("type") == "count":
        tags = elements[0].get("tags", {})
        total = int(tags.get("total", 0))
        return total
    
    # Fallback: count elements directly
    return len(elements)


def main():
    os.makedirs(os.path.dirname(OUTPUT_FILE), exist_ok=True)
    rankings = []
    
    for i, city in enumerate(CITIES):
        name = city["name"]
        state = city["state"]
        bbox = city["bbox"]
        
        print(f"[{i+1}/25] Querying {name}, {state}...", end=" ", flush=True)
        
        try:
            total_cameras = query_overpass(bbox)
            area_sqkm = bbox_area_sqkm(*bbox)
            cameras_per_sqkm = total_cameras / area_sqkm if area_sqkm > 0 else 0
            print(f"{total_cameras} cameras, {area_sqkm:.1f} km², {cameras_per_sqkm:.4f}/km²")
        except Exception as e:
            print(f"ERROR: {e} — using 0")
            total_cameras = 0
            area_sqkm = bbox_area_sqkm(*bbox)
            cameras_per_sqkm = 0
        
        rankings.append({
            "city": name,
            "state": state,
            "total_cameras": total_cameras,
            "bbox_area_sqkm": round(bbox_area_sqkm(*bbox), 2),
            "cameras_per_sqkm": round(cameras_per_sqkm, 6),
        })
        
        if i < len(CITIES) - 1:
            time.sleep(2)  # Rate limit: be nice to Overpass API
    
    # Sort descending by cameras_per_sqkm
    rankings.sort(key=lambda x: x["cameras_per_sqkm"], reverse=True)
    
    # Add rank
    for idx, entry in enumerate(rankings):
        entry["rank"] = idx + 1
    
    output = {
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "source": "OpenStreetMap Overpass API",
        "cities": rankings
    }
    
    with open(OUTPUT_FILE, "w", encoding="utf-8") as f:
        json.dump(output, f, indent=2)
    
    print(f"\n✅ Done! Wrote {len(rankings)} cities to {OUTPUT_FILE}")
    print("\nTop 5 most surveilled:")
    for city in rankings[:5]:
        print(f"  {city['rank']}. {city['city']}, {city['state']} — {city['cameras_per_sqkm']:.4f}/km²")


if __name__ == "__main__":
    main()
