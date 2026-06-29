import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { EnhancedPortalShell } from './EnhancedPortalShell';
import { GiopTopologyTab } from './GiopTopologyTab';
import { GiopMapView } from './GiopMapView';
import { GiopSplitView } from './GiopSplitView';
import { GiopOperationsTab } from './GiopOperationsTab';
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
import { DEFAULT_START_MRID, getSpatialTerritoryGeojson, listWorkOrders, type GiopWorkOrder } from '../api/giop-api';
import {
  readGiopRouteFromLocation,
  subscribeToGiopRouteChanges,
  writeGiopRouteToLocation,
  type GiopPortalTab,
} from '../lib/giopPortalRouting';
import type { GiopGraphQueryKey } from '../lib/giopGraphTypes';
import { normalizeMapCoordinates } from '../lib/giopMapCoordinates';
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
    subtitle: 'Staging assets, validation, and topology repair',
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
  const [selectedTerritory, setSelectedTerritory] = useState<{
    district?: string;
    region?: string;
  } | null>(null);
  const stagingTopologyTimerRef = useRef<number | undefined>(undefined);

  const startMrid = route.startMrid || DEFAULT_START_MRID;
  const { selection, setSelection } = useGiopSelection();
  const {
    impactOverlay,
    sideMap,
    closeSideMap,
    focusOnMap,
    mapIdentifyFocusMrid,
    clearMapIdentifyFocus,
    queueMapViewportCommand,
    setTerritoryHighlight,
  } = useGiopMapOverlay();
  const navBadges = useGiopNavBadges(opsRefreshToken);
  const [workOrders, setWorkOrders] = useState<GiopWorkOrder[]>([]);

  // Only the graph views actually need the (expensive) Memgraph trace. The map
  // renders from Martin tiles + the staging overlay, so it doesn't.
  const needsTrace = route.tab === 'topology' || route.tab === 'combined';

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
  } = useGiopTopology(startMrid, {
    traceActive: needsTrace,
    initialGraphQuery: route.tab === 'combined' ? 'viewport_subgraph' : 'traced_subgraph',
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
  }, [route.tab, graphQuery, applyQuery]);

  useEffect(() => {
    if (route.graphQuery && route.graphQuery !== graphQuery) {
      applyQuery(route.graphQuery as GiopGraphQueryKey);
    }
  }, [route.graphQuery, graphQuery, applyQuery]);

  useEffect(() => {
    try {
      localStorage.setItem(THEME_STORAGE_KEY, isLightMode ? 'light' : 'dark');
    } catch {
      /* ignore */
    }
  }, [isLightMode]);

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
      viewport: mapViewport,
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
      const target: GiopPortalTab =
        tab === 'combined' ? 'combined' : tab === 'map' || !tab ? 'map' : 'map';
      if (route.tab !== target) goToTab(target);
    },
    [goToTab, route.tab],
  );

  const handleMapViewportChange = useCallback(
    (bbox: MapBbox, zoom: number, center: { lon: number; lat: number }) => {
      setMapViewport({ bbox, zoom, center });
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
          writeGiopRouteToLocation(
            { tab, startMrid, graphQuery, focusMrid: action.focus_mrid },
            true,
          );
          if (tab === 'map' || tab === 'combined') {
            void focusOnMap(action.focus_mrid, { navigateTab: true, tab });
          }
        } else {
          goToTab(tab);
        }
        if (action.district || action.region) {
          setSelectedTerritory({ district: action.district, region: action.region });
        }
        if (tab === 'operations') setOpsRefreshToken((t) => t + 1);
        if (tab === 'map' || tab === 'combined') refreshMap();
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
        void (async () => {
          try {
            const geojson =
              action.geojson ??
              (await getSpatialTerritoryGeojson({
                district: action.district,
                region: action.region,
              }));
            setTerritoryHighlight({
              geojson,
              label,
              district: action.district,
              region: action.region,
            });
          } catch (err) {
            console.warn('[GiopPortal] territory highlight failed:', err);
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
    enabled: route.tab === 'map' || route.tab === 'combined',
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
    if (route.tab !== 'map' && route.tab !== 'combined') return;
    const id = window.setInterval(() => void refreshStaging(), 10000);
    return () => window.clearInterval(id);
  }, [route.tab, refreshStaging]);

  const focusCoordinates = useMemo(() => {
    const fromSelection = normalizeMapCoordinates(selection.coordinates);
    if (fromSelection) return fromSelection;
    const asset = staging.find((a) => a.mrid === selection.mrid);
    return normalizeMapCoordinates(asset?.geom?.coordinates) ?? null;
  }, [selection.coordinates, selection.mrid, staging]);

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
            liveStatus === 'live' ? 'bg-cyan-400' : liveStatus === 'loading' ? 'bg-yellow-400 animate-pulse' : 'bg-slate-500'
          }`}
        />
        <span className={isLightMode ? 'text-slate-600' : 'text-slate-400'}>
          {liveStatus === 'live' ? 'Live' : liveStatus === 'loading' ? 'Updating…' : 'Idle'}
        </span>
      </div>
    </div>
  );

  // Side panel is redundant on full-screen map tabs.
  useEffect(() => {
    if (sideMap.open && (route.tab === 'map' || route.tab === 'combined')) {
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
        key={`${sideMap.mrid ?? 'none'}-${sideMapEpoch}`}
        mrid={sideMap.mrid}
        name={sideMap.name}
        coordinates={sideMapCoordinates}
        isLightMode={isLightMode}
        stagingAssets={staging}
        startMrid={sideMap.mrid ?? startMrid}
        mapRefreshToken={mapRefreshToken}
        impactOverlay={impactOverlay}
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
        <GiopOperationsTab
          isLightMode={isLightMode}
          onRefreshTopology={() => void refreshTopology()}
          onMapRefresh={refreshMap}
          refreshToken={opsRefreshToken}
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
            startMrid={startMrid}
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
          startMrid={startMrid}
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
      onToggleTheme={() => setIsLightMode((m) => !m)}
      title={meta.title}
      subtitle={meta.subtitle}
      statusSlot={statusSlot}
      navGroups={navGroups}
      footerLink={{ href: 'http://localhost:8080', label: 'Legacy UI ↗' }}
    >
      <GiopWorkspaceLayout sideOpen={sideMap.open} sidePanel={sideMapPanel}>
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
