import { useCallback, useEffect, useRef, useState } from 'react';
import { getGraphChunk, type GiopGraphChunkResponse } from '../api/giop-api';

export interface MapBbox {
  west: number;
  south: number;
  east: number;
  north: number;
}

export interface UseGiopGraphChunkOptions {
  /** Warm four adjacent viewport caches after each fetch (off by default — heavy on DB). */
  prefetchNeighbors?: boolean;
  /** Debounce rapid map pans before hitting /graph/chunk (ms). */
  debounceMs?: number;
}

function bboxKey(bbox: MapBbox, zoom: number, traceStartMrid?: string): string {
  const precision = zoom >= 14 ? 4 : zoom >= 12 ? 3 : 2;
  const round = (n: number) => n.toFixed(precision);
  const traceKey = traceStartMrid ? `:t:${traceStartMrid}` : '';
  return `${round(bbox.west)}:${round(bbox.south)}:${round(bbox.east)}:${round(bbox.north)}:${zoom}${traceKey}`;
}

/** Mid-zoom overlay only (Martin detail covers z14+); keep payloads small. */
function edgeLimitForZoom(zoom: number): number {
  if (zoom >= 13.5) return 4000;
  if (zoom >= 12) return 3000;
  return 2000;
}

function neighborBboxes(bbox: MapBbox): MapBbox[] {
  const w = bbox.east - bbox.west;
  const h = bbox.north - bbox.south;
  const shifts = [
    { west: -w, east: -w, south: 0, north: 0 },
    { west: w, east: w, south: 0, north: 0 },
    { west: 0, east: 0, south: -h, north: -h },
    { west: 0, east: 0, south: h, north: h },
  ];
  return shifts.map((s) => ({
    west: bbox.west + s.west,
    east: bbox.east + s.east,
    south: bbox.south + s.south,
    north: bbox.north + s.north,
  }));
}

async function fetchChunk(
  bbox: MapBbox,
  zoom: number,
  traceStartMrid?: string,
): Promise<GiopGraphChunkResponse> {
  return getGraphChunk({
    west: bbox.west,
    south: bbox.south,
    east: bbox.east,
    north: bbox.north,
    edgeLimit: edgeLimitForZoom(zoom),
    startMrid: traceStartMrid,
  });
}

export function useGiopGraphChunk(
  traceStartMrid?: string,
  cacheEpoch = 0,
  options: UseGiopGraphChunkOptions = {},
) {
  const prefetchEnabled = options.prefetchNeighbors === true;
  const debounceMs = options.debounceMs ?? 400;
  const [chunk, setChunk] = useState<GiopGraphChunkResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cacheRef = useRef<Map<string, GiopGraphChunkResponse>>(new Map());
  const requestIdRef = useRef(0);
  const inFlightRef = useRef(0);
  const debounceTimerRef = useRef<number | undefined>(undefined);
  const traceStartMridRef = useRef(traceStartMrid);
  traceStartMridRef.current = traceStartMrid;

  useEffect(() => {
    cacheRef.current.clear();
    setChunk(null);
  }, [traceStartMrid, cacheEpoch]);

  useEffect(() => {
    return () => {
      if (debounceTimerRef.current !== undefined) {
        window.clearTimeout(debounceTimerRef.current);
      }
    };
  }, []);

  const prefetchNeighbors = useCallback((bbox: MapBbox, zoom: number) => {
    if (!prefetchEnabled) return;
    const run = () => {
      for (const neighbor of neighborBboxes(bbox)) {
        const key = bboxKey(neighbor, zoom, traceStartMridRef.current);
        if (cacheRef.current.has(key)) continue;
        void fetchChunk(neighbor, zoom, traceStartMridRef.current)
          .then((data) => {
            cacheRef.current.set(key, data);
            if (cacheRef.current.size > 32) {
              const firstKey = cacheRef.current.keys().next().value;
              if (firstKey) cacheRef.current.delete(firstKey);
            }
          })
          .catch(() => undefined);
      }
    };
    if (typeof requestIdleCallback !== 'undefined') {
      requestIdleCallback(run);
    } else {
      setTimeout(run, 100);
    }
  }, [prefetchEnabled]);

  const loadBboxImmediate = useCallback(
    async (bbox: MapBbox, zoom: number) => {
      const key = bboxKey(bbox, zoom, traceStartMridRef.current);
      const cached = cacheRef.current.get(key);
      if (cached) {
        setChunk(cached);
        setError(null);
        setLoading(false);
        prefetchNeighbors(bbox, zoom);
        return;
      }

      const requestId = ++requestIdRef.current;
      inFlightRef.current += 1;
      setLoading(true);
      setError(null);
      try {
        const data = await fetchChunk(bbox, zoom, traceStartMridRef.current);
        if (requestId !== requestIdRef.current) return;

        cacheRef.current.set(key, data);
        if (cacheRef.current.size > 32) {
          const firstKey = cacheRef.current.keys().next().value;
          if (firstKey) cacheRef.current.delete(firstKey);
        }
        setChunk(data);
        prefetchNeighbors(bbox, zoom);
      } catch (err) {
        if (requestId !== requestIdRef.current) return;
        setError(err instanceof Error ? err.message : 'Failed to load map chunk');
        setChunk(null);
      } finally {
        inFlightRef.current = Math.max(0, inFlightRef.current - 1);
        if (requestId === requestIdRef.current && inFlightRef.current === 0) {
          setLoading(false);
        }
      }
    },
    [prefetchNeighbors],
  );

  const loadBbox = useCallback(
    (bbox: MapBbox, zoom: number) => {
      if (debounceMs <= 0) {
        void loadBboxImmediate(bbox, zoom);
        return;
      }
      if (debounceTimerRef.current !== undefined) {
        window.clearTimeout(debounceTimerRef.current);
      }
      setLoading(true);
      debounceTimerRef.current = window.setTimeout(() => {
        debounceTimerRef.current = undefined;
        void loadBboxImmediate(bbox, zoom);
      }, debounceMs);
    },
    [debounceMs, loadBboxImmediate],
  );

  return { chunk, loading, error, loadBbox };
}
