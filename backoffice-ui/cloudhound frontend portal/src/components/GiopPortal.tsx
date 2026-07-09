import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { beginGiopThemeTransition } from '../lib/giopThemeTransition';
import { EnhancedPortalShell } from './EnhancedPortalShell';
import { GiopTopologyTab } from './GiopTopologyTab';
import { GiopMapView } from './GiopMapView';
import { GiopSplitView } from './GiopSplitView';
import { GiopOperationsDesk } from './GiopOperationsDesk';
import { GiopMeterOcr } from './GiopMeterOcr';
import { GiopInsightsTab } from './GiopInsightsTab';
import { GiopSchematicTab } from './GiopSchematicTab';
import { GiopDlqTab } from './GiopDlqTab';
import { GiopAuditTab } from './GiopAuditTab';
import { GiopDataQualityTab } from './GiopDataQualityTab';
import { GiopExportsTab } from './GiopExportsTab';
import { GiopGisReferenceTab } from './GiopGisReferenceTab';
import { GiopMigrationTab } from './GiopMigrationTab';
import { GiopApmWidget } from './GiopApmWidget';
import { GiopCasesTab } from './GiopCasesTab';
import { GiopTicketsTab } from './GiopTicketsTab';
import { GiopWorkOrdersTab } from './GiopWorkOrdersTab';
import { GiopOutagesTab } from './GiopOutagesTab';
import { GiopReportsTab } from './GiopReportsTab';
import { GiopSideMapPanel } from './GiopSideMapPanel';
import { GiopFloatingMapShell } from './GiopFloatingMapShell';
import { GiopMapErrorBoundary } from './GiopMapErrorBoundary';
import { GiopWorkspaceLayout } from './GiopWorkspaceLayout';
import {
  readSideMapDockMode,
  readSideMapDockWidth,
  readSideMapFloatRect,
  writeSideMapDockMode,
  type SideMapDockMode,
  type SideMapFloatRect,
} from '../lib/giopSideMapDock';
import { GiopSelectionProvider, useGiopSelection } from '../context/GiopSelectionContext';
import { GiopMapOverlayProvider, useGiopMapOverlay } from '../context/GiopMapOverlayContext';
import { GiopVoiceModeProvider } from '../context/GiopVoiceModeContext';
import { useGiopTopology } from '../hooks/useGiopTopology';
import { useGiopTopologySeed } from '../hooks/useGiopTopologySeed';
import { useGiopRealtime } from '../hooks/useGiopRealtime';
import { useGiopFieldTechnicians } from '../hooks/useGiopFieldTechnicians';
import { DEFAULT_START_MRID, getAssetLocation, getSpatialTerritoryGeojson, getStagingAssets, isUuidMrid, listWorkOrders, type GiopStagingAsset, type GiopWorkOrder } from '../api/giop-api';
import {
  readGiopRouteFromLocation,
  subscribeToGiopRouteChanges,
  writeGiopRouteToLocation,
  type GiopPortalTab,
} from '../lib/giopPortalRouting';
import type { GiopGraphQueryKey } from '../lib/giopGraphTypes';
import { GIOP_GRAPH_QUERY_OPTIONS } from '../lib/giopGraphTypes';
import type { PortalGraphResponse } from '../lib/giopGraphTypes';
import { resolvePortalGraphNodeCoordinates } from '../lib/giopGraphAdapter';
import { normalizeMapCoordinates, extractStagingGeomCoordinates } from '../lib/giopMapCoordinates';
import type { GiopMapFlyRequest } from '../lib/giopMapFlyRequest';
import { resolveTopologyStartMrid, isStagingOnlySeed } from '../lib/resolveTopologyStartMrid';
import { isDemoIslandSeed } from '../lib/giopTopologySeed';
import { giopLog } from '../lib/giopDebugLog';
import { useGiopNavBadges } from '../hooks/useGiopNavBadges';
import type { PortalNavGroup } from './EnhancedPortalShell';
import { EnhancedCopilotPanel } from './EnhancedCopilotPanel';
import { GiopRealtimeCopilot } from './GiopRealtimeCopilot';
import { prefetchRealtimeSessionToken } from '../lib/giopRealtimeTokenCache';

const REALTIME_VOICE_ENABLED = import.meta.env.VITE_GIOP_REALTIME === '1';
import { isGiopPortalTab } from './GiopCopilotPanel';
import type {
  GiopCopilotPortalContext,
  GiopCopilotUiAction,
  MapViewportContext,
} from '../lib/giopCopilotTypes';
import { buildCopilotContext, bboxFromCenterZoom, defaultMapViewport } from '../lib/giopMapViewport';
import type { MapBbox } from '../hooks/useGiopGraphChunk';

const OPS_TOPOLOGY_GRAPH_QUERY_OPTIONS = GIOP_GRAPH_QUERY_OPTIONS.filter(
  (o) => o.key === 'traced_subgraph' || o.key === 'network_topology',
);

function isSplitViewGraphQuery(key: GiopGraphQueryKey): boolean {
  return key === 'viewport_subgraph' || key === 'traced_subgraph';
}

/** Spinner only while the active mode has no graph yet. Viewport skips seedReady gate. */
function topologyPanelLoading(
  queryKey: GiopGraphQueryKey,
  loading: boolean,
  graph: PortalGraphResponse | null,
  seedReady: boolean,
): boolean {
  if (graph) return false;
  if (loading) return true;
  if (queryKey === 'viewport_subgraph') return false;
  return !seedReady;
}

const NAV_GROUPS: PortalNavGroup[] = [
  {
    label: 'Grid',
    items: [
      { id: 'map', label: 'Map' },
      { id: 'topology', label: 'Topology' },
      { id: 'combined', label: 'Map + Topology' },
      { id: 'schematic', label: 'Schematic' },
    ],
  },
  {
    label: 'Assets & data',
    items: [
      { id: 'operations', label: 'Operations' },
      { id: 'insights', label: 'Energy insights' },
      { id: 'ocr', label: 'Meter OCR' },
      { id: 'dlq', label: 'DLQ' },
      { id: 'audit', label: 'Audit ledger' },
      { id: 'data-quality', label: 'Data quality' },
      { id: 'exports', label: 'CIM export' },
      { id: 'references', label: 'GIS references' },
      { id: 'migration', label: 'Migration' },
    ],
  },
  {
    label: 'Service desk',
    items: [
      { id: 'cases', label: 'Cases' },
      { id: 'tickets', label: 'Tickets' },
      { id: 'work-orders', label: 'Work orders' },
      { id: 'outages', label: 'Outages' },
      { id: 'reports', label: 'Reports' },
    ],
  },
];

const TAB_META: Record<GiopPortalTab, { title: string; subtitle: string }> = {
  operations: {
    title: 'Grid Operations',
    subtitle: 'Map, topology, and asset verification — FR-010 steward desk',
  },
  map: {
    title: 'Network Map',
    subtitle: 'Geospatial view of connectivity nodes and line segments',
  },
  topology: {
    title: 'Network Topology',
    subtitle: 'Memgraph trace visualization from sync-service',
  },
  combined: {
    title: 'Map + Topology',
    subtitle: 'Correlate geography with connectivity graph structure',
  },
  schematic: {
    title: 'Engineering Schematic',
    subtitle: 'SVG one-line diagram from traced topology',
  },
  insights: {
    title: 'Energy Insights',
    subtitle: 'Feeder energy balance and loss-zone anomalies',
  },
  dlq: {
    title: 'Integration DLQ',
    subtitle: 'Review, retry, or discard failed integration payloads',
  },
  audit: {
    title: 'Audit Ledger',
    subtitle: 'Immutable data lineage — search, diff, and investigate mutations',
  },
  'data-quality': {
    title: 'Data Quality',
    subtitle: 'Validation rules, exception queue, and steward cleansing actions',
  },
  exports: {
    title: 'CIM Export',
    subtitle: 'CIM-aligned JSON export of approved master data for enterprise integration',
  },
  references: {
    title: 'GIS Reference Layers',
    subtitle: 'Import boundary and network overlays for field capture context — stored in gis.*, not master',
  },
  migration: {
    title: 'Migration Adapter',
    subtitle: 'Parse GeoPackage / AutoCAD DXF, georeference, validate, and commit to staging',
  },
  ocr: {
    title: 'Meter OCR',
    subtitle: 'Extract readings and submit telemetry',
  },
  cases: {
    title: 'Contact Centre',
    subtitle: 'Customer case intake and conversion',
  },
  tickets: {
    title: 'Trouble Tickets',
    subtitle: 'Incident tracking and assignment',
  },
  'work-orders': {
    title: 'Work Orders',
    subtitle: 'Field dispatch and crew assignment',
  },
  outages: {
    title: 'Outages',
    subtitle: 'Planned and unplanned outage visibility',
  },
  reports: {
    title: 'Regulatory Reports',
    subtitle: 'SAIDI, SAIFI, CAIDI reliability metrics',
  },
};

const THEME_STORAGE_KEY = 'giop.portal.theme.v1';

function readSavedTheme(): boolean {
  try {
    const raw = localStorage.getItem(THEME_STORAGE_KEY);
    if (raw === 'light') return true;
    if (raw === 'dark') return false;
  } catch {
    /* ignore */
  }
  return false;
}

function GiopPortalInner() {
  const [route, setRoute] = useState(readGiopRouteFromLocation);
  const [isLightMode, setIsLightMode] = useState(readSavedTheme);
  const [mapRefreshToken, setMapRefreshToken] = useState(0);
  const [sideMapEpoch, setSideMapEpoch] = useState(0);
  const [sideMapDockMode, setSideMapDockMode] = useState<SideMapDockMode>(() => readSideMapDockMode());
  const [sideMapDockWidth, setSideMapDockWidth] = useState(() => readSideMapDockWidth());
  const [sideMapFloatRect, setSideMapFloatRect] = useState<SideMapFloatRect>(() => readSideMapFloatRect());
  const [opsRefreshToken, setOpsRefreshToken] = useState(0);
  const [liveStatus, setLiveStatus] = useState<'idle' | 'loading' | 'live'>('idle');
  const [mapViewport, setMapViewport] = useState<MapViewportContext | null>(() => defaultMapViewport());
  const mapViewportRef = useRef<MapViewportContext | null>(defaultMapViewport());
  const [selectedTerritory, setSelectedTerritory] = useState<{
    district?: string;
    region?: string;
  } | null>(null);
  const [boundaryFeederId, setBoundaryFeederId] = useState<string | null>(null);
  const [copilotTentativeHighlight, setCopilotTentativeHighlight] = useState(false);
  const stagingTopologyTimerRef = useRef<number | undefined>(undefined);
  /** Guards against an older async territory-geojson fetch overwriting a newer one. */
  const territoryHighlightSeqRef = useRef(0);

  useEffect(() => {
    if (!REALTIME_VOICE_ENABLED) return;
    void prefetchRealtimeSessionToken();
  }, []);

  const { selection, setSelection } = useGiopSelection();
  const {
    impactOverlay,
    setImpactOverlay,
    clearImpactOverlay,
    feederHighlight,
    sideMap,
    closeSideMap,
    focusOnMap,
    sidePanelFlyRequest,
    mapIdentifyFocusMrid,
    clearMapIdentifyFocus,
    queueMapViewportCommand,
    setTerritoryHighlight,
    clearTerritoryHighlight,
    setFeederHighlight,
    clearFeederHighlight,
    getLiveMapViewport,
  } = useGiopMapOverlay();
  const navBadges = useGiopNavBadges(opsRefreshToken);
  const [workOrders, setWorkOrders] = useState<GiopWorkOrder[]>([]);
  const [opsTopologyFocus, setOpsTopologyFocus] = useState<string | null>(null);
  const [opsTableStaging, setOpsTableStaging] = useState<GiopStagingAsset[]>([]);
  const [opsFlyRequest, setOpsFlyRequest] = useState<GiopMapFlyRequest | null>(null);

  const routeStartMrid = route.startMrid || DEFAULT_START_MRID;
  const startMrid = routeStartMrid;

  const { topologySeed, seedCenter, seedReady } = useGiopTopologySeed(route.startMrid);

  // Operations topology panel uses master Memgraph trace; map uses tiles + staging overlay.
  const needsTrace =
    route.tab === 'topology' || route.tab === 'combined' || route.tab === 'operations';

  const [stagingSeedRows, setStagingSeedRows] = useState<GiopStagingAsset[]>([]);
  useEffect(() => {
    void getStagingAssets()
      .then(setStagingSeedRows)
      .catch(() => setStagingSeedRows([]));
  }, [opsRefreshToken]);

  const focusMridForCopilot = selection.mrid ?? route.focusMrid ?? null;
  useEffect(() => {
    const mrid = focusMridForCopilot;
    if (!mrid) {
      setBoundaryFeederId(null);
      return;
    }
    if (isStagingOnlySeed(mrid, stagingSeedRows)) {
      setBoundaryFeederId(null);
      return;
    }
    if (!isUuidMrid(mrid)) {
      setBoundaryFeederId(null);
      return;
    }
    let cancelled = false;
    void getAssetLocation(mrid)
      .then((loc) => {
        if (!cancelled) {
          setBoundaryFeederId(loc.boundary_feeder_id ?? null);
        }
      })
      .catch(() => {
        if (!cancelled) setBoundaryFeederId(null);
      });
    return () => {
      cancelled = true;
    };
  }, [focusMridForCopilot, stagingSeedRows]);

  const topologyStartMrid = useMemo(
    () => resolveTopologyStartMrid(route.tab, route.startMrid, topologySeed, stagingSeedRows),
    [route.tab, route.startMrid, topologySeed, stagingSeedRows],
  );

  useEffect(() => {
    if (!seedReady) return;
    if (!topologySeed || isDemoIslandSeed(topologySeed)) return;
    if (isDemoIslandSeed(route.startMrid) || !route.startMrid) {
      writeGiopRouteToLocation(
        {
          tab: route.tab,
          startMrid: topologySeed,
          graphQuery: route.graphQuery,
          focusMrid: route.focusMrid,
        },
        true,
      );
    }
  }, [seedReady, topologySeed, route.tab, route.startMrid, route.graphQuery, route.focusMrid]);

  useEffect(() => {
    if (!seedReady || !seedCenter) return;
    const vp: MapViewportContext = {
      center: { lon: seedCenter.lon, lat: seedCenter.lat },
      zoom: 14,
      bbox: bboxFromCenterZoom(seedCenter.lon, seedCenter.lat, 14),
    };
    mapViewportRef.current = vp;
    setMapViewport(vp);
  }, [seedReady, seedCenter]);

  /** Stable reference for topology hook — avoids render loops from inline `{ bbox, zoom }`. */
  const topologyMapViewport = useMemo(() => {
    if (!mapViewport) return null;
    return { bbox: mapViewport.bbox, zoom: mapViewport.zoom };
  }, [
    mapViewport?.bbox.west,
    mapViewport?.bbox.south,
    mapViewport?.bbox.east,
    mapViewport?.bbox.north,
    mapViewport?.zoom,
  ]);

  const {
    graph,
    staging,
    graphQuery,
    loading,
    revalidating,
    error,
    refresh,
    refreshStaging,
    applyQuery,
  } = useGiopTopology(topologyStartMrid, {
    traceActive: needsTrace && seedReady,
    initialGraphQuery:
      route.tab === 'combined'
        ? 'viewport_subgraph'
        : route.tab === 'operations'
          ? 'traced_subgraph'
          : 'traced_subgraph',
    mapViewport: topologyMapViewport,
  });

  useEffect(() => {
    return subscribeToGiopRouteChanges(() => setRoute(readGiopRouteFromLocation()));
  }, []);

  useEffect(() => {
    const path = window.location.pathname.replace(/\/$/, '');
    if (!path || path === '/') {
      writeGiopRouteToLocation({ tab: 'operations' }, true);
    }
  }, []);

  useEffect(() => {
    if (route.tab !== 'map' && route.tab !== 'combined' && route.tab !== 'work-orders') return;
    void listWorkOrders()
      .then(setWorkOrders)
      .catch(() => setWorkOrders([]));
  }, [route.tab, opsRefreshToken]);

  useEffect(() => {
    if (route.tab === 'combined' && !isSplitViewGraphQuery(graphQuery)) {
      applyQuery('viewport_subgraph');
      writeGiopRouteToLocation(
        {
          tab: 'combined',
          startMrid: topologyStartMrid,
          graphQuery: 'viewport_subgraph',
          focusMrid: route.focusMrid,
        },
        true,
      );
    }
    if (route.tab === 'operations' && graphQuery !== 'traced_subgraph' && graphQuery !== 'network_topology') {
      applyQuery('traced_subgraph');
    }
  }, [route.tab, graphQuery, applyQuery, topologyStartMrid, route.focusMrid]);

  useEffect(() => {
    if (route.tab !== 'operations' || !route.startMrid) return;
    if (!isStagingOnlySeed(route.startMrid, stagingSeedRows)) return;
    writeGiopRouteToLocation(
      {
        tab: 'operations',
        graphQuery,
        focusMrid: route.focusMrid,
      },
      true,
    );
  }, [route.tab, route.startMrid, route.focusMrid, graphQuery, stagingSeedRows]);

  useEffect(() => {
    if (route.tab !== 'operations') {
      setOpsTopologyFocus(null);
    }
  }, [route.tab]);

  useEffect(() => {
    if (!route.graphQuery || route.graphQuery === graphQuery) return;
    if (route.tab === 'operations') return;
    const next = route.graphQuery as GiopGraphQueryKey;
    if (route.tab === 'combined' && !isSplitViewGraphQuery(next)) return;
    applyQuery(next);
  }, [route.graphQuery, graphQuery, applyQuery, route.tab]);

  useEffect(() => {
    const theme = isLightMode ? 'light' : 'dark';
    try {
      localStorage.setItem(THEME_STORAGE_KEY, theme);
    } catch {
      /* ignore */
    }
    document.documentElement.dataset.theme = theme;
    document.documentElement.classList.toggle('dark', !isLightMode);
  }, [isLightMode]);

  const setTheme = useCallback(
    (isLight: boolean) => {
      if (isLight === isLightMode) return;
      beginGiopThemeTransition();
      setIsLightMode(isLight);
    },
    [isLightMode],
  );

  const goToTab = useCallback(
    (tab: GiopPortalTab) => {
      writeGiopRouteToLocation({
        tab,
        startMrid,
        graphQuery,
        focusMrid: selection.mrid || undefined,
      });
    },
    [graphQuery, selection.mrid, startMrid],
  );

  const onQueryChange = useCallback(
    (key: GiopGraphQueryKey) => {
      applyQuery(key);
      writeGiopRouteToLocation(
        {
          tab: route.tab,
          startMrid,
          graphQuery: key,
          focusMrid: selection.mrid || undefined,
        },
        true,
      );
    },
    [applyQuery, route.tab, selection.mrid, startMrid],
  );

  const refreshTopology = useCallback(async () => {
    setLiveStatus('loading');
    await refresh();
    setLiveStatus('live');
  }, [refresh]);

  const refreshMap = useCallback(() => {
    setMapRefreshToken((t) => t + 1);
  }, []);

  /** Coalesce bursty master-table realtime events so the map does not flash-reload. */
  const masterMapRefreshTimerRef = useRef<number | undefined>(undefined);
  const scheduleMapRefresh = useCallback(() => {
    window.clearTimeout(masterMapRefreshTimerRef.current);
    masterMapRefreshTimerRef.current = window.setTimeout(() => {
      masterMapRefreshTimerRef.current = undefined;
      refreshMap();
    }, 2500);
  }, [refreshMap]);

  useEffect(
    () => () => {
      window.clearTimeout(masterMapRefreshTimerRef.current);
    },
    [],
  );

  const copilotContext = useMemo((): GiopCopilotPortalContext => {
    const pending = staging.filter((a) => a.validation !== 'REJECTED').length;
    const base: GiopCopilotPortalContext = {
      active_tab: route.tab,
      focus_mrid: focusMridForCopilot,
      selection_name: selection.name ?? null,
      boundary_feeder_id: boundaryFeederId,
      staging_pending_count: pending,
      viewport: mapViewport ?? mapViewportRef.current,
      selected_district: selectedTerritory?.district ?? null,
      selected_region: selectedTerritory?.region ?? null,
    };
    return buildCopilotContext(base, getLiveMapViewport);
  }, [
    route.tab,
    focusMridForCopilot,
    selection.name,
    boundaryFeederId,
    staging,
    mapViewport,
    selectedTerritory,
    getLiveMapViewport,
  ]);

  const ensureMapVisible = useCallback(
    (tab?: string) => {
      if (route.tab === 'operations') return;
      const target: GiopPortalTab = tab === 'combined' ? 'combined' : 'map';
      if (route.tab !== target) goToTab(target);
    },
    [goToTab, route.tab],
  );

  const handleMapViewportChange = useCallback(
    (bbox: MapBbox, zoom: number, center: { lon: number; lat: number }) => {
      const next = { bbox, zoom, center };
      mapViewportRef.current = next;
      setMapViewport(next);
    },
    [],
  );

  const handleTerritorySelect = useCallback(
    (territory: { district?: string; region?: string }) => {
      setSelectedTerritory(territory);
    },
    [],
  );

  const handleCopilotUiAction = useCallback(
    (action: GiopCopilotUiAction) => {
      if (action.type === 'navigate') {
        const tabRaw = String(action.tab);
        const tab: GiopPortalTab = isGiopPortalTab(tabRaw) ? tabRaw : 'operations';
        if (action.focus_mrid) {
          setSelection(action.focus_mrid, { source: 'table' });
          if (tab === 'topology') {
            // Re-root the trace on the focused asset so the graph actually
            // shows it instead of keeping the previous start node.
            writeGiopRouteToLocation(
              {
                tab,
                startMrid: action.focus_mrid,
                graphQuery: 'traced_subgraph',
                focusMrid: action.focus_mrid,
              },
              true,
            );
          } else {
            writeGiopRouteToLocation(
              { tab, startMrid, graphQuery, focusMrid: action.focus_mrid },
              true,
            );
          }
          if (tab === 'map' || tab === 'combined') {
            void focusOnMap(action.focus_mrid, { navigateTab: true, tab });
          } else if (tab === 'operations') {
            void focusOnMap(action.focus_mrid, { navigateTab: false, sidePanel: false });
          }
        } else {
          goToTab(tab);
        }
        if (action.district || action.region) {
          setSelectedTerritory({ district: action.district, region: action.region });
        }
        if (tab === 'operations') setOpsRefreshToken((t) => t + 1);
        // Camera/nav only — do not bust Martin tiles (that looked like a random refresh).
        return;
      }

      if (action.type === 'fit_bounds') {
        ensureMapVisible(action.tab ? String(action.tab) : 'map');
        if (action.district || action.region) {
          setSelectedTerritory({ district: action.district, region: action.region });
        }
        queueMapViewportCommand({
          type: 'fit_bounds',
          bbox: action.bbox,
          max_zoom: action.max_zoom,
        });
        return;
      }

      if (action.type === 'fly_to') {
        ensureMapVisible(action.tab ? String(action.tab) : 'map');
        queueMapViewportCommand({
          type: 'fly_to',
          center: action.center,
          zoom: action.zoom,
          duration: action.duration,
        });
        return;
      }

      if (action.type === 'highlight_node') {
        ensureMapVisible(action.tab ? String(action.tab) : 'map');
        setCopilotTentativeHighlight(action.tentative ?? true);
        void focusOnMap(action.mrid, {
          name: action.label,
          coordinates: [action.center.lon, action.center.lat],
          navigateTab: true,
          tab: 'map',
        });
        queueMapViewportCommand({
          type: 'fly_to',
          center: action.center,
          zoom: action.zoom ?? 17,
        });
        return;
      }

      if (action.type === 'highlight_territory') {
        ensureMapVisible(action.tab ? String(action.tab) : 'map');
        clearFeederHighlight();
        if (action.district || action.region) {
          setSelectedTerritory({ district: action.district, region: action.region });
        }
        const label =
          action.label ?? action.district ?? action.region ?? 'Territory';
        const seq = ++territoryHighlightSeqRef.current;
        void (async () => {
          try {
            const geojson =
              action.geojson ??
              (await getSpatialTerritoryGeojson({
                district: action.district,
                region: action.region,
              }));
            if (seq !== territoryHighlightSeqRef.current) return;
            setTerritoryHighlight({
              geojson,
              label,
              district: action.district,
              region: action.region,
            });
          } catch (err) {
            giopLog.portal.warn('territory highlight failed', err);
          }
        })();
        queueMapViewportCommand({ type: 'fit_bounds', bbox: action.bbox });
        return;
      }

      if (action.type === 'highlight_feeder') {
        ensureMapVisible(action.tab ? String(action.tab) : 'map');
        clearTerritoryHighlight();
        clearImpactOverlay();
        setFeederHighlight({
          feederId: action.feeder_id,
          label: action.label ?? action.feeder_id,
          geojson: action.geojson,
          bbox: action.bbox,
        });
        if (action.bbox) {
          queueMapViewportCommand({ type: 'fit_bounds', bbox: action.bbox });
        }
        return;
      }

      if (action.type === 'show_downstream_impact') {
        ensureMapVisible(action.tab ? String(action.tab) : 'map');
        clearTerritoryHighlight();
        clearFeederHighlight();
        setImpactOverlay(action.impact);
        if (action.start_mrid) {
          setSelection(action.start_mrid, { source: 'table' });
        }
        if (action.bbox) {
          queueMapViewportCommand({ type: 'fit_bounds', bbox: action.bbox, max_zoom: 17 });
        }
      }
    },
    [
      ensureMapVisible,
      focusOnMap,
      goToTab,
      graphQuery,
      queueMapViewportCommand,
      setSelection,
      setTerritoryHighlight,
      setFeederHighlight,
      clearFeederHighlight,
      clearTerritoryHighlight,
      setImpactOverlay,
      clearImpactOverlay,
      startMrid,
    ],
  );

  const {
    technicians,
    selectedId: selectedTechnicianId,
    submissions: technicianSubmissions,
    loading: techniciansLoading,
    error: techniciansError,
    selectTechnician,
    clearSelection: clearTechnicianSelection,
  } = useGiopFieldTechnicians({
    enabled: route.tab === 'map' || route.tab === 'combined' || route.tab === 'operations',
  });

  const fieldCrewsPanel = {
    selectedId: selectedTechnicianId,
    submissions: technicianSubmissions,
    loading: techniciansLoading,
    error: techniciansError,
    onSelect: selectTechnician,
    onClear: clearTechnicianSelection,
    onFocusTechnician: (tech: (typeof technicians)[number]) => {
      setSelection(tech.technician_id, {
        coordinates: [tech.longitude, tech.latitude],
        source: 'map',
      });
    },
    onFocusAsset: (mrid: string, coordinates?: [number, number]) => {
      setSelection(mrid, { coordinates: coordinates ?? null, source: 'table' });
    },
  };

  // Keep latest "needs trace" flag for realtime callbacks without re-subscribing.
  const needsTraceRef = useRef(needsTrace);
  needsTraceRef.current = needsTrace;

  useGiopRealtime({
    onStagingChange: () => {
      setOpsRefreshToken((t) => t + 1);
      void refreshStaging();
      if (!needsTraceRef.current) return;
      window.clearTimeout(stagingTopologyTimerRef.current);
      stagingTopologyTimerRef.current = window.setTimeout(() => {
        void refreshTopology();
      }, 1200);
    },
    onMasterChange: () => {
      setOpsRefreshToken((t) => t + 1);
      scheduleMapRefresh();
      if (!needsTraceRef.current) return;
      setTimeout(() => void refreshTopology(), 1200);
    },
  });

  // Belt-and-suspenders: poll staging while map is open (realtime can lag).
  useEffect(() => {
    if (route.tab !== 'map' && route.tab !== 'combined' && route.tab !== 'operations') return;
    const id = window.setInterval(() => void refreshStaging(), 10000);
    return () => window.clearInterval(id);
  }, [route.tab, refreshStaging]);

  const focusCoordinates = useMemo(() => {
    const fromSelection = normalizeMapCoordinates(selection.coordinates);
    if (fromSelection) return fromSelection;
    const asset = staging.find((a) => a.mrid === selection.mrid);
    return normalizeMapCoordinates(asset?.geom?.coordinates) ?? null;
  }, [selection.coordinates, selection.mrid, staging]);

  const opsMapStagingAssets = opsTableStaging.length > 0 ? opsTableStaging : staging;

  const opsDeskFocusCoordinates = useMemo((): [number, number] | null => {
    const fromSelection = normalizeMapCoordinates(selection.coordinates);
    if (fromSelection) return fromSelection;
    const asset = opsMapStagingAssets.find((a) => a.mrid === selection.mrid);
    return extractStagingGeomCoordinates(asset?.geom);
  }, [selection.coordinates, selection.mrid, opsMapStagingAssets]);

  const bumpOpsFly = useCallback((coordinates: [number, number] | null) => {
    if (!coordinates) {
      giopLog.ops.warn('fly request skipped — no coordinates');
      return;
    }
    setOpsFlyRequest((prev) => {
      const next = { id: (prev?.id ?? 0) + 1, coordinates };
      giopLog.ops.info('fly request queued', next);
      return next;
    });
  }, []);

  // Ops desk "View on map" / row click: drive selection (label + pulse) and an
  // imperative camera pan. Coordinates come from the staging row; falls back to the
  // asset-location API only when the row has no geometry.
  const handleOpsAssetFocus = useCallback(
    async (asset: GiopStagingAsset) => {
      let coords = extractStagingGeomCoordinates(asset.geom);
      let name = asset.name?.trim() || undefined;
      giopLog.ops.info('View on map', { mrid: asset.mrid, geom: asset.geom, coords, name });

      setSelection(asset.mrid, { name, coordinates: coords, source: 'table' });
      if (coords) {
        bumpOpsFly(coords);
        return;
      }

      giopLog.ops.info('row geom missing — fetching asset location', { mrid: asset.mrid });
      try {
        const loc = await getAssetLocation(asset.mrid);
        if (loc.longitude != null && loc.latitude != null) {
          coords = normalizeMapCoordinates([loc.longitude, loc.latitude]);
        }
        name = name ?? loc.name?.trim() ?? undefined;
        giopLog.ops.info('asset location resolved', { mrid: asset.mrid, coords, name });
      } catch (err) {
        giopLog.ops.error('asset location fetch failed — pan skipped', { mrid: asset.mrid, err });
      }
      if (coords) {
        setSelection(asset.mrid, { name, coordinates: coords, source: 'table' });
        bumpOpsFly(coords);
      } else {
        giopLog.ops.warn('View on map failed — no coordinates for asset', { mrid: asset.mrid });
      }
    },
    [bumpOpsFly, setSelection],
  );

  const handleGraphNodeSelect = useCallback(
    (mrid: string, label?: string) => {
      setSelection(mrid, { name: label, source: 'graph' });
      writeGiopRouteToLocation(
        { tab: route.tab, startMrid, graphQuery, focusMrid: mrid },
        true,
      );
      if (route.tab === 'combined') {
        clearMapIdentifyFocus();
        const coordinates =
          resolvePortalGraphNodeCoordinates(graph, mrid) ??
          extractStagingGeomCoordinates(staging.find((a) => a.mrid === mrid)?.geom) ??
          null;
        void focusOnMap(mrid, {
          name: label,
          source: 'graph',
          navigateTab: false,
          sidePanel: false,
          coordinates,
        });
      }
    },
    [
      clearMapIdentifyFocus,
      focusOnMap,
      graph,
      graphQuery,
      route.tab,
      setSelection,
      staging,
      startMrid,
    ],
  );

  const handleOperationsMapNodeClick = useCallback(
    (mrid: string, coordinates?: [number, number]) => {
      clearMapIdentifyFocus();
      const asset = opsMapStagingAssets.find((a) => a.mrid === mrid);
      const coords =
        normalizeMapCoordinates(coordinates) ?? extractStagingGeomCoordinates(asset?.geom);
      giopLog.ops.info('map node click', { mrid, coordinates, resolved: coords });
      setSelection(mrid, { name: asset?.name, coordinates: coords, source: 'map' });
      bumpOpsFly(coords);
    },
    [bumpOpsFly, clearMapIdentifyFocus, opsMapStagingAssets, setSelection],
  );

  const handleOperationsGraphNodeSelect = useCallback((mrid: string, _label?: string) => {
    setOpsTopologyFocus(mrid);
  }, []);

  const clearOpsTopologyFocus = useCallback(() => {
    setOpsTopologyFocus(null);
  }, []);

  const clearFocus = useCallback(() => {
    writeGiopRouteToLocation(
      { tab: route.tab, startMrid, graphQuery, focusMrid: undefined },
      true,
    );
  }, [graphQuery, route.tab, startMrid]);

  const statusSlot = (
    <div className="flex items-center gap-3">
      <GiopApmWidget isLightMode={isLightMode} />
      <div className="flex items-center gap-2 text-xs">
        <span
          className={`inline-block h-2.5 w-2.5 rounded-full ${
            liveStatus === 'live' ? 'bg-premium-success-fg/80' : liveStatus === 'loading' ? 'bg-premium-warn-fg/80 animate-pulse' : 'bg-premium-muted-dim'
          }`}
        />
        <span className={isLightMode ? 'text-slate-600' : 'text-premium-muted'}>
          {liveStatus === 'live' ? 'Live' : liveStatus === 'loading' ? 'Updating…' : 'Idle'}
        </span>
      </div>
    </div>
  );

  // Side panel is redundant on full-screen map tabs and the operations desk.
  useEffect(() => {
    if (sideMap.open && (route.tab === 'map' || route.tab === 'combined' || route.tab === 'operations')) {
      closeSideMap();
    }
  }, [route.tab, sideMap.open, closeSideMap]);

  // Refresh staging when side map opens so master assets can still resolve coords.
  useEffect(() => {
    if (sideMap.open) void refreshStaging();
  }, [sideMap.open, refreshStaging]);

  const navGroups = useMemo(
    () =>
      NAV_GROUPS.map((group) => ({
        ...group,
        items: group.items.map((item) => ({
          ...item,
          badge: navBadges[item.id],
        })),
      })),
    [navBadges],
  );

  const sideMapCoordinates = useMemo(() => {
    const fromSide = normalizeMapCoordinates(sideMap.coordinates);
    if (fromSide) return fromSide;
    if (!sideMap.mrid) return null;
    const asset = staging.find((a) => a.mrid === sideMap.mrid);
    return normalizeMapCoordinates(asset?.geom?.coordinates) ?? null;
  }, [sideMap.coordinates, sideMap.mrid, staging]);

  const openSideMapFullTab = useCallback(() => {
    if (!sideMap.mrid) return;
    void focusOnMap(sideMap.mrid, {
      name: sideMap.name ?? undefined,
      coordinates: sideMapCoordinates,
      navigateTab: true,
      tab: 'map',
    });
  }, [focusOnMap, sideMap.mrid, sideMap.name, sideMapCoordinates]);

  const handleSideMapDockModeChange = useCallback((mode: SideMapDockMode) => {
    setSideMapDockMode(mode);
    writeSideMapDockMode(mode);
  }, []);

  const mapPulseFocus =
    mapIdentifyFocusMrid != null && selection.mrid === mapIdentifyFocusMrid;
  const mapPulseTentative = copilotTentativeHighlight && mapPulseFocus;

  const handleMapNodeClick = useCallback(
    (mrid: string, coordinates?: [number, number]) => {
      clearMapIdentifyFocus();
      setCopilotTentativeHighlight(false);
      setSelection(mrid, { coordinates: coordinates ?? null, source: 'map' });
    },
    [clearMapIdentifyFocus, setSelection],
  );

  const dqMapPinned = route.tab === 'data-quality';
  const sideMapVisible = dqMapPinned || sideMap.open;
  const sideMapFloating = sideMapVisible && sideMapDockMode === 'floating';

  const sideMapPanel = (
    <GiopMapErrorBoundary
      isLightMode={isLightMode}
      onReset={() => setSideMapEpoch((n) => n + 1)}
    >
      <GiopSideMapPanel
        key={`side-map-${sideMapEpoch}`}
        mrid={sideMap.mrid}
        name={sideMap.name}
        coordinates={sideMapCoordinates}
        isLightMode={isLightMode}
        stagingAssets={staging}
        startMrid={
          route.tab === 'data-quality' ? topologyStartMrid : (sideMap.mrid ?? topologyStartMrid)
        }
        mapRefreshToken={mapRefreshToken}
        flyRequest={sidePanelFlyRequest}
        impactOverlay={impactOverlay}
        persistent={route.tab === 'data-quality'}
        dockMode={sideMapDockMode}
        onDockModeChange={handleSideMapDockModeChange}
        onClose={closeSideMap}
        onOpenFullMap={openSideMapFullTab}
        onNodeClick={(mrid, coordinates) =>
          void focusOnMap(mrid, { coordinates: coordinates ?? null, source: 'map' })
        }
      />
    </GiopMapErrorBoundary>
  );

  const tabContent = (
    <>
      {route.tab === 'operations' && (
        <GiopOperationsDesk
          isLightMode={isLightMode}
          graph={graph}
          loading={topologyPanelLoading(graphQuery, loading, graph, seedReady)}
          revalidating={revalidating}
          error={error}
          graphQuery={graphQuery}
          onQueryChange={onQueryChange}
          focusMrid={selection.mrid}
          focusCoordinates={opsDeskFocusCoordinates}
          focusLabel={selection.name ?? null}
          topologyFocusMrid={opsTopologyFocus}
          flyRequest={opsFlyRequest}
          topologyGraphQueryOptions={OPS_TOPOLOGY_GRAPH_QUERY_OPTIONS}
          onFocusHandled={clearOpsTopologyFocus}
          onGraphNodeSelect={handleOperationsGraphNodeSelect}
          stagingAssets={opsMapStagingAssets}
          onMapNodeClick={handleOperationsMapNodeClick}
          onMapViewportChange={handleMapViewportChange}
          onTerritorySelect={handleTerritorySelect}
          mapRefreshToken={mapRefreshToken}
          startMrid={topologyStartMrid}
          impactOverlay={impactOverlay}
          feederHighlight={feederHighlight}
          opsRefreshToken={opsRefreshToken}
          onRefreshTopology={() => void refreshTopology()}
          onMapRefresh={refreshMap}
          onAssetFocus={handleOpsAssetFocus}
          onTableAssetsLoaded={setOpsTableStaging}
          fieldTechnicians={technicians}
          fieldCrews={fieldCrewsPanel}
          onTechnicianClick={selectTechnician}
          workOrders={workOrders}
        />
      )}

      {route.tab === 'map' && (
        <div className="relative h-full min-h-0 flex flex-col">
          <GiopMapView
            isLightMode={isLightMode}
            focusMrid={selection.mrid}
            focusCoordinates={focusCoordinates}
            focusLabel={mapPulseFocus ? (selection.name ?? null) : null}
            pulseFocus={mapPulseFocus}
            pulseFocusTentative={mapPulseTentative}
            stagingAssets={staging}
            fieldTechnicians={technicians}
            fieldCrews={fieldCrewsPanel}
            refreshToken={mapRefreshToken}
            onNodeClick={handleMapNodeClick}
            onTechnicianClick={selectTechnician}
            onViewportChange={handleMapViewportChange}
            onTerritorySelect={handleTerritorySelect}
            workOrders={workOrders}
            impactOverlay={impactOverlay}
            feederHighlight={feederHighlight}
          />
        </div>
      )}

      {route.tab === 'topology' && (
        <GiopTopologyTab
          graph={graph}
          loading={topologyPanelLoading(graphQuery, loading, graph, seedReady)}
          revalidating={revalidating}
          error={error}
          graphQuery={graphQuery}
          onQueryChange={onQueryChange}
          isLightMode={isLightMode}
          focusMrid={selection.mrid || route.focusMrid}
          onFocusHandled={clearFocus}
          onNodeSelect={handleGraphNodeSelect}
        />
      )}

      {route.tab === 'combined' && (
        <GiopSplitView
          graph={graph}
          loading={topologyPanelLoading(graphQuery, loading, graph, seedReady)}
          revalidating={revalidating}
          error={error}
          graphQuery={graphQuery}
          onQueryChange={onQueryChange}
          isLightMode={isLightMode}
          focusMrid={selection.mrid || route.focusMrid}
          onFocusHandled={clearFocus}
          onGraphNodeSelect={handleGraphNodeSelect}
          focusCoordinates={focusCoordinates}
          stagingAssets={staging}
          mapRefreshToken={mapRefreshToken}
          startMrid={topologyStartMrid}
          onMapNodeClick={handleMapNodeClick}
          onMapViewportChange={handleMapViewportChange}
          onTerritorySelect={handleTerritorySelect}
          fieldTechnicians={technicians}
          onTechnicianClick={selectTechnician}
          fieldCrews={fieldCrewsPanel}
          workOrders={workOrders}
          impactOverlay={impactOverlay}
          feederHighlight={feederHighlight}
          focusLabel={mapPulseFocus ? (selection.name ?? null) : null}
          pulseFocus={mapPulseFocus}
          pulseFocusTentative={mapPulseTentative}
        />
      )}

      {route.tab === 'schematic' && (
        <GiopSchematicTab isLightMode={isLightMode} startMrid={startMrid} />
      )}

      {route.tab === 'insights' && <GiopInsightsTab isLightMode={isLightMode} />}

      {route.tab === 'dlq' && <GiopDlqTab isLightMode={isLightMode} />}

      {route.tab === 'audit' && <GiopAuditTab isLightMode={isLightMode} />}

      {route.tab === 'data-quality' && <GiopDataQualityTab isLightMode={isLightMode} />}

      {route.tab === 'exports' && <GiopExportsTab isLightMode={isLightMode} />}

      {route.tab === 'references' && (
        <GiopGisReferenceTab isLightMode={isLightMode} onMapRefresh={refreshMap} />
      )}

      {route.tab === 'migration' && <GiopMigrationTab isLightMode={isLightMode} />}

      {route.tab === 'ocr' && <GiopMeterOcr isLightMode={isLightMode} />}

      {route.tab === 'cases' && <GiopCasesTab isLightMode={isLightMode} />}

      {route.tab === 'tickets' && <GiopTicketsTab isLightMode={isLightMode} />}

      {route.tab === 'work-orders' && (
        <GiopWorkOrdersTab
          isLightMode={isLightMode}
          workOrders={workOrders}
          onRefresh={() => {
            refreshMap();
            void listWorkOrders()
              .then(setWorkOrders)
              .catch(() => setWorkOrders([]));
          }}
        />
      )}

      {route.tab === 'outages' && <GiopOutagesTab isLightMode={isLightMode} />}

      {route.tab === 'reports' && <GiopReportsTab isLightMode={isLightMode} />}
    </>
  );

  const meta = TAB_META[route.tab];

  return (
    <EnhancedPortalShell
      activeTab={route.tab}
      onTabChange={goToTab}
      isLightMode={isLightMode}
      onThemeChange={setTheme}
      title={meta.title}
      subtitle={meta.subtitle}
      statusSlot={statusSlot}
      navGroups={navGroups}
      footerLink={{ href: 'http://localhost:8080', label: 'Legacy UI ↗' }}
    >
      <GiopWorkspaceLayout
        sideOpen={sideMapVisible}
        sideFloating={sideMapFloating}
        sidePanel={sideMapPanel}
        sideWidth={sideMapDockWidth}
        onSideWidthChange={setSideMapDockWidth}
        isLightMode={isLightMode}
      >
        {tabContent}
      </GiopWorkspaceLayout>
      {sideMapFloating && (
        <GiopFloatingMapShell
          rect={sideMapFloatRect}
          onRectChange={setSideMapFloatRect}
          isLightMode={isLightMode}
        >
          {sideMapPanel}
        </GiopFloatingMapShell>
      )}
      <EnhancedCopilotPanel
        isLightMode={isLightMode}
        portalContext={copilotContext}
        onUiAction={handleCopilotUiAction}
      />
      {REALTIME_VOICE_ENABLED && (
        <GiopRealtimeCopilot
          isLightMode={isLightMode}
          portalContext={copilotContext}
          onUiAction={handleCopilotUiAction}
        />
      )}
    </EnhancedPortalShell>
  );
}

export function GiopPortal() {
  return (
    <GiopSelectionProvider>
      <GiopMapOverlayProvider>
        <GiopVoiceModeProvider>
          <GiopPortalInner />
        </GiopVoiceModeProvider>
      </GiopMapOverlayProvider>
    </GiopSelectionProvider>
  );
}
