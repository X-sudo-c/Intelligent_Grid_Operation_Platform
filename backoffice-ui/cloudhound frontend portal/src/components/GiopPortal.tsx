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
import { GiopMapErrorBoundary } from './GiopMapErrorBoundary';
import { GiopWorkspaceLayout } from './GiopWorkspaceLayout';
import { GiopSelectionProvider, useGiopSelection } from '../context/GiopSelectionContext';
import { GiopMapOverlayProvider, useGiopMapOverlay } from '../context/GiopMapOverlayContext';
import { useGiopTopology } from '../hooks/useGiopTopology';
import { useGiopRealtime } from '../hooks/useGiopRealtime';
import { useGiopFieldTechnicians } from '../hooks/useGiopFieldTechnicians';
import { DEFAULT_START_MRID, getAssetLocation, getSpatialTerritoryGeojson, getStagingAssets, listWorkOrders, type GiopStagingAsset, type GiopWorkOrder } from '../api/giop-api';
import {
  readGiopRouteFromLocation,
  subscribeToGiopRouteChanges,
  writeGiopRouteToLocation,
  type GiopPortalTab,
} from '../lib/giopPortalRouting';
import type { GiopGraphQueryKey } from '../lib/giopGraphTypes';
import { GIOP_GRAPH_QUERY_OPTIONS } from '../lib/giopGraphTypes';
import { normalizeMapCoordinates, extractStagingGeomCoordinates } from '../lib/giopMapCoordinates';
import type { GiopMapFlyRequest } from '../lib/giopMapFlyRequest';
import { resolveTopologyStartMrid, isStagingOnlySeed } from '../lib/resolveTopologyStartMrid';
import { giopLog } from '../lib/giopDebugLog';
import { useGiopNavBadges } from '../hooks/useGiopNavBadges';
import type { PortalNavGroup } from './EnhancedPortalShell';
import { EnhancedCopilotPanel } from './EnhancedCopilotPanel';
import { isGiopPortalTab } from './GiopCopilotPanel';
import type {
  GiopCopilotPortalContext,
  GiopCopilotUiAction,
  MapViewportContext,
} from '../lib/giopCopilotTypes';
import type { MapBbox } from '../hooks/useGiopGraphChunk';

const OPS_TOPOLOGY_GRAPH_QUERY_OPTIONS = GIOP_GRAPH_QUERY_OPTIONS.filter(
  (o) => o.key === 'traced_subgraph' || o.key === 'network_topology',
);

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
  const [opsRefreshToken, setOpsRefreshToken] = useState(0);
  const [liveStatus, setLiveStatus] = useState<'idle' | 'loading' | 'live'>('idle');
  const [mapViewport, setMapViewport] = useState<MapViewportContext | null>(null);
  const mapViewportRef = useRef<MapViewportContext | null>(null);
  const [selectedTerritory, setSelectedTerritory] = useState<{
    district?: string;
    region?: string;
  } | null>(null);
  const stagingTopologyTimerRef = useRef<number | undefined>(undefined);
  /** Guards against an older async territory-geojson fetch overwriting a newer one. */
  const territoryHighlightSeqRef = useRef(0);

  const { selection, setSelection } = useGiopSelection();
  const {
    impactOverlay,
    sideMap,
    closeSideMap,
    focusOnMap,
    sidePanelFlyRequest,
    mapIdentifyFocusMrid,
    clearMapIdentifyFocus,
    queueMapViewportCommand,
    setTerritoryHighlight,
  } = useGiopMapOverlay();
  const navBadges = useGiopNavBadges(opsRefreshToken);
  const [workOrders, setWorkOrders] = useState<GiopWorkOrder[]>([]);
  const [opsTopologyFocus, setOpsTopologyFocus] = useState<string | null>(null);
  const [opsTableStaging, setOpsTableStaging] = useState<GiopStagingAsset[]>([]);
  const [opsFlyRequest, setOpsFlyRequest] = useState<GiopMapFlyRequest | null>(null);

  const routeStartMrid = route.startMrid || DEFAULT_START_MRID;
  const startMrid = routeStartMrid;

  // Operations topology panel uses master Memgraph trace; map uses tiles + staging overlay.
  const needsTrace =
    route.tab === 'topology' || route.tab === 'combined' || route.tab === 'operations';

  const [stagingSeedRows, setStagingSeedRows] = useState<GiopStagingAsset[]>([]);
  useEffect(() => {
    void getStagingAssets()
      .then(setStagingSeedRows)
      .catch(() => setStagingSeedRows([]));
  }, [opsRefreshToken]);

  const topologyStartMrid = useMemo(
    () => resolveTopologyStartMrid(route.tab, route.startMrid, stagingSeedRows),
    [route.tab, route.startMrid, stagingSeedRows],
  );

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
    traceActive: needsTrace,
    initialGraphQuery:
      route.tab === 'combined'
        ? 'viewport_subgraph'
        : route.tab === 'operations'
          ? 'traced_subgraph'
          : 'traced_subgraph',
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
    if (route.tab === 'combined' && graphQuery !== 'viewport_subgraph' && graphQuery !== 'traced_subgraph') {
      applyQuery('viewport_subgraph');
    }
    if (route.tab === 'operations' && graphQuery !== 'traced_subgraph' && graphQuery !== 'network_topology') {
      applyQuery('traced_subgraph');
    }
  }, [route.tab, graphQuery, applyQuery]);

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
    if (route.graphQuery && route.graphQuery !== graphQuery) {
      if (route.tab === 'operations') return;
      applyQuery(route.graphQuery as GiopGraphQueryKey);
    }
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

  const copilotContext = useMemo((): GiopCopilotPortalContext => {
    const pending = staging.filter((a) => a.validation !== 'REJECTED').length;
    return {
      active_tab: route.tab,
      focus_mrid: selection.mrid ?? route.focusMrid ?? null,
      selection_name: selection.name ?? null,
      staging_pending_count: pending,
      viewport: mapViewport ?? mapViewportRef.current,
      selected_district: selectedTerritory?.district ?? null,
      selected_region: selectedTerritory?.region ?? null,
    };
  }, [
    route.tab,
    route.focusMrid,
    selection.mrid,
    selection.name,
    staging,
    mapViewport,
    selectedTerritory,
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
        if (tab === 'map' || tab === 'combined' || tab === 'operations') refreshMap();
        return;
      }

      if (action.type === 'fit_bounds') {
        ensureMapVisible(action.tab ? String(action.tab) : 'map');
        if (action.district || action.region) {
          setSelectedTerritory({ district: action.district, region: action.region });
        }
        queueMapViewportCommand({ type: 'fit_bounds', bbox: action.bbox });
        refreshMap();
        return;
      }

      if (action.type === 'fly_to') {
        ensureMapVisible(action.tab ? String(action.tab) : 'map');
        queueMapViewportCommand({
          type: 'fly_to',
          center: action.center,
          zoom: action.zoom,
        });
        refreshMap();
        return;
      }

      if (action.type === 'highlight_territory') {
        ensureMapVisible(action.tab ? String(action.tab) : 'map');
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
        refreshMap();
      }
    },
    [
      ensureMapVisible,
      focusOnMap,
      goToTab,
      graphQuery,
      queueMapViewportCommand,
      refreshMap,
      setSelection,
      setTerritoryHighlight,
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
      refreshMap();
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
    },
    [graphQuery, route.tab, setSelection, startMrid],
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

  const mapPulseFocus =
    mapIdentifyFocusMrid != null && selection.mrid === mapIdentifyFocusMrid;

  const handleMapNodeClick = useCallback(
    (mrid: string, coordinates?: [number, number]) => {
      clearMapIdentifyFocus();
      setSelection(mrid, { coordinates: coordinates ?? null, source: 'map' });
    },
    [clearMapIdentifyFocus, setSelection],
  );

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
        onClose={closeSideMap}
        onOpenFullMap={openSideMapFullTab}
        onNodeClick={(mrid, coordinates) =>
          void focusOnMap(mrid, { coordinates: coordinates ?? null, source: 'map' })
        }
      />
    </GiopMapErrorBoundary>
  );

  const dqMapPinned = route.tab === 'data-quality';

  const tabContent = (
    <>
      {route.tab === 'operations' && (
        <GiopOperationsDesk
          isLightMode={isLightMode}
          graph={graph}
          loading={loading}
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
            stagingAssets={staging}
            fieldTechnicians={technicians}
            fieldCrews={fieldCrewsPanel}
            refreshToken={mapRefreshToken}
            startMrid={topologyStartMrid}
            onNodeClick={handleMapNodeClick}
            onTechnicianClick={selectTechnician}
            onViewportChange={handleMapViewportChange}
            onTerritorySelect={handleTerritorySelect}
            workOrders={workOrders}
            impactOverlay={impactOverlay}
          />
        </div>
      )}

      {route.tab === 'topology' && (
        <GiopTopologyTab
          graph={graph}
          loading={loading}
          revalidating={revalidating}
          error={error}
          graphQuery={(route.graphQuery as GiopGraphQueryKey) || graphQuery}
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
          loading={loading}
          revalidating={revalidating}
          error={error}
          graphQuery={(route.graphQuery as GiopGraphQueryKey) || graphQuery}
          onQueryChange={onQueryChange}
          isLightMode={isLightMode}
          focusMrid={selection.mrid || route.focusMrid}
          onFocusHandled={clearFocus}
          onGraphNodeSelect={handleGraphNodeSelect}
          focusCoordinates={focusCoordinates}
          stagingAssets={staging}
          mapRefreshToken={mapRefreshToken}
          startMrid={topologyStartMrid}
          onMapNodeClick={(mrid, coordinates) =>
            setSelection(mrid, { coordinates: coordinates ?? null, source: 'map' })
          }
          onMapViewportChange={handleMapViewportChange}
          onTerritorySelect={handleTerritorySelect}
          fieldTechnicians={technicians}
          onTechnicianClick={selectTechnician}
          fieldCrews={fieldCrewsPanel}
          workOrders={workOrders}
          impactOverlay={impactOverlay}
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
        sideOpen={dqMapPinned || sideMap.open}
        sidePanel={sideMapPanel}
      >
        {tabContent}
      </GiopWorkspaceLayout>
      <EnhancedCopilotPanel
        isLightMode={isLightMode}
        portalContext={copilotContext}
        onUiAction={handleCopilotUiAction}
      />
    </EnhancedPortalShell>
  );
}

export function GiopPortal() {
  return (
    <GiopSelectionProvider>
      <GiopMapOverlayProvider>
        <GiopPortalInner />
      </GiopMapOverlayProvider>
    </GiopSelectionProvider>
  );
}
