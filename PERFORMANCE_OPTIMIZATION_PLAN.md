# Ghost Nav Performance Optimization Plan

## Current Latency Analysis

### Route Calculation: 28 seconds
- OSRM route request: 5-10s (external)
- Overpass camera fetch: 10-20s (external, blocking)
- Camera proximity analysis: 2-5s (local)
- **Bottleneck: Overpass**

### Heatmap Load: 4-5 seconds
- Overpass fetch: 10-20s (when slow)
- Canvas rendering: <1s
- **Bottleneck: Overpass**

### Current Architecture
```
Browser Request
    ↓
Ghost Nav Server (localhost:8766)
    ↓
+-- OSRM (external) ──→ 5-10s
+-- Overpass (external) ──→ 10-20s (BLOCKING)
    ↓
Python processing (clustering, bypass waypoints)
    ↓
Response (28s total)
```

---

## Solution: Localized Camera Database

### Architecture (Optimized)
```
Browser Request
    ↓
Ghost Nav Server
    ↓
+-- OSRM (external) ──→ 5-10s
+-- Local SQLite ──→ <100ms (bbox query)
    ↓
Python processing
    ↓
Response (6-12s total) ← 70% faster
```

### Implementation Steps

#### 1. Create SQLite Schema
```python
CREATE TABLE cameras (
    id INTEGER PRIMARY KEY,
    osm_id INTEGER UNIQUE,
    lat REAL NOT NULL,
    lon REAL NOT NULL,
    manufacturer TEXT,
    operator TEXT,
    direction TEXT,
    tags JSON,
    created_at TIMESTAMP,
    INDEX idx_lat_lon (lat, lon)  # Enable fast bbox queries
);

CREATE TABLE camera_sources (
    id INTEGER PRIMARY KEY,
    name TEXT,
    fetch_date TIMESTAMP,
    bbox TEXT,
    camera_count INTEGER
);
```

#### 2. Bulk Import from Overpass (One-time)
- Run a background script to fetch all cameras in Summerville/Charleston bbox
- Store in SQLite with spatial index
- ~5 min one-time fetch instead of repeated queries

**Script:** `ghost-nav/scripts/import_cameras_overpass.py`
```python
# Fetch from Overpass once
# Parse response
# Bulk insert into SQLite with index
# Result: ~200-500 cameras in Summerville area
```

#### 3. Replace Overpass Calls with SQLite Queries

**Current code (server.py, line ~375):**
```python
def fetch_cameras_in_bbox(min_lat, min_lon, max_lat, max_lon):
    # Hits Overpass API (10-20s)
    query = '[out:json][timeout:30]; ...'
    # ... HTTP request ...
```

**New code:**
```python
def fetch_cameras_in_bbox(min_lat, min_lon, max_lat, max_lon):
    conn = sqlite3.connect(CAMERAS_DB)
    cursor = conn.cursor()
    
    # SQLite spatial query (reads index, <100ms)
    cursor.execute('''
        SELECT lat, lon, id, tags FROM cameras
        WHERE lat BETWEEN ? AND ?
          AND lon BETWEEN ? AND ?
    ''', (min_lat, max_lat, min_lon, max_lon))
    
    results = cursor.fetchall()
    conn.close()
    return results  # <100ms
```

#### 4. Update Cache Strategy

**Current:** 5-minute in-memory cache of Overpass results  
**New:** 24-hour cache of SQLite (database is the cache)

**Refresh Strategy:**
- Option A: Nightly cron job to re-fetch Overpass and update SQLite (safe, accurate)
- Option B: Update on-demand if cache >24h old (lazy loading)
- Recommended: **Option A** (nightly refresh at 2 AM)

#### 5. Add Community Reports to SQLite

**New table:**
```python
CREATE TABLE community_cameras (
    id TEXT PRIMARY KEY,
    lat REAL,
    lon REAL,
    type TEXT,
    operator TEXT,
    direction TEXT,
    status TEXT,  # 'pending', 'confirmed', 'rejected'
    submitted_at TIMESTAMP,
    INDEX idx_status (status)
);
```

Merge confirmed reports with OSM cameras in bbox queries.

---

## Performance Improvement Summary

| Metric | Current | Optimized | Improvement |
|--------|---------|-----------|-------------|
| Route calc time | 28s | 6-12s | **70% faster** |
| Heatmap load | 4-5s | <2s | **60% faster** |
| Camera lookup | 10-20s | <100ms | **100-200x faster** |
| OSRM dependency | Yes | Yes | Unchanged (external) |
| Overpass dependency | Yes | No (one-time bulk) | **Eliminated** |

---

## Implementation Priority

### Phase 1: Foundation (2 hours)
1. Create SQLite schema
2. Write `import_cameras_overpass.py` bulk loader
3. Run initial import (Summerville/Charleston)
4. Verify query performance

### Phase 2: Integration (1 hour)
1. Replace `fetch_cameras_in_bbox()` in server.py
2. Remove Overpass timeout logic
3. Test route calculation (should be 6-12s now)
4. Test heatmap load

### Phase 3: Maintenance (30 min)
1. Add cron job for nightly Overpass refresh
2. Add admin endpoint to manually trigger refresh
3. Log import stats (camera count, timestamp)

### Phase 4: Enhancement (optional)
1. Extend to other regions (add bbox parameter to import script)
2. Add community reports to same database
3. Web UI to show "Data last updated: 2h ago"

---

## Files to Create/Modify

**New Files:**
- `ghost-nav/scripts/import_cameras_overpass.py` — Bulk loader
- `ghost-nav/data/cameras.db` — SQLite database (gitignored)
- `ghost-nav/scripts/nightly_refresh.sh` — Cron job

**Modified Files:**
- `ghost-nav/server.py` — Replace `fetch_cameras_in_bbox()` function
- `ghost-nav/app.js` — Remove Overpass error handling (no longer needed)

---

## Rollout Plan

1. **Test locally** with SQLite (1 route calc = 6-12s vs 28s)
2. **A/B test** — route calc with/without SQLite to measure savings
3. **Deploy** — replace Overpass with SQLite
4. **Monitor** — track response times in production

---

## Questions Answered

**Q: Is lookup the bottleneck?**
A: Yes, Overpass at 10-20s per request.

**Q: Should we cache responses?**
A: Better: Replace Overpass with indexed SQLite (24h refresh, <100ms queries).

**Q: Can we make it faster?**
A: Route calc drops from 28s → 6-12s (70% improvement). OSRM is still external, but unavoidable.

---

## Next Steps

Ready to implement Phase 1 (SQLite foundation)?
