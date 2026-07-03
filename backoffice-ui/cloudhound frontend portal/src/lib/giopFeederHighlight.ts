import type { MapBboxContext } from './giopCopilotTypes';

export interface FeederHighlightGeoJson {
  nodes: {
    type: 'FeatureCollection';
    features: Array<{
      type: 'Feature';
      properties?: Record<string, unknown>;
      geometry: { type: string; coordinates: unknown };
    }>;
  };
  edges: {
    type: 'FeatureCollection';
    features: Array<{
      type: 'Feature';
      properties?: Record<string, unknown>;
      geometry: { type: string; coordinates: unknown };
    }>;
  };
}

export interface FeederHighlightState {
  feederId: string;
  label: string;
  geojson: FeederHighlightGeoJson;
  bbox?: MapBboxContext;
}

export const FEEDER_HIGHLIGHT_NODE_SOURCE = 'feeder-highlight-nodes';
export const FEEDER_HIGHLIGHT_EDGE_SOURCE = 'feeder-highlight-edges';
export const FEEDER_HIGHLIGHT_NODE_LAYER = 'feeder-highlight-nodes-layer';
export const FEEDER_HIGHLIGHT_EDGE_LAYER = 'feeder-highlight-edges-layer';

export function feederHighlightNodePaint(isLightMode: boolean) {
  return {
    'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 3, 14, 5, 18, 7],
    'circle-color': isLightMode ? '#ea580c' : '#fb923c',
    'circle-stroke-color': isLightMode ? '#ffffff' : '#1e293b',
    'circle-stroke-width': 1.5,
    'circle-opacity': 0.92,
  };
}

export function feederHighlightEdgePaint(isLightMode: boolean) {
  return {
    'line-color': isLightMode ? '#f97316' : '#fdba74',
    'line-width': ['interpolate', ['linear'], ['zoom'], 10, 1.5, 14, 2.5, 18, 3.5],
    'line-opacity': 0.85,
  };
}
