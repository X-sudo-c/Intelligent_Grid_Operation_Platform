/** Persist last MapLibre camera so remounts resume where the steward left off. */

import { MIN_MAP_ZOOM } from './giopMapLayers';

export const MAP_CAMERA_STORAGE_KEY = 'giop.map.camera.v1';

export type GiopMapCamera = {
  center: [number, number];
  zoom: number;
  bearing?: number;
  pitch?: number;
};

const MAX_MAP_ZOOM = 20;

function isFiniteNumber(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n);
}

export function readStoredMapCamera(
  fallback: GiopMapCamera,
): GiopMapCamera {
  try {
    const raw = localStorage.getItem(MAP_CAMERA_STORAGE_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<GiopMapCamera>;
    const lon = parsed.center?.[0];
    const lat = parsed.center?.[1];
    const zoom = parsed.zoom;
    if (!isFiniteNumber(lon) || !isFiniteNumber(lat) || !isFiniteNumber(zoom)) {
      return fallback;
    }
    if (lon < -180 || lon > 180 || lat < -90 || lat > 90) return fallback;
    return {
      center: [lon, lat],
      zoom: Math.min(MAX_MAP_ZOOM, Math.max(MIN_MAP_ZOOM, zoom)),
      bearing: isFiniteNumber(parsed.bearing) ? parsed.bearing : 0,
      pitch: isFiniteNumber(parsed.pitch) ? Math.max(0, Math.min(60, parsed.pitch)) : 0,
    };
  } catch {
    return fallback;
  }
}

export function writeStoredMapCamera(camera: GiopMapCamera): void {
  try {
    localStorage.setItem(
      MAP_CAMERA_STORAGE_KEY,
      JSON.stringify({
        center: camera.center,
        zoom: camera.zoom,
        bearing: camera.bearing ?? 0,
        pitch: camera.pitch ?? 0,
      }),
    );
  } catch {
    // Quota / private mode — ignore.
  }
}
