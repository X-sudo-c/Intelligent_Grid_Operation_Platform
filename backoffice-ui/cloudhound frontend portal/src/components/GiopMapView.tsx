import { useEffect, useRef, useState } from 'react';
import maplibregl from '../lib/maplibreSetup';
import { MARTIN_URL, getAssetLocation, getH3Coverage } from '../api/giop-api';
import type { GiopStagingAsset, GiopGraphChunkResponse, GiopFieldTechnician, GiopWorkOrder, GiopTopologyPayload } from '../api/giop-api';
import { useGiopGraphChunk } from '../hooks/useGiopGraphChunk';
import { chunkToNodeGeoJson, chunkToTracedNodeGeoJson } from '../lib/giopChunkGeoJson';
import type { MapBbox } from '../hooks/useGiopGraphChunk';
import {
  applyTileLayerTheme,
  buildGiopMapStyle,
  applyStagingMapLayersPaint,
  stagingPointCirclePaint,
  workOrderPinCirclePaint,
  impactNodeCirclePaint,
  tracedHighlightCirclePaint,
  focusIdentifyCirclePaint,
  tileNodeCirclePaint,
  WORK_ORDER_PULSE_FILTER,
  CHUNK_NODE_MIN_ZOOM,
  chunkNodeCirclePaint,
  MARTIN_REFRESH_SOURCE_IDS,
  martinLayerPath,
  MIN_MAP_ZOOM,
  NODE_DETAIL_ZOOM,
  fitMapBounds,
  flyToLatLon,
  flyToNodeFocus,
  panToNodeFocus,
} from '../lib/giopMapLayers';
import { refreshGiopMapIcons, registerGiopMapIcons } from '../lib/giopMapIcons';
import { attachGiopMapHover } from '../lib/giopMapHover';
import {
  createGiopIdentifyPopup,
  identifyKindForLayer,
  showGiopIdentifyPopup,
} from '../lib/giopMapIdentify';
import { attachGiopMapPulseLoop } from '../lib/giopMapPulse';
import { normalizeMapCoordinates } from '../lib/giopMapCoordinates';
import { topologyImpactToGeoJson } from '../lib/giopImpactGeoJson';
import {
  applyTerritoryHighlight,
  clearTerritoryHighlight as removeTerritoryHighlightLayers,
} from '../lib/giopTerritoryHighlight';
import {
  ECG_BOUNDARY_HIT_LAYER_IDS,
  applyEcgBoundaryTheme,
  ecgBoundaryPopupHtml,
  setEcgBoundaryVisibility,
  territoryFromBoundaryFeature,
} from '../lib/giopBoundaries';
import { GiopMapControlPanel } from './GiopMapControlPanel';
import { GiopMapLegend } from './GiopMapLegend';
import { GiopMapFieldPanel } from './GiopMapFieldPanel';
import { GiopTerritoryMapToggle, GiopTerritoryProvider } from '../context/GiopTerritoryContext';
import { useGiopMapOverlay } from '../context/GiopMapOverlayContext';

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
  startMrid?: string;
  streamGraphChunk?: boolean;
  graphChunk?: GiopGraphChunkResponse | null;
  chunkLoadingExternal?: boolean;
  chunkErrorExternal?: string | null;
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
  /** Pulsing ripple on the focused node (side-map identify only). */
  pulseFocus?: boolean;
}

const DEFAULT_CENTER: [number, number] = [-0.2941, 5.6812];
const EMPTY_FC = { type: 'FeatureCollection' as const, features: [] };

const H3_COVERAGE_FILL = 'h3-coverage-fill';
const H3_COVERAGE_OUTLINE = 'h3-coverage-outline';
const H3_COVERAGE_SOURCE = 'h3-coverage';
const ZOOM_HINT_HIDE_MS = 1500;
const ZOOM_HINT_INITIAL_MS = 2000;

/** Coarser hexes when zoomed out, finer when zoomed in. */
function coverageResForZoom(zoom: number): number {
  if (zoom < 9) return 6;
  if (zoom < 11) return 7;
  if (zoom < 13) return 8;
  return 9;
}

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
    console.warn('[GiopMap] layer mutation skipped:', err);
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

function whenMapCanAddLayers(map: maplibregl.Map, fn: () => void): () => void {
  let cancelled = false;
  const run = () => {
    if (cancelled || !mapHasStyle(map)) return;
    try {
      fn();
    } catch (err) {
      console.warn('[GiopMap] layer mutation failed:', err);
    }
  };
  if (map.isStyleLoaded()) {
    run();
  } else {
    map.once('load', run);
    map.once('styledata', () => {
      if (map.isStyleLoaded()) run();
    });
  }
  return () => {
    cancelled = true;
  };
}

function applyMapTheme(map: maplibregl.Map, isLightMode: boolean) {
  applyTileLayerTheme(map, isLightMode);
  applyEcgBoundaryTheme(map, isLightMode);
}

function chunkOverlayData(
  chunk: GiopGraphChunkResponse | null,
  zoom: number,
): {
  edges: typeof EMPTY_FC;
  nodes: ReturnType<typeof chunkToNodeGeoJson>;
  traced: ReturnType<typeof chunkToTracedNodeGeoJson>;
} {
  const showNodes = zoom >= CHUNK_NODE_MIN_ZOOM && zoom < NODE_DETAIL_ZOOM;
  return {
    edges: EMPTY_FC,
    nodes: showNodes ? chunkToNodeGeoJson(chunk) : EMPTY_FC,
    traced: showNodes ? chunkToTracedNodeGeoJson(chunk) : EMPTY_FC,
  };
}

export function GiopMapView({
  isLightMode = false,
  focusMrid,
  focusCoordinates,
  focusLabel,
  stagingAssets = [],
  fieldTechnicians = [],
  onNodeClick,
  onTechnicianClick,
  onViewportChange,
  onTerritorySelect,
  refreshToken = 0,
  startMrid,
  streamGraphChunk = true,
  graphChunk: graphChunkExternal = null,
  chunkLoadingExternal: _chunkLoadingExternal = false,
  chunkErrorExternal: _chunkErrorExternal = null,
  fieldCrews,
  workOrders = [],
  impactOverlay = null,
  pulseFocus = false,
}: GiopMapViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const onNodeClickRef = useRef(onNodeClick);
  const onTechnicianClickRef = useRef(onTechnicianClick);
  const onViewportChangeRef = useRef(onViewportChange);
  const onTerritorySelectRef = useRef(onTerritorySelect);
  const isLightModeRef = useRef(isLightMode);
  const [mapBusy, setMapBusy] = useState(true);
  const [mapZoom, setMapZoom] = useState(11);
  const [zoomHintVisible, setZoomHintVisible] = useState(false);
  const hideZoomHintTimerRef = useRef<number | undefined>(undefined);
  const [showCoverage, setShowCoverage] = useState(false);
  const [showBoundaries, setShowBoundaries] = useState(false);
  const showBoundariesRef = useRef(false);
  const boundaryPopupRef = useRef<maplibregl.Popup | null>(null);
  const identifyPopupRef = useRef<maplibregl.Popup | null>(null);
  const [showWorkOrdersLayer, setShowWorkOrdersLayer] = useState(true);
  const [territoryActive, setTerritoryActive] = useState(false);
  const territoryActiveRef = useRef(false);
  const handledCameraRequestIdRef = useRef(0);
  const handledViewportCommandIdRef = useRef(0);
  const { focusCameraRequest, clearFocusCamera, mapViewportCommand, clearMapViewportCommand, territoryHighlight, clearTerritoryHighlight } =
    useGiopMapOverlay();

  const { chunk: internalChunk, loadBbox } = useGiopGraphChunk(startMrid);

  const chunk = streamGraphChunk ? internalChunk : graphChunkExternal;

  territoryActiveRef.current = territoryActive;
  showBoundariesRef.current = showBoundaries;

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
    if (!containerRef.current || mapRef.current) return;

    const light = isLightModeRef.current;
    const container = containerRef.current;
    const host = container.parentElement;
    if (!host) return;

    const map = new maplibregl.Map({
      container: containerRef.current,
      style: buildGiopMapStyle(MARTIN_URL, light),
      center: DEFAULT_CENTER,
      zoom: 13,
      minZoom: MIN_MAP_ZOOM,
      maxZoom: 20,
    });

    map.addControl(new maplibregl.NavigationControl(), 'top-right');
    mapRef.current = map;

    const syncMapState = () => {
      setMapZoom(Number(map.getZoom().toFixed(1)));
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
      syncMapState();
      setMapBusy(false);
    };

    map.on('movestart', () => setMapBusy(true));
    map.on('zoomstart', () => {
      setMapBusy(true);
      revealZoomHint();
    });
    map.on('zoom', syncMapState);
    map.on('moveend', () => setMapBusy(false));
    map.on('zoomend', () => {
      markMapReady();
      scheduleHideZoomHint();
    });

    const handleNodeFeatureClickInit = (
      feature: maplibregl.MapGeoJSONFeature | undefined,
      lngLat?: maplibregl.LngLat,
      layerId?: string,
    ) => {
      handleNodeFeatureClick(map, feature, lngLat, layerId);
    };

    const bindMartinClicks = () => {
      for (const layerId of ['nodes', 'nodes-transformers-dt', 'nodes-transformers-pt'] as const) {
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
      registerGiopMapIcons(map, isLightModeRef.current);
      bindMartinClicks();
      detachHover = attachGiopMapHover(map, host, () => isLightModeRef.current);
      detachPulse = attachGiopMapPulseLoop(map);
      if (showBoundariesRef.current) {
        setEcgBoundaryVisibility(map, true);
      }
      resizeMap();
      markMapReady();
      revealZoomHint();
      scheduleHideZoomHint(ZOOM_HINT_INITIAL_MS);
    });

    map.on('error', (event) => {
      console.warn('[GiopMap] MapLibre error:', event.error?.message ?? event);
    });

    return () => {
      window.clearTimeout(hideZoomHintTimerRef.current);
      detachPulse?.();
      detachHover?.();
      resizeObserver?.disconnect();
      map.remove();
      mapRef.current = null;
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const apply = () => {
      applyMapTheme(map, isLightMode);
      if (map.isStyleLoaded()) {
        refreshGiopMapIcons(map, isLightMode);
        map.triggerRepaint();
      }
    };
    if (map.isStyleLoaded()) {
      apply();
    } else {
      map.once('load', apply);
    }
  }, [isLightMode]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const emitViewport = () => {
      const bounds = map.getBounds();
      const bbox: MapBbox = {
        west: bounds.getWest(),
        south: bounds.getSouth(),
        east: bounds.getEast(),
        north: bounds.getNorth(),
      };
      const zoom = map.getZoom();
      const c = map.getCenter();
      onViewportChangeRef.current?.(bbox, zoom, { lon: c.lng, lat: c.lat });
      if (streamGraphChunk && zoom >= CHUNK_NODE_MIN_ZOOM && zoom < NODE_DETAIL_ZOOM) {
        void loadBbox(bbox, zoom);
      }
    };

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

    return () => {
      window.clearTimeout(debounceTimer);
      map.off('load', emitViewport);
      map.off('styledata', onStyleReady);
      map.off('moveend', scheduleSync);
      map.off('zoomend', scheduleSync);
    };
  }, [loadBbox, streamGraphChunk]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || refreshToken === 0) return;

    const v = Date.now();
    for (const id of MARTIN_REFRESH_SOURCE_IDS) {
      const src = map.getSource(id) as maplibregl.VectorTileSource | undefined;
      if (!src || typeof src.setTiles !== 'function') continue;
      const layer = martinLayerPath(id);
      src.setTiles([`${MARTIN_URL}/${layer}/{z}/{x}/{y}?v=${v}`]);
    }
    map.triggerRepaint();
  }, [refreshToken]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const applyChunkLayers = () => {
      const zoom = map.getZoom();
      const { edges: edgeData, nodes: nodeData, traced: tracedData } = chunkOverlayData(chunk, zoom);
      const edgeSourceId = 'graph-chunk-edges';
      const nodeSourceId = 'graph-chunk-nodes';
      const tracedSourceId = 'graph-chunk-traced';

      if (map.getSource(nodeSourceId)) {
        (map.getSource(nodeSourceId) as maplibregl.GeoJSONSource).setData(nodeData);
      } else if (nodeData.features.length > 0) {
        map.addSource(nodeSourceId, { type: 'geojson', data: nodeData });
        map.addLayer(
          {
            id: 'graph-chunk-nodes-layer',
            type: 'circle',
            source: nodeSourceId,
            paint: chunkNodeCirclePaint(isLightModeRef.current),
          },
          map.getLayer('nodes') ? 'nodes' : undefined,
        );
        map.on('click', 'graph-chunk-nodes-layer', (e) => {
          const f = e.features?.[0];
          handleNodeFeatureClick(map, f, e.lngLat, 'graph-chunk-nodes-layer');
        });
      }

      if (map.getSource(edgeSourceId)) {
        (map.getSource(edgeSourceId) as maplibregl.GeoJSONSource).setData(edgeData);
      } else {
        map.addSource(edgeSourceId, { type: 'geojson', data: edgeData });
        map.addLayer(
          {
            id: 'graph-chunk-edges-layer',
            type: 'line',
            source: edgeSourceId,
            paint: {
              'line-color': ['coalesce', ['get', 'color'], '#475569'],
              'line-width': ['interpolate', ['linear'], ['zoom'], 5, 0.9, 7, 1.1, 9, 1.4, 12, 1.8],
              'line-opacity': ['interpolate', ['linear'], ['zoom'], 5, 0.72, 8, 0.8, 13, 0.9],
            },
          },
          map.getLayer('nodes') ? 'nodes' : undefined,
        );
      }

      if (map.getSource(tracedSourceId)) {
        (map.getSource(tracedSourceId) as maplibregl.GeoJSONSource).setData(tracedData);
      } else if (tracedData.features.length > 0) {
        map.addSource(tracedSourceId, { type: 'geojson', data: tracedData });
        map.addLayer({
          id: 'graph-chunk-traced-layer',
          type: 'circle',
          source: tracedSourceId,
          paint: tracedHighlightCirclePaint(),
        });
      }
    };

    if (map.isStyleLoaded()) {
      applyChunkLayers();
    } else {
      whenMapCanAddLayers(map, applyChunkLayers);
    }
  }, [chunk, mapZoom]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || mapBusy) return;

    const geojson = {
      type: 'FeatureCollection' as const,
      features: stagingAssets
        .filter((a) => a.geom?.coordinates)
        .map((a) => ({
          type: 'Feature' as const,
          properties: {
            mrid: a.mrid,
            name: a.name || a.mrid,
            validation: a.validation ?? 'PENDING_FIELD',
          },
          geometry: {
            type: 'Point' as const,
            coordinates: a.geom!.coordinates,
          },
        })),
    };

    const sourceId = 'staging-overlay';

    const ensureStagingLayers = () => {
      if (!map.getSource(sourceId)) {
        map.addSource(sourceId, { type: 'geojson', data: geojson });
      } else {
        (map.getSource(sourceId) as maplibregl.GeoJSONSource).setData(geojson);
      }

      for (const rippleId of ['staging-points-pulse', 'staging-points-pulse-2'] as const) {
        if (!map.getLayer(rippleId)) {
          map.addLayer({
            id: rippleId,
            type: 'circle',
            source: sourceId,
            filter: ['in', ['get', 'validation'], ['literal', ['PENDING_FIELD', 'STAGED']]],
            paint: {
              'circle-radius': 6,
              'circle-color': [
                'match',
                ['get', 'validation'],
                'STAGED',
                '#3b82f6',
                '#f59e0b',
              ],
              'circle-opacity': 0,
              'circle-stroke-width': 1.5,
              'circle-stroke-color': [
                'match',
                ['get', 'validation'],
                'STAGED',
                '#3b82f6',
                '#f59e0b',
              ],
              'circle-stroke-opacity': 0,
            },
          });
        }
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
    };

    if (map.isStyleLoaded()) {
      ensureStagingLayers();
    } else {
      whenMapCanAddLayers(map, ensureStagingLayers);
    }
  }, [stagingAssets, mapBusy]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.isStyleLoaded()) return;

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
  }, [fieldTechnicians]);

  // Camera moves only on explicit focusOnMap requests — not selection/staging churn.
  useEffect(() => {
    if (territoryActive || !focusMrid) return;

    const req = focusCameraRequest;
    if (!req || req.mrid !== focusMrid) return;
    if (req.id <= handledCameraRequestIdRef.current) return;

    const coords = normalizeMapCoordinates(focusCoordinates);
    if (!coords) return;

    const map = mapRef.current;
    if (!map) return;

    const performFly = () => {
      try {
        if (req.boostZoom) {
          flyToNodeFocus(map, coords, 800, { boostZoom: true });
        } else {
          panToNodeFocus(map, coords);
        }
        handledCameraRequestIdRef.current = req.id;
        // Clear the consumed request so a later remount (e.g. re-entering the
        // Map tab) does not re-fly to this node — the Map tab must stay free.
        clearFocusCamera();
      } catch (err) {
        console.warn('[GiopMap] focus camera failed:', err);
      }
    };

    // On a freshly mounted map (e.g. side-panel remount per mrid) the style
    // is not loaded yet and MapLibre silently drops flyTo. Wait for 'load'
    // before moving the camera, and only mark the request handled once the
    // move actually runs so a later coords/map update can still retry.
    if (map.isStyleLoaded()) {
      performFly();
      return;
    }

    const onLoad = () => performFly();
    map.once('load', onLoad);
    return () => {
      map.off('load', onLoad);
    };
  }, [focusCameraRequest, focusMrid, focusCoordinates, territoryActive, clearFocusCamera]);

  useEffect(() => {
    const cmd = mapViewportCommand;
    if (!cmd) return;
    if (cmd.id <= handledViewportCommandIdRef.current) return;

    const map = mapRef.current;
    if (!map) return;

    const perform = () => {
      try {
        if (cmd.type === 'fit_bounds' && cmd.bbox) {
          fitMapBounds(map, cmd.bbox);
        } else if (cmd.type === 'fly_to' && cmd.center) {
          flyToLatLon(map, cmd.center.lon, cmd.center.lat, cmd.zoom ?? 14);
        }
        handledViewportCommandIdRef.current = cmd.id;
        clearMapViewportCommand();
      } catch (err) {
        console.warn('[GiopMap] viewport command failed:', err);
      }
    };

    if (map.isStyleLoaded()) {
      perform();
      return;
    }
    map.once('load', perform);
  }, [mapViewportCommand, clearMapViewportCommand]);

  // Work-order dispatch pins (FR-012 map overlay).
  useEffect(() => {
    const map = mapRef.current;
    if (!map || mapBusy) return;

    const geojson = {
      type: 'FeatureCollection' as const,
      features: workOrders
        .filter((wo) => wo.longitude != null && wo.latitude != null)
        .map((wo) => ({
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
            coordinates: [wo.longitude!, wo.latitude!] as [number, number],
          },
        })),
    };

    const sourceId = 'work-orders-overlay';
    const rippleLayerIds = ['work-order-pins-pulse', 'work-order-pins-pulse-2'] as const;
    const layerId = 'work-order-pins';
    const woRipplePaint = {
      'circle-radius': 10,
      'circle-color': '#a855f7',
      'circle-opacity': 0,
      'circle-stroke-width': 1.5,
      'circle-stroke-color': '#a855f7',
      'circle-stroke-opacity': 0,
    };

    const ensureLayers = () => {
      if (!map.getSource(sourceId)) {
        map.addSource(sourceId, { type: 'geojson', data: geojson });
      } else {
        (map.getSource(sourceId) as maplibregl.GeoJSONSource).setData(geojson);
      }

      for (const rippleId of rippleLayerIds) {
        if (!map.getLayer(rippleId)) {
          map.addLayer({
            id: rippleId,
            type: 'circle',
            source: sourceId,
            filter: WORK_ORDER_PULSE_FILTER,
            paint: woRipplePaint,
          });
        }
      }

      if (!map.getLayer(layerId)) {
        map.addLayer({
          id: layerId,
          type: 'circle',
          source: sourceId,
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
      } else {
        const pinPaint = workOrderPinCirclePaint();
        for (const key of Object.keys(pinPaint) as Array<keyof typeof pinPaint>) {
          map.setPaintProperty(layerId, key, pinPaint[key]);
        }
      }

      const visibility = showWorkOrdersLayer ? 'visible' : 'none';
      for (const id of [...rippleLayerIds, layerId]) {
        if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', visibility);
      }
    };

    if (map.isStyleLoaded()) {
      ensureLayers();
    } else {
      whenMapCanAddLayers(map, ensureLayers);
    }
  }, [workOrders, mapBusy, showWorkOrdersLayer]);

  // Outage downstream impact highlight (FR-016).
  useEffect(() => {
    const map = mapRef.current;
    if (!map || mapBusy) return;

    let nodes: ReturnType<typeof topologyImpactToGeoJson>['nodes'];
    let edges: ReturnType<typeof topologyImpactToGeoJson>['edges'];
    try {
      ({ nodes, edges } = topologyImpactToGeoJson(impactOverlay));
    } catch (err) {
      console.warn('[GiopMap] impact overlay parse failed:', err);
      return;
    }
    const nodeSourceId = 'impact-nodes';
    const edgeSourceId = 'impact-edges';

    const applyImpact = () => {
      if (!impactOverlay) {
        if (map.getLayer('impact-edges-layer')) map.removeLayer('impact-edges-layer');
        if (map.getLayer('impact-nodes-layer')) map.removeLayer('impact-nodes-layer');
        if (map.getLayer('impact-nodes-pulse')) map.removeLayer('impact-nodes-pulse');
        if (map.getLayer('impact-nodes-pulse-2')) map.removeLayer('impact-nodes-pulse-2');
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
        const impactRipplePaint = {
          'circle-radius': 9,
          'circle-color': '#ef4444',
          'circle-opacity': 0,
          'circle-stroke-width': 1.5,
          'circle-stroke-color': '#ef4444',
          'circle-stroke-opacity': 0,
        };
        for (const rippleId of ['impact-nodes-pulse', 'impact-nodes-pulse-2'] as const) {
          if (!map.getLayer(rippleId)) {
            map.addLayer({
              id: rippleId,
              type: 'circle',
              source: nodeSourceId,
              paint: impactRipplePaint,
            });
          }
        }
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

  // Side-map identify: pulse the focused asset so stewards can spot it on the map.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const sourceId = 'focus-identify';
    const rippleLayerIds = ['focus-identify-pulse', 'focus-identify-pulse-2'] as const;
    const pointLayerId = 'focus-identify-point';
    const labelLayerId = 'focus-identify-label';
    const layerIds = [...rippleLayerIds, pointLayerId, labelLayerId] as const;
    let cancelPendingApply: (() => void) | undefined;

    const teardown = () => {
      for (const id of layerIds) {
        safeRemoveLayer(map, id);
      }
      safeRemoveSource(map, sourceId);
    };

    if (!pulseFocus || !focusMrid) {
      return () => {
        cancelPendingApply?.();
        teardown();
      };
    }

    let cancelled = false;
    const labelText =
      (focusLabel && focusLabel.trim()) || `${focusMrid.slice(0, 8)}…`;

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

      const ripplePaint = {
        'circle-radius': 9,
        'circle-color': '#06b6d4',
        'circle-opacity': 0,
        'circle-stroke-width': 1.5,
        'circle-stroke-color': '#06b6d4',
        'circle-stroke-opacity': 0,
      };

      const apply = () => {
        if (cancelled || !mapHasStyle(map)) return;
        safeMapMutate(map, () => {
          for (const id of layerIds) {
            if (map.getLayer(id)) map.removeLayer(id);
          }
          if (map.getSource(sourceId)) map.removeSource(sourceId);

          map.addSource(sourceId, { type: 'geojson', data: geojson });

          for (const rippleId of rippleLayerIds) {
            map.addLayer({
              id: rippleId,
              type: 'circle',
              source: sourceId,
              paint: ripplePaint,
            });
          }

          map.addLayer({
            id: pointLayerId,
            type: 'circle',
            source: sourceId,
            paint: focusIdentifyCirclePaint(),
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
              'text-font': ['Noto Sans Bold'],
              'text-allow-overlap': true,
              'text-ignore-placement': true,
            },
            paint: {
              'text-color': '#0e7490',
              'text-halo-color': '#ffffff',
              'text-halo-width': 2.5,
            },
          });
        });
      };

      cancelPendingApply?.();
      if (map.isStyleLoaded()) apply();
      else cancelPendingApply = whenMapCanAddLayers(map, apply);
    };

    const resolved = normalizeMapCoordinates(focusCoordinates);
    if (resolved) {
      applyWithCoords(resolved);
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
  }, [pulseFocus, focusMrid, focusCoordinates, focusLabel]);

  // De-emphasise neighbouring poles while side-map identify is active.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const nodeLayerIds = ['nodes', 'graph-chunk-nodes-layer'] as const;

    const restore = () => {
      safeMapMutate(map, () => {
        const tilePaint = tileNodeCirclePaint(isLightModeRef.current);
        if (map.getLayer('nodes') && tilePaint['circle-opacity'] != null) {
          map.setPaintProperty('nodes', 'circle-opacity', tilePaint['circle-opacity']);
        }
        const chunkPaint = chunkNodeCirclePaint(isLightModeRef.current);
        if (map.getLayer('graph-chunk-nodes-layer') && chunkPaint['circle-opacity'] != null) {
          map.setPaintProperty('graph-chunk-nodes-layer', 'circle-opacity', chunkPaint['circle-opacity']);
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

  // H3 rebuild-coverage overlay: per-hex verified/staged/reference counts.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const removeCoverage = () => {
      if (map.getLayer(H3_COVERAGE_OUTLINE)) map.removeLayer(H3_COVERAGE_OUTLINE);
      if (map.getLayer(H3_COVERAGE_FILL)) map.removeLayer(H3_COVERAGE_FILL);
      if (map.getSource(H3_COVERAGE_SOURCE)) map.removeSource(H3_COVERAGE_SOURCE);
    };

    if (!showCoverage) {
      whenMapCanAddLayers(map, removeCoverage);
      return;
    }

    let cancelled = false;
    let debounceTimer: number | undefined;

    const fetchAndRender = async () => {
      const bounds = map.getBounds();
      const zoom = map.getZoom();
      try {
        const fc = await getH3Coverage({
          west: bounds.getWest(),
          south: bounds.getSouth(),
          east: bounds.getEast(),
          north: bounds.getNorth(),
          res: coverageResForZoom(zoom),
        });
        if (cancelled) return;
        whenMapCanAddLayers(map, () => {
          const data = fc as unknown as GeoJSON.FeatureCollection;
          const existing = map.getSource(H3_COVERAGE_SOURCE) as
            | maplibregl.GeoJSONSource
            | undefined;
          if (existing) {
            existing.setData(data);
            return;
          }
          map.addSource(H3_COVERAGE_SOURCE, { type: 'geojson', data });
          // Color by verified node count: grey (unsurveyed) → green (rebuilt).
          map.addLayer({
            id: H3_COVERAGE_FILL,
            type: 'fill',
            source: H3_COVERAGE_SOURCE,
            paint: {
              'fill-color': [
                'interpolate',
                ['linear'],
                ['get', 'verified_count'],
                0, '#64748b',
                1, '#fde047',
                10, '#84cc16',
                50, '#16a34a',
                200, '#15803d',
              ],
              'fill-opacity': 0.35,
            },
          });
          map.addLayer({
            id: H3_COVERAGE_OUTLINE,
            type: 'line',
            source: H3_COVERAGE_SOURCE,
            paint: {
              'line-color': isLightModeRef.current ? '#334155' : '#cbd5e1',
              'line-width': 0.5,
              'line-opacity': 0.5,
            },
          });
        });
      } catch {
        /* coverage unavailable (e.g. h3 not installed) — silently skip */
      }
    };

    const schedule = () => {
      window.clearTimeout(debounceTimer);
      debounceTimer = window.setTimeout(() => void fetchAndRender(), 300);
    };

    void fetchAndRender();
    map.on('moveend', schedule);
    map.on('zoomend', schedule);

    return () => {
      cancelled = true;
      window.clearTimeout(debounceTimer);
      map.off('moveend', schedule);
      map.off('zoomend', schedule);
      whenMapCanAddLayers(map, removeCoverage);
    };
  }, [showCoverage]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const applyVisibility = () => setEcgBoundaryVisibility(map, showBoundaries);
    whenMapCanAddLayers(map, applyVisibility);
    if (!showBoundaries) boundaryPopupRef.current?.remove();
  }, [showBoundaries, mapBusy]);

  useEffect(() => {
    if (territoryHighlight) {
      setShowBoundaries(true);
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
    if (!map || !showBoundaries) return;

    const boundaryHitLayers = [...ECG_BOUNDARY_HIT_LAYER_IDS];

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
      if (!territoryActiveRef.current) map.getCanvas().style.cursor = 'pointer';
    };
    const onLeave = () => {
      map.getCanvas().style.cursor = '';
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
  }, [showBoundaries]);

  return (
    <GiopTerritoryProvider
      mapRef={mapRef}
      mapReady={!mapBusy}
      isLightMode={isLightMode}
      fieldTechnicians={fieldTechnicians}
      active={territoryActive}
      onActiveChange={setTerritoryActive}
    >
      <div className="giop-map-host">
        <div ref={containerRef} className="absolute inset-0" />
        <div className="pointer-events-none absolute top-3 right-16 z-10 flex items-start gap-2 flex-row-reverse">
          {fieldCrews && (
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
          <div
            className={`giop-map-zoom-hint shrink-0 rounded-md border px-3 py-2 text-xs shadow-lg ${
              zoomHintVisible ? 'giop-map-zoom-hint--visible' : ''
            } ${
              isLightMode
                ? 'border-slate-200 bg-white/90 text-slate-700'
                : 'border-slate-700 bg-slate-900/90 text-slate-200'
            }`}
            aria-hidden={!zoomHintVisible}
          >
            Zoom {mapZoom.toFixed(1)}
          </div>
        </div>
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
              label: 'Context',
              toggles: [
                {
                  id: 'boundaries',
                  label: 'Boundaries',
                  color: '#0ea5e9',
                  active: showBoundaries,
                  onToggle: () => setShowBoundaries((v) => !v),
                  hint: 'Toggle ECG boundaries — regions when zoomed out, districts when zoomed in',
                },
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
          footerSlot={<GiopTerritoryMapToggle inline />}
        />
        <GiopMapLegend
          isLightMode={isLightMode}
          mapRef={mapRef}
          mapZoom={mapZoom}
          mapReady={!mapBusy}
        />
      </div>
    </GiopTerritoryProvider>
  );
}
