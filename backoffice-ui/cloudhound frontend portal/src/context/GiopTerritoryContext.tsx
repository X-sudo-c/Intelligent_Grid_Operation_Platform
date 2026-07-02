import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { GeoJSONSource, Map as MapLibreMap, MapMouseEvent } from 'maplibre-gl';
import {
  TERRITORY_H3_RES,
  batchAssignH3Cells,
  deleteH3Assignments,
  getH3AssignmentsGeoJson,
  getH3Status,
  formatH3ApiError,
  type GiopAssignmentStatus,
  type GiopFieldTechnician,
  type GiopH3AssignmentFeature,
} from '../api/giop-api';
import { bboxToHexGrid, pointToCell } from '../lib/giopH3Client';

const GRID_SOURCE = 'h3-territory-grid';
const GRID_FILL = 'h3-territory-grid-fill';
const GRID_LAYER = 'h3-territory-grid-outline';
const ASSIGN_SOURCE = 'h3-territory-assignments';
const ASSIGN_FILL = 'h3-territory-assign-fill';
const ASSIGN_OUTLINE = 'h3-territory-assign-outline';
const SELECT_SOURCE = 'h3-territory-selection';
const SELECT_FILL = 'h3-territory-select-fill';
const SELECT_OUTLINE = 'h3-territory-select-outline';

export const MIN_TERRITORY_GRID_ZOOM = 12;

export const TERRITORY_STATUS_OPTIONS: { value: GiopAssignmentStatus; label: string }[] = [
  { value: 'ASSIGNED', label: 'Assigned' },
  { value: 'IN_PROGRESS', label: 'In progress' },
  { value: 'DONE', label: 'Done' },
  { value: 'BLOCKED', label: 'Blocked' },
];

const ASSIGN_FILL_PAINT = {
  'fill-color': [
    'match',
    ['get', 'status'],
    'ASSIGNED',
    '#f59e0b',
    'IN_PROGRESS',
    '#2563eb',
    'DONE',
    '#16a34a',
    'BLOCKED',
    '#dc2626',
    '#94a3b8',
  ],
  'fill-opacity': 0.28,
} as const;

function whenMapReady(map: MapLibreMap, fn: () => void) {
  if (map.isStyleLoaded()) {
    fn();
    return;
  }
  map.once('load', fn);
  map.once('styledata', () => {
    if (map.isStyleLoaded()) fn();
  });
}

function emptyFc(): GeoJSON.FeatureCollection {
  return { type: 'FeatureCollection', features: [] };
}

function selectionFc(cells: Map<string, GeoJSON.Polygon>): GeoJSON.FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: [...cells.entries()].map(([h3, geometry]) => ({
      type: 'Feature',
      geometry,
      properties: { h3 },
    })),
  };
}

export interface GiopTerritoryContextValue {
  active: boolean;
  setActive: (active: boolean) => void;
  toggleActive: () => void;
  isLightMode: boolean;
  fieldTechnicians: GiopFieldTechnician[];
  zoom: number;
  gridCellCount: number;
  gridTruncated: boolean;
  gridError: string | null;
  error: string | null;
  loading: boolean;
  saving: boolean;
  selectedCount: number;
  assignmentCount: number;
  filterTech: string;
  setFilterTech: (value: string) => void;
  assignTo: string;
  setAssignTo: (value: string) => void;
  assignStatus: GiopAssignmentStatus;
  setAssignStatus: (value: GiopAssignmentStatus) => void;
  assignNote: string;
  setAssignNote: (value: string) => void;
  clearSelection: () => void;
  handleAssign: () => Promise<void>;
  handleUnassignSelected: () => Promise<void>;
  handleAssignFeature: (feature: GiopH3AssignmentFeature) => void;
  zoomToGrid: () => void;
}

const GiopTerritoryContext = createContext<GiopTerritoryContextValue | null>(null);

export function useGiopTerritory(): GiopTerritoryContextValue {
  const ctx = useContext(GiopTerritoryContext);
  if (!ctx) {
    throw new Error('useGiopTerritory must be used within GiopTerritoryProvider');
  }
  return ctx;
}

interface GiopTerritoryProviderProps {
  mapRef: React.RefObject<MapLibreMap | null>;
  mapReady: boolean;
  isLightMode?: boolean;
  fieldTechnicians?: GiopFieldTechnician[];
  active: boolean;
  onActiveChange?: (active: boolean) => void;
  children: ReactNode;
}

export function GiopTerritoryProvider({
  mapRef,
  mapReady,
  isLightMode = false,
  fieldTechnicians = [],
  active,
  onActiveChange,
  children,
}: GiopTerritoryProviderProps) {
  const activeRef = useRef(active);
  activeRef.current = active;

  const [selectedCells, setSelectedCells] = useState<Map<string, GeoJSON.Polygon>>(() => new Map());
  const selectedRef = useRef(selectedCells);
  selectedRef.current = selectedCells;

  const [assignTo, setAssignTo] = useState('');
  const [assignStatus, setAssignStatus] = useState<GiopAssignmentStatus>('ASSIGNED');
  const [assignNote, setAssignNote] = useState('');
  const [filterTech, setFilterTech] = useState('');
  const [assignmentCount, setAssignmentCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [gridTruncated, setGridTruncated] = useState(false);
  const [gridError, setGridError] = useState<string | null>(null);
  const [gridCellCount, setGridCellCount] = useState(0);
  const [zoom, setZoom] = useState(0);

  const setActive = useCallback(
    (next: boolean) => {
      onActiveChange?.(next);
    },
    [onActiveChange],
  );

  const toggleActive = useCallback(() => {
    setActive(!active);
  }, [active, setActive]);

  const refreshAssignments = useCallback(
    async (map: MapLibreMap) => {
      try {
        const fc = await getH3AssignmentsGeoJson({
          assignedTo: filterTech || undefined,
          status: 'ASSIGNED,IN_PROGRESS,DONE,BLOCKED',
        });
        setAssignmentCount(fc.cell_count);
        const data = fc as unknown as GeoJSON.FeatureCollection;
        whenMapReady(map, () => {
          const src = map.getSource(ASSIGN_SOURCE) as GeoJSONSource | undefined;
          if (src) src.setData(data);
        });
      } catch (err) {
        setError(formatH3ApiError(err, 'Assignments'));
      }
    },
    [filterTech],
  );

  const refreshGrid = useCallback((map: MapLibreMap) => {
    if (map.getZoom() < MIN_TERRITORY_GRID_ZOOM) {
      const src = map.getSource(GRID_SOURCE) as GeoJSONSource | undefined;
      src?.setData(emptyFc());
      setGridTruncated(false);
      return;
    }
    const bounds = map.getBounds();
    try {
      const fc = bboxToHexGrid(
        {
          west: bounds.getWest(),
          south: bounds.getSouth(),
          east: bounds.getEast(),
          north: bounds.getNorth(),
        },
        TERRITORY_H3_RES,
      );
      setGridTruncated(fc.truncated);
      setGridError(null);
      setGridCellCount(fc.cell_count);
      const src = map.getSource(GRID_SOURCE) as GeoJSONSource | undefined;
      if (src) src.setData(fc as unknown as GeoJSON.FeatureCollection);
    } catch (err) {
      setGridCellCount(0);
      setGridError(err instanceof Error ? err.message : 'Hex grid failed');
    }
  }, []);

  const ensureLayers = useCallback(
    (map: MapLibreMap) => {
      const outlineColor = isLightMode ? '#475569' : '#cbd5e1';
      const addSourceLayer = (
        sourceId: string,
        fillId: string | null,
        outlineId: string,
        fillPaint?: Record<string, unknown>,
      ) => {
        if (!map.getSource(sourceId)) {
          map.addSource(sourceId, { type: 'geojson', data: emptyFc() });
        }
        if (fillId && fillPaint && !map.getLayer(fillId)) {
          map.addLayer({ id: fillId, type: 'fill', source: sourceId, paint: fillPaint });
        }
        if (!map.getLayer(outlineId)) {
          map.addLayer({
            id: outlineId,
            type: 'line',
            source: sourceId,
            paint: {
              'line-color': outlineColor,
              'line-width': outlineId === GRID_LAYER ? 1.2 : 1.5,
              'line-opacity': 0.85,
            },
          });
        }
      };
      addSourceLayer(GRID_SOURCE, GRID_FILL, GRID_LAYER, {
        'fill-color': isLightMode ? '#64748b' : '#94a3b8',
        'fill-opacity': 0.12,
      });
      addSourceLayer(ASSIGN_SOURCE, ASSIGN_FILL, ASSIGN_OUTLINE, ASSIGN_FILL_PAINT);
      addSourceLayer(SELECT_SOURCE, SELECT_FILL, SELECT_OUTLINE, {
        'fill-color': '#fbbf24',
        'fill-opacity': 0.42,
      });
      if (map.getLayer(SELECT_OUTLINE)) {
        map.setPaintProperty(SELECT_OUTLINE, 'line-color', '#d97706');
        map.setPaintProperty(SELECT_OUTLINE, 'line-width', 2.5);
      }
    },
    [isLightMode],
  );

  const removeLayers = useCallback((map: MapLibreMap) => {
    for (const layerId of [
      SELECT_OUTLINE,
      SELECT_FILL,
      ASSIGN_OUTLINE,
      ASSIGN_FILL,
      GRID_LAYER,
      GRID_FILL,
    ]) {
      if (map.getLayer(layerId)) map.removeLayer(layerId);
    }
    for (const sourceId of [SELECT_SOURCE, ASSIGN_SOURCE, GRID_SOURCE]) {
      if (map.getSource(sourceId)) map.removeSource(sourceId);
    }
  }, []);

  const syncSelectionLayer = useCallback((map: MapLibreMap, cells: Map<string, GeoJSON.Polygon>) => {
    const src = map.getSource(SELECT_SOURCE) as GeoJSONSource | undefined;
    if (src) src.setData(selectionFc(cells));
  }, []);

  const clearSelection = useCallback(() => {
    const empty = new Map<string, GeoJSON.Polygon>();
    setSelectedCells(empty);
    selectedRef.current = empty;
    const map = mapRef.current;
    if (map) syncSelectionLayer(map, empty);
  }, [mapRef, syncSelectionLayer]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return undefined;

    if (!active) {
      whenMapReady(map, () => removeLayers(map));
      return undefined;
    }

    let cancelled = false;
    let debounceTimer: number | undefined;

    setZoom(map.getZoom());
    if (map.getZoom() < MIN_TERRITORY_GRID_ZOOM) {
      map.easeTo({ zoom: MIN_TERRITORY_GRID_ZOOM + 1, duration: 600 });
    }

    const boot = async () => {
      whenMapReady(map, () => {
        ensureLayers(map);
        syncSelectionLayer(map, selectedRef.current);
        refreshGrid(map);
      });
      setLoading(true);
      setError(null);
      setGridError(null);
      try {
        await getH3Status();
      } catch (err) {
        const msg = formatH3ApiError(err, 'H3 API');
        setError(msg);
      }
      try {
        await refreshAssignments(map);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    void boot();

    const onZoom = () => setZoom(map.getZoom());
    const scheduleGrid = () => {
      setZoom(map.getZoom());
      window.clearTimeout(debounceTimer);
      debounceTimer = window.setTimeout(() => refreshGrid(map), 60);
    };
    map.on('zoom', onZoom);
    map.on('moveend', scheduleGrid);
    map.on('zoomend', scheduleGrid);

    const toggleCellSelection = (h3: string, geometry: GeoJSON.Polygon) => {
      const next = new Map(selectedRef.current);
      if (next.has(h3)) next.delete(h3);
      else next.set(h3, geometry);
      selectedRef.current = next;
      setSelectedCells(next);
      syncSelectionLayer(map, next);
    };

    const territoryHitLayers = () =>
      [SELECT_FILL, SELECT_OUTLINE, ASSIGN_FILL, ASSIGN_OUTLINE, GRID_FILL, GRID_LAYER].filter(
        (id) => map.getLayer(id),
      );

    const onTerritoryMapClick = async (e: MapMouseEvent) => {
      if (!activeRef.current) return;

      let h3: string | undefined;
      let geometry: GeoJSON.Polygon | undefined;

      const layers = territoryHitLayers();
      if (layers.length > 0) {
        const hits = map.queryRenderedFeatures(e.point, { layers });
        for (const feature of hits) {
          const candidate = feature.properties?.h3 as string | undefined;
          if (!candidate) continue;
          if (feature.geometry?.type === 'Polygon') {
            h3 = candidate;
            geometry = feature.geometry as GeoJSON.Polygon;
            break;
          }
        }
      }

      if (!h3) {
        if (map.getZoom() < MIN_TERRITORY_GRID_ZOOM) {
          setError(`Zoom to ${MIN_TERRITORY_GRID_ZOOM}+ to select hexes, or use Zoom in.`);
          return;
        }
        try {
          const cell = pointToCell(e.lngLat.lat, e.lngLat.lng, TERRITORY_H3_RES);
          h3 = cell.h3;
          geometry = cell.geometry;
        } catch (err) {
          setError(err instanceof Error ? err.message : 'Cell lookup failed');
          return;
        }
      }

      if (h3 && geometry) toggleCellSelection(h3, geometry);
    };

    const onTerritoryDblClick = (e: MapMouseEvent) => {
      e.preventDefault();
    };

    map.doubleClickZoom.disable();
    map.on('click', onTerritoryMapClick);
    map.on('dblclick', onTerritoryDblClick);
    map.getCanvas().style.cursor = 'crosshair';

    return () => {
      cancelled = true;
      window.clearTimeout(debounceTimer);
      // GiopMapView may have already called map.remove() during unmount —
      // touching a destroyed map instance throws.
      try {
        map.off('zoom', onZoom);
        map.off('moveend', scheduleGrid);
        map.off('zoomend', scheduleGrid);
        map.off('click', onTerritoryMapClick);
        map.off('dblclick', onTerritoryDblClick);
        map.doubleClickZoom.enable();
        map.getCanvas().style.cursor = '';
        whenMapReady(map, () => removeLayers(map));
      } catch {
        // Map already destroyed — nothing to clean up.
      }
    };
  }, [
    active,
    mapReady,
    mapRef,
    ensureLayers,
    removeLayers,
    refreshAssignments,
    refreshGrid,
    syncSelectionLayer,
  ]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady || !active) return;
    void refreshAssignments(map);
  }, [filterTech, active, mapReady, mapRef, refreshAssignments]);

  useEffect(() => {
    if (fieldTechnicians.length > 0 && !assignTo) {
      setAssignTo(fieldTechnicians[0].technician_id);
    }
  }, [fieldTechnicians, assignTo]);

  const handleAssign = useCallback(async () => {
    if (selectedCells.size === 0 || !assignTo.trim()) return;
    setSaving(true);
    setError(null);
    try {
      await batchAssignH3Cells({
        h3_indexes: [...selectedCells.keys()],
        assigned_to: assignTo.trim(),
        status: assignStatus,
        note: assignNote.trim() || undefined,
      });
      clearSelection();
      const map = mapRef.current;
      if (map) await refreshAssignments(map);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Assign failed');
    } finally {
      setSaving(false);
    }
  }, [
    selectedCells,
    assignTo,
    assignStatus,
    assignNote,
    clearSelection,
    mapRef,
    refreshAssignments,
  ]);

  const handleUnassignSelected = useCallback(async () => {
    if (selectedCells.size === 0) return;
    setSaving(true);
    setError(null);
    try {
      await deleteH3Assignments([...selectedCells.keys()]);
      clearSelection();
      const map = mapRef.current;
      if (map) await refreshAssignments(map);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unassign failed');
    } finally {
      setSaving(false);
    }
  }, [selectedCells, clearSelection, mapRef, refreshAssignments]);

  const handleAssignFeature = useCallback(
    (feature: GiopH3AssignmentFeature) => {
      const h3 = feature.properties.h3;
      const next = new Map([[h3, feature.geometry]]);
      setSelectedCells(next);
      selectedRef.current = next;
      setAssignTo(feature.properties.assigned_to ?? assignTo);
      setAssignStatus((feature.properties.status as GiopAssignmentStatus) || 'ASSIGNED');
      setAssignNote(feature.properties.note ?? '');
      const map = mapRef.current;
      if (map) syncSelectionLayer(map, next);
    },
    [assignTo, mapRef, syncSelectionLayer],
  );

  const zoomToGrid = useCallback(() => {
    mapRef.current?.easeTo({ zoom: MIN_TERRITORY_GRID_ZOOM + 1, duration: 500 });
  }, [mapRef]);

  const value = useMemo<GiopTerritoryContextValue>(
    () => ({
      active,
      setActive,
      toggleActive,
      isLightMode,
      fieldTechnicians,
      zoom,
      gridCellCount,
      gridTruncated,
      gridError,
      error,
      loading,
      saving,
      selectedCount: selectedCells.size,
      assignmentCount,
      filterTech,
      setFilterTech,
      assignTo,
      setAssignTo,
      assignStatus,
      setAssignStatus,
      assignNote,
      setAssignNote,
      clearSelection,
      handleAssign,
      handleUnassignSelected,
      handleAssignFeature,
      zoomToGrid,
    }),
    [
      active,
      setActive,
      toggleActive,
      isLightMode,
      fieldTechnicians,
      zoom,
      gridCellCount,
      gridTruncated,
      gridError,
      error,
      loading,
      saving,
      selectedCells.size,
      assignmentCount,
      filterTech,
      assignTo,
      assignStatus,
      assignNote,
      clearSelection,
      handleAssign,
      handleUnassignSelected,
      handleAssignFeature,
      zoomToGrid,
    ],
  );

  return <GiopTerritoryContext.Provider value={value}>{children}</GiopTerritoryContext.Provider>;
}

/**
 * Territory mode toggle. When `inline` is set, it renders as a full-width
 * control (for embedding in the map control panel); otherwise it floats
 * as a standalone map button (legacy placement).
 */
export function GiopTerritoryMapToggle({ inline = false }: { inline?: boolean } = {}) {
  const { active, toggleActive, isLightMode } = useGiopTerritory();

  if (inline) {
    return (
      <button
        type="button"
        onClick={toggleActive}
        role="switch"
        aria-checked={active}
        className={`flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors ${
          isLightMode ? 'hover:bg-slate-100/80' : 'hover:bg-premium-hover/80'
        }`}
        title="Assign field-work territories (H3 hexagons)"
      >
        <span
          className="h-2.5 w-2.5 shrink-0 rounded-full ring-2 ring-inset ring-white/15"
          style={{ backgroundColor: '#f59e0b', opacity: active ? 1 : 0.4 }}
          aria-hidden
        />
        <span
          className={`flex-1 truncate text-xs font-medium ${
            active
              ? isLightMode
                ? 'text-amber-700'
                : 'text-amber-400'
              : isLightMode
                ? 'text-slate-500'
                : 'text-premium-muted'
          }`}
        >
          Territory mode
        </span>
        <span
          className={`relative h-4 w-7 shrink-0 rounded-full transition-colors duration-200 ${
            active
              ? 'bg-amber-500'
              : isLightMode
                ? 'bg-slate-300'
                : 'bg-premium-hover-strong'
          }`}
          aria-hidden
        >
          <span
            className={`absolute top-0.5 h-3 w-3 rounded-full bg-white shadow-sm transition-transform duration-200 ${
              active ? 'translate-x-3.5' : 'translate-x-0.5'
            }`}
          />
        </span>
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={toggleActive}
      className={`pointer-events-auto absolute left-3 top-14 z-10 rounded-md border px-3 py-2 text-xs font-medium shadow-lg transition-all duration-450 ease-[cubic-bezier(0.22,1,0.36,1)] ${
        active
          ? 'border-amber-500 bg-amber-600 text-white shadow-[0_8px_24px_rgba(245,158,11,0.28)] scale-[1.02]'
          : isLightMode
            ? 'border-slate-200 bg-white/90 text-slate-700 hover:bg-white hover:shadow-md'
            : 'border-premium-border/70 bg-premium-card text-slate-200 hover:bg-premium-hover hover:shadow-md'
      }`}
      title="Assign field-work territories (H3 hexagons)"
    >
      {active ? 'Territory: on' : 'Territory'}
    </button>
  );
}

function TerritoryAssignmentList({
  isLightMode,
  filterTech,
  onPick,
}: {
  isLightMode: boolean;
  filterTech: string;
  onPick: (f: GiopH3AssignmentFeature) => void;
}) {
  const [items, setItems] = useState<GiopH3AssignmentFeature[]>([]);

  useEffect(() => {
    let cancelled = false;
    void getH3AssignmentsGeoJson({ assignedTo: filterTech || undefined }).then((fc) => {
      if (!cancelled) setItems(fc.features.slice(0, 12));
    });
    return () => {
      cancelled = true;
    };
  }, [filterTech]);

  if (items.length === 0) return null;

  return (
    <div className="mt-2 border-t pt-2">
      <div className="mb-1 font-medium opacity-80">Recent in view</div>
      <ul className="space-y-1">
        {items.map((f) => (
          <li key={f.properties.h3}>
            <button
              type="button"
              className={`w-full rounded px-1 py-0.5 text-left hover:underline ${
                isLightMode ? 'hover:bg-slate-100' : 'hover:bg-premium-hover'
              }`}
              onClick={() => onPick(f)}
            >
              <span className="font-mono text-[10px] opacity-70">{f.properties.h3.slice(-8)}</span>
              {' · '}
              {f.properties.assigned_to ?? '—'}
              {' · '}
              {f.properties.status}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function GiopTerritoryAssignPanel() {
  const territory = useGiopTerritory();
  const {
    isLightMode,
    zoom,
    gridCellCount,
    gridTruncated,
    gridError,
    error,
    loading,
    saving,
    selectedCount,
    assignmentCount,
    filterTech,
    setFilterTech,
    assignTo,
    setAssignTo,
    assignStatus,
    setAssignStatus,
    assignNote,
    setAssignNote,
    fieldTechnicians,
    clearSelection,
    handleAssign,
    handleUnassignSelected,
    handleAssignFeature,
    zoomToGrid,
  } = territory;

  const inputClass = isLightMode
    ? 'border-slate-300 bg-white text-slate-800'
    : 'border-slate-600 bg-slate-800 text-slate-100';

  return (
    <div className="px-3 py-2 text-xs">
      <div
        className={`mb-2 flex items-center justify-between gap-2 rounded px-2 py-1 ${
          zoom >= MIN_TERRITORY_GRID_ZOOM
            ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300'
            : 'bg-amber-500/15 text-amber-700 dark:text-amber-300'
        }`}
      >
        <span>Zoom {zoom.toFixed(1)}</span>
        <span>
          {zoom >= MIN_TERRITORY_GRID_ZOOM
            ? `grid visible · ${gridCellCount} hexes`
            : `need ${MIN_TERRITORY_GRID_ZOOM}+`}
        </span>
        {zoom < MIN_TERRITORY_GRID_ZOOM && (
          <button
            type="button"
            className="rounded bg-amber-600 px-2 py-0.5 font-medium text-white"
            onClick={zoomToGrid}
          >
            Zoom in
          </button>
        )}
      </div>

      <p className="mb-3 leading-relaxed opacity-75">
        Click hexes to select. Assign selected cells to a field technician — they see the same area
        on mobile.
      </p>

      {gridError && (
        <p className="mb-2 rounded bg-red-500/15 px-2 py-1 text-red-700 dark:text-red-300">
          {gridError}
        </p>
      )}
      {gridTruncated && (
        <p className="mb-2 rounded bg-amber-500/15 px-2 py-1 text-amber-700 dark:text-amber-300">
          Grid truncated — zoom in for finer selection.
        </p>
      )}
      {error && (
        <p className="mb-2 rounded bg-red-500/15 px-2 py-1 text-red-700 dark:text-red-300">
          {error}
        </p>
      )}

      <label className="mb-1 block font-medium opacity-80">Filter map by technician</label>
      <select
        className={`mb-3 w-full rounded border px-2 py-1.5 text-xs ${inputClass}`}
        value={filterTech}
        onChange={(e) => setFilterTech(e.target.value)}
      >
        <option value="">All assignments ({assignmentCount})</option>
        {fieldTechnicians.map((t) => (
          <option key={t.technician_id} value={t.technician_id}>
            {t.display_name || t.technician_id}
          </option>
        ))}
      </select>

      <label className="mb-1 block font-medium opacity-80">Assign to</label>
      <input
        type="text"
        list="giop-technician-ids"
        placeholder="technician ID (e.g. tech.demo)"
        className={`mb-3 w-full rounded border px-2 py-1.5 text-xs ${inputClass}`}
        value={assignTo}
        onChange={(e) => setAssignTo(e.target.value)}
      />
      <datalist id="giop-technician-ids">
        {fieldTechnicians.map((t) => (
          <option key={t.technician_id} value={t.technician_id}>
            {t.display_name || t.technician_id}
          </option>
        ))}
      </datalist>

      <label className="mb-1 block font-medium opacity-80">Status</label>
      <select
        className={`mb-3 w-full rounded border px-2 py-1.5 text-xs ${inputClass}`}
        value={assignStatus}
        onChange={(e) => setAssignStatus(e.target.value as GiopAssignmentStatus)}
      >
        {TERRITORY_STATUS_OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>

      <label className="mb-1 block font-medium opacity-80">Note (optional)</label>
      <input
        type="text"
        placeholder="Block name, feeder, etc."
        className={`mb-3 w-full rounded border px-2 py-1.5 text-xs ${inputClass}`}
        value={assignNote}
        onChange={(e) => setAssignNote(e.target.value)}
      />

      <div className="mb-3 rounded border border-dashed px-2 py-1.5 opacity-80">
        Selected: <strong>{selectedCount}</strong> hex{selectedCount === 1 ? '' : 'es'}
        {loading && ' · loading…'}
      </div>

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={saving || selectedCount === 0 || !assignTo.trim()}
          onClick={() => void handleAssign()}
          className="rounded bg-amber-600 px-3 py-1.5 font-medium text-white disabled:opacity-40"
        >
          {saving ? 'Saving…' : 'Assign'}
        </button>
        <button
          type="button"
          disabled={saving || selectedCount === 0}
          onClick={() => void handleUnassignSelected()}
          className={`rounded border px-3 py-1.5 font-medium ${
            isLightMode ? 'border-slate-300 hover:bg-slate-50' : 'border-slate-600 hover:bg-premium-hover'
          }`}
        >
          Unassign
        </button>
        <button
          type="button"
          disabled={selectedCount === 0}
          onClick={clearSelection}
          className={`rounded border px-3 py-1.5 ${
            isLightMode ? 'border-slate-300 hover:bg-slate-50' : 'border-slate-600 hover:bg-premium-hover'
          }`}
        >
          Clear
        </button>
      </div>

      <div className="mt-3 border-t pt-2 opacity-70">
        <div className="mb-1 font-medium">Legend</div>
        <ul className="space-y-0.5">
          <li className="flex items-center gap-2">
            <span className="inline-block h-2 w-4 rounded-sm bg-amber-500/50" />
            Assigned
          </li>
          <li className="flex items-center gap-2">
            <span className="inline-block h-2 w-4 rounded-sm bg-blue-600/50" />
            In progress
          </li>
          <li className="flex items-center gap-2">
            <span className="inline-block h-2 w-4 rounded-sm bg-yellow-400/60" />
            Selection (pending)
          </li>
        </ul>
      </div>

      <TerritoryAssignmentList
        isLightMode={isLightMode}
        filterTech={filterTech}
        onPick={handleAssignFeature}
      />
    </div>
  );
}
