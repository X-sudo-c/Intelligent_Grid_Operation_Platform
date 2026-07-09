/**
 * Clearance / proximity buffers for map planning.
 *
 * Circles and polyline envelopes use geodesic destination on WGS84 so radii
 * match the same ground metres as the measure tool (and PostGIS geography).
 */

import { geodesicMeters, type MapMeasurePoint } from './giopMapMeasure';

export const MAP_CLEARANCE_SOURCE = 'map-clearance-buffer';
export const MAP_CLEARANCE_FILL_LAYER = 'map-clearance-fill-layer';
export const MAP_CLEARANCE_OUTLINE_LAYER = 'map-clearance-outline-layer';

export const CLEARANCE_RADIUS_PRESETS_M = [5, 10, 25, 50, 100] as const;
export const DEFAULT_CLEARANCE_RADIUS_M = 10;

const toRad = (deg: number) => (deg * Math.PI) / 180;
const toDeg = (rad: number) => (rad * 180) / Math.PI;
const EARTH_R = 6_371_008.8;

/** Destination point from WGS84 lon/lat, bearing (°), distance (m). */
export function geodesicDestination(
  origin: MapMeasurePoint,
  bearingDeg: number,
  distanceM: number,
): MapMeasurePoint {
  const [lon, lat] = origin;
  const δ = distanceM / EARTH_R;
  const θ = toRad(bearingDeg);
  const φ1 = toRad(lat);
  const λ1 = toRad(lon);
  const sinφ1 = Math.sin(φ1);
  const cosφ1 = Math.cos(φ1);
  const sinδ = Math.sin(δ);
  const cosδ = Math.cos(δ);

  const sinφ2 = sinφ1 * cosδ + cosφ1 * sinδ * Math.cos(θ);
  const φ2 = Math.asin(sinφ2);
  const λ2 = λ1 + Math.atan2(Math.sin(θ) * sinδ * cosφ1, cosδ - sinφ1 * sinφ2);

  return [((toDeg(λ2) + 540) % 360) - 180, toDeg(φ2)];
}

export function geodesicCircle(
  center: MapMeasurePoint,
  radiusM: number,
  steps = 64,
): MapMeasurePoint[] {
  if (!(radiusM > 0)) return [center];
  const ring: MapMeasurePoint[] = [];
  for (let i = 0; i <= steps; i += 1) {
    ring.push(geodesicDestination(center, (360 * i) / steps, radiusM));
  }
  return ring;
}

function samplePolyline(points: MapMeasurePoint[], stepM: number): MapMeasurePoint[] {
  if (points.length === 0) return [];
  if (points.length === 1) return [points[0]];
  const samples: MapMeasurePoint[] = [points[0]];
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1];
    const b = points[i];
    const len = geodesicMeters(a, b);
    if (len <= 0) {
      samples.push(b);
      continue;
    }
    const n = Math.max(1, Math.ceil(len / stepM));
    for (let s = 1; s <= n; s += 1) {
      const t = s / n;
      samples.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    }
  }
  return samples;
}

/** Monotone-chain convex hull (lon/lat treated as plane — fine for local clearance envelopes). */
function convexHull(points: MapMeasurePoint[]): MapMeasurePoint[] {
  const uniq = new Map<string, MapMeasurePoint>();
  for (const p of points) uniq.set(`${p[0]},${p[1]}`, p);
  const pts = [...uniq.values()].sort((a, b) => (a[0] === b[0] ? a[1] - b[1] : a[0] - b[0]));
  if (pts.length <= 2) return pts;

  const cross = (o: MapMeasurePoint, a: MapMeasurePoint, b: MapMeasurePoint) =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

  const lower: MapMeasurePoint[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) {
      lower.pop();
    }
    lower.push(p);
  }
  const upper: MapMeasurePoint[] = [];
  for (let i = pts.length - 1; i >= 0; i -= 1) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) {
      upper.pop();
    }
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

/**
 * Clearance envelope around a point or polyline.
 * Samples the path, expands each sample by `radiusM`, returns a convex hull polygon.
 */
export function buildClearancePolygon(
  points: MapMeasurePoint[],
  radiusM: number,
): GeoJSON.Feature<GeoJSON.Polygon> | null {
  if (points.length === 0 || !(radiusM > 0)) return null;

  const stepM = Math.min(Math.max(radiusM / 2, 2), 8);
  const samples = samplePolyline(points, stepM);
  const ringPts: MapMeasurePoint[] = [];
  const circleSteps = points.length === 1 ? 64 : 24;
  for (const sample of samples) {
    const circle = geodesicCircle(sample, radiusM, circleSteps);
    for (const c of circle) ringPts.push(c);
  }

  const hull = convexHull(ringPts);
  if (hull.length < 3) return null;
  const ring = [...hull, hull[0]];

  return {
    type: 'Feature',
    properties: {
      radius_m: radiusM,
      source_points: points.length,
    },
    geometry: {
      type: 'Polygon',
      coordinates: [ring],
    },
  };
}

export function buildClearanceGeoJson(
  points: MapMeasurePoint[],
  radiusM: number,
): GeoJSON.FeatureCollection {
  const feature = buildClearancePolygon(points, radiusM);
  return {
    type: 'FeatureCollection',
    features: feature ? [feature] : [],
  };
}

/** Approximate geodesic area (m²) via spherical excess on the polygon ring. */
export function polygonAreaMeters2(ring: MapMeasurePoint[]): number {
  if (ring.length < 4) return 0;
  let area = 0;
  for (let i = 0; i < ring.length - 1; i += 1) {
    const [lon1, lat1] = ring[i];
    const [lon2, lat2] = ring[i + 1];
    area += toRad(lon2 - lon1) * (2 + Math.sin(toRad(lat1)) + Math.sin(toRad(lat2)));
  }
  return Math.abs((area * EARTH_R * EARTH_R) / 2);
}

export function clearanceAreaMeters2(points: MapMeasurePoint[], radiusM: number): number {
  const feature = buildClearancePolygon(points, radiusM);
  if (!feature) return 0;
  const ring = feature.geometry.coordinates[0] as MapMeasurePoint[];
  return polygonAreaMeters2(ring);
}

export function formatClearanceArea(areaM2: number): string {
  if (!Number.isFinite(areaM2) || areaM2 <= 0) return '—';
  if (areaM2 < 10_000) return `${areaM2.toFixed(0)} m²`;
  return `${(areaM2 / 10_000).toFixed(3)} ha`;
}

export function clearanceFillPaint(isLightMode: boolean) {
  return {
    'fill-color': isLightMode ? '#f59e0b' : '#fbbf24',
    'fill-opacity': 0.18,
  };
}

export function clearanceOutlinePaint(isLightMode: boolean) {
  return {
    'line-color': isLightMode ? '#d97706' : '#fbbf24',
    'line-width': 1.5,
    'line-opacity': 0.9,
    'line-dasharray': [2, 1.5],
  };
}
