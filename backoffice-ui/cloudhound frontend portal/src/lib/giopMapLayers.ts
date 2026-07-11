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
  opts?: { padding?: number; duration?: number; maxZoom?: number; minSpan?: number },
): void {
  const minSpan = opts?.minSpan ?? 0.008;
  let west = bbox.west;
  let south = bbox.south;
  let east = bbox.east;
  let north = bbox.north;
  const lonSpan = east - west;
  const latSpan = north - south;
  if (lonSpan < minSpan || latSpan < minSpan) {
    const cx = (west + east) / 2;
    const cy = (south + north) / 2;
    const halfLon = Math.max(lonSpan / 2, minSpan / 2);
    const halfLat = Math.max(latSpan / 2, minSpan / 2);
    west = cx - halfLon;
    east = cx + halfLon;
    south = cy - halfLat;
    north = cy + halfLat;
  }
  map.fitBounds(
    [
      [west, south],
      [east, north],
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

/** Master detail Martin lines from this zoom (GIS overview covers country/mid zoom). */
export const DETAIL_LINE_MIN_ZOOM = 11;

/** LV service drops from this zoom (MV detail from DETAIL_LINE_MIN_ZOOM). */
export const DETAIL_LV_MIN_ZOOM = 13;

/** Connectivity nodes (~924k) — poles/support from mid detail zoom. */
export const DETAIL_NODE_MIN_ZOOM = 11.5;

/** Martin H3 rebuild coverage (toggle via layout visibility). */
export const H3_REBUILD_COVERAGE_SOURCE = 'h3_rebuild_coverage';

export const H3_COVERAGE_RES_BANDS = [
  { res: 6, minzoom: 0, maxzoom: 9, fillId: 'h3-coverage-fill-r6', outlineId: 'h3-coverage-outline-r6' },
  { res: 7, minzoom: 9, maxzoom: 11, fillId: 'h3-coverage-fill-r7', outlineId: 'h3-coverage-outline-r7' },
  { res: 8, minzoom: 11, maxzoom: 13, fillId: 'h3-coverage-fill-r8', outlineId: 'h3-coverage-outline-r8' },
  { res: 9, minzoom: 13, maxzoom: 22, fillId: 'h3-coverage-fill-r9', outlineId: 'h3-coverage-outline-r9' },
] as const;

export const H3_COVERAGE_LAYER_IDS = H3_COVERAGE_RES_BANDS.flatMap((band) => [
  band.fillId,
  band.outlineId,
]);

export function h3CoverageFillPaint() {
  return {
    'fill-color': [
      'interpolate',
      ['linear'],
      ['get', 'verified_count'],
      0,
      '#64748b',
      1,
      '#fde047',
      10,
      '#84cc16',
      50,
      '#16a34a',
      200,
      '#15803d',
    ],
    'fill-opacity': 0.35,
  } as const;
}

export function h3CoverageOutlinePaint(light: boolean) {
  return {
    'line-color': light ? '#334155' : '#cbd5e1',
    'line-width': 0.5,
    'line-opacity': 0.5,
  } as const;
}

function h3CoverageLayerEntries(light: boolean): StyleSpecification['layers'] {
  const hidden = { visibility: 'none' as const };
  return H3_COVERAGE_RES_BANDS.flatMap(({ res, minzoom, maxzoom, fillId, outlineId }) => [
    {
      id: fillId,
      type: 'fill',
      source: H3_REBUILD_COVERAGE_SOURCE,
      'source-layer': 'h3_rebuild_coverage',
      filter: ['==', ['get', 'resolution'], res],
      minzoom,
      maxzoom,
      layout: hidden,
      paint: { ...h3CoverageFillPaint() },
    },
    {
      id: outlineId,
      type: 'line',
      source: H3_REBUILD_COVERAGE_SOURCE,
      'source-layer': 'h3_rebuild_coverage',
      filter: ['==', ['get', 'resolution'], res],
      minzoom,
      maxzoom,
      layout: hidden,
      paint: { ...h3CoverageOutlinePaint(light) },
    },
  ]) as StyleSpecification['layers'];
}

/** Symbol icons for DT/PT; circles remain for poles and generic nodes. */
export const TRANSFORMER_ICON_MIN_ZOOM = 12;

export const TRANSFORMER_ASSET_KINDS = ['distribution_transformer', 'power_transformer'] as const;

/** Martin/detail node circles — exclude transformers (they use symbol overlay layers). */
export function tileNodeNonTransformerFilter(): FilterSpecification {
  return [
    'all',
    ['!=', ['get', 'asset_kind'], 'distribution_transformer'],
    ['!=', ['get', 'asset_kind'], 'power_transformer'],
  ];
}

export const TRANSFORMER_OVERLAY_LAYER_IDS = [
  'overview-transformers',
  'nodes-transformers-dt',
  'nodes-transformers-pt',
  'master-transformers-dt',
  'master-transformers-pt',
] as const;

/** Insert transformer overlays immediately above detail node circles. */
export const TRANSFORMER_OVERLAY_BEFORE_LAYER = 'ecg-regions-fill';

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
  overview_oh_support_structure_33kv: 'oh_support_structure_33kv',
  overview_oh_support_structure_11kv: 'oh_support_structure_11kv',
  overview_oh_support_structure_lvle: 'oh_support_structure_lvle',
};

/** MapLibre source id → Martin tileset path segment. */
export function martinLayerPath(sourceId: string): string {
  return OVERVIEW_MARTIN_LAYER[sourceId] ?? sourceId;
}

/** Master CIM tile sources (public.map_* views) — always safe on a fresh schema DB. */
export const MARTIN_MASTER_REFRESH_SOURCE_IDS = [
  'map_connectivity_nodes',
  'map_ac_line_segments',
  'map_unpromoted_conductor_segments',
  'map_power_transformers',
  H3_REBUILD_COVERAGE_SOURCE,
] as const;

/** GIS GPKG overview sources — only load when gis.* import tables exist. */
export const MARTIN_GIS_OVERVIEW_REFRESH_SOURCE_IDS = [
  'overview_ug_cable_33kv',
  'overview_ug_cable_11kv',
  'overview_oh_conductor_33kv',
  'overview_oh_conductor_11kv',
  'overview_power_transformer',
  'overview_distribution_transformer',
  'overview_oh_support_structure_33kv',
  'overview_oh_support_structure_11kv',
  'overview_oh_support_structure_lvle',
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

/** GIS GPKG transformer overlays (overview circles + detail symbols). */
export const GIS_TRANSFORMER_LAYER_IDS = [
  'overview-transformers',
  'nodes-transformers-dt',
  'nodes-transformers-pt',
] as const;

/** GIS GPKG support-structure (pole) circles — GIS mode stand-in for master nodes. */
export const GIS_POLE_LAYER_IDS = [
  'overview-poles-33kv',
  'overview-poles-11kv',
  'overview-poles-lv',
] as const;

/** Raw GPKG / GIS import Martin overview layers (country → mid zoom). */
export const GIS_IMPORT_GEOMETRY_LAYER_IDS = [
  'overview-oh-33kv',
  'overview-oh-11kv',
  'overview-ug-33kv',
  'overview-ug-11kv',
  'overview-transformers',
] as const;

/** Promoted master network Martin detail layers (mid → street zoom). */
export const MASTER_NETWORK_LINE_LAYER_IDS = [
  'lines-overhead-mv',
  'lines-underground-mv',
  'lines-overhead-lv',
  'lines-underground-lv',
] as const;

/** Promoted CIM PowerTransformer symbol layers (map_power_transformers). */
export const MASTER_NETWORK_TRANSFORMER_LAYER_IDS = [
  'master-transformers-dt',
  'master-transformers-pt',
] as const;

/** GIS import geometry color (GPKG overview + compare gaps). */
export const GIS_IMPORT_MAGENTA = '#c026d3';

/** GIS segments not yet in master — compare-mode gap layer. */
export const UNPROMOTED_GIS_GAP_LAYER_ID = 'unpromoted-gis-lines' as const;

export const UNPROMOTED_GIS_GAP_LAYER_IDS = [UNPROMOTED_GIS_GAP_LAYER_ID] as const;

/** @deprecated Use GIS_IMPORT_MAGENTA — kept for import-queue highlight styling. */
export const UNPROMOTED_GIS_GAP_CYAN_LIGHT = '#06b6d4';
/** @deprecated Use GIS_IMPORT_MAGENTA */
export const UNPROMOTED_GIS_GAP_CYAN_DARK = '#22d3ee';

/** Same zoom as master detail lines. */
export const UNPROMOTED_GIS_GAP_MIN_ZOOM = DETAIL_LINE_MIN_ZOOM;

/** Detail transformer symbol layers for click/hover (GIS + master). */
export const TRANSFORMER_SYMBOL_LAYER_IDS = [
  'nodes-transformers-dt',
  'nodes-transformers-pt',
  ...MASTER_NETWORK_TRANSFORMER_LAYER_IDS,
] as const;

export type NetworkGeometryMode = 'gis' | 'master' | 'both';

const GEOMETRY_MODE_STORAGE_KEY = 'giop.map.geometryMode.v1';

export function readNetworkGeometryMode(): NetworkGeometryMode {
  try {
    const value = localStorage.getItem(GEOMETRY_MODE_STORAGE_KEY);
    if (value === 'gis' || value === 'master' || value === 'both') return value;
  } catch {
    /* ignore */
  }
  return 'master';
}

export function writeNetworkGeometryMode(mode: NetworkGeometryMode): void {
  try {
    localStorage.setItem(GEOMETRY_MODE_STORAGE_KEY, mode);
  } catch {
    /* ignore */
  }
}

export const NETWORK_GEOMETRY_MODE_META: Record<
  NetworkGeometryMode,
  { label: string; hint: string; swatch: string }
> = {
  gis: {
    label: 'GIS import',
    hint: 'Full GPKG geometry in magenta — raw GIS topology',
    swatch: GIS_IMPORT_MAGENTA,
  },
  master: {
    label: 'Master network',
    hint: 'Promoted CIM lines only — trusted operational topology',
    swatch: '#b91c1c',
  },
  both: {
    label: 'Gaps (compare)',
    hint: 'Master SLD underneath · dashed magenta = GIS not promoted in this view',
    swatch: GIS_IMPORT_MAGENTA,
  },
};

/** Layer maxzoom ceiling (exclusive); 24 = visible through map maxZoom 20. */
export const GIOP_VECTOR_LAYER_MAX_ZOOM = 24;

/** Extend GIS compare gap *layer* visibility through street zoom (tiles overzoom above tile max). */
export const GIS_COMPARE_LAYER_MAX_ZOOM = GIOP_VECTOR_LAYER_MAX_ZOOM;

/** Martin vector tile max zoom — MapLibre overzooms sources above this. */
export const MARTIN_VECTOR_SOURCE_MAX_ZOOM = 16;

/** @deprecated Use GIS_COMPARE_LAYER_MAX_ZOOM for layer maxzoom; tiles still fetch to MARTIN_VECTOR_SOURCE_MAX_ZOOM. */
export const GIS_COMPARE_MAX_ZOOM = MARTIN_VECTOR_SOURCE_MAX_ZOOM;

const GIS_OVERVIEW_LINE_STYLE: Record<
  string,
  { color: string; minzoom: number; underground?: boolean }
> = {
  'overview-oh-33kv': { color: SLD_MV_33KV, minzoom: OVERVIEW_OH_33_MIN_ZOOM },
  'overview-oh-11kv': { color: SLD_MV_11KV, minzoom: OVERVIEW_OH_11_MIN_ZOOM },
  'overview-ug-33kv': { color: SLD_MV_33KV, minzoom: 10, underground: true },
  'overview-ug-11kv': { color: SLD_MV_11KV, minzoom: 10, underground: true },
  'overview-transformers': { color: '#7c3aed', minzoom: MIN_MAP_ZOOM },
};

function applyGisOverviewLinePaint(
  map: MaplibreMap,
  layerId: string,
  style: { color: string; underground?: boolean },
  compare: 'gis' | 'both' | 'default',
): void {
  if (!map.getLayer(layerId)) return;
  if (compare === 'default') {
    const paint = style.underground
      ? overviewUgLinePaint(style.color)
      : overviewLinePaint(style.color);
    map.setPaintProperty(layerId, 'line-color', paint['line-color']);
    map.setPaintProperty(layerId, 'line-width', paint['line-width']);
    map.setPaintProperty(layerId, 'line-opacity', paint['line-opacity']);
    if (style.underground) {
      map.setPaintProperty(layerId, 'line-dasharray', UG_LINE_DASH);
    } else {
      map.setPaintProperty(layerId, 'line-dasharray', [1, 0]);
    }
    return;
  }

  const importPaint = gisImportLinePaint();
  const basePaint = style.underground
    ? overviewUgLinePaint(style.color)
    : overviewLinePaint(style.color);
  map.setPaintProperty(layerId, 'line-color', importPaint['line-color']);
  // Match SLD overview stroke — same weight as master country/mid zoom, not thick magenta.
  map.setPaintProperty(layerId, 'line-width', basePaint['line-width']);
  map.setPaintProperty(layerId, 'line-opacity', basePaint['line-opacity']);
  if (style.underground) {
    map.setPaintProperty(layerId, 'line-dasharray', [2, 1.5]);
  } else {
    map.setPaintProperty(layerId, 'line-dasharray', [1, 0]);
  }
}

function applyGisOverviewZoomRange(
  map: MaplibreMap,
  mode: NetworkGeometryMode,
  gisOk: boolean,
): void {
  const extend = gisOk && mode === 'gis';
  const maxZoom = extend ? GIOP_VECTOR_LAYER_MAX_ZOOM : NODE_DETAIL_ZOOM;
  for (const layerId of GIS_IMPORT_GEOMETRY_LAYER_IDS) {
    if (!map.getLayer(layerId)) continue;
    const spec = GIS_OVERVIEW_LINE_STYLE[layerId];
    const minZoom = spec?.minzoom ?? MIN_MAP_ZOOM;
    map.setLayerZoomRange(layerId, minZoom, maxZoom);
  }
  for (const layerId of GIS_POLE_LAYER_IDS) {
    if (!map.getLayer(layerId)) continue;
    map.setLayerZoomRange(layerId, DETAIL_NODE_MIN_ZOOM, maxZoom);
  }
}

function applyUnpromotedGapZoomRange(map: MaplibreMap, mode: NetworkGeometryMode): void {
  if (!map.getLayer(UNPROMOTED_GIS_GAP_LAYER_ID)) return;
  const maxZoom = mode === 'both' ? GIS_COMPARE_LAYER_MAX_ZOOM : NODE_DETAIL_ZOOM;
  map.setLayerZoomRange(UNPROMOTED_GIS_GAP_LAYER_ID, UNPROMOTED_GIS_GAP_MIN_ZOOM, maxZoom);
}

/** Magenta GIS import lines (full GPKG overview). */
export function gisImportLinePaint() {
  return {
    'line-color': GIS_IMPORT_MAGENTA,
    'line-width': TILE_LINE_WIDTH,
    'line-opacity': TILE_LINE_OPACITY,
  } as const;
}

/** Compare-mode gaps only — dashed magenta, same weight as master. */
export function unpromotedGapLinePaint(_light: boolean) {
  return {
    ...gisImportLinePaint(),
    'line-dasharray': [2.5, 1.5] as [number, number],
  } as const;
}

function isCountryScaleZoom(zoom: number): boolean {
  return zoom < DETAIL_LINE_MIN_ZOOM;
}

function applyNetworkGeometryModeOverride(
  map: MaplibreMap,
  mode: NetworkGeometryMode,
  options?: { gisOverviewAvailable?: boolean },
): void {
  const gisOk = options?.gisOverviewAvailable !== false;
  const showFullGis = gisOk && mode === 'gis';
  const countryScale = isCountryScaleZoom(map.getZoom());

  applyGisOverviewZoomRange(map, mode, gisOk);
  applyUnpromotedGapZoomRange(map, mode);

  for (const layerId of GIS_IMPORT_GEOMETRY_LAYER_IDS) {
    const spec = GIS_OVERVIEW_LINE_STYLE[layerId];
    if (spec && layerId !== 'overview-transformers') {
      applyGisOverviewLinePaint(
        map,
        layerId,
        spec,
        showFullGis ? 'gis' : 'default',
      );
    }
  }

  const showGapInBoth =
    mode === 'both'
    && !countryScale
    && Boolean(map.getLayer(UNPROMOTED_GIS_GAP_LAYER_ID));

  if (!showGapInBoth) {
    setGiopLayerVisibility(map, UNPROMOTED_GIS_GAP_LAYER_ID, false);
  }

  if (mode === 'gis' && gisOk) {
    for (const layerId of GIS_IMPORT_GEOMETRY_LAYER_IDS) {
      setGiopLayerVisibility(map, layerId, true);
    }
    for (const layerId of GIS_TRANSFORMER_LAYER_IDS) {
      if (layerId === 'overview-transformers') continue;
      setGiopLayerVisibility(map, layerId, true);
    }
    for (const layerId of GIS_POLE_LAYER_IDS) {
      setGiopLayerVisibility(map, layerId, true);
    }
    for (const layerId of MASTER_NETWORK_LINE_LAYER_IDS) {
      setGiopLayerVisibility(map, layerId, false);
    }
    for (const layerId of MASTER_NETWORK_TRANSFORMER_LAYER_IDS) {
      setGiopLayerVisibility(map, layerId, false);
    }
    // Master connectivity nodes do not align with raw GIS geometry — use GIS poles.
    setGiopLayerVisibility(map, 'nodes', false);
    setGiopLayerVisibility(map, UNPROMOTED_GIS_GAP_LAYER_ID, false);
    return;
  }

  if (mode === 'master') {
    if (!countryScale) {
      for (const layerId of GIS_IMPORT_GEOMETRY_LAYER_IDS) {
        setGiopLayerVisibility(map, layerId, false);
      }
      for (const layerId of GIS_TRANSFORMER_LAYER_IDS) {
        setGiopLayerVisibility(map, layerId, false);
      }
      for (const layerId of GIS_POLE_LAYER_IDS) {
        setGiopLayerVisibility(map, layerId, false);
      }
    }
    setGiopLayerVisibility(map, UNPROMOTED_GIS_GAP_LAYER_ID, false);
    return;
  }

  if (mode === 'both') {
    if (!countryScale) {
      for (const layerId of GIS_IMPORT_GEOMETRY_LAYER_IDS) {
        setGiopLayerVisibility(map, layerId, false);
      }
      for (const layerId of GIS_TRANSFORMER_LAYER_IDS) {
        setGiopLayerVisibility(map, layerId, false);
      }
      for (const layerId of GIS_POLE_LAYER_IDS) {
        setGiopLayerVisibility(map, layerId, false);
      }
    }
    setGiopLayerVisibility(
      map,
      UNPROMOTED_GIS_GAP_LAYER_ID,
      Boolean(map.getLayer(UNPROMOTED_GIS_GAP_LAYER_ID)),
    );
    return;
  }
}

/** Attach optional gap tiles and apply master/gis/both visibility rules. */
export function syncNetworkGeometryModeOnMap(
  map: MaplibreMap,
  mode: NetworkGeometryMode,
  options?: { gisOverviewAvailable?: boolean; light?: boolean; martinUrl?: string },
): void {
  const gisOk = options?.gisOverviewAvailable !== false;
  const countryScale = isCountryScaleZoom(map.getZoom());

  if (options?.martinUrl && gisOk) {
    if (mode === 'gis' || countryScale) {
      ensureGisOverviewOnMap(map, options.martinUrl, options.light ?? true);
    }
    if (mode === 'both') {
      ensureUnpromotedGapOnMap(map, options.martinUrl, options.light ?? true);
    }
  }
  applyNetworkGeometryModeOverride(map, mode, {
    gisOverviewAvailable: options?.gisOverviewAvailable,
  });
}

export function overviewLinePaint(color: string) {
  return {
    'line-color': color,
    'line-width': ['interpolate', ['linear'], ['zoom'], 6, 0.92, 7, 1.02, 9, 1.2, 11, 1.45, 12, 1.5],
    'line-opacity': ['interpolate', ['linear'], ['zoom'], 6, 0.74, 8, 0.8, 10, 0.84, 12, 0.82],
  } as const;
}

export function overviewUgLinePaint(color: string) {
  return {
    ...overviewLinePaint(color),
    'line-dasharray': UG_LINE_DASH,
  } as const;
}

export function overviewLengthFilter(): LineLayerSpecification['filter'] {
  return [
    '<',
    ['coalesce', ['get', 'length_m'], ['get', 'length_in_meters'], 0],
    MAX_OVERVIEW_LENGTH_M,
  ];
}

type TileLinePaint = Required<Pick<NonNullable<LineLayerSpecification['paint']>, 'line-color' | 'line-width' | 'line-opacity'>>;
type TileNodePaint = Required<Pick<NonNullable<CircleLayerSpecification['paint']>, 'circle-radius' | 'circle-color' | 'circle-opacity' | 'circle-stroke-width' | 'circle-stroke-color' | 'circle-stroke-opacity'>>;

const LV_VOLTAGE_FILTER: ['in', ['get', string], ['literal', string[]]] = [
  'in',
  ['get', 'nominal_voltage'],
  ['literal', ['LV_230V', 'LV_400V']],
];

const TILE_LINE_WIDTH: NonNullable<LineLayerSpecification['paint']>['line-width'] = [
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
    1.2,
  ],
  13,
  [
    'match',
    ['get', 'nominal_voltage'],
    'HV_161KV',
    3,
    'HV_330KV',
    3,
    'MV_33KV',
    1.8,
    'MV_11KV',
    1.4,
    1.2,
  ],
  14,
  [
    'match',
    ['get', 'nominal_voltage'],
    'HV_161KV',
    2.8,
    'HV_330KV',
    2.8,
    'MV_33KV',
    1.5,
    'MV_11KV',
    1.2,
    1.1,
  ],
  15,
  [
    'match',
    ['get', 'nominal_voltage'],
    'HV_161KV',
    2.4,
    'HV_330KV',
    2.4,
    'MV_33KV',
    1.55,
    'MV_11KV',
    1.25,
    1,
  ],
  17,
  [
    'match',
    ['get', 'nominal_voltage'],
    'HV_161KV',
    2.1,
    'HV_330KV',
    2.1,
    'MV_33KV',
    1.35,
    'MV_11KV',
    1.1,
    0.9,
  ],
];

const TILE_LINE_OPACITY: NonNullable<LineLayerSpecification['paint']>['line-opacity'] = [
  'interpolate',
  ['linear'],
  ['zoom'],
  11,
  0.72,
  12,
  0.85,
  14,
  0.9,
  15,
  0.94,
  16,
  0.92,
  18,
  0.88,
];

/** Detail Martin MV/HV lines — LV uses dedicated layers below. */
export function tileLinePaint(light: boolean): TileLinePaint {
  const fallback = light ? '#64748b' : '#94a3b8';
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
      fallback,
    ],
    'line-width': TILE_LINE_WIDTH,
    'line-opacity': TILE_LINE_OPACITY,
  };
}

/** Overhead LV — thin black mesh; MV/HV stay visually dominant at street zoom. */
export function tileLineLvOverheadPaint(light: boolean): TileLinePaint {
  const color = light ? SLD_LV : '#cbd5e1';
  return {
    'line-color': color,
    'line-width': ['interpolate', ['linear'], ['zoom'], 13, 0.5, 14, 0.55, 15, 0.6, 16, 0.65, 18, 0.75],
    'line-opacity': 0.65,
  };
}

/** Underground LV — lighter dash than MV UG. */
export function tileLineLvUndergroundPaint(light: boolean): TileLinePaint {
  const color = light ? '#475569' : '#64748b';
  return {
    'line-color': color,
    'line-width': ['interpolate', ['linear'], ['zoom'], 14, 0.5, 16, 0.85, 18, 1.1],
    'line-opacity': ['interpolate', ['linear'], ['zoom'], 14, 0.28, 16, 0.5, 18, 0.72],
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

/** Copilot tentative node pick — amber so the user can confirm or correct. */
export function focusTentativeCirclePaint(): CirclePaint {
  return {
    'circle-radius': radiusExpressionFromStops(MAP_NODE_RADIUS_STOPS),
    'circle-color': '#f59e0b',
    'circle-opacity': 0.95,
    'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 6, 0.65, 11, 1, 14, 1.35, 18, 1.7],
    'circle-stroke-color': '#ffffff',
  };
}

type SymbolPaint = NonNullable<SymbolLayerSpecification['paint']>;

/** Carto basemap tile URLs — base without labels; label overlay sits above network lines. */
export const GIOP_BASEMAP_TILES = {
  light: ['https://basemaps.cartocdn.com/light_nolabels/{z}/{x}/{y}.png'],
  dark: ['https://basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}.png'],
  lightLabels: ['https://basemaps.cartocdn.com/light_only_labels/{z}/{x}/{y}.png'],
  darkLabels: ['https://basemaps.cartocdn.com/dark_only_labels/{z}/{x}/{y}.png'],
} as const;

/**
 * Native basemap detail stops here. Beyond this zoom MapLibre overzooms the last
 * tiles so road casings scale up with the map instead of staying hairline-thin
 * (Carto redraws streets as thin strokes at every z-level).
 * 18 keeps overzoom mild at map max (z20) so tiles stay usable for site work.
 */
export const GIOP_BASEMAP_NATIVE_MAX_ZOOM = 18;

/**
 * Street/place-name raster labels hide past this zoom so names do not blow up
 * into unreadable blobs during close-in measuring / planning.
 */
export const GIOP_BASEMAP_LABELS_MAX_ZOOM = 16;

/** Side-map / duplicate fan asset name labels — amber ink, no halo stroke. */
export const GIOP_MAP_FOCUS_LABEL_COLOR = '#b45309';

export const GIOP_BASEMAP_LAYER_LIGHT = 'basemap-light';
export const GIOP_BASEMAP_LAYER_DARK = 'basemap-dark';
export const GIOP_BASEMAP_LABELS_LAYER_LIGHT = 'basemap-labels-light';
export const GIOP_BASEMAP_LABELS_LAYER_DARK = 'basemap-labels-dark';

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
    if (map.getLayer(GIOP_BASEMAP_LABELS_LAYER_LIGHT) && map.getLayer(GIOP_BASEMAP_LABELS_LAYER_DARK)) {
      map.setLayoutProperty(
        GIOP_BASEMAP_LABELS_LAYER_LIGHT,
        'visibility',
        isLightMode ? 'visible' : 'none',
      );
      map.setLayoutProperty(
        GIOP_BASEMAP_LABELS_LAYER_DARK,
        'visibility',
        isLightMode ? 'none' : 'visible',
      );
    }
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
  const applyLvOverheadPaint = (layerId: string) => {
    if (!map.getLayer(layerId)) return;
    const linePaint = tileLineLvOverheadPaint(isLightMode);
    map.setPaintProperty(layerId, 'line-color', linePaint['line-color']);
    map.setPaintProperty(layerId, 'line-width', linePaint['line-width']);
    map.setPaintProperty(layerId, 'line-opacity', linePaint['line-opacity']);
    map.setPaintProperty(layerId, 'line-dasharray', [1, 0]);
  };
  const applyLvUndergroundPaint = (layerId: string) => {
    if (!map.getLayer(layerId)) return;
    const linePaint = tileLineLvUndergroundPaint(isLightMode);
    map.setPaintProperty(layerId, 'line-color', linePaint['line-color']);
    map.setPaintProperty(layerId, 'line-width', linePaint['line-width']);
    map.setPaintProperty(layerId, 'line-opacity', linePaint['line-opacity']);
    map.setPaintProperty(layerId, 'line-dasharray', UG_LINE_DASH);
  };
  applyLinePaint('lines-overhead-mv');
  applyLinePaint('lines-underground-mv', UG_LINE_DASH);
  for (const layerId of ['lines-overhead-lv'] as const) {
    applyLvOverheadPaint(layerId);
  }
  applyLvUndergroundPaint('lines-underground-lv');
  if (map.getLayer(UNPROMOTED_GIS_GAP_LAYER_ID)) {
    const gapPaint = unpromotedGapLinePaint(isLightMode);
    for (const key of Object.keys(gapPaint) as Array<keyof typeof gapPaint>) {
      map.setPaintProperty(UNPROMOTED_GIS_GAP_LAYER_ID, key, gapPaint[key]);
    }
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
  for (const layerId of GIS_POLE_LAYER_IDS) {
    if (!map.getLayer(layerId)) continue;
    const nodePaint = tileNodeCirclePaint(isLightMode);
    map.setPaintProperty(layerId, 'circle-radius', nodePaint['circle-radius']);
    map.setPaintProperty(layerId, 'circle-color', nodePaint['circle-color']);
    map.setPaintProperty(layerId, 'circle-opacity', nodePaint['circle-opacity']);
    map.setPaintProperty(layerId, 'circle-stroke-width', nodePaint['circle-stroke-width']);
    map.setPaintProperty(layerId, 'circle-stroke-color', nodePaint['circle-stroke-color']);
    map.setPaintProperty(layerId, 'circle-stroke-opacity', nodePaint['circle-stroke-opacity']);
  }
  for (const band of H3_COVERAGE_RES_BANDS) {
    if (map.getLayer(band.outlineId)) {
      const outlinePaint = h3CoverageOutlinePaint(isLightMode);
      map.setPaintProperty(band.outlineId, 'line-color', outlinePaint['line-color']);
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
  const applyLvOverheadPaint = (layerId: string) => {
    if (!map.getLayer(layerId)) return;
    const linePaint = tileLineLvOverheadPaint(isLightMode);
    map.setPaintProperty(layerId, 'line-color', linePaint['line-color']);
    map.setPaintProperty(layerId, 'line-width', linePaint['line-width']);
    map.setPaintProperty(layerId, 'line-opacity', linePaint['line-opacity']);
    map.setPaintProperty(layerId, 'line-dasharray', [1, 0]);
  };
  const applyLvUndergroundPaint = (layerId: string) => {
    if (!map.getLayer(layerId)) return;
    const linePaint = tileLineLvUndergroundPaint(isLightMode);
    map.setPaintProperty(layerId, 'line-color', linePaint['line-color']);
    map.setPaintProperty(layerId, 'line-width', linePaint['line-width']);
    map.setPaintProperty(layerId, 'line-opacity', linePaint['line-opacity']);
    map.setPaintProperty(layerId, 'line-dasharray', UG_LINE_DASH);
  };
  applyLinePaint('lines-overhead-mv');
  applyLinePaint('lines-underground-mv', UG_LINE_DASH);
  for (const layerId of ['lines-overhead-lv'] as const) {
    applyLvOverheadPaint(layerId);
  }
  applyLvUndergroundPaint('lines-underground-lv');
  if (map.getLayer('nodes')) {
    const nodePaint = tileNodeCirclePaint(isLightMode);
    map.setPaintProperty('nodes', 'circle-radius', nodePaint['circle-radius']);
    map.setPaintProperty('nodes', 'circle-color', nodePaint['circle-color']);
    map.setPaintProperty('nodes', 'circle-opacity', nodePaint['circle-opacity']);
    map.setPaintProperty('nodes', 'circle-stroke-width', nodePaint['circle-stroke-width']);
    map.setPaintProperty('nodes', 'circle-stroke-color', nodePaint['circle-stroke-color']);
    map.setPaintProperty('nodes', 'circle-stroke-opacity', nodePaint['circle-stroke-opacity']);
  }
  for (const layerId of GIS_POLE_LAYER_IDS) {
    if (!map.getLayer(layerId)) continue;
    const nodePaint = tileNodeCirclePaint(isLightMode);
    map.setPaintProperty(layerId, 'circle-radius', nodePaint['circle-radius']);
    map.setPaintProperty(layerId, 'circle-color', nodePaint['circle-color']);
    map.setPaintProperty(layerId, 'circle-stroke-width', nodePaint['circle-stroke-width']);
    map.setPaintProperty(layerId, 'circle-stroke-color', nodePaint['circle-stroke-color']);
    map.setPaintProperty(layerId, 'circle-opacity', nodePaint['circle-opacity']);
    map.setPaintProperty(layerId, 'circle-stroke-opacity', nodePaint['circle-stroke-opacity']);
  }
}

const GIS_OVERVIEW_BEFORE_LAYER = 'lines-overhead-mv';

function martinVectorSource(
  martinUrl: string,
  layer: string,
  minzoom: number,
  maxzoom = 14,
): { type: 'vector'; tiles: string[]; minzoom: number; maxzoom: number } {
  return {
    type: 'vector',
    tiles: [`${martinUrl}/${layer}/{z}/{x}/{y}`],
    minzoom,
    maxzoom,
  };
}

function gisOverviewSourceEntries(martinUrl: string): Record<string, ReturnType<typeof martinVectorSource>> {
  const maxZoom = MARTIN_VECTOR_SOURCE_MAX_ZOOM;
  return {
    overview_ug_cable_33kv: martinVectorSource(martinUrl, 'ug_cable_33kv', 10, maxZoom),
    overview_ug_cable_11kv: martinVectorSource(martinUrl, 'ug_cable_11kv', 10, maxZoom),
    overview_oh_conductor_33kv: martinVectorSource(
      martinUrl,
      'oh_conductor_33kv',
      OVERVIEW_OH_33_MIN_ZOOM,
      maxZoom,
    ),
    overview_oh_conductor_11kv: martinVectorSource(
      martinUrl,
      'oh_conductor_11kv',
      OVERVIEW_OH_11_MIN_ZOOM,
      maxZoom,
    ),
    overview_power_transformer: martinVectorSource(martinUrl, 'power_transformer', MIN_MAP_ZOOM, maxZoom),
    overview_distribution_transformer: martinVectorSource(
      martinUrl,
      'distribution_transformer',
      TRANSFORMER_ICON_MIN_ZOOM,
      maxZoom,
    ),
    overview_oh_support_structure_33kv: martinVectorSource(
      martinUrl,
      'oh_support_structure_33kv',
      DETAIL_NODE_MIN_ZOOM,
      maxZoom,
    ),
    overview_oh_support_structure_11kv: martinVectorSource(
      martinUrl,
      'oh_support_structure_11kv',
      DETAIL_NODE_MIN_ZOOM,
      maxZoom,
    ),
    overview_oh_support_structure_lvle: martinVectorSource(
      martinUrl,
      'oh_support_structure_lvle',
      DETAIL_NODE_MIN_ZOOM,
      maxZoom,
    ),
  };
}

/** Whether the cyan GIS gap layer is on the map style. */
export function unpromotedGapOnMap(map: MaplibreMap): boolean {
  return Boolean(map.getLayer(UNPROMOTED_GIS_GAP_LAYER_ID));
}

function unpromotedGapLayerEntry(light: boolean): StyleSpecification['layers'] {
  return [
    {
      id: UNPROMOTED_GIS_GAP_LAYER_ID,
      type: 'line',
      source: 'map_unpromoted_conductor_segments',
      'source-layer': 'map_unpromoted_conductor_segments',
      minzoom: UNPROMOTED_GIS_GAP_MIN_ZOOM,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: unpromotedGapLinePaint(light),
    },
  ] as StyleSpecification['layers'];
}

/** Keep dashed gap strokes above master SLD lines (below nodes). */
function pinUnpromotedGapAboveMasterLines(map: MaplibreMap): void {
  if (!map.getLayer(UNPROMOTED_GIS_GAP_LAYER_ID)) return;
  const anchor = map.getLayer('nodes') ? 'nodes' : undefined;
  if (!anchor) return;
  try {
    map.moveLayer(UNPROMOTED_GIS_GAP_LAYER_ID, anchor);
  } catch {
    /* style may be mid-update */
  }
}

/**
 * Attach unpromoted-only Martin layer (Both mode). No-ops when anchor layers missing.
 */
export function ensureUnpromotedGapOnMap(map: MaplibreMap, martinUrl: string, light: boolean): boolean {
  if (!map.getLayer('lines-overhead-mv')) return false;

  const sourceId = 'map_unpromoted_conductor_segments';
  if (!map.getSource(sourceId)) {
    map.addSource(
      sourceId,
      martinVectorSource(
        martinUrl,
        'map_unpromoted_conductor_segments',
        UNPROMOTED_GIS_GAP_MIN_ZOOM,
        MARTIN_VECTOR_SOURCE_MAX_ZOOM,
      ),
    );
  }

  if (!unpromotedGapOnMap(map)) {
    for (const layer of unpromotedGapLayerEntry(light)) {
      if (!map.getLayer(layer.id)) {
        map.addLayer(layer, 'nodes');
      }
    }
  } else {
    const gapPaint = unpromotedGapLinePaint(light);
    for (const key of Object.keys(gapPaint) as Array<keyof typeof gapPaint>) {
      map.setPaintProperty(UNPROMOTED_GIS_GAP_LAYER_ID, key, gapPaint[key]);
    }
  }

  pinUnpromotedGapAboveMasterLines(map);
  applyUnpromotedGapZoomRange(map, 'both');
  return unpromotedGapOnMap(map);
}

function gisOverviewConductorLayerEntries(light: boolean): StyleSpecification['layers'] {
  return [
    {
      id: 'overview-ug-33kv',
      type: 'line',
      source: 'overview_ug_cable_33kv',
      'source-layer': 'ug_cable_33kv',
      minzoom: 10,
      maxzoom: NODE_DETAIL_ZOOM,
      filter: overviewLengthFilter(),
      paint: { ...overviewUgLinePaint(SLD_MV_33KV) },
    },
    {
      id: 'overview-ug-11kv',
      type: 'line',
      source: 'overview_ug_cable_11kv',
      'source-layer': 'ug_cable_11kv',
      minzoom: 10,
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
  ] as StyleSpecification['layers'];
}

function gisOverviewPoleLayerEntries(light: boolean): StyleSpecification['layers'] {
  const paint = tileNodeCirclePaint(light);
  return [
    {
      id: 'overview-poles-33kv',
      type: 'circle',
      source: 'overview_oh_support_structure_33kv',
      'source-layer': 'oh_support_structure_33kv',
      minzoom: DETAIL_NODE_MIN_ZOOM,
      maxzoom: NODE_DETAIL_ZOOM,
      paint: { ...paint },
    },
    {
      id: 'overview-poles-11kv',
      type: 'circle',
      source: 'overview_oh_support_structure_11kv',
      'source-layer': 'oh_support_structure_11kv',
      minzoom: DETAIL_NODE_MIN_ZOOM,
      maxzoom: NODE_DETAIL_ZOOM,
      paint: { ...paint },
    },
    {
      id: 'overview-poles-lv',
      type: 'circle',
      source: 'overview_oh_support_structure_lvle',
      'source-layer': 'oh_support_structure_lvle',
      minzoom: DETAIL_NODE_MIN_ZOOM,
      maxzoom: NODE_DETAIL_ZOOM,
      paint: { ...paint },
    },
  ] as StyleSpecification['layers'];
}

function gisOverviewTransformerLayerEntries(light: boolean): StyleSpecification['layers'] {
  return [
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
  ] as StyleSpecification['layers'];
}

function masterTransformerLayerEntries(): StyleSpecification['layers'] {
  return [
    {
      id: 'master-transformers-dt',
      type: 'symbol',
      source: 'map_power_transformers',
      'source-layer': 'map_power_transformers',
      minzoom: TRANSFORMER_ICON_MIN_ZOOM,
      filter: ['==', ['get', 'transformer_kind'], 'distribution'],
      layout: tileTransformerSymbolLayout(),
    },
    {
      id: 'master-transformers-pt',
      type: 'symbol',
      source: 'map_power_transformers',
      'source-layer': 'map_power_transformers',
      minzoom: TRANSFORMER_ICON_MIN_ZOOM,
      filter: ['==', ['get', 'transformer_kind'], 'power'],
      layout: tileTransformerSymbolLayout(),
    },
  ] as StyleSpecification['layers'];
}

function gisOverviewLayerEntries(light: boolean): StyleSpecification['layers'] {
  return [
    ...gisOverviewConductorLayerEntries(light),
    ...gisOverviewPoleLayerEntries(light),
    ...gisOverviewTransformerLayerEntries(light),
  ] as StyleSpecification['layers'];
}

/** Keep purple transformer/feeder glyphs above generic node circles. */
export function pinTransformerLayersAboveNodes(map: MaplibreMap): void {
  if (!map.getLayer('nodes')) return;
  const anchor = map.getLayer(TRANSFORMER_OVERLAY_BEFORE_LAYER)
    ? TRANSFORMER_OVERLAY_BEFORE_LAYER
    : undefined;
  try {
    for (const id of [...TRANSFORMER_OVERLAY_LAYER_IDS].reverse()) {
      if (map.getLayer(id)) {
        if (anchor) map.moveLayer(id, anchor);
      }
    }
  } catch {
    /* style may be mid-reload */
  }
}

/** Whether country/mid-zoom GIS overview layers are on the map style. */
export function gisOverviewOnMap(map: MaplibreMap): boolean {
  return Boolean(map.getLayer('overview-oh-11kv'));
}

/**
 * Attach GIS overview sources/layers when zoomed out past detail tiles.
 * Safe to call repeatedly; no-ops when already present or detail anchor missing.
 */
export function ensureGisOverviewOnMap(map: MaplibreMap, martinUrl: string, light: boolean): boolean {
  if (gisOverviewOnMap(map)) return true;
  if (!map.getLayer(GIS_OVERVIEW_BEFORE_LAYER)) return false;

  for (const [sourceId, spec] of Object.entries(gisOverviewSourceEntries(martinUrl))) {
    if (!map.getSource(sourceId)) {
      map.addSource(sourceId, spec);
    }
  }
  for (const layer of gisOverviewConductorLayerEntries(light)) {
    if (!map.getLayer(layer.id)) {
      map.addLayer(layer, GIS_OVERVIEW_BEFORE_LAYER);
    }
  }
  for (const layer of gisOverviewPoleLayerEntries(light)) {
    if (!map.getLayer(layer.id)) {
      const before = map.getLayer('nodes') ? 'nodes' : GIS_OVERVIEW_BEFORE_LAYER;
      map.addLayer(layer, before);
    }
  }
  for (const layer of gisOverviewTransformerLayerEntries(light)) {
    if (!map.getLayer(layer.id)) {
      const before = map.getLayer(TRANSFORMER_OVERLAY_BEFORE_LAYER)
        ? TRANSFORMER_OVERLAY_BEFORE_LAYER
        : GIS_OVERVIEW_BEFORE_LAYER;
      map.addLayer(layer, before);
    }
  }
  pinTransformerLayersAboveNodes(map);
  return gisOverviewOnMap(map);
}

export function buildGiopMapStyle(
  martinUrl: string,
  light: boolean,
  options: GiopMapStyleOptions = {},
): StyleSpecification {
  const includeGisOverview = options.includeGisOverview === true;

  const vector = (layer: string) => `${martinUrl}/${layer}/{z}/{x}/{y}`;

  const gisOverviewSources = includeGisOverview ? gisOverviewSourceEntries(martinUrl) : {};
  const gisOverviewConductorLayers = (includeGisOverview
    ? gisOverviewConductorLayerEntries(light)
    : []) as StyleSpecification['layers'];
  const gisOverviewPoleLayers = (includeGisOverview
    ? gisOverviewPoleLayerEntries(light)
    : []) as StyleSpecification['layers'];
  const gisOverviewTransformerLayers = (includeGisOverview
    ? gisOverviewTransformerLayerEntries(light)
    : []) as StyleSpecification['layers'];

  return {
    version: 8,
    glyphs: 'https://fonts.openmaptiles.org/{fontstack}/{range}.pbf',
    sources: {
      'basemap-light': {
        type: 'raster',
        tiles: [...GIOP_BASEMAP_TILES.light],
        tileSize: 256,
        maxzoom: GIOP_BASEMAP_NATIVE_MAX_ZOOM,
        attribution:
          '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
      },
      'basemap-dark': {
        type: 'raster',
        tiles: [...GIOP_BASEMAP_TILES.dark],
        tileSize: 256,
        maxzoom: GIOP_BASEMAP_NATIVE_MAX_ZOOM,
        attribution:
          '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
      },
      'basemap-labels-light': {
        type: 'raster',
        tiles: [...GIOP_BASEMAP_TILES.lightLabels],
        tileSize: 256,
        maxzoom: GIOP_BASEMAP_NATIVE_MAX_ZOOM,
      },
      'basemap-labels-dark': {
        type: 'raster',
        tiles: [...GIOP_BASEMAP_TILES.darkLabels],
        tileSize: 256,
        maxzoom: GIOP_BASEMAP_NATIVE_MAX_ZOOM,
      },
      ...gisOverviewSources,
      // Source min/maxzoom must stay within Martin's published range (see config/martin.yaml).
      // Requests outside that range return plain-text 404s that MapLibre mis-parses as PBF.
      map_connectivity_nodes: {
        type: 'vector',
        tiles: [vector('map_connectivity_nodes')],
        minzoom: 11,
        maxzoom: 16,
      },
      map_ac_line_segments: {
        type: 'vector',
        tiles: [vector('map_ac_line_segments')],
        minzoom: DETAIL_LINE_MIN_ZOOM,
        maxzoom: 16,
      },
      map_power_transformers: {
        type: 'vector',
        tiles: [vector('map_power_transformers')],
        minzoom: TRANSFORMER_ICON_MIN_ZOOM,
        maxzoom: 16,
      },
      ecg_admin_boundaries: {
        type: 'vector',
        tiles: [vector('ecg_admin_boundaries')],
        minzoom: 6,
        maxzoom: 16,
      },
      ecg_admin_regions: {
        type: 'vector',
        tiles: [vector('ecg_admin_regions')],
        minzoom: 6,
        maxzoom: 16,
      },
      [H3_REBUILD_COVERAGE_SOURCE]: {
        type: 'vector',
        tiles: [vector(H3_REBUILD_COVERAGE_SOURCE)],
        minzoom: 0,
        maxzoom: 16,
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
      ...gisOverviewConductorLayers,
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
        minzoom: DETAIL_LV_MIN_ZOOM,
        filter: tileLineOverheadLvFilter(),
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: tileLineLvOverheadPaint(light),
      },
      {
        id: 'lines-underground-lv',
        type: 'line',
        source: 'map_ac_line_segments',
        'source-layer': 'map_ac_line_segments',
        minzoom: DETAIL_LV_MIN_ZOOM,
        filter: tileLineUndergroundLvFilter(),
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { ...tileLineLvUndergroundPaint(light), 'line-dasharray': UG_LINE_DASH },
      },
      {
        id: 'nodes',
        type: 'circle',
        source: 'map_connectivity_nodes',
        'source-layer': 'map_connectivity_nodes',
        minzoom: DETAIL_NODE_MIN_ZOOM,
        filter: tileNodeNonTransformerFilter(),
        paint: tileNodeCirclePaint(light),
      },
      ...gisOverviewPoleLayers,
      ...gisOverviewTransformerLayers,
      ...masterTransformerLayerEntries(),
      // H3 rebuild coverage above network geometry (toggle via layout visibility).
      ...(h3CoverageLayerEntries(light) ?? []),
      // Place-name labels above network geometry (CARTO label-only raster).
      // Cap zoom so street names disappear for close-in engineering work.
      {
        id: GIOP_BASEMAP_LABELS_LAYER_LIGHT,
        type: 'raster',
        source: 'basemap-labels-light',
        maxzoom: GIOP_BASEMAP_LABELS_MAX_ZOOM,
        layout: { visibility: light ? 'visible' : 'none' },
        paint: {
          'raster-opacity': [
            'interpolate',
            ['linear'],
            ['zoom'],
            GIOP_BASEMAP_LABELS_MAX_ZOOM - 1,
            1,
            GIOP_BASEMAP_LABELS_MAX_ZOOM,
            0,
          ],
        },
      },
      {
        id: GIOP_BASEMAP_LABELS_LAYER_DARK,
        type: 'raster',
        source: 'basemap-labels-dark',
        maxzoom: GIOP_BASEMAP_LABELS_MAX_ZOOM,
        layout: { visibility: light ? 'none' : 'visible' },
        paint: {
          'raster-opacity': [
            'interpolate',
            ['linear'],
            ['zoom'],
            GIOP_BASEMAP_LABELS_MAX_ZOOM - 1,
            1,
            GIOP_BASEMAP_LABELS_MAX_ZOOM,
            0,
          ],
        },
      },
      // ECG admin boundaries above basemap labels so the overlay toggle is always visible.
      // Regions below zoom 10; districts at/above zoom 10.
      {
        id: 'ecg-regions-fill',
        type: 'fill',
        source: 'ecg_admin_regions',
        'source-layer': 'ecg_admin_regions',
        minzoom: 6,
        maxzoom: 10,
        layout: { visibility: 'none' },
        paint: {
          'fill-color': light ? '#0284c7' : '#38bdf8',
          'fill-opacity': ['interpolate', ['linear'], ['zoom'], 6, 0.1, 8, 0.14, 9.5, 0.18],
          'fill-antialias': true,
        },
      },
      {
        id: 'ecg-regions-outline',
        type: 'line',
        source: 'ecg_admin_regions',
        'source-layer': 'ecg_admin_regions',
        minzoom: 6,
        maxzoom: 10,
        layout: {
          visibility: 'none',
          'line-join': 'round',
          'line-cap': 'round',
        },
        paint: {
          'line-color': light ? '#0369a1' : '#7dd3fc',
          'line-width': ['interpolate', ['linear'], ['zoom'], 6, 1.8, 8, 2.6, 9.5, 3.2],
          'line-opacity': 0.95,
        },
      },
      {
        id: 'ecg-regions-label',
        type: 'symbol',
        source: 'ecg_admin_regions',
        'source-layer': 'ecg_admin_regions',
        minzoom: 6,
        maxzoom: 10,
        layout: {
          visibility: 'none',
          'text-field': ['get', 'region'],
          'text-size': ['interpolate', ['linear'], ['zoom'], 6, 11, 8, 14, 9.5, 16],
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
          'text-opacity': 1,
        },
      },
      {
        id: 'ecg-boundaries-fill',
        type: 'fill',
        source: 'ecg_admin_boundaries',
        'source-layer': 'ecg_admin_boundaries',
        minzoom: 10,
        layout: { visibility: 'none' },
        paint: {
          'fill-color': light ? '#0284c7' : '#38bdf8',
          'fill-opacity': ['interpolate', ['linear'], ['zoom'], 10, 0.1, 12, 0.16, 13, 0.2],
          'fill-antialias': true,
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
          'line-width': ['interpolate', ['linear'], ['zoom'], 10, 1.6, 12, 2.4, 13, 3],
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
          'text-opacity': 1,
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
  'overview-poles-33kv': { min: DETAIL_NODE_MIN_ZOOM, max: NODE_DETAIL_ZOOM },
  'overview-poles-11kv': { min: DETAIL_NODE_MIN_ZOOM, max: NODE_DETAIL_ZOOM },
  'overview-poles-lv': { min: DETAIL_NODE_MIN_ZOOM, max: NODE_DETAIL_ZOOM },
  'lines-overhead-mv': { min: DETAIL_LINE_MIN_ZOOM },
  'lines-underground-mv': { min: DETAIL_LINE_MIN_ZOOM },
  'lines-overhead-lv': { min: DETAIL_LV_MIN_ZOOM },
  'lines-underground-lv': { min: DETAIL_LV_MIN_ZOOM },
  [UNPROMOTED_GIS_GAP_LAYER_ID]: { min: UNPROMOTED_GIS_GAP_MIN_ZOOM, max: GIS_COMPARE_LAYER_MAX_ZOOM },
  nodes: { min: DETAIL_NODE_MIN_ZOOM },
  'nodes-transformers-dt': { min: TRANSFORMER_ICON_MIN_ZOOM },
  'nodes-transformers-pt': { min: TRANSFORMER_ICON_MIN_ZOOM },
  'master-transformers-dt': { min: TRANSFORMER_ICON_MIN_ZOOM },
  'master-transformers-pt': { min: TRANSFORMER_ICON_MIN_ZOOM },
  ...Object.fromEntries(
    H3_COVERAGE_LAYER_IDS.map((id) => [id, { min: 0 }]),
  ),
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
      id: 'gis-unpromoted-gap',
      label: 'GIS gaps (dashed magenta)',
      color: GIS_IMPORT_MAGENTA,
      dashed: true,
      layerIds: [...UNPROMOTED_GIS_GAP_LAYER_IDS],
    },
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
      layerIds: [
        'overview-transformers',
        'nodes-transformers-dt',
        'nodes-transformers-pt',
        'master-transformers-dt',
        'master-transformers-pt',
      ],
    },
    {
      id: 'poles',
      label: 'Pole / node (red = in conflict)',
      color: isLightMode ? '#64748b' : '#94a3b8',
      dot: true,
      layerIds: ['nodes', ...GIS_POLE_LAYER_IDS],
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

export function setGiopLayerVisibility(map: MaplibreMap, layerId: string, visible: boolean): void {
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
  options?: {
    geometryMode?: NetworkGeometryMode;
    gisOverviewAvailable?: boolean;
    /** Endpoint-fix row preview — hide district-wide gap tiles. */
    suppressUnpromotedGapLayer?: boolean;
  },
): void {
  const geometryMode = options?.geometryMode ?? 'master';
  const gisOk = options?.gisOverviewAvailable !== false;
  const mvVoltages = enabledMvVoltages(state);
  const undergroundOn = giopLegendGroupOn(state, 'underground');
  const mv33On = giopLegendGroupOn(state, 'mv-33-overhead');
  const mv11On = giopLegendGroupOn(state, 'mv-11-overhead');
  const transformersOn = giopLegendGroupOn(state, 'transformers');
  const polesOn = giopLegendGroupOn(state, 'poles');

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

  setGiopLayerVisibility(map, 'overview-oh-33kv', mv33On);
  setGiopLayerVisibility(map, 'overview-oh-11kv', mv11On);
  const lvOn = giopLegendGroupOn(state, 'lv-overhead');
  setGiopLayerVisibility(map, 'lines-overhead-lv', lvOn);
  setGiopLayerVisibility(map, 'lines-underground-lv', undergroundOn);
  setGiopLayerVisibility(map, 'overview-ug-33kv', undergroundOn && mv33On);
  setGiopLayerVisibility(map, 'overview-ug-11kv', undergroundOn && mv11On);

  const exclusiveByGroup: [string, string[]][] = [
    [
      'transformers',
      [
        'overview-transformers',
        'nodes-transformers-dt',
        'nodes-transformers-pt',
        'master-transformers-dt',
        'master-transformers-pt',
      ],
    ],
    ['poles', ['nodes', ...GIS_POLE_LAYER_IDS]],
    ['staging-pending', ['staging-points']],
    ['field-tech', ['field-technician-halo', 'field-technician-points']],
  ];
  for (const [groupId, layerIds] of exclusiveByGroup) {
    const visible = giopLegendGroupOn(state, groupId);
    for (const layerId of layerIds) {
      setGiopLayerVisibility(map, layerId, visible);
    }
  }

  // Legend groups share overview + master layer IDs. Geometry mode must run last
  // so GIS import does not leave master lines/nodes drawn on top (same red look).
  applyNetworkGeometryModeOverride(map, geometryMode, {
    gisOverviewAvailable: options?.gisOverviewAvailable,
  });

  if (geometryMode === 'gis' && gisOk) {
    // Override forces all GIS layers on; re-honor voltage / transformer / pole legend.
    setGiopLayerVisibility(map, 'overview-oh-33kv', mv33On);
    setGiopLayerVisibility(map, 'overview-oh-11kv', mv11On);
    setGiopLayerVisibility(map, 'overview-ug-33kv', undergroundOn && mv33On);
    setGiopLayerVisibility(map, 'overview-ug-11kv', undergroundOn && mv11On);
    setGiopLayerVisibility(map, 'overview-transformers', transformersOn);
    setGiopLayerVisibility(map, 'nodes-transformers-dt', transformersOn);
    setGiopLayerVisibility(map, 'nodes-transformers-pt', transformersOn);
    for (const layerId of GIS_POLE_LAYER_IDS) {
      setGiopLayerVisibility(map, layerId, polesOn);
    }
  }

  if (geometryMode === 'both' && map.getLayer(UNPROMOTED_GIS_GAP_LAYER_ID)) {
    if (options?.suppressUnpromotedGapLayer) {
      setGiopLayerVisibility(map, UNPROMOTED_GIS_GAP_LAYER_ID, false);
    } else {
      setGiopLayerVisibility(
        map,
        UNPROMOTED_GIS_GAP_LAYER_ID,
        giopLegendGroupOn(state, 'gis-unpromoted-gap'),
      );
    }
  } else if (options?.suppressUnpromotedGapLayer && map.getLayer(UNPROMOTED_GIS_GAP_LAYER_ID)) {
    setGiopLayerVisibility(map, UNPROMOTED_GIS_GAP_LAYER_ID, false);
  }
}
