/**
 * Client-side H3 hex grid (h3-js v4) so the territory grid renders without an
 * API round-trip on every pan/zoom. Mirrors sync-service h3_service output shape.
 */
import { cellToBoundary, isValidCell, latLngToCell, polygonToCells } from 'h3-js';

export interface H3Bounds {
  west: number;
  south: number;
  east: number;
  north: number;
}

export interface H3GridResult {
  type: 'FeatureCollection';
  resolution: number;
  features: Array<{
    type: 'Feature';
    geometry: GeoJSON.Polygon;
    properties: { h3: string; resolution: number };
  }>;
  cell_count: number;
  truncated: boolean;
}

/** Closed GeoJSON ring ([lng, lat]) for an H3 cell. */
export function cellToPolygon(cell: string): GeoJSON.Polygon {
  const ring = cellToBoundary(cell, true) as [number, number][];
  if (ring.length > 0) ring.push(ring[0]);
  return { type: 'Polygon', coordinates: [ring] };
}

export function pointToCell(
  lat: number,
  lng: number,
  res: number,
): { h3: string; geometry: GeoJSON.Polygon } {
  const h3 = latLngToCell(lat, lng, res);
  return { h3, geometry: cellToPolygon(h3) };
}

/** All H3 cells covering a bbox as a GeoJSON FeatureCollection. */
export function bboxToHexGrid(
  bounds: H3Bounds,
  res: number,
  maxCells = 4000,
): H3GridResult {
  const { west, south, east, north } = bounds;
  const loop: [number, number][] = [
    [west, south],
    [east, south],
    [east, north],
    [west, north],
    [west, south],
  ];
  const cells = polygonToCells([loop], res, true);
  const truncated = cells.length > maxCells;
  const limited = truncated ? cells.slice(0, maxCells) : cells;
  const features = limited
    .filter((cell) => isValidCell(cell))
    .map((cell) => ({
      type: 'Feature' as const,
      geometry: cellToPolygon(cell),
      properties: { h3: cell, resolution: res },
    }));
  return {
    type: 'FeatureCollection',
    resolution: res,
    features,
    cell_count: features.length,
    truncated,
  };
}
