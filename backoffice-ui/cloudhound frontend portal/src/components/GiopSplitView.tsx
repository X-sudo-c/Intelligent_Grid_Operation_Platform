import { useCallback, useMemo, useRef, useState } from 'react';
import { GiopMapView } from './GiopMapView';
import { GiopTopologyTab } from './GiopTopologyTab';
import { GiopMapSearchBar } from './GiopMapSearchBar';
import type { GiopMapSearchResult } from '../api/giop-api';
import { SPLIT_VIEW_GRAPH_QUERY_OPTIONS, GIOP_GRAPH_QUERY_OPTIONS, type GiopGraphQueryKey } from '../lib/giopGraphTypes';
import type { PortalGraphResponse } from '../lib/giopGraphTypes';
import type { GiopFieldTechnician, GiopStagingAsset, GiopWorkOrder, GiopTopologyPayload } from '../api/giop-api';
import type { MapBbox } from '../hooks/useGiopGraphChunk';
import type { FeederHighlightState } from '../lib/giopFeederHighlight';
import type { GiopMapSearchBridge } from '../lib/giopMapSearchBridge';
import { buildGraphNodeSearchCatalog, mergeSearchCatalogs } from '../lib/giopMapLocalSearch';

type SearchCatalogSnapshot = Pick<GiopMapSearchBridge, 'placeCatalog' | 'opsCatalog' | 'placesReady'>;

export interface GiopSplitViewProps {
  graph: PortalGraphResponse | null;
  loading: boolean;
  revalidating?: boolean;
  error: string | null;
  graphQuery: GiopGraphQueryKey;
  onQueryChange: (key: GiopGraphQueryKey) => void;
  isLightMode: boolean;
  focusMrid?: string | null;
  onFocusHandled?: () => void;
  onGraphNodeSelect?: (mrid: string, label?: string) => void;
  focusCoordinates?: [number, number] | null;
  stagingAssets?: GiopStagingAsset[];
  onMapNodeClick?: (mrid: string, coordinates?: [number, number]) => void;
  onMapViewportChange?: (bbox: MapBbox, zoom: number, center: { lon: number; lat: number }) => void;
  onTerritorySelect?: (territory: { district?: string; region?: string }) => void;
  mapRefreshToken?: number;
  startMrid?: string;
  fieldTechnicians?: GiopFieldTechnician[];
  onTechnicianClick?: (technicianId: string) => void;
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
  focusLabel?: string | null;
  pulseFocus?: boolean;
  pulseFocusTentative?: boolean;
  mapChrome?: 'full' | 'operations';
  topologyFocusMrid?: string | null;
  flyRequest?: { id: number; coordinates: [number, number] | null } | null;
  topologyGraphQueryOptions?: typeof GIOP_GRAPH_QUERY_OPTIONS;
}

const SPLIT_RATIO_KEY = 'giop.portal.splitRatio.v1';

function readSplitRatio(): number {
  try {
    const raw = localStorage.getItem(SPLIT_RATIO_KEY);
    const n = raw ? Number(raw) : 50;
    return Number.isFinite(n) ? Math.min(80, Math.max(20, n)) : 50;
  } catch {
    return 50;
  }
}

export function GiopSplitView({
  graph,
  loading,
  revalidating = false,
  error,
  graphQuery,
  onQueryChange,
  isLightMode,
  focusMrid,
  onFocusHandled,
  onGraphNodeSelect,
  focusCoordinates,
  stagingAssets = [],
  onMapNodeClick,
  onMapViewportChange,
  onTerritorySelect,
  mapRefreshToken = 0,
  workOrders = [],
  impactOverlay = null,
  feederHighlight = null,
  focusLabel,
  pulseFocus = false,
  pulseFocusTentative = false,
  mapChrome = 'full',
  topologyFocusMrid,
  flyRequest = null,
  topologyGraphQueryOptions,
}: GiopSplitViewProps) {
  const isOpsDesk = mapChrome === 'operations';
  const isCombinedView = !isOpsDesk;
  const ratio = readSplitRatio();
  const searchBridgeRef = useRef<GiopMapSearchBridge | null>(null);
  const catalogSnapshotRef = useRef<SearchCatalogSnapshot | null>(null);
  const [catalogSnapshot, setCatalogSnapshot] = useState<SearchCatalogSnapshot | null>(null);
  const onSearchBridgeCatalog = useCallback((snapshot: SearchCatalogSnapshot) => {
    const prev = catalogSnapshotRef.current;
    if (
      prev &&
      prev.placeCatalog === snapshot.placeCatalog &&
      prev.opsCatalog === snapshot.opsCatalog &&
      prev.placesReady === snapshot.placesReady
    ) {
      return;
    }
    catalogSnapshotRef.current = snapshot;
    setCatalogSnapshot(snapshot);
  }, []);

  const queryOptions = topologyGraphQueryOptions ?? SPLIT_VIEW_GRAPH_QUERY_OPTIONS;

  const unifiedOpsCatalog = useMemo(() => {
    if (!catalogSnapshot) return [];
    const ops = catalogSnapshot.opsCatalog.filter((item) => item.kind !== 'crew');
    const graphNodes = buildGraphNodeSearchCatalog(graph);
    return mergeSearchCatalogs(ops, graphNodes);
  }, [catalogSnapshot, graph]);

  const handleUnifiedSearchSelect = useCallback(
    (result: GiopMapSearchResult) => {
      searchBridgeRef.current?.onSelect(result);
      const inGraph =
        result.subtitle === 'Network node' ||
        Boolean(graph?.nodes.some((node) => node.id === result.id));
      if (inGraph) {
        onGraphNodeSelect?.(result.id, result.title);
      }
    },
    [graph?.nodes, onGraphNodeSelect],
  );

  const handleViewportChange = useCallback(
    (bbox: MapBbox, zoom: number, center: { lon: number; lat: number }) => {
      onMapViewportChange?.(bbox, zoom, center);
    },
    [onMapViewportChange],
  );

  const displayLoading = loading && !graph;

  return (
    <div className={`giop-split-view ${isLightMode ? 'giop-split-view--light' : ''}`}>
      <div className="giop-split-panes">
        <div
          className={`giop-split-pane giop-split-pane--map relative ${isCombinedView ? '' : 'border-r border-slate-800'}`}
          style={{ width: `${ratio}%` }}
        >
          <GiopMapView
            isLightMode={isLightMode}
            focusMrid={focusMrid}
            focusCoordinates={focusCoordinates}
            focusLabel={focusLabel}
            pulseFocus={pulseFocus}
            pulseFocusTentative={pulseFocusTentative}
            mapChrome={isCombinedView ? 'split' : mapChrome}
            flyRequest={flyRequest}
            stagingAssets={stagingAssets}
            onNodeClick={onMapNodeClick}
            onViewportChange={handleViewportChange}
            onTerritorySelect={onTerritorySelect}
            refreshToken={mapRefreshToken}
            workOrders={workOrders}
            impactOverlay={impactOverlay}
            feederHighlight={feederHighlight}
            showSearchBar={!isCombinedView}
            searchBridgeRef={isCombinedView ? searchBridgeRef : undefined}
            onSearchBridgeCatalog={isCombinedView ? onSearchBridgeCatalog : undefined}
          />
        </div>
        <div className="giop-split-pane flex-1 min-w-0">
          <GiopTopologyTab
            graph={graph}
            loading={displayLoading}
            revalidating={revalidating}
            error={error}
            graphQuery={graphQuery}
            onQueryChange={onQueryChange}
            isLightMode={isLightMode}
            focusMrid={isOpsDesk ? topologyFocusMrid : focusMrid}
            onFocusHandled={onFocusHandled}
            onNodeSelect={onGraphNodeSelect}
            graphQueryOptions={queryOptions}
            compact
            layoutMode={isCombinedView ? 'split' : 'default'}
            graphChrome={isOpsDesk ? 'operations' : 'full'}
          />
        </div>
      </div>

      {isCombinedView && (
        <div className="giop-split-chrome">
          <div className="giop-split-chrome__modes">
            {queryOptions.map((option) => (
              <button
                key={option.key}
                type="button"
                onClick={() => onQueryChange(option.key)}
                title={
                  option.key === graphQuery && graph?.metrics?.note
                    ? graph.metrics.note
                    : option.label
                }
                className={`inline-flex h-7 items-center rounded-full border px-2.5 text-[11px] font-medium transition ${
                  graphQuery === option.key
                    ? 'border-premium-accent/70 bg-premium-accent/20 text-premium-text'
                    : isLightMode
                      ? 'border-transparent bg-white/90 text-slate-600 hover:bg-white'
                      : 'border-transparent bg-premium-card/80 text-premium-muted hover:bg-premium-hover hover:text-premium-text'
                }`}
              >
                {option.label}
              </button>
            ))}
          </div>

          <div className="giop-split-chrome__search">
            {catalogSnapshot ? (
              <GiopMapSearchBar
                variant="split"
                isLightMode={isLightMode}
                placeCatalog={catalogSnapshot.placeCatalog}
                opsCatalog={unifiedOpsCatalog}
                placesReady={catalogSnapshot.placesReady}
                onPreview={(result) => searchBridgeRef.current?.onPreview(result)}
                onSelect={handleUnifiedSearchSelect}
                placeholder="Search map & network"
                hideCrewFilter
              />
            ) : null}
          </div>
        </div>
      )}

      {isCombinedView && error && !graph && (
        <div
          className={`giop-split-float giop-split-float--meta ${isLightMode ? 'giop-split-float--meta-light' : ''}`}
          style={{ top: 'auto', bottom: 12, right: 12 }}
        >
          {error}
        </div>
      )}
    </div>
  );
}
