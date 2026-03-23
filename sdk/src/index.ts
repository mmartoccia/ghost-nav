export interface RouteResult {
  fastest: RouteOption;
  ghost: RouteOption;
  cameras_avoided: number;
  extra_distance_m: number;
  extra_duration_s: number;
}

export interface RouteOption {
  geometry: string;
  distance_m: number;
  duration_s: number;
  cameras: number;
  privacy_score: number;
}

export interface SurveillanceScore {
  lat: number;
  lon: number;
  radius_m: number;
  camera_count: number;
  surveillance_density: number;
  privacy_score: number;
  cameras: Camera[];
}

export interface Camera {
  id: number;
  lat: number;
  lon: number;
  manufacturer?: string;
  operator?: string;
}

export interface EmbedOptions {
  theme?: 'light' | 'dark';
  width?: string;
  height?: string;
  mode?: 'fast' | 'balanced' | 'private';
}

export class GhostClient {
  private apiKey?: string;
  private baseUrl: string;

  constructor(options: { apiKey?: string; baseUrl?: string } = {}) {
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl || 'http://localhost:8766';
  }

  private getHeaders(): Record<string, string> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.apiKey) headers['X-API-Key'] = this.apiKey;
    return headers;
  }

  async getRoute(
    from: [number, number],
    to: [number, number],
    mode: 'fast' | 'balanced' | 'private' = 'private'
  ): Promise<RouteResult> {
    const res = await fetch(`${this.baseUrl}/api/v1/route`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify({ start: from, end: to, mode }),
    });
    if (!res.ok) throw new Error(`Ghost API error: ${res.status}`);
    return res.json();
  }

  async getScore(lat: number, lon: number, radiusKm: number = 1): Promise<SurveillanceScore> {
    const radius_m = radiusKm * 1000;
    const res = await fetch(
      `${this.baseUrl}/api/v1/score?lat=${lat}&lon=${lon}&radius_m=${radius_m}`,
      { headers: this.getHeaders() }
    );
    if (!res.ok) throw new Error(`Ghost API error: ${res.status}`);
    return res.json();
  }

  async getCameras(bbox: [number, number, number, number]): Promise<Camera[]> {
    const [minLon, minLat, maxLon, maxLat] = bbox;
    const res = await fetch(
      `${this.baseUrl}/api/v1/cameras?minLon=${minLon}&minLat=${minLat}&maxLon=${maxLon}&maxLat=${maxLat}`,
      { headers: this.getHeaders() }
    );
    if (!res.ok) throw new Error(`Ghost API error: ${res.status}`);
    return res.json();
  }

  embed(containerId: string, options: EmbedOptions = {}): void {
    const container = document.getElementById(containerId);
    if (!container) throw new Error(`Container #${containerId} not found`);
    const theme = options.theme || 'light';
    const width = options.width || '100%';
    const height = options.height || '500px';
    const mode = options.mode || 'private';
    const params = new URLSearchParams({ theme, mode });
    if (this.apiKey) params.set('apiKey', this.apiKey);
    const iframe = document.createElement('iframe');
    iframe.src = `${this.baseUrl}/?${params}`;
    iframe.width = width;
    iframe.height = height;
    iframe.style.border = 'none';
    iframe.allow = 'geolocation';
    container.appendChild(iframe);
  }
}
