import { useCallback, useEffect, useRef, useState } from 'react';
import { DEFAULT_START_MRID, getStagingAssets, getTopologyGaps, getTrace } from '../api/giop-api';
import type { GiopStagingAsset, GiopTraceResponse } from '../api/giop-api';
import { topologyPayloadToPortalGraph, traceToPortalGraph } from '../lib/giopGraphAdapter';
import type { GiopGraphQueryKey } from '../lib/giopGraphTypes';
import type { PortalGraphResponse } from '../lib/giopGraphTypes';
import { readSwCache, writeSwCache } from '../lib/giopSwCache';

function traceCacheKey(startMrid: string, scope: 'traced' | 'full'): string {
  return `trace:${scope}:${startMrid}`;
}

export interface GiopTopologyState {
  trace: GiopTraceResponse | null;
  staging: GiopStagingAsset[];
  graph: PortalGraphResponse | null;
  loading: boolean;
  error: string | null;
}

function traceScopeForQuery(queryKey: GiopGraphQueryKey): 'traced' | 'full' {
  return queryKey === 'traced_subgraph' ? 'traced' : 'full';
}

/** Only these modes need a fresh /trace call; viewport uses map chunks instead. */
function needsTraceFetch(queryKey: GiopGraphQueryKey): boolean {
  return queryKey === 'traced_subgraph' || queryKey === 'network_topology';
}

interface UseGiopTopologyOptions {
  /**
   * When false, the expensive Memgraph trace is NOT fetched on mount. Only the
   * lightweight staging overlay loads (enough for the map + side panel). The
   * trace loads lazily the first time this flips true (i.e. when the user opens
   * the Topology / Map+Topology tabs). Defaults to true for backwards-compat.
   */
  traceActive?: boolean;
  /** Initial graph query key (e.g. viewport for split view). */
  initialGraphQuery?: GiopGraphQueryKey;
}

export function useGiopTopology(
  startMrid: string = DEFAULT_START_MRID,
  options?: UseGiopTopologyOptions,
) {
  const traceActive = options?.traceActive ?? true;
  const initialGraphQuery = options?.initialGraphQuery ?? 'traced_subgraph';
  const [trace, setTrace] = useState<GiopTraceResponse | null>(null);
  const [staging, setStaging] = useState<GiopStagingAsset[]>([]);
  const [graphQuery, setGraphQuery] = useState<GiopGraphQueryKey>(initialGraphQuery);
  const [graph, setGraph] = useState<PortalGraphResponse | null>(null);
  const [loading, setLoading] = useState(() => {
    if (!traceActive || !needsTraceFetch(initialGraphQuery)) return false;
    const scope = traceScopeForQuery(initialGraphQuery);
    return readSwCache<GiopTraceResponse>(traceCacheKey(startMrid, scope)) === null;
  });
  const [revalidating, setRevalidating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [traceScope, setTraceScope] = useState<'traced' | 'full'>('traced');
  const loadedTraceKeyRef = useRef<string | null>(null);

  useEffect(() => {
    loadedTraceKeyRef.current = null;
  }, [startMrid]);

  const rebuildGraph = useCallback(
    (traceData: GiopTraceResponse, stagingData: GiopStagingAsset[], queryKey: GiopGraphQueryKey) => {
      setGraph(traceToPortalGraph(traceData, stagingData, queryKey));
    },
    [],
  );

  const refresh = useCallback(
    async (queryKey: GiopGraphQueryKey = graphQuery) => {
      const scope = traceScopeForQuery(queryKey);
      const stagingData = await getStagingAssets().catch(() => [] as GiopStagingAsset[]);
      setStaging(stagingData);

      if (queryKey === 'topology_gaps') {
        setLoading(true);
        setRevalidating(false);
        setError(null);
        try {
          const gapsData = await getTopologyGaps({ limit: 2000 });
          setTrace(null);
          setTraceScope(scope);
          setGraph(topologyPayloadToPortalGraph(gapsData, stagingData, queryKey, 'Disconnected assets'));
        } catch (err) {
          setError(err instanceof Error ? err.message : 'Failed to load topology');
          setGraph(null);
        } finally {
          setLoading(false);
        }
        return;
      }

      const cacheKey = traceCacheKey(startMrid, scope);
      const cachedTrace = readSwCache<GiopTraceResponse>(cacheKey);
      const hadCachedTrace = cachedTrace !== null;

      if (!needsTraceFetch(queryKey)) {
        if (trace) {
          rebuildGraph(trace, stagingData, queryKey);
          return;
        }
        if (cachedTrace) {
          setTrace(cachedTrace);
          setTraceScope('traced');
          setGraph(traceToPortalGraph(cachedTrace, stagingData, queryKey));
          setLoading(false);
        } else {
          setLoading(true);
        }
        setError(null);
        setRevalidating(hadCachedTrace);
        try {
          const traceData = await getTrace(startMrid, 'traced');
          writeSwCache(traceCacheKey(startMrid, 'traced'), traceData);
          setTrace(traceData);
          setTraceScope('traced');
          setGraph(traceToPortalGraph(traceData, stagingData, queryKey));
        } catch (err) {
          if (!hadCachedTrace) {
            setError(err instanceof Error ? err.message : 'Failed to load topology');
            setTrace(null);
            setGraph(null);
          }
        } finally {
          setLoading(false);
          setRevalidating(false);
        }
        return;
      }

      if (cachedTrace) {
        setTrace(cachedTrace);
        setTraceScope(scope);
        setGraph(traceToPortalGraph(cachedTrace, stagingData, queryKey));
        setLoading(false);
      } else {
        setLoading(true);
      }
      setError(null);
      setRevalidating(hadCachedTrace);

      try {
        const traceData = await getTrace(startMrid, scope);
        writeSwCache(cacheKey, traceData);
        setTrace(traceData);
        setTraceScope(scope);
        setGraph(traceToPortalGraph(traceData, stagingData, queryKey));
      } catch (err) {
        if (!hadCachedTrace) {
          setError(err instanceof Error ? err.message : 'Failed to load topology');
          setTrace(null);
          setGraph(null);
        }
      } finally {
        setLoading(false);
        setRevalidating(false);
      }
    },
    [startMrid, graphQuery, trace, rebuildGraph],
  );

  /** Fast path: refresh staging overlay only (map + graph node styling). */
  const refreshStaging = useCallback(async () => {
    try {
      const stagingData = await getStagingAssets().catch(() => [] as GiopStagingAsset[]);
      setStaging(stagingData);
      if (trace) {
        setGraph(traceToPortalGraph(trace, stagingData, graphQuery));
      }
    } catch {
      // Staging overlay is best-effort; full refresh can recover.
    }
  }, [trace, graphQuery]);

  // Hydrate graph from session cache on seed / query change so tab switches are instant.
  useEffect(() => {
    if (!traceActive || !needsTraceFetch(graphQuery)) return;
    const scope = traceScopeForQuery(graphQuery);
    const cached = readSwCache<GiopTraceResponse>(traceCacheKey(startMrid, scope));
    if (!cached) return;
    setTrace(cached);
    setTraceScope(scope);
    setGraph(traceToPortalGraph(cached, staging, graphQuery));
    setLoading(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startMrid, graphQuery, traceActive]);

  // Heavy path: fetch / revalidate when a graph view needs trace data.
  useEffect(() => {
    if (!traceActive) return;
    if (!needsTraceFetch(graphQuery)) return;
    const scope = traceScopeForQuery(graphQuery);
    const fetchKey = `${startMrid}:${scope}`;
    if (loadedTraceKeyRef.current === fetchKey) return;
    loadedTraceKeyRef.current = fetchKey;
    void refresh(graphQuery);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [traceActive, startMrid, graphQuery]);

  // Light path: keep the staging overlay warm for the map + side panel on
  // non-graph tabs without paying for the full trace.
  useEffect(() => {
    if (traceActive) return;
    void refreshStaging();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [traceActive, startMrid]);

  const applyQuery = useCallback(
    (queryKey: GiopGraphQueryKey) => {
      setGraphQuery(queryKey);
      if (queryKey === 'topology_gaps') {
        void refresh(queryKey);
        return;
      }
      // Viewport mode is served by map chunks in split view — never pull full trace.
      if (queryKey === 'viewport_subgraph') {
        if (trace) rebuildGraph(trace, staging, queryKey);
        return;
      }
      if (!needsTraceFetch(queryKey)) {
        if (trace) {
          rebuildGraph(trace, staging, queryKey);
          return;
        }
        void refresh(queryKey);
        return;
      }
      const nextScope = traceScopeForQuery(queryKey);
      if (trace && nextScope === traceScope) {
        rebuildGraph(trace, staging, queryKey);
        return;
      }
      void refresh(queryKey);
    },
    [trace, traceScope, staging, rebuildGraph, refresh],
  );

  return {
    trace,
    staging,
    graph,
    graphQuery,
    loading,
    revalidating,
    error,
    refresh: () => refresh(graphQuery),
    refreshStaging,
    applyQuery,
    setGraphQuery,
  };
}
