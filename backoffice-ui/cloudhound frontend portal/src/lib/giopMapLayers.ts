/**
 * MapLibre layer paint + Martin source helpers for GiopMapView.
 * SLD colors match backoffice-ui/theme.js and giopSldTheme.ts.
 */

import type {
  CircleLayerSpecification,
  DataDrivenPropertyValueSpecification,
  FilterSpecification,
  LineLayerSpecification,
  Map as MaplibreMap,
  RasterTileSource,
  StyleSpecification,
  SymbolLayerSpecification,
} from 'maplibre-gl';
import { TRANSFORMER_ICON_ID } from './giopMapIcons';
import {
  CONFLICT_NODE_FILL,
  CONFLICT_NODE_STROKE,
  voltageEdgeColor,
} from './giopSldTheme';

/** demotiles.maplibre.org glyph stacks (see buildGiopMapStyle glyphs URL). */
export const GIOP_MAP_LABEL_FONT_BOLD = ['Noto Sans Bold'];
export const GIOP_MAP_LABEL_FONT_REGULAR = ['Noto Sans Regular'];

export const NODE_DETAIL_ZOOM = 12;

/** Street-level zoom when focusing a node from the map or sidebar (buildings + labels visible). */
export const NODE_FOCUS_ZOOM = 17;

/** Close-up zoom for duplicate spider/fan pins (~12–20 m separation visible). */
export const DUPLICATE_CLUSTER_ZOOM = 19;

export function nodeFocusZoom(currentZoom: number): number {
  return Math.max(currentZoom, NODE_FOCUS_ZOOM);
}

export type NodeFocusFlyOpts = {
  /** When true (default), zoom to at least NODE_FOCUS_ZOOM. When false, pan only. */
  boostZoom?: boolean;
  /** Override zoom level (e.g. DUPLICATE_CLUSTER_ZOOM for duplicate fan view). */
  targetZoom?: number;
};

export function flyToNodeFocus(
  map: MaplibreMap,
  center: [number, number],
  duration = 800,
  opts?: NodeFocusFlyOpts,
): void {
  const boostZoom = opts?.boostZoom !== false;
  if (boostZoom) {
    const zoom =
      opts?.targetZoom != null
        ? Math.max(map.getZoom(), opts.targetZoom)
        : nodeFocusZoom(map.getZoom());
    map.flyTo({
      center,
      zoom,
      duration,
    });
  } else if (opts?.targetZoom != null && map.getZoom() < opts.targetZoom) {
    map.flyTo({ center, zoom: opts.targetZoom, duration });
  } else {
    map.easeTo({ center, duration });
  }
}

/** Pan to a node without changing zoom (e.g. late-arriving coords for same focus). */
export function panToNodeFocus(
  map: MaplibreMap,
  center: [number, number],
  duration = 400,
): void {
  map.easeTo({ center, duration });
}

export interface MapBoundsLike {
  west: number;
  south: number;
  east: number;
  north: number;
}

/** Fit map camera to a geographic bounding box (district, viewport query, etc.). */
export function fitMapBounds(
  map: MaplibreMap,
  bbox: MapBoundsLike,
  opts?: { padding?: number; duration?: number; maxZoom?: number },
): void {
  map.fitBounds(
    [
      [bbox.west, bbox.south],
      [bbox.east, bbox.north],
    ],
    {
      padding: opts?.padding ?? 48,
      duration: opts?.duration ?? 900,
      maxZoom: opts?.maxZoom ?? 14,
    },
  );
}

export function flyToLatLon(
  map: MaplibreMap,
  lon: number,
  lat: number,
  zoom = 14,
  duration = 900,
): void {
  map.flyTo({ center: [lon, lat], zoom, duration });
}

/** Country-scale floor — users cannot zoom out past this. */
export const MIN_MAP_ZOOM = 6.6;

/** OH 11 kV tiles are ~5 MB at z6; 33 kV is ~11 MB so defer to z7. */
export const OVERVIEW_OH_11_MIN_ZOOM = 6;
export const OVERVIEW_OH_33_MIN_ZOOM = 7;

/** Drop GIS import outliers (e.g. 350 km "UNDERGROUND FEEDER" rings) from overview layers. */
export const MAX_OVERVIEW_LENGTH_M = 50_000;

/** map_ac_line_segments tiles error at z10; detail layers start at z11. */
export const DETAIL_LINE_MIN_ZOOM = 11;

/** Graph-chunk edges are topological chords (node→node), not map geometry — never draw on map. */
export const CHUNK_OVERLAY_MIN_ZOOM = 10;
export const CHUNK_NODE_MIN_ZOOM = 11.5;

/** Symbol icons for DT/PT; circles remain for poles and generic nodes. */
export const TRANSFORMER_ICON_MIN_ZOOM = 12;

export const TRANSFORMER_ASSET_KINDS = ['distribution_transformer', 'power_transformer'] as const;

export const SLD_MV_33KV = '#1D4ED8';
export const SLD_MV_11KV = '#B91C1C';
export const SLD_HV = '#78350F';
export const SLD_LV = '#0F172A';

/** Dashed pattern for underground conductors (overview + detail). */
export const UG_LINE_DASH: [number, number] = [4, 3];

const INSTALLATION_UNDERGROUND: ['==', ['get', string], string] = [
  '==',
  ['get', 'installation_type'],
  'UNDERGROUND',
];

const INSTALLATION_OVERHEAD: ['!=', ['get', string], string] = [
  '!=',
  ['get', 'installation_type'],
  'UNDERGROUND',
];

const OVERVIEW_MARTIN_LAYER: Record<string, string> = {
  overview_ug_cable_33kv: 'ug_cable_33kv',
  overview_ug_cable_11kv: 'ug_cable_11kv',
  overview_oh_conductor_33kv: 'oh_conductor_33kv',
  overview_oh_conductor_11kv: 'oh_conductor_11kv',
  overview_power_transformer: 'power_transformer',
  overview_distribution_transformer: 'distribution_transformer',
};

/** MapLibre source id → Martin tileset path segment. */
export function martinLayerPath(sourceId: string): string {
  return OVERVIEW_MARTIN_LAYER[sourceId] ?? sourceId;
}

/** Master CIM tile sources (public.map_* views) — always safe on a fresh schema DB. */
export const MARTIN_MASTER_REFRESH_SOURCE_IDS = [
  'map_connectivity_nodes',
  'map_ac_line_segments',
] as const;

/** GIS GPKG overview sources — only load when gis.* import tables exist. */
export const MARTIN_GIS_OVERVIEW_REFRESH_SOURCE_IDS = [
  'overview_ug_cable_33kv',
  'overview_ug_cable_11kv',
  'overview_oh_conductor_33kv',
  'overview_oh_conductor_11kv',
  'overview_power_transformer',
  'overview_distribution_transformer',
] as const;

/** Martin source ids eligible for cache-bust on repair/promote. */
export const MARTIN_REFRESH_SOURCE_IDS = [
  ...MARTIN_MASTER_REFRESH_SOURCE_IDS,
  ...MARTIN_GIS_OVERVIEW_REFRESH_SOURCE_IDS,
] as const;

export interface GiopMapStyleOptions {
  /** Include GIS GPKG overview layers (conductors, transformers). Default false until probed. */
  includeGisOverview?: boolean;
}

const GIS_OVERVIEW_LAYER_ID_PREFIXES = ['overview-', 'nodes-transformers-'] as const;

export function isGisOverviewMapLayer(layerId: string): boolean {
  return GIS_OVERVIEW_LAYER_ID_PREFIXES.some((prefix) => layerId.startsWith(prefix));
}

export function overviewLinePaint(color: string) {
  return {
    'line-color': color,
    'line-width': ['interpolate', ['linear'], ['zoom'], 6, 1.05, 7, 1.15, 9, 1.35, 11, 1.6, 12, 1.9],
    'line-opacity': ['interpolate', ['linear'], ['zoom'], 6, 0.82, 8, 0.88, 10, 0.92, 12, 0.94],
  } as const;
}

export function overviewUgLinePaint(color: string) {
  return {
    ...overviewLinePaint(color),
    'line-dasharray': UG_LINE_DASH,
  } as const;
}

export function overviewLengthFilter(): LineLayerSpecification['filter'] {
  return ['<', ['coalesce', ['get', 'length_in_meters'], 0], MAX_OVERVIEW_LENGTH_M];
}

type TileLinePaint = Required<Pick<NonNullable<LineLayerSpecification['paint']>, 'line-color' | 'line-width' | 'line-opacity'>>;
type TileNodePaint = Required<Pick<NonNullable<CircleLayerSpecification['paint']>, 'circle-radius' | 'circle-color' | 'circle-opacity' | 'circle-stroke-width' | 'circle-stroke-color' | 'circle-stroke-opacity'>>;

const LV_VOLTAGE_FILTER: ['in', ['get', string], ['literal', string[]]] = [
  'in',
  ['get', 'nominal_voltage'],
  ['literal', ['LV_230V', 'LV_400V']],
];

/** Detail Martin lines — color/width from nominal_voltage (LV dash uses separate layer). */
export function tileLinePaint(light: boolean): TileLinePaint {
  const fallback = light ? '#64748b' : '#94a3b8';
  const lvColor = light ? SLD_LV : '#cbd5e1';
  return {
    'line-color': [
      'match',
      ['get', 'nominal_voltage'],
      'HV_161KV',
      SLD_HV,
      'HV_330KV',
      SLD_HV,
      'MV_33KV',
      SLD_MV_33KV,
      'MV_11KV',
      SLD_MV_11KV,
      'LV_230V',
      lvColor,
      'LV_400V',
      lvColor,
      fallback,
    ],
    'line-width': [
      'interpolate',
      ['linear'],
      ['zoom'],
      11,
      [
        'match',
        ['get', 'nominal_voltage'],
        'HV_161KV',
        2.2,
        'HV_330KV',
        2.2,
        'MV_33KV',
        1.4,
        'MV_11KV',
        1.1,
        'LV_230V',
        1.4,
        'LV_400V',
        1.4,
        0.9,
      ],
      12,
      [
        'match',
        ['get', 'nominal_voltage'],
        'HV_161KV',
        2.8,
        'HV_330KV',
        2.8,
        'MV_33KV',
        1.8,
        'MV_11KV',
        1.4,
        'LV_230V',
        1.8,
        'LV_400V',
        1.8,
        1.2,
      ],
      15,
      [
        'match',
        ['get', 'nominal_voltage'],
        'HV_161KV',
        4,
        'HV_330KV',
        4,
        'MV_33KV',
        2.5,
        'MV_11KV',
        2,
        'LV_230V',
        2.2,
        'LV_400V',
        2.2,
        1.5,
      ],
    ],
    'line-opacity': ['interpolate', ['linear'], ['zoom'], 11, 0.72, 12, 0.85, 14, 0.95],
  };
}

export function tileLineLvFilter(): LineLayerSpecification['filter'] {
  return LV_VOLTAGE_FILTER;
}

export function tileLineSolidFilter(): LineLayerSpecification['filter'] {
  return ['!', LV_VOLTAGE_FILTER];
}

export function tileLineOverheadMvFilter(): LineLayerSpecification['filter'] {
  return ['all', ['!', LV_VOLTAGE_FILTER], INSTALLATION_OVERHEAD];
}

export function tileLineUndergroundMvFilter(): LineLayerSpecification['filter'] {
  return ['all', ['!', LV_VOLTAGE_FILTER], INSTALLATION_UNDERGROUND];
}

export function tileLineOverheadLvFilter(): LineLayerSpecification['filter'] {
  return ['all', LV_VOLTAGE_FILTER, INSTALLATION_OVERHEAD];
}

export function tileLineUndergroundLvFilter(): LineLayerSpecification['filter'] {
  return ['all', LV_VOLTAGE_FILTER, INSTALLATION_UNDERGROUND];
}

export function tileTransformerSymbolLayout(): SymbolLayerSpecification['layout'] {
  return {
    'icon-image': TRANSFORMER_ICON_ID,
    'icon-size': ['interpolate', ['linear'], ['zoom'], 12, 0.42, 14, 0.55, 16, 0.72, 18, 0.9],
    'icon-allow-overlap': true,
    'icon-ignore-placement': true,
  };
}

/** Detail Martin nodes — poles/support; transformers use symbol layers. */
export function tileNodeCirclePaint(light: boolean): TileNodePaint {
  const defaultFill = light ? '#64748b' : '#94a3b8';
  return {
    'circle-radius': ['interpolate', ['linear'], ['zoom'], 11.5, 1.2, 12, 1.6, 13, 2.2, 15, 3.5],
    'circle-color': [
      'case',
      ['==', ['get', 'validation'], 'IN_CONFLICT'],
      CONFLICT_NODE_FILL,
      ['==', ['get', 'validation'], 'PENDING_FIELD'],
      '#f59e0b',
      defaultFill,
    ],
    'circle-opacity': ['interpolate', ['linear'], ['zoom'], 11.5, 0.45, 12, 0.62, 15, 0.9],
    'circle-stroke-width': [
      'interpolate',
      ['linear'],
      ['zoom'],
      11.5,
      ['case', ['==', ['get', 'validation'], 'IN_CONFLICT'], 3, 0.2],
      12,
      ['case', ['==', ['get', 'validation'], 'IN_CONFLICT'], 3, 0.35],
      15,
      ['case', ['==', ['get', 'validation'], 'IN_CONFLICT'], 3, 1.2],
    ],
    'circle-stroke-color': [
      'case',
      ['==', ['get', 'validation'], 'IN_CONFLICT'],
      CONFLICT_NODE_STROKE,
      '#ffffff',
    ],
    'circle-stroke-opacity': ['interpolate', ['linear'], ['zoom'], 11.5, 0.25, 12, 0.4, 15, 0.85],
  };
}

export function chunkNodeCirclePaint(light: boolean): CirclePaint {
  return {
    'circle-radius': radiusExpressionFromStops(MAP_NODE_RADIUS_STOPS),
    'circle-color': [
      'case',
      ['==', ['get', 'validation'], 'IN_CONFLICT'],
      CONFLICT_NODE_FILL,
      ['boolean', ['get', 'traced'], false],
      '#f97316',
      ['==', ['get', 'validation'], 'PENDING_FIELD'],
      '#f59e0b',
      ['boolean', ['get', 'connected'], false],
      light ? '#2563eb' : '#3b82f6',
      light ? '#64748b' : '#94a3b8',
    ],
    'circle-stroke-width': [
      'interpolate',
      ['linear'],
      ['zoom'],
      5,
      ['case', ['==', ['get', 'validation'], 'IN_CONFLICT'], 3, 0.2],
      9,
      ['case', ['==', ['get', 'validation'], 'IN_CONFLICT'], 3, 0.4],
      14,
      ['case', ['==', ['get', 'validation'], 'IN_CONFLICT'], 3, 1],
      18,
      ['case', ['==', ['get', 'validation'], 'IN_CONFLICT'], 3, 1.6],
    ],
    'circle-stroke-color': [
      'case',
      ['==', ['get', 'validation'], 'IN_CONFLICT'],
      CONFLICT_NODE_STROKE,
      '#ffffff',
    ],
    'circle-opacity': ['interpolate', ['linear'], ['zoom'], 5, 0.5, 9, 0.65, 14, 0.85],
  };
}

/** Zoom stops aligned with chunk/tile node scale (screen pixels, not fixed giants). */
export const MAP_NODE_RADIUS_STOPS: [number, number][] = [
  [6, 1.4],
  [8, 1.9],
  [11, 2.6],
  [13, 3.4],
  [15, 4.5],
  [18, 6],
];

function interpolateZoomStops(zoom: number, stops: [number, number][]): number {
  if (stops.length === 0) return 4;
  const zMin = stops[0][0];
  const zMax = stops[stops.length - 1][0];
  const z = Math.max(zMin, Math.min(zMax, zoom));
  for (let i = 0; i < stops.length - 1; i++) {
    const [z0, v0] = stops[i];
    const [z1, v1] = stops[i + 1];
    if (z >= z0 && z <= z1) {
      const t = z1 === z0 ? 0 : (z - z0) / (z1 - z0);
      return v0 + t * (v1 - v0);
    }
  }
  return stops[stops.length - 1][1];
}

export function mapNodeRadiusAtZoom(zoom: number): number {
  return interpolateZoomStops(zoom, MAP_NODE_RADIUS_STOPS);
}

/** Dispatch pins — slightly larger than grid nodes, still zoom-scaled. */
export const WORK_ORDER_PIN_RADIUS_STOPS: [number, number][] = [
  [6, 2.2],
  [8, 2.8],
  [11, 3.6],
  [13, 4.8],
  [15, 6],
  [18, 7.5],
];

export function workOrderPinRadiusAtZoom(zoom: number): number {
  return interpolateZoomStops(zoom, WORK_ORDER_PIN_RADIUS_STOPS);
}

/** Wider ripple spread multiplier for work-order dispatch rings. */
export const WORK_ORDER_RIPPLE_SPREAD_SCALE = 2.5;

type CirclePaint = NonNullable<CircleLayerSpecification['paint']>;

function radiusExpressionFromStops(
  stops: [number, number][],
): DataDrivenPropertyValueSpecification<number> {
  const flat = stops.flat();
  return ['interpolate', ['linear'], ['zoom'], ...flat];
}

/** Staging overlay dots — same scale as master grid nodes. */
export function stagingPointCirclePaint(): CirclePaint {
  return {
    'circle-radius': radiusExpressionFromStops(MAP_NODE_RADIUS_STOPS),
    'circle-color': [
      'match',
      ['get', 'validation'],
      'IN_CONFLICT',
      CONFLICT_NODE_FILL,
      'STAGED',
      '#3b82f6',
      'REJECTED',
      '#64748b',
      '#f59e0b',
    ],
    'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 6, 0.45, 11, 0.75, 14, 1.1, 18, 1.4],
    'circle-stroke-color': '#ffffff',
    'circle-opacity': ['interpolate', ['linear'], ['zoom'], 6, 0.75, 11, 0.88, 15, 0.95],
  };
}

/** Outage impact highlight nodes — zoom-scaled. */
export function impactNodeCirclePaint(): CirclePaint {
  return {
    'circle-radius': radiusExpressionFromStops(MAP_NODE_RADIUS_STOPS),
    'circle-color': '#ef4444',
    'circle-opacity': 0.75,
    'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 6, 0.5, 11, 0.85, 14, 1.1, 18, 1.4],
    'circle-stroke-color': '#7f1d1d',
  };
}

/** Work-order dispatch pin — zoom-scaled like grid nodes. */
export function workOrderPinCirclePaint(): CirclePaint {
  return {
    'circle-radius': radiusExpressionFromStops(WORK_ORDER_PIN_RADIUS_STOPS),
    'circle-color': '#a855f7',
    'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 6, 0.55, 11, 0.9, 14, 1.3, 18, 1.7],
    'circle-stroke-color': '#581c87',
    'circle-opacity': 0.95,
  };
}

/** Traced / start node highlight on chunk overlay. */
export function tracedHighlightCirclePaint(): CirclePaint {
  return {
    'circle-radius': ['interpolate', ['linear'], ['zoom'], 5, 1.6, 8, 2.2, 12, 3.8, 14, 5, 18, 6.5],
    'circle-color': '#f97316',
    'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 5, 0.8, 12, 1.2, 18, 1.6],
    'circle-stroke-color': '#ffffff',
    'circle-opacity': 0.92,
  };
}

/** Subtle ripple anchor — same scale as grid nodes. */
export function focusIdentifyRipplePinRadius(zoom: number): number {
  return mapNodeRadiusAtZoom(zoom);
}

/** Side-panel "show on map" identify pin — cyan at normal node scale. */
export function focusIdentifyCirclePaint(): CirclePaint {
  return {
    'circle-radius': radiusExpressionFromStops(MAP_NODE_RADIUS_STOPS),
    'circle-color': '#06b6d4',
    'circle-opacity': 0.95,
    'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 6, 0.65, 11, 1, 14, 1.35, 18, 1.7],
    'circle-stroke-color': '#ffffff',
  };
}

type SymbolPaint = NonNullable<SymbolLayerSpecification['paint']>;

/** Carto basemap tile URLs — keep in sync with buildGiopMapStyle. */
export const GIOP_BASEMAP_TILES = {
  light: ['https://basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png'],
  dark: ['https://basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png'],
} as const;

/** Side-map / duplicate fan asset name labels — amber ink, no halo stroke. */
export const GIOP_MAP_FOCUS_LABEL_COLOR = '#b45309';

export const GIOP_BASEMAP_LAYER_LIGHT = 'basemap-light';
export const GIOP_BASEMAP_LAYER_DARK = 'basemap-dark';

type MapStyleInternals = MaplibreMap & {
  style?: {
    sourceCaches?: Record<string, { clearTiles(): void; reload(): void }>;
  };
};

/** Instant, reliable basemap theme — toggle preloaded light/dark raster layers. */
export function setBasemapThemeVisibility(map: MaplibreMap, isLightMode: boolean): void {
  if (map.getLayer(GIOP_BASEMAP_LAYER_LIGHT) && map.getLayer(GIOP_BASEMAP_LAYER_DARK)) {
    map.setLayoutProperty(GIOP_BASEMAP_LAYER_LIGHT, 'visibility', isLightMode ? 'visible' : 'none');
    map.setLayoutProperty(GIOP_BASEMAP_LAYER_DARK, 'visibility', isLightMode ? 'none' : 'visible');
    map.triggerRepaint();
    return;
  }

  // Legacy single-source styles (before dual basemap).
  const basemap = map.getSource('basemap') as RasterTileSource | undefined;
  if (!basemap || typeof basemap.setTiles !== 'function') return;
  const tiles = isLightMode ? GIOP_BASEMAP_TILES.light : GIOP_BASEMAP_TILES.dark;
  basemap.setTiles([...tiles]);
  const cache = (map as MapStyleInternals).style?.sourceCaches?.basemap;
  cache?.clearTiles();
  cache?.reload();
  map.triggerRepaint();
}

/** Map symbol labels — original amber ink for focus, no white halo stroke. */
export function mapSymbolLabelPaint(
  isLightMode: boolean,
  emphasis: 'default' | 'focus' | 'muted' = 'default',
): SymbolPaint {
  if (emphasis === 'focus') {
    return {
      'text-color': GIOP_MAP_FOCUS_LABEL_COLOR,
      'text-halo-color': isLightMode ? '#f8fafc' : '#121212',
      'text-halo-width': 0,
    };
  }
  if (isLightMode) {
    const colors = {
      default: '#1e293b',
      muted: '#475569',
    } as const;
    return {
      'text-color': colors[emphasis === 'muted' ? 'muted' : 'default'],
      'text-halo-color': '#f8fafc',
      'text-halo-width': 0,
    };
  }
  const colors = {
    default: '#BCBCBC',
    muted: '#9A9A9A',
  } as const;
  return {
    'text-color': colors[emphasis === 'muted' ? 'muted' : 'default'],
    'text-halo-color': '#121212',
    'text-halo-width': 0,
  };
}

/** Apply basemap + vector paint after light/dark toggle (safe while style is loaded). */
export function syncGiopMapTheme(map: MaplibreMap, isLightMode: boolean): void {
  setBasemapThemeVisibility(map, isLightMode);
  const applyLinePaint = (layerId: string, dash?: number[]) => {
    if (!map.getLayer(layerId)) return;
    const linePaint = tileLinePaint(isLightMode);
    map.setPaintProperty(layerId, 'line-color', linePaint['line-color']);
    map.setPaintProperty(layerId, 'line-width', linePaint['line-width']);
    map.setPaintProperty(layerId, 'line-opacity', linePaint['line-opacity']);
    if (dash) {
      map.setPaintProperty(layerId, 'line-dasharray', dash);
    } else if (map.getPaintProperty(layerId, 'line-dasharray') != null) {
      map.setPaintProperty(layerId, 'line-dasharray', [1, 0]);
    }
  };
  for (const layerId of ['lines-overhead-mv', 'lines-overhead-lv'] as const) {
    applyLinePaint(layerId);
  }
  for (const layerId of ['lines-underground-mv', 'lines-underground-lv'] as const) {
    applyLinePaint(layerId, UG_LINE_DASH);
  }
  if (map.getLayer('nodes')) {
    const nodePaint = tileNodeCirclePaint(isLightMode);
    map.setPaintProperty('nodes', 'circle-radius', nodePaint['circle-radius']);
    map.setPaintProperty('nodes', 'circle-color', nodePaint['circle-color']);
    map.setPaintProperty('nodes', 'circle-opacity', nodePaint['circle-opacity']);
    map.setPaintProperty('nodes', 'circle-stroke-width', nodePaint['circle-stroke-width']);
    map.setPaintProperty('nodes', 'circle-stroke-color', nodePaint['circle-stroke-color']);
    map.setPaintProperty('nodes', 'circle-stroke-opacity', nodePaint['circle-stroke-opacity']);
  }
  if (map.getLayer('graph-chunk-nodes-layer')) {
    const chunkPaint = chunkNodeCirclePaint(isLightMode);
    for (const key of Object.keys(chunkPaint) as Array<keyof typeof chunkPaint>) {
      map.setPaintProperty('graph-chunk-nodes-layer', key, chunkPaint[key]);
    }
  }
  if (map.getLayer('focus-identify-label')) {
    map.setPaintProperty('focus-identify-label', 'text-color', GIOP_MAP_FOCUS_LABEL_COLOR);
    map.setPaintProperty('focus-identify-label', 'text-halo-width', 0);
  }
  if (map.getLayer('duplicate-cluster-labels')) {
    map.setPaintProperty('duplicate-cluster-labels', 'text-color', GIOP_MAP_FOCUS_LABEL_COLOR);
    map.setPaintProperty('duplicate-cluster-labels', 'text-halo-width', 0);
  }
}

export function applyStagingMapLayersPaint(map: MaplibreMap) {
  if (!map.getLayer('staging-points')) return;
  const paint: CirclePaint = stagingPointCirclePaint();
  for (const key of Object.keys(paint) as Array<keyof CirclePaint>) {
    map.setPaintProperty('staging-points', key, paint[key]);
  }
}

/** Ripple ring frame — phase 0→1 expands outward and fades (no fill blob). */
export function noticeRippleFrame(
  zoom: number,
  phase: number,
  pinRadius: number,
  spreadScale = 1,
): { radius: number; strokeOpacity: number; strokeWidth: number } {
  const baseSpread = zoom < 11 ? 9 : zoom < 14 ? 7 : 5;
  const spread = baseSpread * spreadScale;
  const t = 1 - (1 - phase) ** 2;
  const strokeBase = zoom < 11 ? 1.1 : zoom < 14 ? 1.35 : 1.55;
  return {
    radius: pinRadius + 1.5 + t * spread,
    strokeOpacity: Math.max(0, (1 - phase) * 0.62),
    strokeWidth: strokeBase * (spreadScale > 1 ? 1.2 : 1),
  };
}

export function stagingRipplePinRadius(zoom: number): number {
  return mapNodeRadiusAtZoom(zoom);
}

/** @deprecated Use noticeRippleFrame — kept for any external refs. */
export function noticePinPulseRadiusAtZoom(
  zoom: number,
  phase: number,
  pinRadius: number,
): number {
  return noticeRippleFrame(zoom, phase, pinRadius).radius;
}

/** @deprecated Use noticeRippleFrame */
export function noticePulseOpacityAtZoom(_zoom: number, phase: number): number {
  return Math.max(0, (1 - phase) * 0.62);
}

export function stagingPulseRadiusAtZoom(zoom: number, phase: number): number {
  return noticeRippleFrame(zoom, phase, mapNodeRadiusAtZoom(zoom)).radius;
}

export function stagingPulseOpacityAtZoom(zoom: number, phase: number): number {
  return noticeRippleFrame(zoom, phase, mapNodeRadiusAtZoom(zoom)).strokeOpacity;
}

/** Work-order statuses that still need field attention (pulse halo). */
export const ACTIVE_WORK_ORDER_STATUSES = [
  'DISPATCHED',
  'RECEIVED',
  'ACCEPTED',
  'EN_ROUTE',
  'ON_SITE',
  'IN_PROGRESS',
] as const;

export const WORK_ORDER_PULSE_FILTER: FilterSpecification = [
  'in',
  ['get', 'status'],
  ['literal', [...ACTIVE_WORK_ORDER_STATUSES]],
];

export function applyTileLayerTheme(map: MaplibreMap, isLightMode: boolean) {
  setBasemapThemeVisibility(map, isLightMode);
  const applyLinePaint = (layerId: string, dash?: number[]) => {
    if (!map.getLayer(layerId)) return;
    const linePaint = tileLinePaint(isLightMode);
    map.setPaintProperty(layerId, 'line-color', linePaint['line-color']);
    map.setPaintProperty(layerId, 'line-width', linePaint['line-width']);
    map.setPaintProperty(layerId, 'line-opacity', linePaint['line-opacity']);
    if (dash) {
      map.setPaintProperty(layerId, 'line-dasharray', dash);
    } else if (map.getPaintProperty(layerId, 'line-dasharray') != null) {
      map.setPaintProperty(layerId, 'line-dasharray', [1, 0]);
    }
  };
  for (const layerId of [
    'lines-overhead-mv',
    'lines-overhead-lv',
  ] as const) {
    applyLinePaint(layerId);
  }
  for (const layerId of [
    'lines-underground-mv',
    'lines-underground-lv',
  ] as const) {
    applyLinePaint(layerId, UG_LINE_DASH);
  }
  if (map.getLayer('nodes')) {
    const nodePaint = tileNodeCirclePaint(isLightMode);
    map.setPaintProperty('nodes', 'circle-radius', nodePaint['circle-radius']);
    map.setPaintProperty('nodes', 'circle-color', nodePaint['circle-color']);
    map.setPaintProperty('nodes', 'circle-opacity', nodePaint['circle-opacity']);
    map.setPaintProperty('nodes', 'circle-stroke-width', nodePaint['circle-stroke-width']);
    map.setPaintProperty('nodes', 'circle-stroke-color', nodePaint['circle-stroke-color']);
    map.setPaintProperty('nodes', 'circle-stroke-opacity', nodePaint['circle-stroke-opacity']);
  }
}

export function buildGiopMapStyle(
  martinUrl: string,
  light: boolean,
  options: GiopMapStyleOptions = {},
): StyleSpecification {
  const includeGisOverview = options.includeGisOverview === true;

  const vector = (layer: string) => `${martinUrl}/${layer}/{z}/{x}/{y}`;

  const gisOverviewSources = includeGisOverview
    ? {
        overview_ug_cable_33kv: { type: 'vector' as const, tiles: [vector('ug_cable_33kv')], minzoom: 0, maxzoom: 14 },
        overview_ug_cable_11kv: { type: 'vector' as const, tiles: [vector('ug_cable_11kv')], minzoom: 0, maxzoom: 14 },
        overview_oh_conductor_33kv: {
          type: 'vector' as const,
          tiles: [vector('oh_conductor_33kv')],
          minzoom: OVERVIEW_OH_33_MIN_ZOOM,
          maxzoom: 14,
        },
        overview_oh_conductor_11kv: {
          type: 'vector' as const,
          tiles: [vector('oh_conductor_11kv')],
          minzoom: OVERVIEW_OH_11_MIN_ZOOM,
          maxzoom: 14,
        },
        overview_power_transformer: {
          type: 'vector' as const,
          tiles: [vector('power_transformer')],
          minzoom: MIN_MAP_ZOOM,
          maxzoom: 14,
        },
        overview_distribution_transformer: {
          type: 'vector' as const,
          tiles: [vector('distribution_transformer')],
          minzoom: TRANSFORMER_ICON_MIN_ZOOM,
          maxzoom: 14,
        },
      }
    : {};

  const gisOverviewLayers = (includeGisOverview
    ? [
        {
          id: 'overview-ug-33kv',
          type: 'line',
          source: 'overview_ug_cable_33kv',
          'source-layer': 'ug_cable_33kv',
          maxzoom: NODE_DETAIL_ZOOM,
          filter: overviewLengthFilter(),
          paint: { ...overviewUgLinePaint(SLD_MV_33KV) },
        },
        {
          id: 'overview-ug-11kv',
          type: 'line',
          source: 'overview_ug_cable_11kv',
          'source-layer': 'ug_cable_11kv',
          maxzoom: NODE_DETAIL_ZOOM,
          filter: overviewLengthFilter(),
          paint: { ...overviewUgLinePaint(SLD_MV_11KV) },
        },
        {
          id: 'overview-oh-33kv',
          type: 'line',
          source: 'overview_oh_conductor_33kv',
          'source-layer': 'oh_conductor_33kv',
          minzoom: OVERVIEW_OH_33_MIN_ZOOM,
          maxzoom: NODE_DETAIL_ZOOM,
          filter: overviewLengthFilter(),
          paint: { ...overviewLinePaint(SLD_MV_33KV) },
        },
        {
          id: 'overview-oh-11kv',
          type: 'line',
          source: 'overview_oh_conductor_11kv',
          'source-layer': 'oh_conductor_11kv',
          minzoom: OVERVIEW_OH_11_MIN_ZOOM,
          maxzoom: NODE_DETAIL_ZOOM,
          filter: overviewLengthFilter(),
          paint: { ...overviewLinePaint(SLD_MV_11KV) },
        },
        {
          id: 'overview-transformers',
          type: 'circle',
          source: 'overview_power_transformer',
          'source-layer': 'power_transformer',
          minzoom: MIN_MAP_ZOOM,
          maxzoom: NODE_DETAIL_ZOOM,
          paint: {
            'circle-radius': ['interpolate', ['linear'], ['zoom'], 6, 1.8, 9, 2.2, 11, 3.2, 12, 4],
            'circle-color': light ? '#7c3aed' : '#a78bfa',
            'circle-stroke-width': 1,
            'circle-stroke-color': '#ffffff',
            'circle-opacity': ['interpolate', ['linear'], ['zoom'], 6, 0.6, 10, 0.75, 12, 0.9],
          },
        },
        {
          id: 'nodes-transformers-dt',
          type: 'symbol',
          source: 'overview_distribution_transformer',
          'source-layer': 'distribution_transformer',
          minzoom: TRANSFORMER_ICON_MIN_ZOOM,
          layout: tileTransformerSymbolLayout(),
        },
        {
          id: 'nodes-transformers-pt',
          type: 'symbol',
          source: 'overview_power_transformer',
          'source-layer': 'power_transformer',
          minzoom: TRANSFORMER_ICON_MIN_ZOOM,
          layout: tileTransformerSymbolLayout(),
        },
      ]
    : []) as StyleSpecification['layers'];

  return {
    version: 8,
    glyphs: 'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf',
    sources: {
      'basemap-light': {
        type: 'raster',
        tiles: [...GIOP_BASEMAP_TILES.light],
        tileSize: 256,
        attribution:
          '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
      },
      'basemap-dark': {
        type: 'raster',
        tiles: [...GIOP_BASEMAP_TILES.dark],
        tileSize: 256,
        attribution:
          '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
      },
      ...gisOverviewSources,
      map_connectivity_nodes: {
        type: 'vector',
        tiles: [vector('map_connectivity_nodes')],
        minzoom: 11.5,
        maxzoom: 14,
      },
      map_ac_line_segments: {
        type: 'vector',
        tiles: [vector('map_ac_line_segments')],
        minzoom: NODE_DETAIL_ZOOM,
        maxzoom: 14,
      },
      ecg_admin_boundaries: {
        type: 'vector',
        tiles: [vector('ecg_admin_boundaries')],
        minzoom: 0,
        maxzoom: 14,
      },
      ecg_admin_regions: {
        type: 'vector',
        tiles: [vector('ecg_admin_regions')],
        minzoom: 0,
        maxzoom: 14,
      },
    },
    layers: [
      {
        id: GIOP_BASEMAP_LAYER_LIGHT,
        type: 'raster',
        source: 'basemap-light',
        layout: { visibility: light ? 'visible' : 'none' },
      },
      {
        id: GIOP_BASEMAP_LAYER_DARK,
        type: 'raster',
        source: 'basemap-dark',
        layout: { visibility: light ? 'none' : 'visible' },
      },
      ...gisOverviewLayers,
      {
        id: 'lines-overhead-mv',
        type: 'line',
        source: 'map_ac_line_segments',
        'source-layer': 'map_ac_line_segments',
        minzoom: DETAIL_LINE_MIN_ZOOM,
        filter: tileLineOverheadMvFilter(),
        paint: tileLinePaint(light),
      },
      {
        id: 'lines-underground-mv',
        type: 'line',
        source: 'map_ac_line_segments',
        'source-layer': 'map_ac_line_segments',
        minzoom: DETAIL_LINE_MIN_ZOOM,
        filter: tileLineUndergroundMvFilter(),
        paint: { ...tileLinePaint(light), 'line-dasharray': UG_LINE_DASH },
      },
      {
        id: 'lines-overhead-lv',
        type: 'line',
        source: 'map_ac_line_segments',
        'source-layer': 'map_ac_line_segments',
        minzoom: DETAIL_LINE_MIN_ZOOM,
        filter: tileLineOverheadLvFilter(),
        paint: tileLinePaint(light),
      },
      {
        id: 'lines-underground-lv',
        type: 'line',
        source: 'map_ac_line_segments',
        'source-layer': 'map_ac_line_segments',
        minzoom: DETAIL_LINE_MIN_ZOOM,
        filter: tileLineUndergroundLvFilter(),
        paint: { ...tileLinePaint(light), 'line-dasharray': UG_LINE_DASH },
      },
      {
        id: 'nodes',
        type: 'circle',
        source: 'map_connectivity_nodes',
        'source-layer': 'map_connectivity_nodes',
        minzoom: 11.5,
        paint: tileNodeCirclePaint(light),
      },
      // ECG regions (country/regional zoom) — one outline + label per region.
      {
        id: 'ecg-regions-fill',
        type: 'fill',
        source: 'ecg_admin_regions',
        'source-layer': 'ecg_admin_regions',
        maxzoom: 10,
        layout: { visibility: 'none' },
        paint: {
          'fill-color': light ? '#0ea5e9' : '#38bdf8',
          'fill-opacity': ['interpolate', ['linear'], ['zoom'], 5, 0.04, 7, 0.08, 9, 0.12],
          'fill-antialias': false,
        },
      },
      {
        id: 'ecg-regions-outline',
        type: 'line',
        source: 'ecg_admin_regions',
        'source-layer': 'ecg_admin_regions',
        maxzoom: 10,
        layout: {
          visibility: 'none',
          'line-join': 'round',
          'line-cap': 'round',
        },
        paint: {
          'line-color': light ? '#0369a1' : '#7dd3fc',
          'line-width': ['interpolate', ['linear'], ['zoom'], 5, 0.8, 8, 2, 9, 2.4],
          'line-opacity': ['interpolate', ['linear'], ['zoom'], 5, 0, 6.5, 0.35, 8, 0.75, 9, 0.95],
        },
      },
      {
        id: 'ecg-regions-label',
        type: 'symbol',
        source: 'ecg_admin_regions',
        'source-layer': 'ecg_admin_regions',
        minzoom: 5,
        maxzoom: 10,
        layout: {
          visibility: 'none',
          'text-field': ['get', 'region'],
          'text-size': ['interpolate', ['linear'], ['zoom'], 5, 10, 7, 13, 9, 15],
          'text-font': GIOP_MAP_LABEL_FONT_BOLD,
          'text-anchor': 'center',
          'text-allow-overlap': false,
          'text-ignore-placement': false,
          'text-padding': 4,
          'text-max-width': 8,
        },
        paint: {
          'text-color': light ? '#0c4a6e' : '#e0f2fe',
          'text-halo-color': light ? '#ffffff' : '#0f172a',
          'text-halo-width': 2.5,
          'text-opacity': ['interpolate', ['linear'], ['zoom'], 5, 0.85, 8, 1],
        },
      },
      // ECG districts — visible from zoom 10+ when regional view would be too coarse.
      {
        id: 'ecg-boundaries-fill',
        type: 'fill',
        source: 'ecg_admin_boundaries',
        'source-layer': 'ecg_admin_boundaries',
        minzoom: 10,
        layout: { visibility: 'none' },
        paint: {
          'fill-color': light ? '#0ea5e9' : '#38bdf8',
          'fill-opacity': ['interpolate', ['linear'], ['zoom'], 10, 0.08, 12, 0.14, 13, 0.18],
          'fill-antialias': false,
        },
      },
      {
        id: 'ecg-boundaries-outline',
        type: 'line',
        source: 'ecg_admin_boundaries',
        'source-layer': 'ecg_admin_boundaries',
        minzoom: 10,
        layout: { visibility: 'none' },
        paint: {
          'line-color': light ? '#0369a1' : '#7dd3fc',
          'line-width': ['interpolate', ['linear'], ['zoom'], 10, 1.4, 12, 2.2, 13, 2.8],
          'line-opacity': 0.95,
        },
      },
      {
        id: 'ecg-boundaries-label-district',
        type: 'symbol',
        source: 'ecg_admin_boundaries',
        'source-layer': 'ecg_admin_boundaries',
        minzoom: 10,
        layout: {
          visibility: 'none',
          'text-field': ['get', 'district'],
          'text-size': ['interpolate', ['linear'], ['zoom'], 10, 11, 12, 13, 14, 15],
          'text-font': GIOP_MAP_LABEL_FONT_REGULAR,
          'text-anchor': 'center',
          'text-allow-overlap': false,
          'text-ignore-placement': false,
          'text-padding': 2,
        },
        paint: {
          'text-color': light ? '#0c4a6e' : '#e0f2fe',
          'text-halo-color': light ? '#ffffff' : '#0f172a',
          'text-halo-width': 2,
          'text-opacity': ['interpolate', ['linear'], ['zoom'], 10, 0.9, 12, 1],
        },
      },
    ],
  } as StyleSpecification;
}

export function detailLineColorFromVoltage(voltage?: string | null): string {
  return voltageEdgeColor(voltage);
}

/** MapLibre layer id → zoom range where the layer can render (approximate style min/maxzoom). */
export const GIOP_LAYER_ZOOM_RANGE: Record<string, { min?: number; max?: number }> = {
  'overview-oh-33kv': { min: OVERVIEW_OH_33_MIN_ZOOM, max: NODE_DETAIL_ZOOM },
  'overview-oh-11kv': { min: OVERVIEW_OH_11_MIN_ZOOM, max: NODE_DETAIL_ZOOM },
  'overview-ug-33kv': { min: 0, max: NODE_DETAIL_ZOOM },
  'overview-ug-11kv': { min: 0, max: NODE_DETAIL_ZOOM },
  'overview-transformers': { min: MIN_MAP_ZOOM, max: NODE_DETAIL_ZOOM },
  'lines-overhead-mv': { min: DETAIL_LINE_MIN_ZOOM },
  'lines-underground-mv': { min: DETAIL_LINE_MIN_ZOOM },
  'lines-overhead-lv': { min: DETAIL_LINE_MIN_ZOOM },
  'lines-underground-lv': { min: DETAIL_LINE_MIN_ZOOM },
  nodes: { min: 11.5 },
  'nodes-transformers-dt': { min: TRANSFORMER_ICON_MIN_ZOOM },
  'nodes-transformers-pt': { min: TRANSFORMER_ICON_MIN_ZOOM },
  'graph-chunk-nodes-layer': { min: CHUNK_NODE_MIN_ZOOM, max: NODE_DETAIL_ZOOM },
  'graph-chunk-traced-layer': { min: CHUNK_NODE_MIN_ZOOM, max: NODE_DETAIL_ZOOM },
  'staging-points': { min: 0 },
  'field-technician-halo': { min: 0 },
  'field-technician-points': { min: 0 },
};

export interface GiopLegendGroup {
  id: string;
  label: string;
  color: string;
  layerIds: string[];
  dashed?: boolean;
  icon?: boolean;
  dot?: boolean;
}

export function isGiopLayerAvailableAtZoom(layerId: string, zoom: number): boolean {
  const range = GIOP_LAYER_ZOOM_RANGE[layerId];
  if (!range) return true;
  if (range.min != null && zoom < range.min) return false;
  if (range.max != null && zoom >= range.max) return false;
  return true;
}

export function isGiopLegendGroupAvailableAtZoom(group: GiopLegendGroup, zoom: number): boolean {
  return group.layerIds.some((id) => isGiopLayerAvailableAtZoom(id, zoom));
}

export function buildGiopLegendGroups(
  isLightMode: boolean,
  options: GiopMapStyleOptions = {},
): GiopLegendGroup[] {
  const includeGisOverview = options.includeGisOverview === true;
  const lv = isLightMode ? SLD_LV : '#cbd5e1';
  const groups: GiopLegendGroup[] = [
    {
      id: 'hv-overhead',
      label: '161 kV / HV — overhead',
      color: SLD_HV,
      layerIds: ['lines-overhead-mv', 'lines-underground-mv'],
    },
    {
      id: 'mv-33-overhead',
      label: '33 kV — overhead',
      color: SLD_MV_33KV,
      layerIds: ['overview-oh-33kv', 'lines-overhead-mv'],
    },
    {
      id: 'mv-11-overhead',
      label: '11 kV — overhead',
      color: SLD_MV_11KV,
      layerIds: ['overview-oh-11kv', 'lines-overhead-mv'],
    },
    {
      id: 'lv-overhead',
      label: 'LV — overhead',
      color: lv,
      layerIds: ['lines-overhead-lv'],
    },
    {
      id: 'underground',
      label: 'Underground cable',
      color: SLD_MV_33KV,
      dashed: true,
      layerIds: [
        'overview-ug-33kv',
        'overview-ug-11kv',
        'lines-underground-mv',
        'lines-underground-lv',
      ],
    },
    {
      id: 'transformers',
      label: 'Transformer (DT / PT)',
      color: '#7c3aed',
      icon: true,
      layerIds: ['overview-transformers', 'nodes-transformers-dt', 'nodes-transformers-pt'],
    },
    {
      id: 'poles',
      label: 'Pole / node',
      color: isLightMode ? '#64748b' : '#94a3b8',
      dot: true,
      layerIds: ['nodes', 'graph-chunk-nodes-layer'],
    },
    {
      id: 'staging-pending',
      label: 'Staging / pending',
      color: '#f59e0b',
      dot: true,
      layerIds: ['staging-points'],
    },
    {
      id: 'field-tech',
      label: 'Field technician',
      color: '#22d3ee',
      dot: true,
      layerIds: ['field-technician-halo', 'field-technician-points'],
    },
    {
      id: 'conflict',
      label: 'In conflict',
      color: CONFLICT_NODE_FILL,
      dot: true,
      layerIds: ['graph-chunk-traced-layer'],
    },
  ];

  if (!includeGisOverview) {
    return groups
      .filter((g) => g.id !== 'transformers')
      .map((g) => ({
        ...g,
        layerIds: g.layerIds.filter((id) => !isGisOverviewMapLayer(id)),
      }));
  }

  return groups;
}

export type GiopLegendVisibilityState = Record<string, boolean>;

export function createDefaultGiopLegendVisibility(
  groups: GiopLegendGroup[],
): GiopLegendVisibilityState {
  return Object.fromEntries(groups.map((g) => [g.id, true]));
}

export function isGiopLegendGroupVisible(
  group: GiopLegendGroup,
  state: GiopLegendVisibilityState,
): boolean {
  return state[group.id] !== false;
}

function giopLegendGroupOn(state: GiopLegendVisibilityState, groupId: string): boolean {
  return state[groupId] !== false;
}

function setGiopLayerVisibility(map: MaplibreMap, layerId: string, visible: boolean): void {
  if (!map.getLayer(layerId)) return;
  map.setLayoutProperty(layerId, 'visibility', visible ? 'visible' : 'none');
}

function enabledMvVoltages(state: GiopLegendVisibilityState): string[] {
  const voltages: string[] = [];
  if (giopLegendGroupOn(state, 'hv-overhead')) {
    voltages.push('HV_161KV', 'HV_330KV');
  }
  if (giopLegendGroupOn(state, 'mv-33-overhead')) {
    voltages.push('MV_33KV');
  }
  if (giopLegendGroupOn(state, 'mv-11-overhead')) {
    voltages.push('MV_11KV');
  }
  return voltages;
}

function applySharedMvLineLayer(
  map: MaplibreMap,
  layerId: string,
  baseFilter: LineLayerSpecification['filter'],
  voltages: string[],
  visible: boolean,
): void {
  if (!map.getLayer(layerId)) return;
  if (!visible || voltages.length === 0) {
    map.setLayoutProperty(layerId, 'visibility', 'none');
    return;
  }
  map.setLayoutProperty(layerId, 'visibility', 'visible');
  map.setFilter(
    layerId,
    [
      'all',
      baseFilter!,
      ['in', ['get', 'nominal_voltage'], ['literal', voltages]],
    ] as LineLayerSpecification['filter'],
  );
}

/** Apply legend on/off state; shared MV detail layers use per-voltage filters. */
export function applyGiopLegendVisibility(
  map: MaplibreMap,
  state: GiopLegendVisibilityState,
): void {
  const mvVoltages = enabledMvVoltages(state);
  const undergroundOn = giopLegendGroupOn(state, 'underground');

  applySharedMvLineLayer(
    map,
    'lines-overhead-mv',
    tileLineOverheadMvFilter(),
    mvVoltages,
    mvVoltages.length > 0,
  );
  applySharedMvLineLayer(
    map,
    'lines-underground-mv',
    tileLineUndergroundMvFilter(),
    mvVoltages,
    undergroundOn,
  );

  setGiopLayerVisibility(map, 'overview-oh-33kv', giopLegendGroupOn(state, 'mv-33-overhead'));
  setGiopLayerVisibility(map, 'overview-oh-11kv', giopLegendGroupOn(state, 'mv-11-overhead'));
  setGiopLayerVisibility(map, 'lines-overhead-lv', giopLegendGroupOn(state, 'lv-overhead'));
  setGiopLayerVisibility(map, 'lines-underground-lv', undergroundOn);
  setGiopLayerVisibility(
    map,
    'overview-ug-33kv',
    undergroundOn && giopLegendGroupOn(state, 'mv-33-overhead'),
  );
  setGiopLayerVisibility(
    map,
    'overview-ug-11kv',
    undergroundOn && giopLegendGroupOn(state, 'mv-11-overhead'),
  );

  const exclusiveByGroup: [string, string[]][] = [
    ['transformers', ['overview-transformers', 'nodes-transformers-dt', 'nodes-transformers-pt']],
    ['poles', ['nodes', 'graph-chunk-nodes-layer']],
    ['staging-pending', ['staging-points']],
    ['field-tech', ['field-technician-halo', 'field-technician-points']],
    ['conflict', ['graph-chunk-traced-layer']],
  ];
  for (const [groupId, layerIds] of exclusiveByGroup) {
    const visible = giopLegendGroupOn(state, groupId);
    for (const layerId of layerIds) {
      setGiopLayerVisibility(map, layerId, visible);
    }
  }
}
