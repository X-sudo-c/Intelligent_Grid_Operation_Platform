import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react';
import maplibregl from '../lib/maplibreSetup';
import { MARTIN_URL, getAssetLocation, getTopologyImpact, isUuidMrid, probeGisOverviewAvailable, probeUnpromotedGapAvailable, getReferenceMapConfig, getReferenceMapConfigCached } from '../api/giop-api';
import type { GiopReferenceMapLayerConfig } from '../api/giop-api';
import type { GiopStagingAsset, GiopFieldTechnician, GiopWorkOrder, GiopTopologyPayload } from '../api/giop-api';
import type { MapBbox } from '../hooks/useGiopGraphChunk';
import type { MapViewportContext } from '../lib/giopCopilotTypes';
import {
  applyGiopLegendVisibility,
  buildGiopLegendGroups,
  buildGiopMapStyle,
  createDefaultGiopLegendVisibility,
  syncNetworkGeometryModeOnMap,
  pinTransformerLayersAboveNodes,
  applyStagingMapLayersPaint,
  stagingPointCirclePaint,
  workOrderPinCirclePaint,
  fitMapBounds,
  impactNodeCirclePaint,
  focusIdentifyCirclePaint,
  focusTentativeCirclePaint,
  mapSymbolLabelPaint,
  syncGiopMapTheme,
  tileNodeCirclePaint,
  H3_COVERAGE_LAYER_IDS,
  h3CoverageOutlinePaint,
  H3_REBUILD_COVERAGE_SOURCE,
  MARTIN_REFRESH_SOURCE_IDS,
  martinLayerPath,
  MIN_MAP_ZOOM,
  NODE_DETAIL_ZOOM,
  readNetworkGeometryMode,
  flyToLatLon,
  flyToNodeFocus,
  GIOP_MAP_LABEL_FONT_BOLD,
  TRANSFORMER_SYMBOL_LAYER_IDS,
} from '../lib/giopMapLayers';
import { readStoredMapCamera, writeStoredMapCamera } from '../lib/giopMapCameraStorage';
import {
  applyReferenceMapConfig,
  refreshReferenceBboxLayers,
} from '../lib/giopReferenceMapLayers';
import {
  applyAllBoundaryVisibility,
  boundaryHitLayerIds,
  listBoundaryOverlayProducts,
} from '../lib/giopReferenceBoundaryOverlays';
import { refreshGiopMapIcons, registerGiopMapIcons, TRANSFORMER_ICON_ID } from '../lib/giopMapIcons';
import { attachGiopMapHover } from '../lib/giopMapHover';
import {
  createGiopIdentifyPopup,
  identifyKindForLayer,
  showGiopIdentifyPopup,
} from '../lib/giopMapIdentify';
import { attachGiopMapPulseCanvasOverlay } from '../lib/giopMapPulseOverlay';
import { normalizeMapCoordinates, resolveStagingAssetCoordinates, extractStagingGeomCoordinates } from '../lib/giopMapCoordinates';
import { giopLog } from '../lib/giopDebugLog';
import { topologyImpactToGeoJson } from '../lib/giopImpactGeoJson';
import {
  applyTerritoryHighlight,
  clearTerritoryHighlight as removeTerritoryHighlightLayers,
} from '../lib/giopTerritoryHighlight';
import {
  FEEDER_HIGHLIGHT_EDGE_LAYER,
  FEEDER_HIGHLIGHT_EDGE_SOURCE,
  FEEDER_HIGHLIGHT_NODE_LAYER,
  FEEDER_HIGHLIGHT_NODE_SOURCE,
  feederHighlightEdgePaint,
  feederHighlightNodePaint,
  type FeederHighlightState,
} from '../lib/giopFeederHighlight';
import {
  IMPORT_SEGMENT_ENDPOINT_LAYER,
  IMPORT_SEGMENT_ENDPOINT_SOURCE,
  IMPORT_SEGMENT_LABEL_LAYER,
  IMPORT_SEGMENT_LINE_LAYER,
  IMPORT_SEGMENT_LINE_SOURCE,
  IMPORT_SEGMENT_LINK_LAYER,
  IMPORT_SEGMENT_LINK_SOURCE,
  IMPORT_SEGMENT_PROPOSED_LABEL_LAYER,
  IMPORT_SEGMENT_PROPOSED_LAYER,
  IMPORT_SEGMENT_PROPOSED_SOURCE,
  importSegmentEndpointPaint,
  importSegmentLabelLayout,
  importSegmentLabelPaint,
  importSegmentLinePaint,
  importSegmentProposedLabelLayout,
  importSegmentProposedPaint,
  importSegmentSuggestedLinkPaint,
} from '../lib/giopImportSegmentHighlight';
import {
  MAP_MEASURE_LABEL_LAYER,
  MAP_MEASURE_LABEL_SOURCE,
  MAP_MEASURE_LINE_LAYER,
  MAP_MEASURE_LINE_SOURCE,
  MAP_MEASURE_POINT_HALO_LAYER,
  MAP_MEASURE_POINT_LAYER,
  MAP_MEASURE_POINT_SOURCE,
  buildMeasureGeoJson,
  formatMeasureMeters,
  measureLabelLayout,
  measureLabelPaint,
  measureLinePaint,
  measurePointHaloPaint,
  measurePointPaint,
  snapMeasurePoint,
} from '../lib/giopMapMeasure';
import {
  CLEARANCE_RADIUS_PRESETS_M,
  MAP_CLEARANCE_FILL_LAYER,
  MAP_CLEARANCE_OUTLINE_LAYER,
  MAP_CLEARANCE_SOURCE,
  buildClearanceGeoJson,
  clearanceAreaMeters2,
  clearanceFillPaint,
  clearanceOutlinePaint,
  formatClearanceArea,
} from '../lib/giopMapClearance';
import {
  applyEcgBoundaryTheme,
  ecgBoundaryPopupHtml,
  territoryFromBoundaryFeature,
} from '../lib/giopBoundaries';
import { GiopMapControlPanel } from './GiopMapControlPanel';
import { GiopMapLegend } from './GiopMapLegend';
import { GiopNetworkGeometryToggle } from './GiopNetworkGeometryToggle';
import { GiopMapFieldPanel } from './GiopMapFieldPanel';
import { GiopMapSearchBar } from './GiopMapSearchBar';
import type { GiopMapSearchResult } from '../api/giop-api';
import { useGiopMapSearchCatalog, EMPTY_FIELD_TECHNICIANS, EMPTY_STAGING_ASSETS, EMPTY_WORK_ORDERS } from '../hooks/useGiopMapSearchCatalog';
import { applySearchResultCamera } from '../lib/giopMapLocalSearch';
import type { GiopMapSearchBridge } from '../lib/giopMapSearchBridge';
import { GiopTerritoryMapToggle, GiopTerritoryProvider } from '../context/GiopTerritoryContext';
import { useGiopMapOverlay } from '../context/GiopMapOverlayContext';
import type { GiopMapFlyRequest } from '../lib/giopMapFlyRequest';
import {
  applyDuplicateClusterMapPaint,
  buildDuplicateClusterGeoJson,
  duplicateClusterMapStyle,
  duplicateClusterOrbitEnabled,
  DUPLICATE_FAN_ORBIT_PERIOD_S,
  flyToDuplicateClusterView,
} from '../lib/giopDuplicateFan';

interface GiopMapViewProps {
  isLightMode?: boolean;
  focusMrid?: string | null;
  focusCoordinates?: [number, number] | null;
  /** Asset name shown on the identify label (side-map preview). */
  focusLabel?: string | null;
  stagingAssets?: GiopStagingAsset[];
  fieldTechnicians?: GiopFieldTechnician[];
  onNodeClick?: (mrid: string, coordinates?: [number, number]) => void;
  onTechnicianClick?: (technicianId: string) => void;
  onViewportChange?: (bbox: MapBbox, zoom: number, center: { lon: number; lat: number }) => void;
  onTerritorySelect?: (territory: { district?: string; region?: string }) => void;
  refreshToken?: number;
  fieldCrews?: {
    selectedId: string | null;
    submissions: GiopStagingAsset[];
    loading?: boolean;
    error?: string | null;
    onSelect: (technicianId: string) => void;
    onClear: () => void;
    onFocusTechnician?: (technician: GiopFieldTechnician) => void;
    onFocusAsset?: (mrid: string, coordinates?: [number, number]) => void;
  };
  workOrders?: GiopWorkOrder[];
  impactOverlay?: GiopTopologyPayload | null;
  feederHighlight?: FeederHighlightState | null;
  /** Pulsing ripple on the focused node (side-map identify only). */
  pulseFocus?: boolean;
  /** Amber pulse when the copilot is asking the user to confirm a node guess. */
  pulseFocusTentative?: boolean;
  /** Full map chrome, split (Map + Topology), or minimal ops desk map. */
  mapChrome?: 'full' | 'operations' | 'split';
  /** Apple-style spotlight search at top-center (default: on except ops desk). */
  showSearchBar?: boolean;
  /** When search is rendered outside the map (split view toolbar), expose handlers here. */
  searchBridgeRef?: MutableRefObject<GiopMapSearchBridge | null>;
  onSearchBridgeCatalog?: (snapshot: Pick<GiopMapSearchBridge, 'placeCatalog' | 'opsCatalog' | 'placesReady'>) => void;
  flyRequest?: GiopMapFlyRequest | null;
}

const DEFAULT_CENTER: [number, number] = [-0.2941, 5.6812];
const DEFAULT_ZOOM = 13;
const DEFAULT_CAMERA = {
  center: DEFAULT_CENTER,
  zoom: DEFAULT_ZOOM,
  bearing: 0,
  pitch: 0,
} as const;
const EMPTY_FC = { type: 'FeatureCollection' as const, features: [] };

/** Avoid re-probing Martin on every side-map remount (Show on map opens a fresh map). */
let cachedGisOverviewAvailable: boolean | undefined;

const BOUNDARY_VISIBILITY_STORAGE_KEY = 'giop.boundaryOverlayVisibility';

function readStoredBoundaryVisibility(): Record<string, boolean> {
  try {
    const raw = sessionStorage.getItem(BOUNDARY_VISIBILITY_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, boolean> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === 'boolean') out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}

function writeStoredBoundaryVisibility(state: Record<string, boolean>): void {
  try {
    sessionStorage.setItem(BOUNDARY_VISIBILITY_STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* ignore quota / private mode */
  }
}

const ZOOM_HINT_HIDE_MS = 1500;
const ZOOM_HINT_INITIAL_MS = 2000;

function mapHasStyle(map: maplibregl.Map): boolean {
  try {
    return map.getStyle() != null;
  } catch {
    return false;
  }
}

/** Layer/source mutations when style may be absent (before load, after remove, WebGL loss). */
function safeMapMutate(map: maplibregl.Map, fn: () => void): void {
  if (!mapHasStyle(map)) return;
  try {
    fn();
  } catch (err) {
    giopLog.map.warn('layer mutation skipped', err);
  }
}

function safeRemoveLayer(map: maplibregl.Map, layerId: string): void {
  safeMapMutate(map, () => {
    if (map.getLayer(layerId)) map.removeLayer(layerId);
  });
}

function safeRemoveSource(map: maplibregl.Map, sourceId: string): void {
  safeMapMutate(map, () => {
    if (map.getSource(sourceId)) map.removeSource(sourceId);
  });
}

/** MapLibre addLayer beforeId must be a layer id string — getLayer() returns a spec object. */
function firstLayerId(map: maplibregl.Map, ...layerIds: string[]): string | undefined {
  for (const id of layerIds) {
    if (map.getLayer(id)) return id;
  }
  return undefined;
}

function whenMapCanAddLayers(map: maplibregl.Map, fn: () => void): () => void {
  let cancelled = false;
  const run = () => {
    if (cancelled || !mapHasStyle(map)) return;
    try {
      fn();
    } catch (err) {
      giopLog.map.warn('layer mutation failed', err);
    }
  };
  if (mapHasStyle(map)) {
    run();
  } else {
    map.once('load', run);
    map.once('styledata', () => {
      if (mapHasStyle(map)) run();
    });
  }
  return () => {
    cancelled = true;
  };
}

/** Defer layer/source work until the camera is idle — avoids stuck drags from mid-pan mutations. */
function whenMapIdle(map: maplibregl.Map, fn: () => void): () => void {
  let cancelled = false;
  const run = () => {
    if (cancelled) return;
    if (map.isMoving()) {
      map.once('idle', run);
      return;
    }
    fn();
  };
  run();
  return () => {
    cancelled = true;
  };
}

function scheduleMapLayerWork(map: maplibregl.Map, fn: () => void): () => void {
  let cancelled = false;
  let cancelInner = () => {};

  const start = () => {
    if (cancelled) return;
    cancelInner = whenMapIdle(map, () => {
      if (cancelled) return;
      cancelInner = whenMapCanAddLayers(map, fn);
    });
  };

  start();
  return () => {
    cancelled = true;
    cancelInner();
  };
}

const FOCUS_IDENTIFY_LAYER_IDS = [
  'focus-identify-point',
  'focus-identify-label',
] as const;

const FIELD_TECHNICIAN_LAYER_IDS = [
  'field-technician-halo',
  'field-technician-points',
] as const;

/** Keep field crew markers above tile/staging overlays. */
function pinFieldTechnicianLayersToTop(map: maplibregl.Map): void {
  safeMapMutate(map, () => {
    for (const id of FIELD_TECHNICIAN_LAYER_IDS) {
      if (map.getLayer(id)) map.moveLayer(id);
    }
  });
}

/** Keep the focused asset label above staging/tile overlays after pan or layer refresh. */
function pinFocusIdentifyLayersToTop(map: maplibregl.Map): void {
  safeMapMutate(map, () => {
    for (const id of FOCUS_IDENTIFY_LAYER_IDS) {
      if (map.getLayer(id)) map.moveLayer(id);
    }
  });
}

function pinMeasureLayersToTop(map: maplibregl.Map): void {
  safeMapMutate(map, () => {
    for (const id of [
      MAP_CLEARANCE_FILL_LAYER,
      MAP_CLEARANCE_OUTLINE_LAYER,
      MAP_MEASURE_LINE_LAYER,
      MAP_MEASURE_LABEL_LAYER,
      MAP_MEASURE_POINT_HALO_LAYER,
      MAP_MEASURE_POINT_LAYER,
    ]) {
      if (map.getLayer(id)) map.moveLayer(id);
    }
  });
}

function applyMapTheme(map: maplibregl.Map, isLightMode: boolean) {
  syncGiopMapTheme(map, isLightMode);
  applyEcgBoundaryTheme(map, isLightMode);
}

export function GiopMapView({
  isLightMode = false,
  focusMrid,
  focusCoordinates,
  focusLabel,
  stagingAssets = EMPTY_STAGING_ASSETS,
  fieldTechnicians = EMPTY_FIELD_TECHNICIANS,
  onNodeClick,
  onTechnicianClick,
  onViewportChange,
  onTerritorySelect,
  refreshToken = 0,
  fieldCrews,
  workOrders = EMPTY_WORK_ORDERS,
  impactOverlay = null,
  feederHighlight = null,
  pulseFocus = false,
  pulseFocusTentative = false,
  mapChrome = 'full',
  showSearchBar: showSearchBarProp,
  searchBridgeRef,
  onSearchBridgeCatalog,
  flyRequest = null,
}: GiopMapViewProps) {
  const isOpsMap = mapChrome === 'operations';
  const isSplitMap = mapChrome === 'split';
  const showSearchBar = showSearchBarProp ?? (!isOpsMap && !isSplitMap);
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const onNodeClickRef = useRef(onNodeClick);
  const onTechnicianClickRef = useRef(onTechnicianClick);
  const onViewportChangeRef = useRef(onViewportChange);
  const onTerritorySelectRef = useRef(onTerritorySelect);
  const isLightModeRef = useRef(isLightMode);
  const [mapBusy, setMapBusy] = useState(true);
  const [mapReady, setMapReady] = useState(false);
  const [mapZoom, setMapZoom] = useState(11);
  const [gisOverviewAvailable, setGisOverviewAvailable] = useState<boolean>(
    () => cachedGisOverviewAvailable ?? true,
  );
  const [unpromotedGapAvailable, setUnpromotedGapAvailable] = useState(false);
  const [referenceMapConfig, setReferenceMapConfig] = useState<GiopReferenceMapLayerConfig[]>([]);
  const referenceMapConfigRef = useRef(referenceMapConfig);  const [zoomHintVisible, setZoomHintVisible] = useState(false);
  const hideZoomHintTimerRef = useRef<number | undefined>(undefined);
  const [showCoverage, setShowCoverage] = useState(false);
  const [boundaryVisibility, setBoundaryVisibility] = useState<Record<string, boolean>>(
    readStoredBoundaryVisibility,
  );  const boundaryVisibilityRef = useRef(boundaryVisibility);
  const boundaryPopupRef = useRef<maplibregl.Popup | null>(null);
  const identifyPopupRef = useRef<maplibregl.Popup | null>(null);
  const [showWorkOrdersLayer, setShowWorkOrdersLayer] = useState(true);
  const showWorkOrdersLayerRef = useRef(showWorkOrdersLayer);  const [territoryActive, setTerritoryActive] = useState(false);
  const territoryActiveRef = useRef(false);
  const mapMeasureActiveRef = useRef(false);
  const mapTraceActiveRef = useRef(false);
  const mapTraceSeqRef = useRef(0);
  const [mapTraceLoading, setMapTraceLoading] = useState(false);
  const measureDragRef = useRef<{
    index: number;
    startX: number;
    startY: number;
    moved: boolean;
  } | null>(null);
  const measureSkipClickRef = useRef(false);
  const [measureDragging, setMeasureDragging] = useState(false);
  const handledCameraRequestIdRef = useRef(0);
  const handledViewportCommandIdRef = useRef(0);
  const stagingAssetsRef = useRef(stagingAssets);
  const { focusCameraRequest, clearFocusCamera, mapViewportCommand, clearMapViewportCommand, territoryHighlight, clearTerritoryHighlight, repairPreviewLayers, duplicateClusterOverlay, importSegmentHighlight, networkGeometryMode, setNetworkGeometryMode, focusOnMap, queueMapViewportCommand, registerMapViewportReader, mapMeasureActive, measurePoints, addMeasurePoint, updateMeasurePoint, removeMeasurePoint, clearMeasure, measureTotalMeters, mapClearanceActive, clearanceRadiusM, setClearanceRadiusM, mapTraceActive, setMapTraceActive, mapTraceStatus, setMapTraceStatus, setImpactOverlay, clearImpactOverlay } =
    useGiopMapOverlay();

  const { placeCatalog, opsCatalog, placesReady } = useGiopMapSearchCatalog({
    workOrders,
    fieldTechnicians,
    stagingAssets,
  });

  stagingAssetsRef.current = stagingAssets;

  territoryActiveRef.current = territoryActive;
  mapMeasureActiveRef.current = mapMeasureActive;
  mapTraceActiveRef.current = mapTraceActive;
  showWorkOrdersLayerRef.current = showWorkOrdersLayer;
  boundaryVisibilityRef.current = boundaryVisibility;
  referenceMapConfigRef.current = referenceMapConfig;
  useEffect(() => {
    writeStoredBoundaryVisibility(boundaryVisibility);
  }, [boundaryVisibility]);

  const boundaryOverlayProducts = useMemo(() => {
    const fromCatalog = listBoundaryOverlayProducts(referenceMapConfig);
    if (fromCatalog.some((p) => p.slug === 'ecg-admin-boundaries')) {
      return fromCatalog;
    }
    // Keep the built-in ECG toggle available before map-config finishes loading.
    return [
      {
        slug: 'ecg-admin-boundaries',
        display_name: 'ECG Admin Boundaries',
        hint: 'Regions below zoom 10, districts at/above',
      },
      ...fromCatalog,
    ];
  }, [referenceMapConfig]);

  const anyBoundaryVisible = useMemo(
    () => boundaryOverlayProducts.some((p) => boundaryVisibility[p.slug]),
    [boundaryOverlayProducts, boundaryVisibility],
  );

  const toggleBoundaryOverlay = useCallback((slug: string) => {
    setBoundaryVisibility((prev) => ({ ...prev, [slug]: !prev[slug] }));
  }, []);

  useEffect(() => {
    setBoundaryVisibility((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const product of boundaryOverlayProducts) {
        if (!(product.slug in next)) {
          next[product.slug] = false;
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [boundaryOverlayProducts]);

  isLightModeRef.current = isLightMode;

  const showAssetIdentify = (
    map: maplibregl.Map,
    lngLat: maplibregl.LngLat,
    feature: maplibregl.MapGeoJSONFeature | undefined,
    layerId: string,
  ) => {
    if (!feature || territoryActiveRef.current || !identifyKindForLayer(layerId)) return;
    if (!identifyPopupRef.current) {
      identifyPopupRef.current = createGiopIdentifyPopup();
    }
    showGiopIdentifyPopup(
      map,
      identifyPopupRef.current,
      lngLat,
      feature,
      layerId,
      isLightModeRef.current,
    );
  };

  const handleNodeFeatureClick = (
    map: maplibregl.Map,
    feature: maplibregl.MapGeoJSONFeature | undefined,
    lngLat?: maplibregl.LngLat,
    layerId?: string,
  ) => {
    const mrid = feature?.properties?.mrid as string | undefined;
    if (!mrid) return;

    if (mapTraceActiveRef.current) {
      const seq = ++mapTraceSeqRef.current;
      setMapTraceLoading(true);
      setMapTraceStatus(`Tracing downstream from ${mrid.slice(0, 8)}…`);
      void getTopologyImpact(mrid)
        .then((payload) => {
          if (seq !== mapTraceSeqRef.current || !mapTraceActiveRef.current) return;
          setImpactOverlay(payload);
          const nodeCount = payload.metrics?.downstream_nodes ?? payload.nodes.length;
          const edgeCount = payload.metrics?.edge_count ?? payload.edges.length;
          const truncated = payload.metrics?.truncated ? ' · truncated' : '';
          setMapTraceStatus(
            `Downstream: ${nodeCount} nodes · ${edgeCount} lines${truncated}`,
          );

          const coords: [number, number][] = [];
          for (const node of payload.nodes) {
            const lon =
              (node as { longitude?: number }).longitude ?? (node as { lon?: number }).lon;
            const lat =
              (node as { latitude?: number }).latitude ?? (node as { lat?: number }).lat;
            if (lon != null && lat != null) coords.push([lon, lat]);
          }
          for (const edge of payload.edges) {
            if (edge.coordinates) {
              for (const c of edge.coordinates) coords.push(c);
            }
          }
          if (coords.length > 0) {
            const west = Math.min(...coords.map((c) => c[0]));
            const east = Math.max(...coords.map((c) => c[0]));
            const south = Math.min(...coords.map((c) => c[1]));
            const north = Math.max(...coords.map((c) => c[1]));
            fitMapBounds(map, { west, south, east, north }, { padding: 56, maxZoom: 17, duration: 900 });
          }
        })
        .catch((err) => {
          if (seq !== mapTraceSeqRef.current || !mapTraceActiveRef.current) return;
          clearImpactOverlay();
          setMapTraceStatus(err instanceof Error ? err.message : 'Trace failed');
        })
        .finally(() => {
          if (seq === mapTraceSeqRef.current) setMapTraceLoading(false);
        });
      return;
    }

    let coordinates: [number, number] | undefined;
    const geom = feature?.geometry;
    if (geom && geom.type === 'Point' && Array.isArray(geom.coordinates)) {
      coordinates = [geom.coordinates[0], geom.coordinates[1]];
    }
    if (lngLat && layerId) showAssetIdentify(map, lngLat, feature, layerId);
    onNodeClickRef.current?.(mrid, territoryActiveRef.current ? undefined : coordinates);
  };

  onNodeClickRef.current = onNodeClick;
  onTechnicianClickRef.current = onTechnicianClick;
  onViewportChangeRef.current = onViewportChange;
  onTerritorySelectRef.current = onTerritorySelect;
  isLightModeRef.current = isLightMode;

  useEffect(() => {
    if (cachedGisOverviewAvailable === true) {
      setGisOverviewAvailable(true);
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 8000);
    void probeGisOverviewAvailable(MARTIN_URL, controller.signal)
      .then((available) => {
        if (available) {
          cachedGisOverviewAvailable = true;
          setGisOverviewAvailable(true);
        }
        // Keep optimistic overview layers on probe failure — stripping them recreates
        // the map without country/mid-zoom conductors when sync is slow.
      })
      .catch(() => {
        giopLog.map.warn('GIS overview probe failed; keeping overview layers enabled');
      })
      .finally(() => window.clearTimeout(timer));
    const cachedMapConfig = getReferenceMapConfigCached();
    if (cachedMapConfig && cachedMapConfig.length > 0) {
      setReferenceMapConfig(cachedMapConfig);
    }
    void getReferenceMapConfig()
      .then(setReferenceMapConfig)
      .catch(() => {
        if (!cachedMapConfig?.length) setReferenceMapConfig([]);
      });
    void probeUnpromotedGapAvailable(MARTIN_URL, controller.signal)
      .then(setUnpromotedGapAvailable)
      .catch(() => setUnpromotedGapAvailable(false));
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, []);

  useEffect(() => {
    if (networkGeometryMode === 'gis' && !gisOverviewAvailable) {
      setNetworkGeometryMode('master');
    }
  }, [gisOverviewAvailable, networkGeometryMode, setNetworkGeometryMode]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;

    const apply = () => {
      syncNetworkGeometryModeOnMap(map, networkGeometryMode, {
        gisOverviewAvailable,
        light: isLightModeRef.current,
        martinUrl: MARTIN_URL,
      });
    };

    if (map.isStyleLoaded()) apply();
    else whenMapCanAddLayers(map, apply);
  }, [mapReady, networkGeometryMode, gisOverviewAvailable, isLightMode, mapZoom]);

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    const light = isLightModeRef.current;
    const container = containerRef.current;
    const host = container.parentElement;
    if (!host) return;

    const includeGisOverview = cachedGisOverviewAvailable ?? true;
    const initialCamera = readStoredMapCamera(DEFAULT_CAMERA);

    const map = new maplibregl.Map({
      container: containerRef.current,
      style: buildGiopMapStyle(MARTIN_URL, light, { includeGisOverview }),
      center: initialCamera.center,
      zoom: initialCamera.zoom,
      bearing: initialCamera.bearing ?? 0,
      pitch: initialCamera.pitch ?? 0,
      minZoom: MIN_MAP_ZOOM,
      maxZoom: 20,
      // Snappier pan-back after detail tiles load (does not change zoom look).
      maxTileCacheZoomLevels: 12,
      fadeDuration: 0,
      antialias: false,
    });

    map.addControl(new maplibregl.NavigationControl(), 'top-right');
    mapRef.current = map;

    const syncMapZoom = () => {
      setMapZoom(Number(map.getZoom().toFixed(1)));
    };
    const persistCamera = () => {
      const c = map.getCenter();
      writeStoredMapCamera({
        center: [c.lng, c.lat],
        zoom: map.getZoom(),
        bearing: map.getBearing(),
        pitch: map.getPitch(),
      });
    };
    const revealZoomHint = () => {
      window.clearTimeout(hideZoomHintTimerRef.current);
      setZoomHintVisible(true);
    };
    const scheduleHideZoomHint = (delay = ZOOM_HINT_HIDE_MS) => {
      window.clearTimeout(hideZoomHintTimerRef.current);
      hideZoomHintTimerRef.current = window.setTimeout(() => setZoomHintVisible(false), delay);
    };
    const markMapReady = () => {
      syncMapZoom();
      setMapBusy(false);
      setMapReady(true);
    };
    const syncMovingState = () => {
      setMapBusy(map.isMoving());
    };

    map.on('movestart', syncMovingState);
    map.on('moveend', () => {
      syncMovingState();
      syncMapZoom();
      persistCamera();
    });
    map.on('zoomstart', () => {
      syncMovingState();
      revealZoomHint();
    });
    map.on('zoomend', () => {
      syncMovingState();
      syncMapZoom();
      scheduleHideZoomHint();
      persistCamera();
    });
    // Interactive on style load — do not wait for full tile idle.

    const handleNodeFeatureClickInit = (
      feature: maplibregl.MapGeoJSONFeature | undefined,
      lngLat?: maplibregl.LngLat,
      layerId?: string,
    ) => {
      handleNodeFeatureClick(map, feature, lngLat, layerId);
    };

    const bindMartinClicks = () => {
      const nodeLayers = ['nodes'] as const;
      for (const layerId of [...nodeLayers, ...TRANSFORMER_SYMBOL_LAYER_IDS]) {
        if (!map.getLayer(layerId)) continue;
        map.on('click', layerId, (e) => {
          handleNodeFeatureClickInit(e.features?.[0], e.lngLat, layerId);
        });
      }
    };

    const resizeMap = () => {
      if (mapRef.current) mapRef.current.resize();
    };
    resizeMap();
    requestAnimationFrame(resizeMap);

    const resizeObserver =
      container && typeof ResizeObserver !== 'undefined'
        ? new ResizeObserver(() => resizeMap())
        : null;
    resizeObserver?.observe(container);

    let detachHover: (() => void) | undefined;
    let detachPulse: (() => void) | undefined;

    map.once('load', () => {
      // Mark ready first so map setup failures (e.g. Martin tiles unavailable) never
      // leave the map in a permanently "not ready" state that blocks camera flys.
      try {
        syncGiopMapTheme(map, isLightModeRef.current);
        applyEcgBoundaryTheme(map, isLightModeRef.current);
        registerGiopMapIcons(map, isLightModeRef.current);
        const legendGroups = buildGiopLegendGroups(isLightModeRef.current, {
          includeGisOverview,
        });
        applyGiopLegendVisibility(
          map,
          createDefaultGiopLegendVisibility(legendGroups),
          {
            geometryMode: readNetworkGeometryMode(),
            gisOverviewAvailable: includeGisOverview,
          },
        );
        bindMartinClicks();
        detachHover = attachGiopMapHover(
          map,
          host,
          () => isLightModeRef.current,
          () => mapMeasureActiveRef.current || mapTraceActiveRef.current,
        );
        detachPulse = attachGiopMapPulseCanvasOverlay(map);
        pinTransformerLayersAboveNodes(map);
        resizeMap();
      } catch (err) {
        giopLog.map.warn('map load setup failed', err);
      }
      markMapReady();
      revealZoomHint();
      scheduleHideZoomHint(ZOOM_HINT_INITIAL_MS);
    });

    map.on('error', (event) => {
      const message = event.error?.message ?? String(event.error ?? event);
      // Martin plain-text zoom 404s used to parse as PBF ("Unimplemented type: N").
      // nginx now returns empty 204s; ignore any leftover browser-cached bodies.
      if (typeof message === 'string' && message.includes('Unimplemented type:')) {
        return;
      }
      giopLog.map.error('MapLibre error', message);
    });

    map.on('styleimagemissing', (event) => {
      if (event.id !== TRANSFORMER_ICON_ID || map.hasImage(TRANSFORMER_ICON_ID)) return;
      registerGiopMapIcons(map, isLightModeRef.current);
    });

    return () => {
      window.clearTimeout(hideZoomHintTimerRef.current);
      detachPulse?.();
      detachHover?.();
      resizeObserver?.disconnect();
      map.remove();
      mapRef.current = null;
      setMapReady(false);
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;

    applyMapTheme(map, isLightMode);
    if (!map.isStyleLoaded()) return;

    refreshGiopMapIcons(map, isLightMode);
    if (duplicateClusterOverlay && map.getLayer('duplicate-cluster-spokes')) {
      applyDuplicateClusterMapPaint(
        map,
        {
          spoke: 'duplicate-cluster-spokes',
          center: 'duplicate-cluster-center',
          pin: 'duplicate-cluster-pins',
          label: 'duplicate-cluster-labels',
          near: 'duplicate-near-line-layer',
        },
        duplicateClusterMapStyle(isLightMode),
        Boolean(duplicateClusterOverlay.nearLine),
      );
    }
    map.triggerRepaint();
  }, [isLightMode, duplicateClusterOverlay, mapReady]);

  useEffect(() => {
    if (!mapReady) return;
    const map = mapRef.current;
    if (!map) return;

    const readViewport = (): MapViewportContext | null => {
      if (!map.isStyleLoaded()) return null;
      const bounds = map.getBounds();
      const zoom = map.getZoom();
      const c = map.getCenter();
      const bbox: MapBbox = {
        west: bounds.getWest(),
        south: bounds.getSouth(),
        east: bounds.getEast(),
        north: bounds.getNorth(),
      };
      return {
        bbox,
        zoom,
        center: { lon: c.lng, lat: c.lat },
      };
    };

    const emitViewport = () => {
      const viewport = readViewport();
      if (!viewport) return;
      onViewportChangeRef.current?.(
        viewport.bbox,
        viewport.zoom,
        viewport.center,
      );
    };

    const unregisterViewportReader = registerMapViewportReader(readViewport);

    let debounceTimer: number | undefined;
    const scheduleSync = () => {
      window.clearTimeout(debounceTimer);
      debounceTimer = window.setTimeout(emitViewport, 250);
    };

    map.on('load', emitViewport);
    const onStyleReady = () => {
      if (map.isStyleLoaded()) emitViewport();
    };
    map.on('styledata', onStyleReady);
    window.setTimeout(onStyleReady, 300);
    map.on('moveend', scheduleSync);
    map.on('zoomend', scheduleSync);
    // Map may already be loaded before this effect runs (async gisOverview probe).
    if (map.isStyleLoaded()) {
      emitViewport();
    }

    return () => {
      unregisterViewportReader();
      window.clearTimeout(debounceTimer);
      map.off('load', emitViewport);
      map.off('styledata', onStyleReady);
      map.off('moveend', scheduleSync);
      map.off('zoomend', scheduleSync);
    };
  }, [mapReady, registerMapViewportReader]);

  useEffect(() => {
    // Skip on mount — style URLs are fresh; busting here re-downloads every Martin tile.
    if (refreshToken === 0) return;
    const map = mapRef.current;
    if (!map) return;

    const refreshIds = MARTIN_REFRESH_SOURCE_IDS;
    for (const id of refreshIds) {
      const src = map.getSource(id) as maplibregl.VectorTileSource | undefined;
      if (!src || typeof src.setTiles !== 'function') continue;
      const layer = martinLayerPath(id);
      src.setTiles([`${MARTIN_URL}/${layer}/{z}/{x}/{y}?v=${refreshToken}`]);
    }
    // Tile URL bust can leave overlay layout visibility out of sync — re-assert toggles.
    applyAllBoundaryVisibility(map, boundaryVisibilityRef.current, referenceMapConfigRef.current);
    map.triggerRepaint();
  }, [refreshToken]);

  useEffect(() => {
    if (refreshToken === 0) return;
    void getReferenceMapConfig()
      .then(setReferenceMapConfig)
      .catch((err) => {
        // Keep the last good catalog — clearing it removes Overlays toggles until a hard reload.
        giopLog.map.warn('reference map-config refresh failed; keeping previous', err);
      });
  }, [refreshToken]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady || referenceMapConfig.length === 0) return;

    const apply = () => {
      void applyReferenceMapConfig(map, referenceMapConfig, isLightModeRef.current)
        .then(() => {
          applyAllBoundaryVisibility(map, boundaryVisibilityRef.current, referenceMapConfig);
        })
        .catch((err) => {
          giopLog.map.warn('reference layer apply failed', err);
        });
    };

    if (map.isStyleLoaded()) apply();
    else whenMapCanAddLayers(map, apply);
  }, [referenceMapConfig, mapReady, isLightMode]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;

    const apply = () => applyAllBoundaryVisibility(map, boundaryVisibility, referenceMapConfig);
    whenMapCanAddLayers(map, apply);
    if (!anyBoundaryVisible) boundaryPopupRef.current?.remove();
  }, [boundaryVisibility, referenceMapConfig, mapReady, anyBoundaryVisible]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    if (!referenceMapConfig.some((c) => c.render_mode === 'geojson_bbox')) return;

    let debounceTimer: number | undefined;
    const schedule = () => {
      window.clearTimeout(debounceTimer);
      debounceTimer = window.setTimeout(() => {
        const bounds = map.getBounds();
        void refreshReferenceBboxLayers(
          map,
          referenceMapConfig,
          {
            west: bounds.getWest(),
            south: bounds.getSouth(),
            east: bounds.getEast(),
            north: bounds.getNorth(),
          },
          isLightModeRef.current,
        )
          .then(() => {
            applyAllBoundaryVisibility(map, boundaryVisibilityRef.current, referenceMapConfig);
          })
          .catch((err) => {
            giopLog.map.warn('reference bbox refresh failed', err);
          });
      }, 300);
    };

    schedule();
    map.on('moveend', schedule);
    map.on('zoomend', schedule);
    return () => {
      window.clearTimeout(debounceTimer);
      map.off('moveend', schedule);
      map.off('zoomend', schedule);
    };
  }, [referenceMapConfig, mapReady, isLightMode]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || mapBusy) return;

    const geojson = {
      type: 'FeatureCollection' as const,
      features: stagingAssets.flatMap((a) => {
        const coordinates = extractStagingGeomCoordinates(a.geom);
        if (!coordinates) return [];
        return [
          {
            type: 'Feature' as const,
            properties: {
              mrid: a.mrid,
              name: a.name || a.mrid,
              validation: a.validation ?? 'PENDING_FIELD',
            },
            geometry: {
              type: 'Point' as const,
              coordinates,
            },
          },
        ];
      }),
    };

    const sourceId = 'staging-overlay';

    const ensureStagingLayers = () => {
      if (!map.getSource(sourceId)) {
        map.addSource(sourceId, { type: 'geojson', data: geojson });
      } else {
        (map.getSource(sourceId) as maplibregl.GeoJSONSource).setData(geojson);
      }

      if (!map.getLayer('staging-points')) {
        map.addLayer({
          id: 'staging-points',
          type: 'circle',
          source: sourceId,
          paint: stagingPointCirclePaint(),
        });
        map.on('click', 'staging-points', (e) => {
          handleNodeFeatureClick(map, e.features?.[0], e.lngLat, 'staging-points');
        });
      }

      applyStagingMapLayersPaint(map);
      pinFocusIdentifyLayersToTop(map);
    };

    if (mapHasStyle(map)) {
      ensureStagingLayers();
    } else {
      whenMapCanAddLayers(map, ensureStagingLayers);
    }
  }, [stagingAssets, mapBusy]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || isSplitMap) return undefined;

    const geojson = {
      type: 'FeatureCollection' as const,
      features: fieldTechnicians.map((tech) => ({
        type: 'Feature' as const,
        properties: {
          technician_id: tech.technician_id,
          display_name: tech.display_name || tech.technician_id,
        },
        geometry: {
          type: 'Point' as const,
          coordinates: [tech.longitude, tech.latitude] as [number, number],
        },
      })),
    };

    const applyFieldTechnicians = () => {
      const sourceId = 'field-technicians';
      if (map.getSource(sourceId)) {
        (map.getSource(sourceId) as maplibregl.GeoJSONSource).setData(geojson);
      } else {
        map.addSource(sourceId, { type: 'geojson', data: geojson });
        map.addLayer({
          id: 'field-technician-halo',
          type: 'circle',
          source: sourceId,
          paint: {
            'circle-radius': 20,
            'circle-color': '#22d3ee',
            'circle-opacity': 0.15,
            'circle-stroke-width': 0,
          },
        });
        map.addLayer({
          id: 'field-technician-points',
          type: 'circle',
          source: sourceId,
          paint: {
            'circle-radius': 12,
            'circle-color': '#22d3ee',
            'circle-stroke-width': 3,
            'circle-stroke-color': '#0e7490',
          },
        });
        map.on('click', 'field-technician-points', (e) => {
          const f = e.features?.[0];
          if (f) showAssetIdentify(map, e.lngLat, f, 'field-technician-points');
          const id = f?.properties?.technician_id as string | undefined;
          if (id && onTechnicianClickRef.current) onTechnicianClickRef.current(id);
        });
      }
      pinFieldTechnicianLayersToTop(map);
    };

    return scheduleMapLayerWork(map, applyFieldTechnicians);
  }, [fieldTechnicians, isSplitMap]);

  // Camera fly on explicit focus requests (Audit side panel, Map tab).
  useEffect(() => {
    if (isOpsMap) return;
    if (territoryActive) return;
    if (!mapBusy || !focusMrid) return;

    const req = focusCameraRequest;
    if (!req) return;
    if (req.id <= handledCameraRequestIdRef.current) return;
    if (req.mrid !== focusMrid) return;

    const coords =
      normalizeMapCoordinates(req.coordinates) ??
      resolveStagingAssetCoordinates(req.mrid, {
        coordinates: focusCoordinates ?? null,
        stagingAssets: stagingAssetsRef.current,
      });
    if (!coords) return;

    const map = mapRef.current;
    if (!map) return;

    const performFly = () => {
      try {
        map.resize();
        const center = map.getCenter();
        const atTarget =
          Math.abs(center.lng - coords[0]) < 0.00005 && Math.abs(center.lat - coords[1]) < 0.00005;
        if (!req.boostZoom && atTarget) {
          handledCameraRequestIdRef.current = req.id;
          clearFocusCamera();
          return;
        }
        if (req.boostZoom) {
          flyToNodeFocus(map, coords, 800, {
            boostZoom: true,
            targetZoom: req.targetZoom,
          });
        } else if (!atTarget) {
          map.easeTo({ center: coords, duration: 500 });
        }
        handledCameraRequestIdRef.current = req.id;
        clearFocusCamera();
      } catch (err) {
        giopLog.map.error('focus camera failed', err);
      }
    };

    if (map.isStyleLoaded()) {
      performFly();
      return;
    }

    const onLoad = () => performFly();
    map.once('load', onLoad);
    return () => {
      map.off('load', onLoad);
    };
  }, [
    isOpsMap,
    focusCameraRequest,
    focusMrid,
    focusCoordinates,
    territoryActive,
    clearFocusCamera,
    gisOverviewAvailable,
    mapBusy,
    mapReady,
  ]);

  // Operations desk + DQ side panel: gate-free imperative pan.
  useEffect(() => {
    const req = flyRequest;
    if (!req) return;
    giopLog.map.info('flyRequest received', { id: req.id, coordinates: req.coordinates });
    const coords = normalizeMapCoordinates(req.coordinates);
    if (!coords) {
      giopLog.map.warn('flyRequest has no usable coordinates', req);
      return;
    }
    const map = mapRef.current;
    if (!map) {
      giopLog.map.warn('flyRequest received before map was created');
      return;
    }

    const boostZoom = req.boostZoom !== false;
    try {
      map.resize();
      const center = map.getCenter();
      const atTarget =
        Math.abs(center.lng - coords[0]) < 0.00005 && Math.abs(center.lat - coords[1]) < 0.00005;
      const atZoom =
        req.targetZoom != null && map.getZoom() >= req.targetZoom - 0.15;
      if (!boostZoom && atTarget) {
        pinFocusIdentifyLayersToTop(map);
        return;
      }
      if (boostZoom && atTarget && atZoom && req.targetZoom == null) {
        pinFocusIdentifyLayersToTop(map);
        return;
      }
      flyToNodeFocus(map, coords, 800, { boostZoom, targetZoom: req.targetZoom });
      giopLog.map.info('flyRequest pan issued', { coords, boostZoom });
      const onMoveEnd = () => {
        pinFocusIdentifyLayersToTop(map);
        map.off('moveend', onMoveEnd);
      };
      map.on('moveend', onMoveEnd);
    } catch (err) {
      giopLog.map.error('flyRequest pan failed', err);
    }
  }, [flyRequest?.id, mapReady]);

  useEffect(() => {
    const cmd = mapViewportCommand;
    if (!cmd) return;
    if (cmd.id <= handledViewportCommandIdRef.current) return;

    // Camera-only commands (fit/fly) don't need tiles or style layers — run
    // them as soon as the map instance exists so AI viewport actions are
    // never silently dropped while the map is still loading. The command
    // stays queued in context until a map instance can consume it.
    const map = mapRef.current;
    if (!map) return;

    try {
      map.resize();
      if (cmd.type === 'fit_bounds' && cmd.bbox) {
        fitMapBounds(map, cmd.bbox, {
          maxZoom: cmd.max_zoom ?? 14,
          padding: cmd.padding,
          duration: cmd.duration,
          minSpan: cmd.min_span,
        });
      } else if (cmd.type === 'fly_to' && cmd.center) {
        flyToLatLon(
          map,
          cmd.center.lon,
          cmd.center.lat,
          cmd.zoom ?? 16.5,
          cmd.duration ?? 900,
        );
      }
      handledViewportCommandIdRef.current = cmd.id;
      clearMapViewportCommand();
    } catch (err) {
      giopLog.map.error('viewport command failed', err);
    }
  }, [mapViewportCommand, clearMapViewportCommand, mapReady]);

  // Work-order dispatch pins (FR-012) — data sync only (not on every visibility toggle).
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;

    const geojson = {
      type: 'FeatureCollection' as const,
      features: workOrders.flatMap((wo) => {
        const lon = Number(wo.longitude);
        const lat = Number(wo.latitude);
        if (!Number.isFinite(lon) || !Number.isFinite(lat)) return [];
        return [
          {
            type: 'Feature' as const,
            properties: {
              mrid: wo.asset_mrid ?? wo.id,
              reference: wo.reference,
              summary: wo.summary,
              status: wo.status,
              work_type: wo.work_type,
            },
            geometry: {
              type: 'Point' as const,
              coordinates: [lon, lat] as [number, number],
            },
          },
        ];
      }),
    };

    const sourceId = 'work-orders-overlay';
    const layerId = 'work-order-pins';

    const ensureLayers = () => {
      if (!map.getSource(sourceId)) {
        map.addSource(sourceId, { type: 'geojson', data: geojson });
      } else {
        (map.getSource(sourceId) as maplibregl.GeoJSONSource).setData(geojson);
      }

      if (!map.getLayer(layerId)) {
        map.addLayer({
          id: layerId,
          type: 'circle',
          source: sourceId,
          layout: {
            visibility: showWorkOrdersLayerRef.current ? 'visible' : 'none',
          },
          paint: workOrderPinCirclePaint(),
        });
        map.on('click', layerId, (e) => {
          const f = e.features?.[0];
          if (f) showAssetIdentify(map, e.lngLat, f, layerId);
          const assetMrid = f?.properties?.mrid as string | undefined;
          const coords = (f?.geometry as { coordinates?: [number, number] })?.coordinates;
          if (assetMrid) {
            onNodeClickRef.current?.(assetMrid, coords);
          }
        });
      }
    };

    if (map.isStyleLoaded()) ensureLayers();
    else whenMapCanAddLayers(map, ensureLayers);
  }, [workOrders, mapReady]);

  // Visibility-only — avoid setData/setPaint on toggle (those force a heavy style rebuild).
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    const layerId = 'work-order-pins';
    const apply = () => {
      if (!map.getLayer(layerId)) return;
      map.setLayoutProperty(layerId, 'visibility', showWorkOrdersLayer ? 'visible' : 'none');
    };
    if (map.isStyleLoaded()) apply();
    else whenMapCanAddLayers(map, apply);
  }, [showWorkOrdersLayer, mapReady]);

  // Outage downstream impact highlight (FR-016).
  useEffect(() => {
    const map = mapRef.current;
    if (!map || mapBusy) return;

    let nodes: ReturnType<typeof topologyImpactToGeoJson>['nodes'];
    let edges: ReturnType<typeof topologyImpactToGeoJson>['edges'];
    try {
      ({ nodes, edges } = topologyImpactToGeoJson(impactOverlay));
    } catch (err) {
      giopLog.map.warn('impact overlay parse failed', err);
      return;
    }
    const nodeSourceId = 'impact-nodes';
    const edgeSourceId = 'impact-edges';

    const applyImpact = () => {
      if (!impactOverlay) {
        if (map.getLayer('impact-edges-layer')) map.removeLayer('impact-edges-layer');
        if (map.getLayer('impact-nodes-layer')) map.removeLayer('impact-nodes-layer');
        if (map.getSource(edgeSourceId)) map.removeSource(edgeSourceId);
        if (map.getSource(nodeSourceId)) map.removeSource(nodeSourceId);
        return;
      }

      if (map.getSource(nodeSourceId)) {
        (map.getSource(nodeSourceId) as maplibregl.GeoJSONSource).setData(nodes);
      } else if (nodes.features.length > 0) {
        map.addSource(nodeSourceId, { type: 'geojson', data: nodes });
      }

      if (nodes.features.length > 0 && map.getSource(nodeSourceId)) {
        if (!map.getLayer('impact-nodes-layer')) {
          map.addLayer({
            id: 'impact-nodes-layer',
            type: 'circle',
            source: nodeSourceId,
            paint: impactNodeCirclePaint(),
          });
        } else {
          const impactPaint = impactNodeCirclePaint();
          for (const key of Object.keys(impactPaint) as Array<keyof typeof impactPaint>) {
            map.setPaintProperty('impact-nodes-layer', key, impactPaint[key]);
          }
        }
      }

      if (map.getSource(edgeSourceId)) {
        (map.getSource(edgeSourceId) as maplibregl.GeoJSONSource).setData(edges);
      } else if (edges.features.length > 0) {
        map.addSource(edgeSourceId, { type: 'geojson', data: edges });
        map.addLayer(
          {
            id: 'impact-edges-layer',
            type: 'line',
            source: edgeSourceId,
            paint: {
              'line-color': '#f87171',
              'line-width': 2.5,
              'line-opacity': 0.85,
            },
          },
          map.getLayer('impact-nodes-layer') ? 'impact-nodes-layer' : undefined,
        );
      }
    };

    if (map.isStyleLoaded()) {
      applyImpact();
    } else {
      whenMapCanAddLayers(map, applyImpact);
    }
  }, [impactOverlay, mapBusy]);

  // Copilot feeder trace highlight.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || mapBusy) return;

    const nodes = feederHighlight?.geojson.nodes ?? EMPTY_FC;
    const edges = feederHighlight?.geojson.edges ?? EMPTY_FC;

    const applyFeederHighlight = () => {
      if (!feederHighlight) {
        if (map.getLayer(FEEDER_HIGHLIGHT_EDGE_LAYER)) map.removeLayer(FEEDER_HIGHLIGHT_EDGE_LAYER);
        if (map.getLayer(FEEDER_HIGHLIGHT_NODE_LAYER)) map.removeLayer(FEEDER_HIGHLIGHT_NODE_LAYER);
        if (map.getSource(FEEDER_HIGHLIGHT_EDGE_SOURCE)) map.removeSource(FEEDER_HIGHLIGHT_EDGE_SOURCE);
        if (map.getSource(FEEDER_HIGHLIGHT_NODE_SOURCE)) map.removeSource(FEEDER_HIGHLIGHT_NODE_SOURCE);
        return;
      }

      if (map.getSource(FEEDER_HIGHLIGHT_NODE_SOURCE)) {
        (map.getSource(FEEDER_HIGHLIGHT_NODE_SOURCE) as maplibregl.GeoJSONSource).setData(nodes);
      } else if (nodes.features.length > 0) {
        map.addSource(FEEDER_HIGHLIGHT_NODE_SOURCE, { type: 'geojson', data: nodes });
      }

      if (nodes.features.length > 0 && map.getSource(FEEDER_HIGHLIGHT_NODE_SOURCE)) {
        if (!map.getLayer(FEEDER_HIGHLIGHT_NODE_LAYER)) {
          map.addLayer({
            id: FEEDER_HIGHLIGHT_NODE_LAYER,
            type: 'circle',
            source: FEEDER_HIGHLIGHT_NODE_SOURCE,
            paint: feederHighlightNodePaint(isLightMode),
          });
        } else {
          const nodePaint = feederHighlightNodePaint(isLightMode);
          for (const key of Object.keys(nodePaint) as Array<keyof typeof nodePaint>) {
            map.setPaintProperty(FEEDER_HIGHLIGHT_NODE_LAYER, key, nodePaint[key]);
          }
        }
      }

      if (map.getSource(FEEDER_HIGHLIGHT_EDGE_SOURCE)) {
        (map.getSource(FEEDER_HIGHLIGHT_EDGE_SOURCE) as maplibregl.GeoJSONSource).setData(edges);
      } else if (edges.features.length > 0) {
        map.addSource(FEEDER_HIGHLIGHT_EDGE_SOURCE, { type: 'geojson', data: edges });
        map.addLayer(
          {
            id: FEEDER_HIGHLIGHT_EDGE_LAYER,
            type: 'line',
            source: FEEDER_HIGHLIGHT_EDGE_SOURCE,
            paint: feederHighlightEdgePaint(isLightMode),
          },
          map.getLayer(FEEDER_HIGHLIGHT_NODE_LAYER) ? FEEDER_HIGHLIGHT_NODE_LAYER : undefined,
        );
      }
    };

    if (map.isStyleLoaded()) {
      applyFeederHighlight();
    } else {
      whenMapCanAddLayers(map, applyFeederHighlight);
    }
  }, [feederHighlight, isLightMode, mapBusy]);

  // GIS import queue: highlight conductor line + labelled endpoints (hidden in Master-only mode).
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;

    const activeHighlight =
      importSegmentHighlight && networkGeometryMode !== 'master' ? importSegmentHighlight : null;
    const line = activeHighlight?.geojson.line ?? EMPTY_FC;
    const endpoints = activeHighlight?.geojson.endpoints ?? EMPTY_FC;
    const proposedAssets = activeHighlight?.geojson.proposed_assets ?? EMPTY_FC;
    const suggestedLinks = activeHighlight?.geojson.suggested_links ?? EMPTY_FC;

    const applyImportHighlight = () => {
      safeMapMutate(map, () => {
        if (!activeHighlight) {
          for (const layerId of [
            IMPORT_SEGMENT_PROPOSED_LABEL_LAYER,
            IMPORT_SEGMENT_PROPOSED_LAYER,
            IMPORT_SEGMENT_LINK_LAYER,
            IMPORT_SEGMENT_LABEL_LAYER,
            IMPORT_SEGMENT_ENDPOINT_LAYER,
            IMPORT_SEGMENT_LINE_LAYER,
          ]) {
            if (map.getLayer(layerId)) map.removeLayer(layerId);
          }
          for (const sourceId of [
            IMPORT_SEGMENT_LINK_SOURCE,
            IMPORT_SEGMENT_PROPOSED_SOURCE,
            IMPORT_SEGMENT_ENDPOINT_SOURCE,
            IMPORT_SEGMENT_LINE_SOURCE,
          ]) {
            if (map.getSource(sourceId)) map.removeSource(sourceId);
          }
          return;
        }

        if (map.getSource(IMPORT_SEGMENT_LINE_SOURCE)) {
          (map.getSource(IMPORT_SEGMENT_LINE_SOURCE) as maplibregl.GeoJSONSource).setData(line);
        } else if (line.features.length > 0) {
          map.addSource(IMPORT_SEGMENT_LINE_SOURCE, { type: 'geojson', data: line });
        }

        if (line.features.length > 0 && map.getSource(IMPORT_SEGMENT_LINE_SOURCE)) {
          if (!map.getLayer(IMPORT_SEGMENT_LINE_LAYER)) {
            map.addLayer({
              id: IMPORT_SEGMENT_LINE_LAYER,
              type: 'line',
              source: IMPORT_SEGMENT_LINE_SOURCE,
              layout: { 'line-cap': 'round', 'line-join': 'round' },
              paint: importSegmentLinePaint(isLightMode),
            });
          } else {
            const linePaint = importSegmentLinePaint(isLightMode);
            for (const key of Object.keys(linePaint) as Array<keyof typeof linePaint>) {
              map.setPaintProperty(IMPORT_SEGMENT_LINE_LAYER, key, linePaint[key]);
            }
          }
        }

        if (map.getSource(IMPORT_SEGMENT_ENDPOINT_SOURCE)) {
          (map.getSource(IMPORT_SEGMENT_ENDPOINT_SOURCE) as maplibregl.GeoJSONSource).setData(endpoints);
        } else if (endpoints.features.length > 0) {
          map.addSource(IMPORT_SEGMENT_ENDPOINT_SOURCE, { type: 'geojson', data: endpoints });
        }

        if (endpoints.features.length > 0 && map.getSource(IMPORT_SEGMENT_ENDPOINT_SOURCE)) {
          if (!map.getLayer(IMPORT_SEGMENT_ENDPOINT_LAYER)) {
            map.addLayer({
              id: IMPORT_SEGMENT_ENDPOINT_LAYER,
              type: 'circle',
              source: IMPORT_SEGMENT_ENDPOINT_SOURCE,
              paint: importSegmentEndpointPaint(isLightMode),
            });
          } else {
            const endpointPaint = importSegmentEndpointPaint(isLightMode);
            for (const key of Object.keys(endpointPaint) as Array<keyof typeof endpointPaint>) {
              map.setPaintProperty(IMPORT_SEGMENT_ENDPOINT_LAYER, key, endpointPaint[key]);
            }
          }

          if (!map.getLayer(IMPORT_SEGMENT_LABEL_LAYER)) {
            map.addLayer({
              id: IMPORT_SEGMENT_LABEL_LAYER,
              type: 'symbol',
              source: IMPORT_SEGMENT_ENDPOINT_SOURCE,
              layout: importSegmentLabelLayout(),
              paint: importSegmentLabelPaint(isLightMode),
            });
          } else {
            const labelPaint = importSegmentLabelPaint(isLightMode);
            for (const key of Object.keys(labelPaint) as Array<keyof typeof labelPaint>) {
              map.setPaintProperty(IMPORT_SEGMENT_LABEL_LAYER, key, labelPaint[key]);
            }
          }
        }

        if (map.getSource(IMPORT_SEGMENT_LINK_SOURCE)) {
          (map.getSource(IMPORT_SEGMENT_LINK_SOURCE) as maplibregl.GeoJSONSource).setData(suggestedLinks);
        } else if (suggestedLinks.features.length > 0) {
          map.addSource(IMPORT_SEGMENT_LINK_SOURCE, { type: 'geojson', data: suggestedLinks });
        }

        if (suggestedLinks.features.length > 0 && map.getSource(IMPORT_SEGMENT_LINK_SOURCE)) {
          if (!map.getLayer(IMPORT_SEGMENT_LINK_LAYER)) {
            map.addLayer({
              id: IMPORT_SEGMENT_LINK_LAYER,
              type: 'line',
              source: IMPORT_SEGMENT_LINK_SOURCE,
              layout: { 'line-cap': 'round', 'line-join': 'round' },
              paint: importSegmentSuggestedLinkPaint(isLightMode),
            });
          } else {
            const linkPaint = importSegmentSuggestedLinkPaint(isLightMode);
            for (const key of Object.keys(linkPaint) as Array<keyof typeof linkPaint>) {
              map.setPaintProperty(IMPORT_SEGMENT_LINK_LAYER, key, linkPaint[key]);
            }
          }
        }

        if (map.getSource(IMPORT_SEGMENT_PROPOSED_SOURCE)) {
          (map.getSource(IMPORT_SEGMENT_PROPOSED_SOURCE) as maplibregl.GeoJSONSource).setData(
            proposedAssets,
          );
        } else if (proposedAssets.features.length > 0) {
          map.addSource(IMPORT_SEGMENT_PROPOSED_SOURCE, { type: 'geojson', data: proposedAssets });
        }

        if (proposedAssets.features.length > 0 && map.getSource(IMPORT_SEGMENT_PROPOSED_SOURCE)) {
          if (!map.getLayer(IMPORT_SEGMENT_PROPOSED_LAYER)) {
            map.addLayer({
              id: IMPORT_SEGMENT_PROPOSED_LAYER,
              type: 'circle',
              source: IMPORT_SEGMENT_PROPOSED_SOURCE,
              paint: importSegmentProposedPaint(isLightMode),
            });
          } else {
            const proposedPaint = importSegmentProposedPaint(isLightMode);
            for (const key of Object.keys(proposedPaint) as Array<keyof typeof proposedPaint>) {
              map.setPaintProperty(IMPORT_SEGMENT_PROPOSED_LAYER, key, proposedPaint[key]);
            }
          }

          if (!map.getLayer(IMPORT_SEGMENT_PROPOSED_LABEL_LAYER)) {
            map.addLayer({
              id: IMPORT_SEGMENT_PROPOSED_LABEL_LAYER,
              type: 'symbol',
              source: IMPORT_SEGMENT_PROPOSED_SOURCE,
              layout: importSegmentProposedLabelLayout(),
              paint: importSegmentLabelPaint(isLightMode),
            });
          }
        }

        pinFocusIdentifyLayersToTop(map);
      });
    };

    if (map.isStyleLoaded()) {
      applyImportHighlight();
    } else {
      whenMapCanAddLayers(map, applyImportHighlight);
    }
  }, [importSegmentHighlight, isLightMode, mapReady, networkGeometryMode]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady || !mapMeasureActive) return;

    const POINT_HIT_PAD = 12;
    const SNAP_PAD_PX = 10;
    const DRAG_THRESHOLD_PX = 3;

    const setMeasureCursor = (cursor: string) => {
      if (mapMeasureActiveRef.current) {
        map.getCanvas().style.cursor = cursor;
      }
    };

    const hitMeasurePointIndex = (point: { x: number; y: number }): number | null => {
      if (!map.getLayer(MAP_MEASURE_POINT_LAYER)) return null;
      const hits = map.queryRenderedFeatures(
        [
          [point.x - POINT_HIT_PAD, point.y - POINT_HIT_PAD],
          [point.x + POINT_HIT_PAD, point.y + POINT_HIT_PAD],
        ],
        { layers: [MAP_MEASURE_POINT_LAYER, MAP_MEASURE_POINT_HALO_LAYER].filter((id) => map.getLayer(id)) },
      );
      for (const feature of hits) {
        const rawIndex = feature.properties?.index;
        const index = typeof rawIndex === 'number' ? rawIndex : Number(rawIndex);
        if (Number.isFinite(index)) return index;
      }
      return null;
    };

    const resolveCoord = (point: { x: number; y: number }): [number, number] => {
      const snap = snapMeasurePoint(map, point, SNAP_PAD_PX);
      return snap.coord;
    };

    const onClick = (event: maplibregl.MapMouseEvent) => {
      if (!mapMeasureActiveRef.current) return;
      if (measureSkipClickRef.current) {
        measureSkipClickRef.current = false;
        return;
      }

      // Left-click on an existing vertex is for drag only — do not add a duplicate.
      if (hitMeasurePointIndex(event.point) != null) return;

      const [lon, lat] = resolveCoord(event.point);
      addMeasurePoint(lon, lat);
    };

    const onContextMenu = (event: maplibregl.MapMouseEvent) => {
      if (!mapMeasureActiveRef.current) return;
      event.preventDefault();
      const hitIndex = hitMeasurePointIndex(event.point);
      if (hitIndex != null) {
        removeMeasurePoint(hitIndex);
      }
    };

    const onPointMouseDown = (event: maplibregl.MapLayerMouseEvent) => {
      if (!mapMeasureActiveRef.current) return;
      // Only left-button starts a drag; right-click is handled by contextmenu.
      if (event.originalEvent.button !== 0) return;
      const rawIndex = event.features?.[0]?.properties?.index;
      const index = typeof rawIndex === 'number' ? rawIndex : Number(rawIndex);
      if (!Number.isFinite(index)) return;
      event.preventDefault();
      measureDragRef.current = {
        index,
        startX: event.point.x,
        startY: event.point.y,
        moved: false,
      };
      map.dragPan.disable();
    };

    const onMouseMove = (event: maplibregl.MapMouseEvent) => {
      const drag = measureDragRef.current;
      if (!drag) return;
      const dx = event.point.x - drag.startX;
      const dy = event.point.y - drag.startY;
      if (!drag.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
      if (!drag.moved) {
        drag.moved = true;
        measureSkipClickRef.current = true;
        setMeasureDragging(true);
        setMeasureCursor('grabbing');
      }
      const [lon, lat] = resolveCoord(event.point);
      updateMeasurePoint(drag.index, lon, lat);
    };

    const endDrag = () => {
      const drag = measureDragRef.current;
      if (!drag) return;
      measureDragRef.current = null;
      map.dragPan.enable();
      if (drag.moved) {
        setMeasureDragging(false);
      }
      setMeasureCursor('crosshair');
    };

    const onPointEnter = () => {
      if (!mapMeasureActiveRef.current || measureDragRef.current?.moved) return;
      setMeasureCursor('grab');
    };

    const onPointLeave = () => {
      if (!mapMeasureActiveRef.current || measureDragRef.current) return;
      setMeasureCursor('crosshair');
    };

    setMeasureCursor('crosshair');
    map.on('click', onClick);
    map.on('contextmenu', onContextMenu);
    map.on('mousemove', onMouseMove);
    map.on('mouseup', endDrag);
    map.on('mouseleave', endDrag);
    map.on('mousedown', MAP_MEASURE_POINT_LAYER, onPointMouseDown);
    map.on('mousedown', MAP_MEASURE_POINT_HALO_LAYER, onPointMouseDown);
    map.on('mouseenter', MAP_MEASURE_POINT_LAYER, onPointEnter);
    map.on('mouseleave', MAP_MEASURE_POINT_LAYER, onPointLeave);

    return () => {
      map.off('click', onClick);
      map.off('contextmenu', onContextMenu);
      map.off('mousemove', onMouseMove);
      map.off('mouseup', endDrag);
      map.off('mouseleave', endDrag);
      map.off('mousedown', MAP_MEASURE_POINT_LAYER, onPointMouseDown);
      map.off('mousedown', MAP_MEASURE_POINT_HALO_LAYER, onPointMouseDown);
      map.off('mouseenter', MAP_MEASURE_POINT_LAYER, onPointEnter);
      map.off('mouseleave', MAP_MEASURE_POINT_LAYER, onPointLeave);
      measureDragRef.current = null;
      setMeasureDragging(false);
      map.dragPan.enable();
      if (!mapMeasureActiveRef.current) {
        map.getCanvas().style.cursor = '';
      }
    };
  }, [addMeasurePoint, mapMeasureActive, mapReady, removeMeasurePoint, updateMeasurePoint]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;

    const { line, points, labels } = buildMeasureGeoJson(measurePoints);
    const showMeasure = mapMeasureActive && measurePoints.length > 0;

    const applyMeasureOverlay = () => {
      safeMapMutate(map, () => {
        if (!showMeasure) {
          if (map.getLayer(MAP_MEASURE_LABEL_LAYER)) map.removeLayer(MAP_MEASURE_LABEL_LAYER);
          if (map.getLayer(MAP_MEASURE_POINT_LAYER)) map.removeLayer(MAP_MEASURE_POINT_LAYER);
          if (map.getLayer(MAP_MEASURE_POINT_HALO_LAYER)) map.removeLayer(MAP_MEASURE_POINT_HALO_LAYER);
          if (map.getLayer(MAP_MEASURE_LINE_LAYER)) map.removeLayer(MAP_MEASURE_LINE_LAYER);
          if (map.getSource(MAP_MEASURE_LABEL_SOURCE)) map.removeSource(MAP_MEASURE_LABEL_SOURCE);
          if (map.getSource(MAP_MEASURE_POINT_SOURCE)) map.removeSource(MAP_MEASURE_POINT_SOURCE);
          if (map.getSource(MAP_MEASURE_LINE_SOURCE)) map.removeSource(MAP_MEASURE_LINE_SOURCE);
          return;
        }

        if (map.getSource(MAP_MEASURE_LINE_SOURCE)) {
          (map.getSource(MAP_MEASURE_LINE_SOURCE) as maplibregl.GeoJSONSource).setData(line);
        } else if (line.features.length > 0) {
          map.addSource(MAP_MEASURE_LINE_SOURCE, { type: 'geojson', data: line });
        }

        if (line.features.length > 0 && map.getSource(MAP_MEASURE_LINE_SOURCE) && !map.getLayer(MAP_MEASURE_LINE_LAYER)) {
          map.addLayer({
            id: MAP_MEASURE_LINE_LAYER,
            type: 'line',
            source: MAP_MEASURE_LINE_SOURCE,
            layout: { 'line-cap': 'round', 'line-join': 'round' },
            paint: measureLinePaint(isLightMode),
          });
        } else if (map.getLayer(MAP_MEASURE_LINE_LAYER)) {
          const linePaint = measureLinePaint(isLightMode);
          for (const key of Object.keys(linePaint) as Array<keyof typeof linePaint>) {
            map.setPaintProperty(MAP_MEASURE_LINE_LAYER, key, linePaint[key]);
          }
        }

        if (map.getSource(MAP_MEASURE_POINT_SOURCE)) {
          (map.getSource(MAP_MEASURE_POINT_SOURCE) as maplibregl.GeoJSONSource).setData(points);
        } else if (points.features.length > 0) {
          map.addSource(MAP_MEASURE_POINT_SOURCE, { type: 'geojson', data: points });
        }

        if (points.features.length > 0 && map.getSource(MAP_MEASURE_POINT_SOURCE) && !map.getLayer(MAP_MEASURE_POINT_HALO_LAYER)) {
          map.addLayer({
            id: MAP_MEASURE_POINT_HALO_LAYER,
            type: 'circle',
            source: MAP_MEASURE_POINT_SOURCE,
            paint: measurePointHaloPaint(isLightMode),
          });
        } else if (map.getLayer(MAP_MEASURE_POINT_HALO_LAYER)) {
          const haloPaint = measurePointHaloPaint(isLightMode);
          for (const key of Object.keys(haloPaint) as Array<keyof typeof haloPaint>) {
            map.setPaintProperty(MAP_MEASURE_POINT_HALO_LAYER, key, haloPaint[key]);
          }
        }

        if (points.features.length > 0 && map.getSource(MAP_MEASURE_POINT_SOURCE) && !map.getLayer(MAP_MEASURE_POINT_LAYER)) {
          map.addLayer({
            id: MAP_MEASURE_POINT_LAYER,
            type: 'circle',
            source: MAP_MEASURE_POINT_SOURCE,
            paint: measurePointPaint(isLightMode),
          });
        } else if (map.getLayer(MAP_MEASURE_POINT_LAYER)) {
          const pointPaint = measurePointPaint(isLightMode);
          for (const key of Object.keys(pointPaint) as Array<keyof typeof pointPaint>) {
            map.setPaintProperty(MAP_MEASURE_POINT_LAYER, key, pointPaint[key]);
          }
        }

        if (map.getSource(MAP_MEASURE_LABEL_SOURCE)) {
          (map.getSource(MAP_MEASURE_LABEL_SOURCE) as maplibregl.GeoJSONSource).setData(labels);
        } else if (labels.features.length > 0) {
          map.addSource(MAP_MEASURE_LABEL_SOURCE, { type: 'geojson', data: labels });
        }

        if (labels.features.length > 0 && map.getSource(MAP_MEASURE_LABEL_SOURCE) && !map.getLayer(MAP_MEASURE_LABEL_LAYER)) {
          map.addLayer({
            id: MAP_MEASURE_LABEL_LAYER,
            type: 'symbol',
            source: MAP_MEASURE_LABEL_SOURCE,
            layout: measureLabelLayout(),
            paint: measureLabelPaint(isLightMode),
          });
        } else if (map.getLayer(MAP_MEASURE_LABEL_LAYER)) {
          const labelPaint = measureLabelPaint(isLightMode);
          for (const key of Object.keys(labelPaint) as Array<keyof typeof labelPaint>) {
            map.setPaintProperty(MAP_MEASURE_LABEL_LAYER, key, labelPaint[key]);
          }
        }

        pinFocusIdentifyLayersToTop(map);
        pinMeasureLayersToTop(map);
      });
    };

    if (map.isStyleLoaded()) {
      applyMeasureOverlay();
    } else {
      whenMapCanAddLayers(map, applyMeasureOverlay);
    }
  }, [isLightMode, mapMeasureActive, mapReady, measurePoints]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;

    const showClearance = mapClearanceActive && measurePoints.length > 0;
    const clearance = showClearance
      ? buildClearanceGeoJson(measurePoints, clearanceRadiusM)
      : { type: 'FeatureCollection' as const, features: [] };

    const applyClearanceOverlay = () => {
      safeMapMutate(map, () => {
        if (!showClearance || clearance.features.length === 0) {
          if (map.getLayer(MAP_CLEARANCE_OUTLINE_LAYER)) map.removeLayer(MAP_CLEARANCE_OUTLINE_LAYER);
          if (map.getLayer(MAP_CLEARANCE_FILL_LAYER)) map.removeLayer(MAP_CLEARANCE_FILL_LAYER);
          if (map.getSource(MAP_CLEARANCE_SOURCE)) map.removeSource(MAP_CLEARANCE_SOURCE);
          return;
        }

        if (map.getSource(MAP_CLEARANCE_SOURCE)) {
          (map.getSource(MAP_CLEARANCE_SOURCE) as maplibregl.GeoJSONSource).setData(clearance);
        } else {
          map.addSource(MAP_CLEARANCE_SOURCE, { type: 'geojson', data: clearance });
        }

        if (!map.getLayer(MAP_CLEARANCE_FILL_LAYER)) {
          map.addLayer({
            id: MAP_CLEARANCE_FILL_LAYER,
            type: 'fill',
            source: MAP_CLEARANCE_SOURCE,
            paint: clearanceFillPaint(isLightMode),
          });
        } else {
          const fillPaint = clearanceFillPaint(isLightMode);
          for (const key of Object.keys(fillPaint) as Array<keyof typeof fillPaint>) {
            map.setPaintProperty(MAP_CLEARANCE_FILL_LAYER, key, fillPaint[key]);
          }
        }

        if (!map.getLayer(MAP_CLEARANCE_OUTLINE_LAYER)) {
          map.addLayer({
            id: MAP_CLEARANCE_OUTLINE_LAYER,
            type: 'line',
            source: MAP_CLEARANCE_SOURCE,
            layout: { 'line-cap': 'round', 'line-join': 'round' },
            paint: clearanceOutlinePaint(isLightMode),
          });
        } else {
          const outlinePaint = clearanceOutlinePaint(isLightMode);
          for (const key of Object.keys(outlinePaint) as Array<keyof typeof outlinePaint>) {
            map.setPaintProperty(MAP_CLEARANCE_OUTLINE_LAYER, key, outlinePaint[key]);
          }
        }

        pinMeasureLayersToTop(map);
      });
    };

    if (map.isStyleLoaded()) {
      applyClearanceOverlay();
    } else {
      whenMapCanAddLayers(map, applyClearanceOverlay);
    }
  }, [clearanceRadiusM, isLightMode, mapClearanceActive, mapReady, measurePoints]);

  // FR-005 topology repair preview (before/after segment snap).
  useEffect(() => {
    const map = mapRef.current;
    if (!map || mapBusy) return;

    const beforeSourceId = 'repair-preview-before';
    const afterSourceId = 'repair-preview-after';
    const before = repairPreviewLayers?.before ?? EMPTY_FC;
    const after = repairPreviewLayers?.after ?? EMPTY_FC;
    const hasPreview = before.features.length > 0 || after.features.length > 0;

    const applyRepairPreview = () => {
      if (!hasPreview) {
        safeRemoveLayer(map, 'repair-preview-after-layer');
        safeRemoveLayer(map, 'repair-preview-before-layer');
        safeRemoveSource(map, afterSourceId);
        safeRemoveSource(map, beforeSourceId);
        return;
      }

      if (map.getSource(beforeSourceId)) {
        (map.getSource(beforeSourceId) as maplibregl.GeoJSONSource).setData(before);
      } else if (before.features.length > 0) {
        map.addSource(beforeSourceId, { type: 'geojson', data: before });
      }

      if (before.features.length > 0 && map.getSource(beforeSourceId) && !map.getLayer('repair-preview-before-layer')) {
        map.addLayer({
          id: 'repair-preview-before-layer',
          type: 'line',
          source: beforeSourceId,
          paint: {
            'line-color': '#f59e0b',
            'line-width': 3,
            'line-opacity': 0.9,
            'line-dasharray': [2, 2],
          },
        });
      }

      if (map.getSource(afterSourceId)) {
        (map.getSource(afterSourceId) as maplibregl.GeoJSONSource).setData(after);
      } else if (after.features.length > 0) {
        map.addSource(afterSourceId, { type: 'geojson', data: after });
      }

      if (after.features.length > 0 && map.getSource(afterSourceId) && !map.getLayer('repair-preview-after-layer')) {
        map.addLayer({
          id: 'repair-preview-after-layer',
          type: 'line',
          source: afterSourceId,
          paint: {
            'line-color': '#22c55e',
            'line-width': 3.5,
            'line-opacity': 0.95,
          },
        });
      }
    };

    if (map.isStyleLoaded()) {
      applyRepairPreview();
    } else {
      whenMapCanAddLayers(map, applyRepairPreview);
    }
  }, [repairPreviewLayers, mapBusy]);

  // Duplicate cluster fan pins + optional near-duplicate connector line.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) {
      return () => {};
    }

    const sourceId = 'duplicate-cluster';
    const spokeLayerId = 'duplicate-cluster-spokes';
    const centerLayerId = 'duplicate-cluster-center';
    const pinLayerId = 'duplicate-cluster-pins';
    const labelLayerId = 'duplicate-cluster-labels';
    const nearSourceId = 'duplicate-near-line';
    const nearLayerId = 'duplicate-near-line-layer';
    const layerIds = [spokeLayerId, centerLayerId, pinLayerId, labelLayerId, nearLayerId] as const;
    let cancelPendingApply: (() => void) | undefined;

    const teardown = () => {
      for (const id of layerIds) {
        safeRemoveLayer(map, id);
      }
      safeRemoveSource(map, sourceId);
      safeRemoveSource(map, nearSourceId);
    };

    if (!duplicateClusterOverlay) {
      teardown();
      safeMapMutate(map, () => {
        if (map.getLayer('staging-points')) {
          map.setLayoutProperty('staging-points', 'visibility', 'visible');
        }
      });
      return () => {
        cancelPendingApply?.();
        teardown();
      };
    }

    safeMapMutate(map, () => {
      if (map.getLayer('staging-points')) {
        map.setLayoutProperty('staging-points', 'visibility', 'none');
      }
    });

    const overlay = duplicateClusterOverlay;
    const clusterGeojson = buildDuplicateClusterGeoJson(overlay, 0);
    const orbitEnabled =
      duplicateClusterOrbitEnabled(overlay) &&
      typeof window !== 'undefined' &&
      !window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    const nearGeojson = overlay.nearLine
      ? {
          type: 'FeatureCollection' as const,
          features: [
            {
              type: 'Feature' as const,
              properties: {
                distanceM: overlay.nearLine.distanceM ?? null,
              },
              geometry: {
                type: 'LineString' as const,
                coordinates: [overlay.nearLine.from, overlay.nearLine.to],
              },
            },
          ],
        }
      : EMPTY_FC;

    let cancelled = false;
    let orbitRaf = 0;
    let orbitPhase = 0;
    let orbitLastTs = 0;

    const tickOrbit = (ts: number) => {
      if (cancelled || !orbitEnabled) return;
      if (!orbitLastTs) orbitLastTs = ts;
      const dt = Math.min(0.05, (ts - orbitLastTs) / 1000);
      orbitLastTs = ts;
      orbitPhase =
        (orbitPhase + (dt / DUPLICATE_FAN_ORBIT_PERIOD_S) * (2 * Math.PI)) % (2 * Math.PI);

      const src = map.getSource(sourceId) as maplibregl.GeoJSONSource | undefined;
      if (src) {
        src.setData(buildDuplicateClusterGeoJson(overlay, orbitPhase));
      }
      orbitRaf = window.requestAnimationFrame(tickOrbit);
    };

    const startOrbitLoop = () => {
      if (cancelled || !orbitEnabled || orbitRaf) return;
      orbitLastTs = 0;
      orbitRaf = window.requestAnimationFrame(tickOrbit);
    };

    const apply = () => {
      if (!mapHasStyle(map)) return;
      const mapStyle = duplicateClusterMapStyle(isLightMode);
      const layerIdMap = {
        spoke: spokeLayerId,
        center: centerLayerId,
        pin: pinLayerId,
        label: labelLayerId,
        near: nearLayerId,
      };
      safeMapMutate(map, () => {
        const existing = map.getSource(sourceId) as maplibregl.GeoJSONSource | undefined;
        if (existing) {
          existing.setData(clusterGeojson);
          applyDuplicateClusterMapPaint(map, layerIdMap, mapStyle, Boolean(overlay.nearLine));
        } else {
          for (const id of layerIds) {
            if (map.getLayer(id)) map.removeLayer(id);
          }
          if (map.getSource(sourceId)) map.removeSource(sourceId);
          if (map.getSource(nearSourceId)) map.removeSource(nearSourceId);

          map.addSource(sourceId, { type: 'geojson', data: clusterGeojson });

          map.addLayer({
            id: spokeLayerId,
            type: 'line',
            source: sourceId,
            filter: ['==', ['geometry-type'], 'LineString'],
            paint: {
              'line-color': mapStyle.spokeColor,
              'line-width': [
                'case',
                ['==', ['get', 'isActive'], 1],
                mapStyle.spokeActiveWidth,
                mapStyle.spokeInactiveWidth,
              ],
              'line-opacity': [
                'case',
                ['==', ['get', 'isActive'], 1],
                mapStyle.spokeActiveOpacity,
                mapStyle.spokeInactiveOpacity,
              ],
              'line-dasharray': [2, 2],
            },
          });

          map.addLayer({
            id: centerLayerId,
            type: 'circle',
            source: sourceId,
            filter: ['all', ['==', ['geometry-type'], 'Point'], ['!', ['has', 'mrid']]],
            paint: {
              'circle-radius': 3,
              'circle-color': mapStyle.centerColor,
              'circle-stroke-width': 1,
              'circle-stroke-color': mapStyle.centerStroke,
            },
          });

          map.addLayer({
            id: pinLayerId,
            type: 'circle',
            source: sourceId,
            filter: ['all', ['==', ['geometry-type'], 'Point'], ['has', 'mrid']],
            paint: {
              'circle-radius': [
                'case',
                ['==', ['get', 'isActive'], 1],
                mapStyle.pinActiveRadius,
                mapStyle.pinInactiveRadius,
              ],
              'circle-color': ['get', 'color'],
              'circle-stroke-width': ['case', ['==', ['get', 'isActive'], 1], 2.5, 1.5],
              'circle-stroke-color': mapStyle.pinStroke,
            },
          });

          map.addLayer({
            id: labelLayerId,
            type: 'symbol',
            source: sourceId,
            filter: ['all', ['==', ['geometry-type'], 'Point'], ['has', 'mrid']],
            layout: {
              'text-field': ['get', 'name'],
              'text-size': [
                'case',
                ['==', ['get', 'isActive'], 1],
                11.5,
                10,
              ],
              'text-offset': [0, 1.2],
              'text-anchor': 'top',
              'text-font': GIOP_MAP_LABEL_FONT_BOLD,
              'text-allow-overlap': true,
            },
            paint: {
              'text-color': mapStyle.labelColor,
              'text-halo-color': mapStyle.labelHalo,
              'text-halo-width': mapStyle.labelHaloWidth,
            },
          });
        }

        const nearExisting = map.getSource(nearSourceId) as maplibregl.GeoJSONSource | undefined;
        if (nearExisting) {
          nearExisting.setData(nearGeojson);
          applyDuplicateClusterMapPaint(map, layerIdMap, mapStyle, Boolean(overlay.nearLine));
        } else if (overlay.nearLine) {
          map.addSource(nearSourceId, { type: 'geojson', data: nearGeojson });
          map.addLayer({
            id: nearLayerId,
            type: 'line',
            source: nearSourceId,
            paint: {
              'line-color': mapStyle.nearLineColor,
              'line-width': mapStyle.nearLineWidth,
              'line-opacity': mapStyle.nearLineOpacity,
              'line-dasharray': [1.5, 1.5],
            },
          });
        }
        pinFocusIdentifyLayersToTop(map);
        startOrbitLoop();
      });
    };

    cancelPendingApply?.();
    if (mapHasStyle(map)) apply();
    else cancelPendingApply = whenMapCanAddLayers(map, () => {
      if (!cancelled) apply();
    });

    return () => {
      cancelled = true;
      cancelPendingApply?.();
      if (orbitRaf) window.cancelAnimationFrame(orbitRaf);
      teardown();
      safeMapMutate(map, () => {
        if (map.getLayer('staging-points')) {
          map.setLayoutProperty('staging-points', 'visibility', 'visible');
        }
      });
    };
  }, [duplicateClusterOverlay, gisOverviewAvailable, mapBusy, isLightMode]);

  // Duplicate stacks: zoom to street-level fan view (~zoom 19).
  const duplicateActiveMrid =
    duplicateClusterOverlay?.pins.find((pin) => pin.isActive)?.mrid ?? null;

  useEffect(() => {
    if (!duplicateClusterOverlay) return;
    const map = mapRef.current;
    if (!map) return;

    const performFly = () => {
      try {
        map.resize();
        flyToDuplicateClusterView(map, duplicateClusterOverlay);
        giopLog.map.info('duplicate cluster fly issued', {
          mode: duplicateClusterOverlay.mode,
          pinCount: duplicateClusterOverlay.pins.length,
          activeMrid: duplicateActiveMrid,
        });
      } catch (err) {
        giopLog.map.error('duplicate cluster fly failed', err);
      }
    };

    if (map.isStyleLoaded()) {
      performFly();
      return;
    }
    const onLoad = () => performFly();
    map.once('load', onLoad);
    return () => {
      map.off('load', onLoad);
    };
  }, [duplicateClusterOverlay, duplicateActiveMrid, gisOverviewAvailable, mapReady]);

  // Focused asset label + pulse — keep visible while focused; do not rebuild on every pan/zoom.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) {
      return () => {};
    }

    const sourceId = 'focus-identify';
    const pointLayerId = 'focus-identify-point';
    const labelLayerId = 'focus-identify-label';
    const layerIds = [pointLayerId, labelLayerId] as const;
    let cancelPendingApply: (() => void) | undefined;

    const teardown = () => {
      for (const id of layerIds) {
        safeRemoveLayer(map, id);
      }
      safeRemoveSource(map, sourceId);
    };

    if (!pulseFocus || !focusMrid || duplicateClusterOverlay) {
      return () => {
        cancelPendingApply?.();
        teardown();
      };
    }

    let cancelled = false;
    const labelText =
      (focusLabel && focusLabel.trim()) || 'Unnamed asset';

    const applyWithCoords = (coordinates: [number, number]) => {
      if (cancelled) return;
      const coords = normalizeMapCoordinates(coordinates);
      if (!coords) return;

      const geojson = {
        type: 'FeatureCollection' as const,
        features: [
          {
            type: 'Feature' as const,
            properties: { mrid: focusMrid, name: labelText },
            geometry: {
              type: 'Point' as const,
              coordinates: coords,
            },
          },
        ],
      };

      const apply = () => {
        if (cancelled || !mapHasStyle(map)) return;
        safeMapMutate(map, () => {
          const existing = map.getSource(sourceId) as maplibregl.GeoJSONSource | undefined;
          if (existing) {
            existing.setData(geojson);
            const paint = pulseFocusTentative ? focusTentativeCirclePaint() : focusIdentifyCirclePaint();
            if (map.getLayer(pointLayerId)) {
              map.setPaintProperty(pointLayerId, 'circle-color', paint['circle-color']!);
            }
            return;
          }

          for (const id of layerIds) {
            if (map.getLayer(id)) map.removeLayer(id);
          }
          if (map.getSource(sourceId)) map.removeSource(sourceId);

          map.addSource(sourceId, { type: 'geojson', data: geojson });

          map.addLayer({
            id: pointLayerId,
            type: 'circle',
            source: sourceId,
            paint: pulseFocusTentative ? focusTentativeCirclePaint() : focusIdentifyCirclePaint(),
          });

          map.addLayer({
            id: labelLayerId,
            type: 'symbol',
            source: sourceId,
            layout: {
              'text-field': ['get', 'name'],
              'text-size': ['interpolate', ['linear'], ['zoom'], 13, 11, 17, 14, 18, 15],
              'text-offset': [0, -1.8],
              'text-anchor': 'bottom',
              'text-font': GIOP_MAP_LABEL_FONT_BOLD,
              'text-allow-overlap': true,
              'text-ignore-placement': true,
            },
            paint: mapSymbolLabelPaint(isLightModeRef.current, 'focus'),
          });
          pinFocusIdentifyLayersToTop(map);
        });
      };

      cancelPendingApply?.();
      if (mapHasStyle(map)) apply();
      else cancelPendingApply = whenMapCanAddLayers(map, apply);
    };

    const resolved =
      resolveStagingAssetCoordinates(focusMrid, {
        coordinates: focusCoordinates ?? null,
        stagingAssets: stagingAssetsRef.current,
      });
    const activeFanPin = duplicateClusterOverlay?.pins.find(
      (pin) => pin.isActive && pin.mrid === focusMrid,
    );
    const focusCoords = activeFanPin?.coordinates ?? resolved;
    if (focusCoords) {
      applyWithCoords(focusCoords);
      return () => {
        cancelled = true;
        cancelPendingApply?.();
        teardown();
      };
    }

    if (!focusMrid || !isUuidMrid(focusMrid)) {
      return () => {
        cancelled = true;
        cancelPendingApply?.();
        teardown();
      };
    }

    void getAssetLocation(focusMrid)
      .then((loc) => {
        if (cancelled || loc.longitude == null || loc.latitude == null) return;
        const coords = normalizeMapCoordinates([loc.longitude, loc.latitude]);
        if (coords) applyWithCoords(coords);
      })
      .catch(() => {
        /* pulse skipped when coords unknown */
      });

    return () => {
      cancelled = true;
      cancelPendingApply?.();
      teardown();
    };
  }, [pulseFocus, pulseFocusTentative, focusMrid, focusCoordinates, focusLabel, gisOverviewAvailable, flyRequest?.id, duplicateClusterOverlay, isLightMode]);

  // De-emphasise neighbouring poles while side-map identify is active.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const nodeLayerIds = ['nodes'] as const;

    const restore = () => {
      safeMapMutate(map, () => {
        const tilePaint = tileNodeCirclePaint(isLightModeRef.current);
        if (map.getLayer('nodes') && tilePaint['circle-opacity'] != null) {
          map.setPaintProperty('nodes', 'circle-opacity', tilePaint['circle-opacity']);
        }
      });
    };

    if (!pulseFocus) {
      restore();
      return restore;
    }

    const dim = () => {
      safeMapMutate(map, () => {
        for (const id of nodeLayerIds) {
          if (map.getLayer(id)) map.setPaintProperty(id, 'circle-opacity', 0.18);
        }
      });
    };

    if (map.isStyleLoaded()) dim();
    else {
      const cancel = whenMapCanAddLayers(map, dim);
      return () => {
        cancel();
        restore();
      };
    }

    return restore;
  }, [pulseFocus, isLightMode]);

  // H3 rebuild-coverage overlay (Martin vector tiles — toggle visibility only).
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const visibility = showCoverage ? 'visible' : 'none';
    const apply = () => {
      if (showCoverage) {
        const src = map.getSource(H3_REBUILD_COVERAGE_SOURCE) as maplibregl.VectorTileSource | undefined;
        if (src && typeof src.reload === 'function') {
          src.reload();
        }
      }
      for (const layerId of H3_COVERAGE_LAYER_IDS) {
        if (map.getLayer(layerId)) {
          map.setLayoutProperty(layerId, 'visibility', visibility);
        }
      }
      if (showCoverage) {
        const outlinePaint = h3CoverageOutlinePaint(isLightModeRef.current);
        for (const layerId of H3_COVERAGE_LAYER_IDS) {
          if (layerId.includes('-outline-') && map.getLayer(layerId)) {
            map.setPaintProperty(layerId, 'line-color', outlinePaint['line-color']);
          }
        }
      }
    };

    if (map.isStyleLoaded()) apply();
    else return whenMapCanAddLayers(map, apply);
  }, [showCoverage, isLightMode]);

  useEffect(() => {
    if (territoryHighlight) {
      setBoundaryVisibility((prev) => ({ ...prev, 'ecg-admin-boundaries': true }));
    }
  }, [territoryHighlight]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const apply = () => {
      if (territoryHighlight) {
        applyTerritoryHighlight(map, territoryHighlight, isLightModeRef.current);
      } else {
        removeTerritoryHighlightLayers(map);
      }
    };

    return whenMapCanAddLayers(map, apply);
  }, [territoryHighlight, mapBusy]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !territoryHighlight) return;

    const onDismiss = () => clearTerritoryHighlight();
    map.on('click', onDismiss);
    return () => {
      map.off('click', onDismiss);
    };
  }, [territoryHighlight, clearTerritoryHighlight]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !territoryHighlight) return;

    const applyTheme = () => {
      applyTerritoryHighlight(map, territoryHighlight, isLightModeRef.current);
    };
    if (map.isStyleLoaded()) applyTheme();
    else map.once('load', applyTheme);
  }, [isLightMode, territoryHighlight]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !anyBoundaryVisible) return;

    const boundaryHitLayers = boundaryHitLayerIds(boundaryVisibility, referenceMapConfig);

    const onClick = (e: maplibregl.MapLayerMouseEvent) => {
      if (territoryActiveRef.current) return;
      const feature = e.features?.[0];
      if (!feature) return;
      onTerritorySelectRef.current?.(territoryFromBoundaryFeature(feature));
      if (!boundaryPopupRef.current) {
        boundaryPopupRef.current = new maplibregl.Popup({
          closeButton: true,
          closeOnClick: true,
          maxWidth: '280px',
        });
      }
      boundaryPopupRef.current
        .setLngLat(e.lngLat)
        .setHTML(ecgBoundaryPopupHtml(feature, isLightModeRef.current))
        .addTo(map);
    };
    const onEnter = () => {
      if (
        !territoryActiveRef.current &&
        !mapMeasureActiveRef.current &&
        !mapTraceActiveRef.current
      ) {
        map.getCanvas().style.cursor = 'pointer';
      }
    };
    const onLeave = () => {
      if (!mapMeasureActiveRef.current && !mapTraceActiveRef.current) {
        map.getCanvas().style.cursor = '';
      }
    };

    whenMapCanAddLayers(map, () => {
      for (const layerId of boundaryHitLayers) {
        if (!map.getLayer(layerId)) continue;
        map.on('click', layerId, onClick);
        map.on('mouseenter', layerId, onEnter);
        map.on('mouseleave', layerId, onLeave);
      }
    });

    return () => {
      for (const layerId of boundaryHitLayers) {
        map.off('click', layerId, onClick);
        map.off('mouseenter', layerId, onEnter);
        map.off('mouseleave', layerId, onLeave);
      }
    };
  }, [anyBoundaryVisible, boundaryVisibility, referenceMapConfig]);

  const handleSearchPreview = useCallback((result: GiopMapSearchResult | null) => {
    const map = mapRef.current;
    if (!map || !result) return;
    applySearchResultCamera(map, result, { duration: 1000 });
  }, []);

  const searchBridgeHandlersRef = useRef({
    onPreview: handleSearchPreview,
    onSelect: ((_result: GiopMapSearchResult) => {}) as (result: GiopMapSearchResult) => void,
  });

  const handleSearchSelect = useCallback(
    (result: GiopMapSearchResult) => {
      clearFocusCamera();
      clearMapViewportCommand();

      const map = mapRef.current;
      if (map) {
        applySearchResultCamera(map, result, { duration: 900 });
      }

      const coords =
        result.longitude != null && result.latitude != null
          ? ([result.longitude, result.latitude] as [number, number])
          : null;

      if (result.kind === 'asset') {
        if (coords && map) {
          onNodeClickRef.current?.(result.id, coords);
        } else {
          void focusOnMap(result.id, {
            name: result.title,
            sidePanel: false,
            navigateTab: false,
            source: 'map',
          });
        }
        return;
      }

      if (result.kind === 'place') {
        onTerritorySelectRef.current?.({
          district: result.title,
          region: result.subtitle ?? undefined,
        });
        return;
      }

      if (result.kind === 'crew') {
        onTechnicianClickRef.current?.(result.id);
      }
    },
    [clearFocusCamera, clearMapViewportCommand, focusOnMap],
  );

  searchBridgeHandlersRef.current = {
    onPreview: handleSearchPreview,
    onSelect: handleSearchSelect,
  };

  useEffect(() => {
    if (!searchBridgeRef) return;
    searchBridgeRef.current = {
      onPreview: (result) => searchBridgeHandlersRef.current.onPreview(result),
      onSelect: (result) => searchBridgeHandlersRef.current.onSelect(result),
      placeCatalog,
      opsCatalog,
      placesReady,
    };
    onSearchBridgeCatalog?.({ placeCatalog, opsCatalog, placesReady });
    return () => {
      if (searchBridgeRef.current) {
        searchBridgeRef.current = null;
      }
    };
  }, [searchBridgeRef, onSearchBridgeCatalog, placeCatalog, opsCatalog, placesReady]);

  return (
    <GiopTerritoryProvider
      mapRef={mapRef}
      mapReady={!mapBusy}
      isLightMode={isLightMode}
      fieldTechnicians={fieldTechnicians}
      active={territoryActive}
      onActiveChange={setTerritoryActive}
    >
      <div
        className={`giop-map-host${isSplitMap ? ' giop-map-host--split' : ''}${
          mapMeasureActive ? ' giop-map-host--measure' : ''
        }${mapTraceActive ? ' giop-map-host--trace' : ''}${
          measureDragging ? ' giop-map-host--measure-dragging' : ''
        }`}
      >
        <div ref={containerRef} className="absolute inset-0" />
        {showSearchBar && (
          <GiopMapSearchBar
            isLightMode={isLightMode}
            placeCatalog={placeCatalog}
            opsCatalog={opsCatalog}
            placesReady={placesReady}
            onPreview={handleSearchPreview}
            onSelect={handleSearchSelect}
            gisOverviewAvailable={gisOverviewAvailable}
          />
        )}
        {mapTraceActive && (
          <div
            className={`giop-map-measure-hud pointer-events-auto giop-map-measure-hud--trace ${
              isLightMode ? 'giop-map-measure-hud--light' : 'giop-map-measure-hud--dark'
            }`}
          >
            <span>
              {mapTraceLoading
                ? mapTraceStatus ?? 'Tracing…'
                : mapTraceStatus ?? 'Click a pole or transformer to trace downstream'}
            </span>
            <button
              type="button"
              className="giop-map-measure-hud__clear"
              onClick={() => {
                clearImpactOverlay();
                setMapTraceStatus('Click a pole or transformer to trace downstream');
              }}
            >
              Clear
            </button>
            <button
              type="button"
              className="giop-map-measure-hud__clear"
              onClick={() => setMapTraceActive(false)}
            >
              Done
            </button>
          </div>
        )}
        {mapMeasureActive && (
          <div
            className={`giop-map-measure-hud pointer-events-auto ${
              isLightMode ? 'giop-map-measure-hud--light' : 'giop-map-measure-hud--dark'
            }${mapClearanceActive ? ' giop-map-measure-hud--clearance' : ''}`}
          >
            <span>
              {measurePoints.length === 0
                ? mapClearanceActive
                  ? 'Clearance: place a point or path, then pick a radius'
                  : 'Measure: snap to nodes · left-click add · right-click remove · drag adjust'
                : mapClearanceActive
                  ? `Clearance ${clearanceRadiusM} m · ${formatClearanceArea(clearanceAreaMeters2(measurePoints, clearanceRadiusM))} · path ${formatMeasureMeters(measureTotalMeters)}`
                  : `Length: ${formatMeasureMeters(measureTotalMeters)} · WGS84 geodesic (${measurePoints.length} pt${measurePoints.length === 1 ? '' : 's'})`}
            </span>
            {mapClearanceActive && (
              <div className="giop-map-measure-hud__radii" role="group" aria-label="Clearance radius">
                {CLEARANCE_RADIUS_PRESETS_M.map((radius) => (
                  <button
                    key={radius}
                    type="button"
                    className={`giop-map-measure-hud__radius${
                      clearanceRadiusM === radius ? ' giop-map-measure-hud__radius--active' : ''
                    }`}
                    onClick={() => setClearanceRadiusM(radius)}
                  >
                    {radius} m
                  </button>
                ))}
              </div>
            )}
            {measurePoints.length > 0 && (
              <button type="button" className="giop-map-measure-hud__clear" onClick={clearMeasure}>
                Clear
              </button>
            )}
          </div>
        )}
        <div className="pointer-events-none absolute top-3 right-16 z-10 flex items-start gap-2 flex-row-reverse">
          {fieldCrews && !isSplitMap && (
            <div className="pointer-events-auto shrink-0">
              <GiopMapFieldPanel
                isLightMode={isLightMode}
                mode={territoryActive ? 'territory' : 'crews'}
                technicians={fieldTechnicians}
                selectedId={fieldCrews.selectedId}
                submissions={fieldCrews.submissions}
                loading={fieldCrews.loading}
                error={fieldCrews.error}
                onSelect={fieldCrews.onSelect}
                onClear={fieldCrews.onClear}
                onFocusTechnician={fieldCrews.onFocusTechnician}
                onFocusAsset={fieldCrews.onFocusAsset}
              />
            </div>
          )}
          {!isOpsMap && !isSplitMap && (
          <div
            className={`giop-map-zoom-hint shrink-0 rounded-md border px-3 py-2 text-xs shadow-lg ${
              zoomHintVisible ? 'giop-map-zoom-hint--visible' : ''
            } ${
              isLightMode
                ? 'border-slate-200 bg-white/90 text-slate-700'
                : 'border-premium-border/70 bg-premium-card text-slate-200'
            }`}
            aria-hidden={!zoomHintVisible}
          >
            Zoom {mapZoom.toFixed(1)}
          </div>
          )}
        </div>
        {!isOpsMap && !showSearchBar && !isSplitMap && (
        <GiopNetworkGeometryToggle
          isLightMode={isLightMode}
          gisOverviewAvailable={gisOverviewAvailable}
          unpromotedGapAvailable={unpromotedGapAvailable}
          mode={networkGeometryMode}
          onModeChange={setNetworkGeometryMode}
        />
        )}
        {!isOpsMap && (
        <GiopMapControlPanel
          isLightMode={isLightMode}
          groups={[
            {
              label: 'Dispatch',
              toggles: [
                {
                  id: 'work-orders',
                  label: 'Work orders',
                  color: '#8b5cf6',
                  active: showWorkOrdersLayer,
                  onToggle: () => setShowWorkOrdersLayer((v) => !v),
                  hint: 'Toggle work-order dispatch pins',
                },
              ],
            },
            {
              label: 'Overlays',
              toggles: [
                ...boundaryOverlayProducts.map((product) => ({
                  id: product.slug,
                  label: product.display_name,
                  color: '#0ea5e9',
                  active: Boolean(boundaryVisibility[product.slug]),
                  onToggle: () => toggleBoundaryOverlay(product.slug),
                  hint: product.hint,
                })),
                {
                  id: 'coverage',
                  label: 'Rebuild coverage',
                  color: '#22c55e',
                  active: showCoverage,
                  onToggle: () => setShowCoverage((v) => !v),
                  hint: 'Toggle H3 rebuild-coverage heatmap',
                },
              ],
            },
          ]}
          footerSlot={isSplitMap ? undefined : <GiopTerritoryMapToggle inline />}
        />
        )}
        {!isOpsMap && (
        <GiopMapLegend
          isLightMode={isLightMode}
          mapRef={mapRef}
          mapZoom={mapZoom}
          mapReady={!mapBusy}
          includeGisOverview={gisOverviewAvailable}
          geometryMode={networkGeometryMode}
        />
        )}
      </div>
    </GiopTerritoryProvider>
  );
}
