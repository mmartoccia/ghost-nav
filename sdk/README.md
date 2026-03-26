# @ghost-nav/sdk

Ghost Nav privacy routing SDK — JavaScript/TypeScript client for iframe and direct API integration.

## Installation

```bash
npm install @ghost-nav/sdk
```

## Quick Start

```typescript
import { GhostClient } from '@ghost-nav/sdk';

const ghost = new GhostClient({
  apiKey: 'your-api-key',       // optional
  baseUrl: 'http://localhost:8766', // default
});
```

## API

### `getRoute(from, to, mode?)`

Get privacy-aware routing between two coordinates.

```typescript
const result = await ghost.getRoute(
  [40.7128, -74.0060],  // [lat, lon] start
  [40.7580, -73.9855],  // [lat, lon] end
  'ghost'               // 'fastest' | 'ghost' | 'both' (default: 'ghost')
);

console.log(`Cameras avoided: ${result.cameras_avoided}`);
console.log(`Extra distance: ${result.extra_distance_m}m`);
console.log(`Privacy score: ${result.ghost.privacy_score}`);
```

**Returns:** `RouteResult`
```typescript
interface RouteResult {
  fastest: RouteOption;       // fastest route (ignores cameras)
  ghost: RouteOption;         // privacy-optimized route
  cameras_avoided: number;    // how many cameras the ghost route skips
  extra_distance_m: number;   // extra meters vs fastest route
  extra_duration_s: number;   // extra seconds vs fastest route
}
```

---

### `getScore(lat, lon, radiusKm?)`

Get the surveillance density score for a location.

```typescript
const score = await ghost.getScore(40.7128, -74.0060, 0.5); // 0.5km radius

console.log(`Camera count: ${score.camera_count}`);
console.log(`Privacy score: ${score.privacy_score}`); // 0-100, higher = more private
console.log(`Cameras nearby:`, score.cameras);
```

**Returns:** `SurveillanceScore`
```typescript
interface SurveillanceScore {
  lat: number;
  lon: number;
  radius_m: number;
  camera_count: number;
  surveillance_density: number;
  privacy_score: number;       // 0-100
  cameras: Camera[];
}
```

---

### `getCameras(bbox)`

Fetch cameras within a bounding box.

```typescript
const cameras = await ghost.getCameras([
  -74.0060,  // minLon
  40.7128,   // minLat
  -73.9855,  // maxLon
  40.7580,   // maxLat
]);

cameras.forEach(cam => {
  console.log(`Camera ${cam.id}: ${cam.lat}, ${cam.lon} — ${cam.operator}`);
});
```

**Returns:** `Camera[]`
```typescript
interface Camera {
  id: number;
  lat: number;
  lon: number;
  manufacturer?: string;
  operator?: string;
}
```

---

### `embed(containerId, options?)`

Embed the Ghost Nav map UI as an iframe inside a DOM element.

```html
<div id="ghost-map"></div>

<script type="module">
  import { GhostClient } from '@ghost-nav/sdk';

  const ghost = new GhostClient({ apiKey: 'your-key' });
  ghost.embed('ghost-map', {
    theme: 'dark',       // 'light' | 'dark' (default: 'light')
    width: '100%',       // CSS width (default: '100%')
    height: '600px',     // CSS height (default: '500px')
    mode: 'ghost',       // routing mode: 'fastest' | 'ghost' | 'both' (default: 'ghost')
  });
</script>
```

---

## TypeScript Support

Full TypeScript types are included. All interfaces are exported from the package root.

```typescript
import { GhostClient, RouteResult, SurveillanceScore, Camera, EmbedOptions } from '@ghost-nav/sdk';
```

## License

MIT
