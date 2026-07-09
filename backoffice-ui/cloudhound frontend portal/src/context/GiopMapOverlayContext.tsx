import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { getAssetLocation, type GiopTopologyPayload, isUuidMrid } from '../api/giop-api';
import { normalizeMapCoordinates, coordsNearlyEqual } from '../lib/giopMapCoordinates';
import { DUPLICATE_CLUSTER_ZOOM, readNetworkGeometryMode, writeNetworkGeometryMode, type NetworkGeometryMode } from '../lib/giopMapLayers';
import { giopLog } from '../lib/giopDebugLog';
import { writeGiopRouteToLocation, type GiopPortalTab } from '../lib/giopPortalRouting';
import type { GiopMapFlyRequest } from '../lib/giopMapFlyRequest';
import type { MapViewportContext } from '../lib/giopCopilotTypes';
import type { TerritoryHighlightState } from '../lib/giopTerritoryHighlight';
import type { GiopRepairPreviewLayers } from '../lib/giopRepairPreviewGeojson';
import type { DuplicateClusterOverlay } from '../lib/giopDuplicateFan';
import type { FeederHighlightState } from '../lib/giopFeederHighlight';
import type { ImportSegmentHighlightState } from '../lib/giopImportSegmentHighlight';
import { polylineLengthMeters } from '../lib/giopMapMeasure';
import { DEFAULT_CLEARANCE_RADIUS_M } from '../lib/giopMapClearance';
import { useGiopSelection } from './GiopSelectionContext';

export type { TerritoryHighlightState };

export interface GiopSideMapState {
  open: boolean;
  mrid: string | null;
  coordinates: [number, number] | null;
  name: string | null;
}

/** Explicit steward request to move the map camera (Show on map, Full map, etc.). */
export interface FocusCameraRequest {
  id: number;
  mrid: string;
  boostZoom: boolean;
  coordinates?: [number, number] | null;
  targetZoom?: number;
}

/** Copilot-driven map pan/zoom (district fit, fly-to, viewport). */
export interface MapViewportCommand {
  id: number;
  type: 'fit_bounds' | 'fly_to';
  bbox?: { west: number; south: number; east: number; north: number };
  center?: { lon: number; lat: number };
  zoom?: number;
  max_zoom?: number;
  duration?: number;
  padding?: number;
  /** Minimum bbox span in degrees (~0.0005 ≈ 55 m at Ghana latitudes). */
  min_span?: number;
}

interface GiopMapOverlayContextValue {
  impactOverlay: GiopTopologyPayload | null;
  setImpactOverlay: (payload: GiopTopologyPayload | null) => void;
  clearImpactOverlay: () => void;
  repairPreviewLayers: GiopRepairPreviewLayers | null;
  setRepairPreviewLayers: (layers: GiopRepairPreviewLayers | null) => void;
  clearRepairPreviewLayers: () => void;
  duplicateClusterOverlay: DuplicateClusterOverlay | null;
  setDuplicateClusterOverlay: (overlay: DuplicateClusterOverlay | null) => void;
  clearDuplicateClusterOverlay: () => void;
  sideMap: GiopSideMapState;
  sidePanelFlyRequest: GiopMapFlyRequest | null;
  focusCameraRequest: FocusCameraRequest | null;
  mapViewportCommand: MapViewportCommand | null;
  territoryHighlight: TerritoryHighlightState | null;
  feederHighlight: FeederHighlightState | null;
  importSegmentHighlight: ImportSegmentHighlightState | null;
  /** GIS import vs master line geometry (shared across Map tab and side preview). */
  networkGeometryMode: NetworkGeometryMode;
  setNetworkGeometryMode: (mode: NetworkGeometryMode) => void;
  /** MRID highlighted on the full Map tab after Full map / navigateTab (cleared on next map click). */
  mapIdentifyFocusMrid: string | null;
  clearFocusCamera: () => void;
  clearMapViewportCommand: () => void;
  setTerritoryHighlight: (highlight: TerritoryHighlightState | null) => void;
  clearTerritoryHighlight: () => void;
  setFeederHighlight: (highlight: FeederHighlightState | null) => void;
  clearFeederHighlight: () => void;
  setImportSegmentHighlight: (highlight: ImportSegmentHighlightState | null) => void;
  clearImportSegmentHighlight: () => void;
  clearMapIdentifyFocus: () => void;
  closeSideMap: () => void;
  queueMapViewportCommand: (cmd: Omit<MapViewportCommand, 'id'>) => void;
  queueFocusCamera: (mrid: string, boostZoom?: boolean, coordinates?: [number, number] | null, targetZoom?: number) => void;
  focusOnMap: (
    mrid: string,
    opts?: {
      name?: string;
      coordinates?: [number, number] | null;
      impact?: GiopTopologyPayload | null;
      tab?: GiopPortalTab;
      /** Switch to a full map tab instead of the side panel (default: side panel). */
      navigateTab?: boolean;
      /** Open the slide-in side map panel (default: true when navigateTab is false). */
      sidePanel?: boolean;
      source?: 'map' | 'table' | 'graph';
      /** Duplicate stack — camera flies to street-level fan view (zoom ~19). */
      duplicateCluster?: boolean;
      /** Camera target (e.g. fan-pin offset); defaults to coordinates. */
      flyCoordinates?: [number, number] | null;
    },
  ) => Promise<void>;
  bumpSidePanelFly: (coordinates: [number, number], boostZoom?: boolean, targetZoom?: number) => void;
  /** Map instances register a synchronous bounds reader for hands-free voice. */
  registerMapViewportReader: (reader: () => MapViewportContext | null) => () => void;
  getLiveMapViewport: () => MapViewportContext | null;
  /** Tap-to-measure polyline on the map. */
  mapMeasureActive: boolean;
  setMapMeasureActive: (active: boolean) => void;
  measurePoints: [number, number][];
  addMeasurePoint: (lon: number, lat: number) => void;
  updateMeasurePoint: (index: number, lon: number, lat: number) => void;
  removeMeasurePoint: (index: number) => void;
  clearMeasure: () => void;
  measureTotalMeters: number;
  /** Clearance buffer around the measure path (or a single point). */
  mapClearanceActive: boolean;
  setMapClearanceActive: (active: boolean) => void;
  clearanceRadiusM: number;
  setClearanceRadiusM: (meters: number) => void;
  /** Click-to-trace downstream electrical impact on the map. */
  mapTraceActive: boolean;
  setMapTraceActive: (active: boolean) => void;
  mapTraceStatus: string | null;
  setMapTraceStatus: (status: string | null) => void;
}

const GiopMapOverlayContext = createContext<GiopMapOverlayContextValue | null>(null);

const CLOSED_SIDE_MAP: GiopSideMapState = {
  open: false,
  mrid: null,
  coordinates: null,
  name: null,
};

export function GiopMapOverlayProvider({ children }: { children: ReactNode }) {
  const { setSelection } = useGiopSelection();
  const [impactOverlay, setImpactOverlayState] = useState<GiopTopologyPayload | null>(null);
  const [repairPreviewLayers, setRepairPreviewLayersState] = useState<GiopRepairPreviewLayers | null>(
    null,
  );
  const [duplicateClusterOverlay, setDuplicateClusterOverlayState] =
    useState<DuplicateClusterOverlay | null>(null);
  const [sideMap, setSideMap] = useState<GiopSideMapState>(CLOSED_SIDE_MAP);
  const [sidePanelFlyRequest, setSidePanelFlyRequest] = useState<GiopMapFlyRequest | null>(null);
  const [focusCameraRequest, setFocusCameraRequest] = useState<FocusCameraRequest | null>(null);
  const [mapViewportCommand, setMapViewportCommand] = useState<MapViewportCommand | null>(null);
  const [territoryHighlight, setTerritoryHighlightState] = useState<TerritoryHighlightState | null>(
    null,
  );
  const [feederHighlight, setFeederHighlightState] = useState<FeederHighlightState | null>(null);
  const [importSegmentHighlight, setImportSegmentHighlightState] =
    useState<ImportSegmentHighlightState | null>(null);
  const [networkGeometryMode, setNetworkGeometryModeState] = useState<NetworkGeometryMode>(() =>
    readNetworkGeometryMode(),
  );
  const [mapIdentifyFocusMrid, setMapIdentifyFocusMrid] = useState<string | null>(null);
  const [mapMeasureActive, setMapMeasureActiveState] = useState(false);
  const [measurePoints, setMeasurePoints] = useState<[number, number][]>([]);
  const [mapClearanceActive, setMapClearanceActiveState] = useState(false);
  const [clearanceRadiusM, setClearanceRadiusMState] = useState(DEFAULT_CLEARANCE_RADIUS_M);
  const [mapTraceActive, setMapTraceActiveState] = useState(false);
  const [mapTraceStatus, setMapTraceStatus] = useState<string | null>(null);
  const focusCameraRequestIdRef = useRef(0);
  const mapViewportCommandIdRef = useRef(0);
  /** Only the latest focusOnMap call may apply state after its async coordinate lookup. */
  const focusOnMapSeqRef = useRef(0);
  const sideMapRef = useRef(sideMap);
  sideMapRef.current = sideMap;
  const sidePanelFlyIdRef = useRef(0);
  const mapViewportReadersRef = useRef(new Set<() => MapViewportContext | null>());

  const registerMapViewportReader = useCallback((reader: () => MapViewportContext | null) => {
    mapViewportReadersRef.current.add(reader);
    return () => {
      mapViewportReadersRef.current.delete(reader);
    };
  }, []);

  const getLiveMapViewport = useCallback((): MapViewportContext | null => {
    for (const reader of mapViewportReadersRef.current) {
      try {
        const viewport = reader();
        if (viewport?.bbox || (viewport?.center && viewport.zoom != null)) {
          return viewport;
        }
      } catch {
        /* best-effort */
      }
    }
    return null;
  }, []);

  const bumpSidePanelFly = useCallback(
    (coordinates: [number, number], boostZoom = true, targetZoom?: number) => {
      const normalized = normalizeMapCoordinates(coordinates);
      if (!normalized) return;
      sidePanelFlyIdRef.current += 1;
      const req: GiopMapFlyRequest = {
        id: sidePanelFlyIdRef.current,
        coordinates: normalized,
        boostZoom,
        targetZoom,
      };
      giopLog.overlay.info('bumpSidePanelFly', req);
      setSidePanelFlyRequest(req);
    },
    [],
  );

  const queueFocusCamera = useCallback(
    (mrid: string, boostZoom = true, coordinates?: [number, number] | null, targetZoom?: number) => {
      focusCameraRequestIdRef.current += 1;
      const req = {
        id: focusCameraRequestIdRef.current,
        mrid,
        boostZoom,
        coordinates: normalizeMapCoordinates(coordinates) ?? null,
        targetZoom,
      };
      giopLog.overlay.info('queueFocusCamera', req);
      setFocusCameraRequest(req);
    },
    [],
  );

  // Drop the consumed camera request so a later Map-tab remount (e.g. switching
  // tabs and back) does not re-fly to a stale node. The Map tab must stay free
  // once the user has taken control; snap-to-node is reserved for the DQ side
  // panel and the explicit Full-map arrival.
  const clearFocusCamera = useCallback(() => {
    setFocusCameraRequest(null);
  }, []);

  const clearMapViewportCommand = useCallback(() => {
    setMapViewportCommand(null);
  }, []);

  const queueMapViewportCommand = useCallback((cmd: Omit<MapViewportCommand, 'id'>) => {
    mapViewportCommandIdRef.current += 1;
    setMapViewportCommand({ ...cmd, id: mapViewportCommandIdRef.current });
  }, []);

  const setTerritoryHighlight = useCallback((highlight: TerritoryHighlightState | null) => {
    setTerritoryHighlightState(highlight);
  }, []);

  const clearTerritoryHighlight = useCallback(() => {
    setTerritoryHighlightState(null);
  }, []);

  const setFeederHighlight = useCallback((highlight: FeederHighlightState | null) => {
    setFeederHighlightState(highlight);
  }, []);

  const clearFeederHighlight = useCallback(() => {
    setFeederHighlightState(null);
  }, []);

  const setImportSegmentHighlight = useCallback((highlight: ImportSegmentHighlightState | null) => {
    setImportSegmentHighlightState(highlight);
  }, []);

  const setNetworkGeometryMode = useCallback((mode: NetworkGeometryMode) => {
    writeNetworkGeometryMode(mode);
    setNetworkGeometryModeState(mode);
  }, []);

  const clearImportSegmentHighlight = useCallback(() => {
    setImportSegmentHighlightState(null);
  }, []);

  const clearMapIdentifyFocus = useCallback(() => {
    setMapIdentifyFocusMrid(null);
  }, []);

  const setMapMeasureActive = useCallback((active: boolean) => {
    setMapMeasureActiveState(active);
    if (!active) {
      setMeasurePoints([]);
      setMapClearanceActiveState(false);
    } else {
      setMapTraceActiveState(false);
      setMapTraceStatus(null);
    }
  }, []);

  const setMapClearanceActive = useCallback((active: boolean) => {
    setMapClearanceActiveState(active);
    if (active) {
      setMapMeasureActiveState(true);
      setMapTraceActiveState(false);
      setMapTraceStatus(null);
    }
  }, []);

  const setMapTraceActive = useCallback((active: boolean) => {
    setMapTraceActiveState(active);
    if (active) {
      setMapMeasureActiveState(false);
      setMeasurePoints([]);
      setMapClearanceActiveState(false);
      setMapTraceStatus('Click a pole or transformer to trace downstream');
    } else {
      setMapTraceStatus(null);
      setImpactOverlayState(null);
    }
  }, []);

  const setClearanceRadiusM = useCallback((meters: number) => {
    if (!Number.isFinite(meters) || meters <= 0) return;
    setClearanceRadiusMState(Math.min(Math.max(meters, 1), 500));
  }, []);

  const addMeasurePoint = useCallback((lon: number, lat: number) => {
    setMeasurePoints((prev) => [...prev, [lon, lat]]);
  }, []);

  const updateMeasurePoint = useCallback((index: number, lon: number, lat: number) => {
    setMeasurePoints((prev) => {
      if (index < 0 || index >= prev.length) return prev;
      const next = [...prev];
      next[index] = [lon, lat];
      return next;
    });
  }, []);

  const removeMeasurePoint = useCallback((index: number) => {
    setMeasurePoints((prev) => {
      if (index < 0 || index >= prev.length) return prev;
      return prev.filter((_, i) => i !== index);
    });
  }, []);

  const clearMeasure = useCallback(() => {
    setMeasurePoints([]);
  }, []);

  const measureTotalMeters = useMemo(
    () => polylineLengthMeters(measurePoints),
    [measurePoints],
  );

  const setImpactOverlay = useCallback((payload: GiopTopologyPayload | null) => {
    setImpactOverlayState(payload);
  }, []);

  const clearImpactOverlay = useCallback(() => {
    setImpactOverlayState(null);
  }, []);

  const setRepairPreviewLayers = useCallback((layers: GiopRepairPreviewLayers | null) => {
    setRepairPreviewLayersState(layers);
  }, []);

  const clearRepairPreviewLayers = useCallback(() => {
    setRepairPreviewLayersState(null);
  }, []);

  const setDuplicateClusterOverlay = useCallback((overlay: DuplicateClusterOverlay | null) => {
    setDuplicateClusterOverlayState(overlay);
  }, []);

  const clearDuplicateClusterOverlay = useCallback(() => {
    setDuplicateClusterOverlayState(null);
  }, []);

  const closeSideMap = useCallback(() => {
    setSideMap(CLOSED_SIDE_MAP);
  }, []);

  const focusOnMap = useCallback(
    async (
      mrid: string,
      opts?: {
        name?: string;
        coordinates?: [number, number] | null;
        impact?: GiopTopologyPayload | null;
        tab?: GiopPortalTab;
        navigateTab?: boolean;
        sidePanel?: boolean;
        source?: 'map' | 'table' | 'graph';
        duplicateCluster?: boolean;
        flyCoordinates?: [number, number] | null;
      },
    ) => {
      if (!mrid?.trim()) {
        giopLog.overlay.warn('focusOnMap skipped — empty mrid');
        return;
      }

      giopLog.overlay.info('focusOnMap', { mrid, opts });
      const seq = ++focusOnMapSeqRef.current;

      let coordinates = normalizeMapCoordinates(opts?.coordinates) ?? null;
      let name = opts?.name;

      if (!coordinates) {
        if (!isUuidMrid(mrid)) {
          giopLog.overlay.warn('focusOnMap skipped API lookup — not a valid MRID', { mrid });
        } else {
          giopLog.overlay.info('focusOnMap resolving coordinates via API', { mrid });
          try {
            const loc = await getAssetLocation(mrid);
            if (loc.longitude != null && loc.latitude != null) {
              coordinates = normalizeMapCoordinates([loc.longitude, loc.latitude]);
            }
            name = name ?? loc.name ?? undefined;
            giopLog.overlay.info('focusOnMap API resolved', { mrid, coordinates, name });
          } catch (err) {
            giopLog.overlay.error('focusOnMap asset location failed — fly may be skipped', {
              mrid,
              err,
            });
          }
        }
        if (seq !== focusOnMapSeqRef.current) {
          giopLog.overlay.info('focusOnMap superseded by newer call — dropping', { mrid });
          return;
        }
      }

      if (opts?.impact !== undefined) {
        setImpactOverlayState(opts.impact);
      } else if (!opts?.navigateTab) {
        // Drop stale outage overlays so side-panel identify does not reuse bad payloads.
        setImpactOverlayState(null);
      }

      if (opts?.navigateTab) {
        setSideMap(CLOSED_SIDE_MAP);
        setMapIdentifyFocusMrid(mrid);
        queueFocusCamera(mrid, true, coordinates);
        setSelection(mrid, {
          name,
          coordinates,
          source: opts?.source ?? 'table',
        });
        const tab = opts?.tab ?? 'map';
        writeGiopRouteToLocation({
          tab,
          ...(tab !== 'operations' ? { startMrid: mrid } : {}),
          focusMrid: mrid,
          ...(tab === 'combined' || tab === 'topology'
            ? { graphQuery: 'traced_subgraph' as const }
            : {}),
        });
        return;
      }

      // Queue camera before selection so the embedded ops map can fly immediately.
      const openSidePanel = opts?.sidePanel !== false;
      const prevSide = sideMapRef.current;
      const duplicateCluster = opts?.duplicateCluster === true;
      const samePin =
        !duplicateCluster &&
        coordinates != null &&
        prevSide.open &&
        coordsNearlyEqual(prevSide.coordinates, coordinates);
      const boostZoom = duplicateCluster || !(samePin && prevSide.mrid !== mrid);
      const targetZoom = duplicateCluster ? DUPLICATE_CLUSTER_ZOOM : undefined;
      const cameraCoords =
        normalizeMapCoordinates(opts?.flyCoordinates ?? coordinates) ?? null;
      if (duplicateCluster) {
        if (cameraCoords && openSidePanel) {
          bumpSidePanelFly(cameraCoords, true, targetZoom);
        }
      } else {
        queueFocusCamera(mrid, boostZoom, coordinates, targetZoom);
        if (cameraCoords && openSidePanel) {
          bumpSidePanelFly(cameraCoords, boostZoom, targetZoom);
        }
      }
      setSelection(mrid, {
        name,
        coordinates,
        source: opts?.source ?? 'table',
      });
      setMapIdentifyFocusMrid(null);
      if (openSidePanel) {
        giopLog.overlay.info('opening side map panel', { mrid, coordinates, name });
        setSideMap({
          open: true,
          mrid,
          coordinates,
          name: name ?? null,
        });
      }
    },
    [setSelection, queueFocusCamera, bumpSidePanelFly],
  );

  const value = useMemo(
    () => ({
      impactOverlay,
      setImpactOverlay,
      clearImpactOverlay,
      repairPreviewLayers,
      setRepairPreviewLayers,
      clearRepairPreviewLayers,
      duplicateClusterOverlay,
      setDuplicateClusterOverlay,
      clearDuplicateClusterOverlay,
      sideMap,
      sidePanelFlyRequest,
      focusCameraRequest,
      mapViewportCommand,
      territoryHighlight,
      feederHighlight,
      importSegmentHighlight,
      networkGeometryMode,
      setNetworkGeometryMode,
      mapIdentifyFocusMrid,
      clearFocusCamera,
      clearMapViewportCommand,
      setTerritoryHighlight,
      clearTerritoryHighlight,
      setFeederHighlight,
      clearFeederHighlight,
      setImportSegmentHighlight,
      clearImportSegmentHighlight,
      clearMapIdentifyFocus,
      closeSideMap,
      queueMapViewportCommand,
      queueFocusCamera,
      focusOnMap,
      bumpSidePanelFly,
      registerMapViewportReader,
      getLiveMapViewport,
      mapMeasureActive,
      setMapMeasureActive,
      measurePoints,
      addMeasurePoint,
      updateMeasurePoint,
      removeMeasurePoint,
      clearMeasure,
      measureTotalMeters,
      mapClearanceActive,
      setMapClearanceActive,
      clearanceRadiusM,
      setClearanceRadiusM,
      mapTraceActive,
      setMapTraceActive,
      mapTraceStatus,
      setMapTraceStatus,
    }),
    [
      impactOverlay,
      setImpactOverlay,
      clearImpactOverlay,
      repairPreviewLayers,
      setRepairPreviewLayers,
      clearRepairPreviewLayers,
      duplicateClusterOverlay,
      setDuplicateClusterOverlay,
      clearDuplicateClusterOverlay,
      sideMap,
      sidePanelFlyRequest,
      focusCameraRequest,
      mapViewportCommand,
      territoryHighlight,
      feederHighlight,
      importSegmentHighlight,
      networkGeometryMode,
      setNetworkGeometryMode,
      mapIdentifyFocusMrid,
      clearFocusCamera,
      clearMapViewportCommand,
      setTerritoryHighlight,
      clearTerritoryHighlight,
      setFeederHighlight,
      clearFeederHighlight,
      setImportSegmentHighlight,
      clearImportSegmentHighlight,
      clearMapIdentifyFocus,
      closeSideMap,
      queueMapViewportCommand,
      queueFocusCamera,
      focusOnMap,
      bumpSidePanelFly,
      registerMapViewportReader,
      getLiveMapViewport,
      mapMeasureActive,
      setMapMeasureActive,
      measurePoints,
      addMeasurePoint,
      updateMeasurePoint,
      removeMeasurePoint,
      clearMeasure,
      measureTotalMeters,
      mapClearanceActive,
      setMapClearanceActive,
      clearanceRadiusM,
      setClearanceRadiusM,
      mapTraceActive,
      setMapTraceActive,
      mapTraceStatus,
      setMapTraceStatus,
    ],
  );

  return (
    <GiopMapOverlayContext.Provider value={value}>{children}</GiopMapOverlayContext.Provider>
  );
}

export function useGiopMapOverlay() {
  const ctx = useContext(GiopMapOverlayContext);
  if (!ctx) throw new Error('useGiopMapOverlay must be used within GiopMapOverlayProvider');
  return ctx;
}
