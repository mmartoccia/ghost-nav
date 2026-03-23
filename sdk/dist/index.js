"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.GhostClient = void 0;
class GhostClient {
    constructor(options = {}) {
        this.apiKey = options.apiKey;
        this.baseUrl = options.baseUrl || 'http://localhost:8766';
    }
    getHeaders() {
        const headers = { 'Content-Type': 'application/json' };
        if (this.apiKey)
            headers['X-API-Key'] = this.apiKey;
        return headers;
    }
    async getRoute(from, to, mode = 'private') {
        const res = await fetch(`${this.baseUrl}/api/v1/route`, {
            method: 'POST',
            headers: this.getHeaders(),
            body: JSON.stringify({ start: from, end: to, mode }),
        });
        if (!res.ok)
            throw new Error(`Ghost API error: ${res.status}`);
        return res.json();
    }
    async getScore(lat, lon, radiusKm = 1) {
        const radius_m = radiusKm * 1000;
        const res = await fetch(`${this.baseUrl}/api/v1/score?lat=${lat}&lon=${lon}&radius_m=${radius_m}`, { headers: this.getHeaders() });
        if (!res.ok)
            throw new Error(`Ghost API error: ${res.status}`);
        return res.json();
    }
    async getCameras(bbox) {
        const [minLon, minLat, maxLon, maxLat] = bbox;
        const res = await fetch(`${this.baseUrl}/api/v1/cameras?minLon=${minLon}&minLat=${minLat}&maxLon=${maxLon}&maxLat=${maxLat}`, { headers: this.getHeaders() });
        if (!res.ok)
            throw new Error(`Ghost API error: ${res.status}`);
        return res.json();
    }
    embed(containerId, options = {}) {
        const container = document.getElementById(containerId);
        if (!container)
            throw new Error(`Container #${containerId} not found`);
        const theme = options.theme || 'light';
        const width = options.width || '100%';
        const height = options.height || '500px';
        const mode = options.mode || 'private';
        const params = new URLSearchParams({ theme, mode });
        if (this.apiKey)
            params.set('apiKey', this.apiKey);
        const iframe = document.createElement('iframe');
        iframe.src = `${this.baseUrl}/?${params}`;
        iframe.width = width;
        iframe.height = height;
        iframe.style.border = 'none';
        iframe.allow = 'geolocation';
        container.appendChild(iframe);
    }
}
exports.GhostClient = GhostClient;
