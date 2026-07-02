import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { GiopFieldTechnician, GiopStagingAsset } from '../api/giop-api';
import { GiopTerritoryAssignPanel } from '../context/GiopTerritoryContext';
import { TERRITORY_H3_RES } from '../api/giop-api';

export type MapFieldPanelMode = 'crews' | 'territory';

interface GiopMapFieldPanelProps {
  isLightMode?: boolean;
  mode: MapFieldPanelMode;
  technicians: GiopFieldTechnician[];
  selectedId: string | null;
  submissions: GiopStagingAsset[];
  loading?: boolean;
  error?: string | null;
  onSelect: (technicianId: string) => void;
  onClear: () => void;
  onFocusTechnician?: (technician: GiopFieldTechnician) => void;
  onFocusAsset?: (mrid: string, coordinates?: [number, number]) => void;
}

const CREWS_SCROLL_CAP = 360;
const TERRITORY_VIEWPORT_MARGIN = 96;
const PANEL_TRANSITION_MS = 480;

function crewsScrollCapPx(): number {
  if (typeof window === 'undefined') return CREWS_SCROLL_CAP;
  return Math.min(CREWS_SCROLL_CAP, window.innerHeight * 0.45);
}

/** Max body height for territory before scrolling (full viewport minus map chrome). */
function territoryBodyCapPx(): number {
  if (typeof window === 'undefined') return 720;
  return Math.max(320, window.innerHeight - TERRITORY_VIEWPORT_MARGIN);
}

function contentHeightForMode(
  mode: MapFieldPanelMode,
  crewsEl: HTMLDivElement | null,
  territoryEl: HTMLDivElement | null,
): { height: number; needsScroll: boolean } | null {
  const isTerritory = mode === 'territory';
  const el = isTerritory ? territoryEl : crewsEl;
  if (!el) return null;

  const raw = el.scrollHeight;
  const cap = isTerritory ? territoryBodyCapPx() : crewsScrollCapPx();
  const needsScroll = raw > cap + 1;
  return { height: needsScroll ? cap : raw, needsScroll };
}

function crewsSubtitle(loading: boolean, count: number): string {
  if (loading) return 'Updating…';
  return `${count} active`;
}

export function GiopMapFieldPanel({
  isLightMode = false,
  mode,
  technicians,
  selectedId,
  submissions,
  loading = false,
  error,
  onSelect,
  onClear,
  onFocusTechnician,
  onFocusAsset,
}: GiopMapFieldPanelProps) {
  const shell = isLightMode
    ? 'border-slate-200/90 bg-white text-slate-800 shadow-premium-lg'
    : 'border-premium-border/50 bg-premium-card text-slate-100 shadow-premium-lg';

  const rowDivider = isLightMode ? 'border-slate-100' : 'border-premium-border/40';
  const headerDivider = isLightMode ? 'border-slate-200/80' : 'border-premium-border/45';

  const isTerritory = mode === 'territory';
  const [territoryMounted, setTerritoryMounted] = useState(isTerritory);
  const [territoryChrome, setTerritoryChrome] = useState(isTerritory);
  const [stageMinHeight, setStageMinHeight] = useState<number | undefined>(undefined);
  const [scrollHeight, setScrollHeight] = useState<number | null>(null);
  const [overflowing, setOverflowing] = useState(false);
  const prevModeRef = useRef(mode);
  const isTransitioningRef = useRef(false);

  const crewsInnerRef = useRef<HTMLDivElement>(null);
  const territoryInnerRef = useRef<HTMLDivElement>(null);

  const applyBodyMetrics = useCallback((targetMode: MapFieldPanelMode) => {
    const metrics = contentHeightForMode(
      targetMode,
      crewsInnerRef.current,
      territoryInnerRef.current,
    );
    if (!metrics) return;
    setOverflowing(metrics.needsScroll);
    setScrollHeight(metrics.height);
  }, []);

  useLayoutEffect(() => {
    if (isTerritory) setTerritoryMounted(true);
  }, [isTerritory]);

  useLayoutEffect(() => {
    if (isTerritory) setTerritoryChrome(true);
    else {
      const t = window.setTimeout(() => setTerritoryChrome(false), PANEL_TRANSITION_MS);
      return () => window.clearTimeout(t);
    }
  }, [isTerritory]);

  useLayoutEffect(() => {
    const prev = prevModeRef.current;
    if (prev === mode) return;

    prevModeRef.current = mode;
    isTransitioningRef.current = true;

    const finish = () => {
      isTransitioningRef.current = false;
      setStageMinHeight(undefined);
      applyBodyMetrics(mode);
    };

    if (prev === 'territory' && mode === 'crews') {
      const outgoing = territoryInnerRef.current?.scrollHeight;
      if (outgoing) setStageMinHeight(outgoing);
      requestAnimationFrame(() => {
        requestAnimationFrame(() => applyBodyMetrics('crews'));
      });
      const t = window.setTimeout(finish, PANEL_TRANSITION_MS);
      return () => window.clearTimeout(t);
    }

    if (prev === 'crews' && mode === 'territory') {
      const outgoing = crewsInnerRef.current?.scrollHeight;
      if (outgoing) setStageMinHeight(outgoing);
      requestAnimationFrame(() => {
        requestAnimationFrame(() => applyBodyMetrics('territory'));
      });
      const t = window.setTimeout(finish, PANEL_TRANSITION_MS);
      return () => window.clearTimeout(t);
    }

    isTransitioningRef.current = false;
    applyBodyMetrics(mode);
  }, [mode, applyBodyMetrics]);

  useLayoutEffect(() => {
    if (isTransitioningRef.current) return;
    applyBodyMetrics(mode);
    const id = requestAnimationFrame(() => applyBodyMetrics(mode));
    return () => cancelAnimationFrame(id);
  }, [
    applyBodyMetrics,
    mode,
    territoryMounted,
    technicians.length,
    selectedId,
    submissions.length,
    loading,
    error,
  ]);

  useEffect(() => {
    const onResize = () => {
      if (isTransitioningRef.current) return;
      applyBodyMetrics(mode);
    };
    window.addEventListener('resize', onResize);

    const observers: ResizeObserver[] = [];
    for (const node of [crewsInnerRef.current, territoryInnerRef.current]) {
      if (!node) continue;
      const ro = new ResizeObserver(() => {
        if (isTransitioningRef.current) return;
        applyBodyMetrics(mode);
      });
      ro.observe(node);
      observers.push(ro);
    }

    return () => {
      window.removeEventListener('resize', onResize);
      for (const ro of observers) ro.disconnect();
    };
  }, [
    applyBodyMetrics,
    mode,
    territoryMounted,
    technicians.length,
    selectedId,
    submissions.length,
    loading,
    error,
  ]);

  return (
    <div
      className={`giop-field-panel w-72 overflow-hidden rounded-lg border ${shell} ${
        territoryChrome ? 'giop-field-panel--territory giop-field-panel--tall' : 'giop-field-panel--crews'
      } ${isLightMode ? 'giop-field-panel--light' : 'giop-field-panel--dark'}`}
    >
      <div className={`flex items-center justify-between border-b px-3 py-2 ${headerDivider}`}>
        <div className="giop-field-panel-heading min-w-0 flex-1">
          <div
            className={`giop-field-panel-heading-track ${isTerritory ? 'giop-field-panel-heading-track--territory' : ''}`}
            aria-live="polite"
          >
            <div className="giop-field-panel-heading-slide">
              <p className="text-xs font-semibold uppercase tracking-wide opacity-80">Field crews</p>
              <p className="text-[10px] opacity-60 truncate">
                {crewsSubtitle(loading, technicians.length)}
              </p>
            </div>
            <div className="giop-field-panel-heading-slide">
              <p className="text-xs font-semibold uppercase tracking-wide opacity-80">Territory</p>
              <p className="text-[10px] opacity-60 truncate">
                H3 res {TERRITORY_H3_RES} · click hexes on map
              </p>
            </div>
          </div>
        </div>
        {!isTerritory && selectedId && (
          <button
            type="button"
            className="giop-field-panel-back shrink-0 text-[10px] px-2 py-0.5 rounded bg-slate-700 text-white"
            onClick={onClear}
          >
            Back
          </button>
        )}
      </div>

      {error && !isTerritory && <p className="px-3 py-2 text-xs text-red-400">{error}</p>}

      <div
        className={`giop-field-panel-scroll ${overflowing ? 'giop-field-panel-scroll--overflow' : ''} ${
          isLightMode ? 'giop-field-panel-scroll--light' : 'giop-field-panel-scroll--dark'
        }`}
        style={{
          maxHeight: scrollHeight ?? (isTerritory ? territoryBodyCapPx() : crewsScrollCapPx()),
        }}
      >
        <div
          className="giop-field-panel-stage"
          style={stageMinHeight != null ? { minHeight: stageMinHeight } : undefined}
        >
          <div
            className={`giop-field-panel-layer giop-field-panel-layer--crews ${
              isTerritory ? 'giop-field-panel-layer--inactive' : 'giop-field-panel-layer--active'
            }`}
            aria-hidden={isTerritory}
          >
            <div
              ref={crewsInnerRef}
              className={`giop-field-panel-layer-inner ${
                isTerritory ? 'giop-field-panel-layer-inner--out' : 'giop-field-panel-layer-inner--in'
              }`}
            >
              {!selectedId &&
                technicians.map((tech, index) => (
                  <button
                    key={tech.technician_id}
                    type="button"
                    className={`giop-field-panel-row w-full text-left px-3 py-2 border-b last:border-b-0 hover:bg-cyan-500/10 transition-colors duration-200 ${rowDivider} ${
                      isLightMode ? 'hover:bg-cyan-50' : 'hover:bg-premium-hover/60'
                    } ${!isTerritory && !stageMinHeight ? 'giop-field-panel-row--enter' : ''}`}
                    style={!isTerritory && !stageMinHeight ? { animationDelay: `${index * 24}ms` } : undefined}
                    onClick={() => {
                      onSelect(tech.technician_id);
                      onFocusTechnician?.(tech);
                    }}
                  >
                    <div className="flex items-center gap-2">
                      <span
                        className="inline-block h-2.5 w-2.5 rounded-full bg-cyan-400 shrink-0"
                        aria-hidden
                      />
                      <span className="text-sm font-medium truncate">
                        {tech.display_name || tech.technician_id}
                      </span>
                    </div>
                    <p className="text-[10px] opacity-60 mt-0.5 pl-4">
                      {tech.pending_submissions} pending · {tech.total_submissions} total
                      {tech.reported_at
                        ? ` · ${new Date(tech.reported_at).toLocaleTimeString()}`
                        : ''}
                    </p>
                  </button>
                ))}

              {!selectedId && technicians.length === 0 && !loading && (
                <p className="px-3 py-4 text-xs opacity-60">No active field technicians reported.</p>
              )}

              {selectedId && (
                <div className="px-3 py-2">
                  <p className="text-xs font-medium mb-2">Submissions by {selectedId}</p>
                  {submissions.length === 0 && (
                    <p className="text-xs opacity-60">No staging assets linked to this technician.</p>
                  )}
                  <ul className="space-y-1">
                    {submissions.map((asset) => {
                      const coords = asset.geom?.coordinates;
                      return (
                        <li key={asset.mrid}>
                          <button
                            type="button"
                            className="w-full text-left text-xs rounded px-2 py-1 hover:bg-premium-hover/40 transition-colors duration-200"
                            onClick={() => onFocusAsset?.(asset.mrid, coords ?? undefined)}
                          >
                            <span className="font-mono">{asset.mrid.slice(0, 8)}…</span>
                            <span className="opacity-70"> · {asset.name || '—'}</span>
                            <span className="block opacity-50">{asset.validation}</span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              )}
            </div>
          </div>

          {territoryMounted && (
            <div
              className={`giop-field-panel-layer giop-field-panel-layer--territory ${
                isTerritory ? 'giop-field-panel-layer--active' : 'giop-field-panel-layer--inactive'
              }`}
              aria-hidden={!isTerritory}
            >
              <div
                ref={territoryInnerRef}
                className={`giop-field-panel-layer-inner ${
                  isTerritory ? 'giop-field-panel-layer-inner--in' : 'giop-field-panel-layer-inner--out'
                }`}
              >
                <GiopTerritoryAssignPanel />
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
