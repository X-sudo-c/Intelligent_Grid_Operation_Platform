import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { getAssetLocation, type GiopTopologyPayload } from '../api/giop-api';
import { normalizeMapCoordinates } from '../lib/giopMapCoordinates';
import { writeGiopRouteToLocation, type GiopPortalTab } from '../lib/giopPortalRouting';
import type { TerritoryHighlightState } from '../lib/giopTerritoryHighlight';
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
}

/** Copilot-driven map pan/zoom (district fit, fly-to, viewport). */
export interface MapViewportCommand {
  id: number;
  type: 'fit_bounds' | 'fly_to';
  bbox?: { west: number; south: number; east: number; north: number };
  center?: { lon: number; lat: number };
  zoom?: number;
}

interface GiopMapOverlayContextValue {
  impactOverlay: GiopTopologyPayload | null;
  setImpactOverlay: (payload: GiopTopologyPayload | null) => void;
  clearImpactOverlay: () => void;
  sideMap: GiopSideMapState;
  focusCameraRequest: FocusCameraRequest | null;
  mapViewportCommand: MapViewportCommand | null;
  territoryHighlight: TerritoryHighlightState | null;
  /** MRID highlighted on the full Map tab after Full map / navigateTab (cleared on next map click). */
  mapIdentifyFocusMrid: string | null;
  clearFocusCamera: () => void;
  clearMapViewportCommand: () => void;
  setTerritoryHighlight: (highlight: TerritoryHighlightState | null) => void;
  clearTerritoryHighlight: () => void;
  clearMapIdentifyFocus: () => void;
  closeSideMap: () => void;
  queueMapViewportCommand: (cmd: Omit<MapViewportCommand, 'id'>) => void;
  focusOnMap: (
    mrid: string,
    opts?: {
      name?: string;
      coordinates?: [number, number] | null;
      impact?: GiopTopologyPayload | null;
      tab?: GiopPortalTab;
      /** Switch to a full map tab instead of the side panel (default: side panel). */
      navigateTab?: boolean;
      source?: 'map' | 'table' | 'graph';
    },
  ) => Promise<void>;
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
  const [sideMap, setSideMap] = useState<GiopSideMapState>(CLOSED_SIDE_MAP);
  const [focusCameraRequest, setFocusCameraRequest] = useState<FocusCameraRequest | null>(null);
  const [mapViewportCommand, setMapViewportCommand] = useState<MapViewportCommand | null>(null);
  const [territoryHighlight, setTerritoryHighlightState] = useState<TerritoryHighlightState | null>(
    null,
  );
  const [mapIdentifyFocusMrid, setMapIdentifyFocusMrid] = useState<string | null>(null);
  const focusCameraRequestIdRef = useRef(0);
  const mapViewportCommandIdRef = useRef(0);

  const queueFocusCamera = useCallback((mrid: string, boostZoom = true) => {
    focusCameraRequestIdRef.current += 1;
    setFocusCameraRequest({
      id: focusCameraRequestIdRef.current,
      mrid,
      boostZoom,
    });
  }, []);

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

  const clearMapIdentifyFocus = useCallback(() => {
    setMapIdentifyFocusMrid(null);
  }, []);

  const setImpactOverlay = useCallback((payload: GiopTopologyPayload | null) => {
    setImpactOverlayState(payload);
  }, []);

  const clearImpactOverlay = useCallback(() => {
    setImpactOverlayState(null);
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
        source?: 'map' | 'table' | 'graph';
      },
    ) => {
      if (!mrid?.trim()) return;

      let coordinates = normalizeMapCoordinates(opts?.coordinates) ?? null;
      let name = opts?.name;

      if (!coordinates) {
        try {
          const loc = await getAssetLocation(mrid);
          if (loc.longitude != null && loc.latitude != null) {
            coordinates = normalizeMapCoordinates([loc.longitude, loc.latitude]);
          }
          name = name ?? loc.name ?? undefined;
        } catch {
          /* flyTo skipped when coords unknown */
        }
      }

      setSelection(mrid, {
        name,
        coordinates,
        source: opts?.source ?? 'table',
      });

      if (opts?.impact !== undefined) {
        setImpactOverlayState(opts.impact);
      } else if (!opts?.navigateTab) {
        // Drop stale outage overlays so side-panel identify does not reuse bad payloads.
        setImpactOverlayState(null);
      }

      if (opts?.navigateTab) {
        setSideMap(CLOSED_SIDE_MAP);
        setMapIdentifyFocusMrid(mrid);
        queueFocusCamera(mrid, true);
        const tab = opts?.tab ?? 'map';
        writeGiopRouteToLocation({
          tab,
          startMrid: mrid,
          focusMrid: mrid,
          ...(tab === 'combined' || tab === 'topology'
            ? { graphQuery: 'traced_subgraph' as const }
            : {}),
        });
        return;
      }

      queueFocusCamera(mrid, true);
      setMapIdentifyFocusMrid(null);
      setSideMap({
        open: true,
        mrid,
        coordinates,
        name: name ?? null,
      });
    },
    [setSelection, queueFocusCamera],
  );

  const value = useMemo(
    () => ({
      impactOverlay,
      setImpactOverlay,
      clearImpactOverlay,
      sideMap,
      focusCameraRequest,
      mapViewportCommand,
      territoryHighlight,
      mapIdentifyFocusMrid,
      clearFocusCamera,
      clearMapViewportCommand,
      setTerritoryHighlight,
      clearTerritoryHighlight,
      clearMapIdentifyFocus,
      closeSideMap,
      queueMapViewportCommand,
      focusOnMap,
    }),
    [
      impactOverlay,
      setImpactOverlay,
      clearImpactOverlay,
      sideMap,
      focusCameraRequest,
      mapViewportCommand,
      territoryHighlight,
      mapIdentifyFocusMrid,
      clearFocusCamera,
      clearMapViewportCommand,
      setTerritoryHighlight,
      clearTerritoryHighlight,
      clearMapIdentifyFocus,
      closeSideMap,
      queueMapViewportCommand,
      focusOnMap,
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
