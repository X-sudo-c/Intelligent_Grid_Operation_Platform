/**
 * Map distance measure overlay (tap points → polyline + geodesic length).
 *
 * Distances use Vincenty's inverse formula on the WGS84 ellipsoid — the same
 * model PostGIS `geography` / `ST_Distance` uses. Each segment is the shortest
 * ground distance between vertices (not road routing).
 *
 * For planning accuracy: vertices snap to nearby network assets when present,
 * markers stay pinpoint-sized at high zoom, and lengths are shown to cm/mm.
 */

import type { Map as MaplibreMap, MapGeoJSONFeature } from 'maplibre-gl';

export const MAP_MEASURE_LINE_SOURCE = 'map-measure-line';
export const MAP_MEASURE_LINE_LAYER = 'map-measure-line-layer';
export const MAP_MEASURE_POINT_SOURCE = 'map-measure-points';
export const MAP_MEASURE_POINT_LAYER = 'map-measure-points-layer';
export const MAP_MEASURE_POINT_HALO_LAYER = 'map-measure-points-halo-layer';

/** Layers engineers typically measure between — snap targets. */
export const MEASURE_SNAP_LAYER_IDS = [
  'nodes',
  'nodes-transformers-dt',
  'nodes-transformers-pt',
  'master-transformers-dt',
  'master-transformers-pt',
  'staging-points',
] as const;

export type MapMeasurePoint = [number, number];

/** WGS84 ellipsoid — matches EPSG:4326 / PostGIS geography. */
const WGS84_A = 6_378_137;
const WGS84_F = 1 / 298.257223563;
const WGS84_B = WGS84_A * (1 - WGS84_F);

const toRad = (deg: number) => (deg * Math.PI) / 180;

/** Spherical fallback when Vincenty does not converge (antipodal edge cases). */
export function haversineMeters(a: MapMeasurePoint, b: MapMeasurePoint): number {
  const [lon1, lat1] = a;
  const [lon2, lat2] = b;
  const earthR = 6_371_000;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * earthR * Math.asin(Math.sqrt(h));
}

/** Geodesic ground distance (m) on WGS84 between two WGS84 lon/lat points. */
export function geodesicMeters(a: MapMeasurePoint, b: MapMeasurePoint): number {
  const [lon1, lat1] = a;
  const [lon2, lat2] = b;
  if (lon1 === lon2 && lat1 === lat2) return 0;

  const phi1 = toRad(lat1);
  const phi2 = toRad(lat2);
  const L = toRad(lon2 - lon1);

  const U1 = Math.atan((1 - WGS84_F) * Math.tan(phi1));
  const U2 = Math.atan((1 - WGS84_F) * Math.tan(phi2));
  const sinU1 = Math.sin(U1);
  const cosU1 = Math.cos(U1);
  const sinU2 = Math.sin(U2);
  const cosU2 = Math.cos(U2);

  let lambda = L;
  let lambdaPrev = 0;
  let iterLimit = 100;
  let cosSqAlpha = 0;
  let sinSigma = 0;
  let cosSigma = 0;
  let sigma = 0;
  let cos2SigmaM = 0;

  while (Math.abs(lambda - lambdaPrev) > 1e-12 && iterLimit > 0) {
    iterLimit -= 1;
    lambdaPrev = lambda;
    const sinLambda = Math.sin(lambda);
    const cosLambda = Math.cos(lambda);
    sinSigma = Math.sqrt(
      (cosU2 * sinLambda) ** 2 + (cosU1 * sinU2 - sinU1 * cosU2 * cosLambda) ** 2,
    );
    if (sinSigma === 0) return 0;
    cosSigma = sinU1 * sinU2 + cosU1 * cosU2 * cosLambda;
    sigma = Math.atan2(sinSigma, cosSigma);
    const sinAlpha = (cosU1 * cosU2 * sinLambda) / sinSigma;
    cosSqAlpha = 1 - sinAlpha ** 2;
    cos2SigmaM = cosSigma - (2 * sinU1 * sinU2) / cosSqAlpha;
    if (Number.isNaN(cos2SigmaM)) cos2SigmaM = 0;
    const C = (WGS84_F / 16) * cosSqAlpha * (4 + WGS84_F * (4 - 3 * cosSqAlpha));
    lambda =
      L +
      (1 - C) *
        WGS84_F *
        sinAlpha *
        (sigma + C * sinSigma * (cos2SigmaM + C * cosSigma * (-1 + 2 * cos2SigmaM ** 2)));
  }

  if (iterLimit === 0) {
    return haversineMeters(a, b);
  }

  const uSq = (cosSqAlpha * (WGS84_A ** 2 - WGS84_B ** 2)) / WGS84_B ** 2;
  const A = 1 + (uSq / 16384) * (4096 + uSq * (-768 + uSq * (320 - 175 * uSq)));
  const B = (uSq / 1024) * (256 + uSq * (-128 + uSq * (74 - 47 * uSq)));
  const deltaSigma =
    B *
    sinSigma *
    (cos2SigmaM +
      (B / 4) *
        (cosSigma * (-1 + 2 * cos2SigmaM ** 2) -
          (B / 6) * cos2SigmaM * (-3 + 4 * sinSigma ** 2) * (-3 + 4 * cos2SigmaM ** 2)));

  return WGS84_B * A * (sigma - deltaSigma);
}

/** Engineering readout: mm under 1 m, cm-class under 100 m, then m / km. */
export function formatMeasureMeters(meters: number): string {
  if (!Number.isFinite(meters)) return '—';
  if (meters < 1) return `${(meters * 1000).toFixed(0)} mm`;
  if (meters < 100) return `${meters.toFixed(3)} m`;
  if (meters < 1000) return `${meters.toFixed(2)} m`;
  return `${(meters / 1000).toFixed(3)} km`;
}

export function polylineLengthMeters(points: MapMeasurePoint[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i += 1) {
    total += geodesicMeters(points[i - 1], points[i]);
  }
  return total;
}

function segmentLabelPosition(start: MapMeasurePoint, end: MapMeasurePoint): MapMeasurePoint {
  return [(start[0] + end[0]) / 2, (start[1] + end[1]) / 2];
}

/** Screen-stable bearing (degrees) so the dimension sits along the segment. */
function segmentLabelBearing(start: MapMeasurePoint, end: MapMeasurePoint): number {
  const dLon = end[0] - start[0];
  const dLat = end[1] - start[1];
  let deg = (Math.atan2(dLon, dLat) * 180) / Math.PI;
  // Keep text upright (avoid upside-down labels on westbound spans).
  if (deg > 90 || deg < -90) deg += 180;
  return deg;
}

function featurePointCoords(feature: MapGeoJSONFeature): MapMeasurePoint | null {
  const geom = feature.geometry;
  if (!geom) return null;
  if (geom.type === 'Point' && Array.isArray(geom.coordinates) && geom.coordinates.length >= 2) {
    const lon = Number(geom.coordinates[0]);
    const lat = Number(geom.coordinates[1]);
    if (Number.isFinite(lon) && Number.isFinite(lat)) return [lon, lat];
  }
  return null;
}

/**
 * Snap a screen click to the nearest rendered network asset within `padPx`.
 * Returns the asset's true WGS84 coordinates (not the click pixel).
 */
export function snapMeasurePoint(
  map: MaplibreMap,
  point: { x: number; y: number },
  padPx = 10,
): { coord: MapMeasurePoint; snapped: boolean; layerId?: string } {
  const layers = MEASURE_SNAP_LAYER_IDS.filter((id) => map.getLayer(id));
  if (layers.length === 0) {
    const ll = map.unproject([point.x, point.y]);
    return { coord: [ll.lng, ll.lat], snapped: false };
  }

  const hits = map.queryRenderedFeatures(
    [
      [point.x - padPx, point.y - padPx],
      [point.x + padPx, point.y + padPx],
    ],
    { layers: [...layers] },
  );

  let best: { coord: MapMeasurePoint; dist2: number; layerId: string } | null = null;
  for (const feature of hits) {
    const coord = featurePointCoords(feature);
    if (!coord) continue;
    const projected = map.project(coord);
    const dx = projected.x - point.x;
    const dy = projected.y - point.y;
    const dist2 = dx * dx + dy * dy;
    if (!best || dist2 < best.dist2) {
      best = { coord, dist2, layerId: feature.layer?.id ?? '' };
    }
  }

  if (best && best.dist2 <= padPx * padPx) {
    return { coord: best.coord, snapped: true, layerId: best.layerId };
  }

  const ll = map.unproject([point.x, point.y]);
  return { coord: [ll.lng, ll.lat], snapped: false };
}

export type MeasureSegmentDimension = {
  coord: MapMeasurePoint;
  label: string;
  bearing: number;
};

/** Per-segment midpoints + formatted lengths for on-map dimension chips. */
export function buildMeasureSegmentDimensions(points: MapMeasurePoint[]): MeasureSegmentDimension[] {
  const dims: MeasureSegmentDimension[] = [];
  for (let i = 1; i < points.length; i += 1) {
    const start = points[i - 1];
    const end = points[i];
    dims.push({
      coord: segmentLabelPosition(start, end),
      label: formatMeasureMeters(geodesicMeters(start, end)),
      bearing: segmentLabelBearing(start, end),
    });
  }
  return dims;
}

export function buildMeasureGeoJson(points: MapMeasurePoint[]): {
  line: GeoJSON.FeatureCollection;
  points: GeoJSON.FeatureCollection;
} {
  const pointFeatures: GeoJSON.Feature[] = points.map((coord, index) => ({
    type: 'Feature',
    properties: { index },
    geometry: { type: 'Point', coordinates: coord },
  }));

  const lineFeatures: GeoJSON.Feature[] =
    points.length >= 2
      ? [
          {
            type: 'Feature',
            properties: {},
            geometry: { type: 'LineString', coordinates: points },
          },
        ]
      : [];

  return {
    line: { type: 'FeatureCollection', features: lineFeatures },
    points: { type: 'FeatureCollection', features: pointFeatures },
  };
}

export function measureLinePaint(isLightMode: boolean) {
  return {
    'line-color': isLightMode ? '#e11d48' : '#fb7185',
    'line-width': ['interpolate', ['linear'], ['zoom'], 12, 1.25, 16, 1.5, 20, 1.75],
    'line-opacity': 0.95,
    'line-dasharray': [1.25, 2],
  };
}

/** Soft halo so the pinpoint stays visible without covering short spans. */
export function measurePointHaloPaint(isLightMode: boolean) {
  return {
    'circle-radius': ['interpolate', ['linear'], ['zoom'], 12, 5, 16, 4, 18, 3.25, 20, 2.75, 22, 2.5],
    'circle-color': isLightMode ? '#e11d48' : '#fb7185',
    'circle-opacity': 0.18,
    'circle-stroke-width': 0,
  };
}

/** True pinpoint core — stays small at high zoom for engineering work. */
export function measurePointPaint(isLightMode: boolean) {
  return {
    'circle-radius': ['interpolate', ['linear'], ['zoom'], 12, 2.25, 16, 1.75, 18, 1.5, 20, 1.25, 22, 1.1],
    'circle-color': isLightMode ? '#e11d48' : '#fb7185',
    'circle-stroke-color': isLightMode ? '#ffffff' : '#0f172a',
    'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 12, 1.25, 18, 1, 20, 0.85],
  };
}

