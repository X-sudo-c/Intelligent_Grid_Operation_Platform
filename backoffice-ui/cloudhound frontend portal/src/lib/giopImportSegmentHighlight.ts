import type { MapBboxContext } from './giopCopilotTypes';
import { GIOP_MAP_LABEL_FONT_REGULAR } from './giopMapLayers';

export interface ImportSegmentHighlightGeoJson {
  line: GeoJSON.FeatureCollection;
  endpoints: GeoJSON.FeatureCollection;
}

export interface ImportSegmentHighlightState {
  segmentId: number;
  label: string;
  geojson: ImportSegmentHighlightGeoJson;
  bbox?: MapBboxContext;
}

export const IMPORT_SEGMENT_LINE_SOURCE = 'import-segment-line';
export const IMPORT_SEGMENT_LINE_LAYER = 'import-segment-line-layer';
export const IMPORT_SEGMENT_ENDPOINT_SOURCE = 'import-segment-endpoints';
export const IMPORT_SEGMENT_ENDPOINT_LAYER = 'import-segment-endpoints-layer';
export const IMPORT_SEGMENT_LABEL_LAYER = 'import-segment-endpoint-labels';

export function importSegmentLinePaint(isLightMode: boolean) {
  return {
    'line-color': isLightMode ? '#c026d3' : '#e879f9',
    'line-width': ['interpolate', ['linear'], ['zoom'], 14, 4, 16, 6, 18, 8],
    'line-opacity': 0.95,
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
