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
export declare class GhostClient {
    private apiKey?;
    private baseUrl;
    constructor(options?: {
        apiKey?: string;
        baseUrl?: string;
    });
    private getHeaders;
    getRoute(from: [number, number], to: [number, number], mode?: 'fast' | 'balanced' | 'private'): Promise<RouteResult>;
    getScore(lat: number, lon: number, radiusKm?: number): Promise<SurveillanceScore>;
    getCameras(bbox: [number, number, number, number]): Promise<Camera[]>;
    embed(containerId: string, options?: EmbedOptions): void;
}
