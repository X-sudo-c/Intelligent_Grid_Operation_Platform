import { useCallback, useMemo } from 'react';
import { GiopMapView } from './GiopMapView';
import { GiopTopologyTab } from './GiopTopologyTab';
import { SPLIT_VIEW_GRAPH_QUERY_OPTIONS, GIOP_GRAPH_QUERY_OPTIONS, type GiopGraphQueryKey } from '../lib/giopGraphTypes';
import type { PortalGraphResponse } from '../lib/giopGraphTypes';
import type { GiopFieldTechnician, GiopStagingAsset, GiopWorkOrder, GiopTopologyPayload } from '../api/giop-api';
import { useGiopGraphChunk } from '../hooks/useGiopGraphChunk';
import { chunkToPortalGraph } from '../lib/giopGraphAdapter';
import type { MapBbox } from '../hooks/useGiopGraphChunk';

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
  focusLabel?: string | null;
  pulseFocus?: boolean;
  mapChrome?: 'full' | 'operations';
  /** Ops desk: topology highlight is independent of map/table focus. */
  topologyFocusMrid?: string | null;
  /** Ops desk "View on map": imperative pan request forwarded to the embedded map. */
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
  startMrid,
  fieldTechnicians = [],
  onTechnicianClick,
  fieldCrews,
  workOrders = [],
  impactOverlay = null,
  focusLabel,
  pulseFocus = false,
  mapChrome = 'full',
  topologyFocusMrid,
  flyRequest = null,
  topologyGraphQueryOptions,
}: GiopSplitViewProps) {
  const isOpsDesk = mapChrome === 'operations';
  const ratio = readSplitRatio();
  const { chunk, loading: chunkLoading, error: chunkError, loadBbox } = useGiopGraphChunk(startMrid);

  const viewportGraph = useMemo(
    () => (chunk ? chunkToPortalGraph(chunk, stagingAssets) : null),
    [chunk, stagingAssets],
  );

  const displayGraph = graphQuery === 'viewport_subgraph' ? viewportGraph : graph;
  const displayLoading = graphQuery === 'viewport_subgraph' ? chunkLoading && !viewportGraph : loading;
  const displayError =
    graphQuery === 'viewport_subgraph' ? chunkError || (viewportGraph ? null : error) : error;

  const handleViewportChange = useCallback(
    (bbox: MapBbox, zoom: number, center: { lon: number; lat: number }) => {
      void loadBbox(bbox, zoom);
      onMapViewportChange?.(bbox, zoom, center);
    },
    [loadBbox, onMapViewportChange],
  );

  return (
    <div className="flex h-full min-h-0">
      <div className="relative min-h-0 h-full border-r border-slate-800" style={{ width: `${ratio}%` }}>
        <GiopMapView
          isLightMode={isLightMode}
          focusMrid={focusMrid}
          focusCoordinates={focusCoordinates}
          focusLabel={focusLabel}
          pulseFocus={pulseFocus}
          mapChrome={mapChrome}
          flyRequest={flyRequest}
          stagingAssets={stagingAssets}
          fieldTechnicians={fieldTechnicians}
          fieldCrews={fieldCrews}
          onNodeClick={onMapNodeClick}
          onTechnicianClick={onTechnicianClick}
          onViewportChange={handleViewportChange}
          onTerritorySelect={onTerritorySelect}
          refreshToken={mapRefreshToken}
          startMrid={startMrid}
          streamGraphChunk={false}
          graphChunk={chunk}
          chunkLoadingExternal={chunkLoading}
          chunkErrorExternal={chunkError}
          workOrders={workOrders}
          impactOverlay={impactOverlay}
        />
      </div>
      <div className="min-h-0 flex-1">
        <GiopTopologyTab
          graph={displayGraph}
          loading={displayLoading}
          revalidating={revalidating}
          error={displayError}
          graphQuery={graphQuery}
          onQueryChange={onQueryChange}
          isLightMode={isLightMode}
          focusMrid={isOpsDesk ? topologyFocusMrid : focusMrid}
          onFocusHandled={onFocusHandled}
          onNodeSelect={onGraphNodeSelect}
          graphQueryOptions={topologyGraphQueryOptions ?? SPLIT_VIEW_GRAPH_QUERY_OPTIONS}
          compact
          graphChrome={isOpsDesk ? 'operations' : 'full'}
        />
      </div>
    </div>
  );
}
