import type { MapBboxContext } from './giopCopilotTypes';
import { GIOP_MAP_LABEL_FONT_REGULAR, GIS_IMPORT_MAGENTA } from './giopMapLayers';

export interface ImportSegmentHighlightGeoJson {
  line: GeoJSON.FeatureCollection;
  endpoints: GeoJSON.FeatureCollection;
  proposed_assets?: GeoJSON.FeatureCollection;
  suggested_links?: GeoJSON.FeatureCollection;
}

export interface ImportSegmentHighlightState {
  segmentId: number;
  label: string;
  geojson: ImportSegmentHighlightGeoJson;
  bbox?: MapBboxContext;
}

/** Tight focus on endpoint connections — excludes the full conductor span. */
export function bboxFromEndpointFixGeojson(
  geojson: ImportSegmentHighlightGeoJson,
): MapBboxContext | null {
  const coords: Array<[number, number]> = [];

  const collect = (fc?: GeoJSON.FeatureCollection) => {
    for (const feature of fc?.features ?? []) {
      const geom = feature.geometry;
      if (!geom) continue;
      if (geom.type === 'Point') {
        const c = geom.coordinates as [number, number];
        if (Number.isFinite(c[0]) && Number.isFinite(c[1])) coords.push(c);
      } else if (geom.type === 'LineString') {
        for (const c of geom.coordinates) {
          const pt = c as [number, number];
          if (Number.isFinite(pt[0]) && Number.isFinite(pt[1])) coords.push(pt);
        }
      }
    }
  };

  collect(geojson.endpoints);
  collect(geojson.proposed_assets);
  collect(geojson.suggested_links);
  if (coords.length === 0) collect(geojson.line);
  if (coords.length === 0) return null;

  let west = coords[0][0];
  let east = coords[0][0];
  let south = coords[0][1];
  let north = coords[0][1];
  for (const [lon, lat] of coords) {
    west = Math.min(west, lon);
    east = Math.max(east, lon);
    south = Math.min(south, lat);
    north = Math.max(north, lat);
  }

  const pad = 0.00015;
  return {
    west: west - pad,
    south: south - pad,
    east: east + pad,
    north: north + pad,
  };
}

export const IMPORT_SEGMENT_LINE_SOURCE = 'import-segment-line';
export const IMPORT_SEGMENT_LINE_LAYER = 'import-segment-line-layer';
export const IMPORT_SEGMENT_ENDPOINT_SOURCE = 'import-segment-endpoints';
export const IMPORT_SEGMENT_ENDPOINT_LAYER = 'import-segment-endpoints-layer';
export const IMPORT_SEGMENT_LABEL_LAYER = 'import-segment-endpoint-labels';
export const IMPORT_SEGMENT_PROPOSED_SOURCE = 'import-segment-proposed-assets';
export const IMPORT_SEGMENT_PROPOSED_LAYER = 'import-segment-proposed-layer';
export const IMPORT_SEGMENT_PROPOSED_LABEL_LAYER = 'import-segment-proposed-labels';
export const IMPORT_SEGMENT_LINK_SOURCE = 'import-segment-suggested-links';
export const IMPORT_SEGMENT_LINK_LAYER = 'import-segment-suggested-links-layer';

export function importSegmentLinePaint(_isLightMode: boolean) {
  return {
    'line-color': GIS_IMPORT_MAGENTA,
    'line-width': ['interpolate', ['linear'], ['zoom'], 14, 5, 16, 7, 18, 9],
    'line-opacity': 1,
  };
}

export function importSegmentEndpointPaint(isLightMode: boolean) {
  const unresolved = isLightMode ? '#dc2626' : '#f87171';
  const startResolved = isLightMode ? '#16a34a' : '#4ade80';
  const endResolved = isLightMode ? '#2563eb' : '#60a5fa';
  const startUnresolved = isLightMode ? '#ca8a04' : '#facc15';
  return {
    'circle-radius': ['interpolate', ['linear'], ['zoom'], 14, 7, 16, 9, 18, 11],
    'circle-color': [
      'case',
      ['all', ['==', ['get', 'role'], 'start'], ['==', ['get', 'resolved'], true]],
      startResolved,
      ['all', ['==', ['get', 'role'], 'start'], ['==', ['get', 'resolved'], false]],
      startUnresolved,
      ['all', ['==', ['get', 'role'], 'end'], ['==', ['get', 'resolved'], true]],
      endResolved,
      unresolved,
    ],
    'circle-stroke-color': isLightMode ? '#ffffff' : '#0f172a',
    'circle-stroke-width': 2.5,
    'circle-opacity': 1,
  };
}

export function importSegmentLabelLayout() {
  return {
    'text-field': ['get', 'node_id'],
    'text-size': 11,
    'text-offset': [0, 1.4],
    'text-anchor': 'top' as const,
    'text-max-width': 14,
    'text-allow-overlap': true,
    'text-ignore-placement': true,
    'text-font': GIOP_MAP_LABEL_FONT_REGULAR,
  };
}

export function importSegmentLabelPaint(isLightMode: boolean) {
  return {
    'text-color': isLightMode ? '#0f172a' : '#f8fafc',
    'text-halo-color': isLightMode ? '#ffffff' : '#1e293b',
    'text-halo-width': 2,
  };
}

export function importSegmentProposedPaint(isLightMode: boolean) {
  const dt = isLightMode ? '#7c3aed' : '#c4b5fd';
  const pt = isLightMode ? '#b45309' : '#fcd34d';
  const pole = isLightMode ? '#0d9488' : '#5eead4';
  return {
    'circle-radius': ['interpolate', ['linear'], ['zoom'], 14, 8, 16, 10, 18, 12],
    'circle-color': [
      'match',
      ['get', 'asset_kind'],
      'distribution_transformer',
      dt,
      'power_transformer',
      pt,
      pole,
    ],
    'circle-stroke-color': isLightMode ? '#ffffff' : '#0f172a',
    'circle-stroke-width': 2.5,
    'circle-opacity': 1,
  };
}

export function importSegmentProposedLabelLayout() {
  return {
    'text-field': ['get', 'node_id'],
    'text-size': 10,
    'text-offset': [0, 1.6],
    'text-anchor': 'top' as const,
    'text-max-width': 16,
    'text-allow-overlap': true,
    'text-ignore-placement': true,
    'text-font': GIOP_MAP_LABEL_FONT_REGULAR,
  };
}

export function importSegmentSuggestedLinkPaint(isLightMode: boolean) {
  return {
    'line-color': isLightMode ? '#0d9488' : '#2dd4bf',
    'line-width': ['interpolate', ['linear'], ['zoom'], 14, 2, 16, 3, 18, 4],
    'line-opacity': 0.85,
    'line-dasharray': [2, 2],
  };
}
