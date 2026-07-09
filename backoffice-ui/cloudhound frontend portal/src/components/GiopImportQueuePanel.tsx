import { useCallback, useEffect, useRef, useState } from 'react';
import { Info } from 'lucide-react';
import {
  getGisEndpointDiagnostics,
  getGisUnpromotedSegmentGeojson,
  getGisUnpromotedSummary,
  listGisUnpromotedSegments,
  snapGisConductors,
  type GiopConductorSnapResult,
  type GiopEndpointDiagnostics,
  type GiopUnpromotedSegment,
  type GiopUnpromotedSegmentReason,
  type GiopUnpromotedSegmentSummary,
} from '../api/giop-api';
import { useGiopMapOverlay } from '../context/GiopMapOverlayContext';
import type { ImportSegmentHighlightState } from '../lib/giopImportSegmentHighlight';
import {
  REASON_FIX_HINT,
  REASON_HELP,
  REASON_LABELS,
  reasonPct,
  snapEligibleEstimateSec,
  type GisSnapPhaseId,
} from '../lib/gisImportShared';
import { GisImportEndpointDiagnostics } from './GisImportEndpointDiagnostics';
import { GisImportPipelineMetrics } from './GisImportPipelineMetrics';
import { GisImportSnapModal } from './GisImportSnapModal';
import { GisEndpointFixProposalsPanel } from './GisEndpointFixProposalsPanel';
import type { GiopEndpointFixDataTier } from '../api/giop-api';

interface GiopImportQueuePanelProps {
  isLightMode: boolean;
  enabled: boolean;
  dataTier?: GiopEndpointFixDataTier;
  showImportQueue?: boolean;
}

const WORKFLOW_STEPS = [
  'Review customer/meter buckets — expected on LV service lines, not pole errors',
  'Fix lookup / GPKG IDs for unresolved source & target buckets',
  'Generate endpoint fix proposals — geometry → from/to review table',
  'Approve rows and apply — writes GIS conductor from/to IDs',
  'Run endpoint snap — geometry only, both pole IDs must resolve',
  'Run promote_topology.sh — moves eligible MV/LV segments into master',
  'Master topology scan — measure orphans & dangling after promote',
] as const;

const PAGE_SIZE = 25;

export function GiopImportQueuePanel({
  isLightMode,
  enabled,
  dataTier = 'gis',
  showImportQueue = true,
}: GiopImportQueuePanelProps) {
  const { queueMapViewportCommand, setImportSegmentHighlight, networkGeometryMode } = useGiopMapOverlay();
  const [expanded, setExpanded] = useState(false);
  const [summary, setSummary] = useState<GiopUnpromotedSegmentSummary | null>(null);
  const [endpointDiagnostics, setEndpointDiagnostics] = useState<GiopEndpointDiagnostics | null>(null);
  const [segments, setSegments] = useState<GiopUnpromotedSegment[]>([]);
  const [total, setTotal] = useState(0);
  const [reasonFilter, setReasonFilter] = useState<GiopUnpromotedSegmentReason | ''>('');
  const [pageOffset, setPageOffset] = useState(0);
  const [loading, setLoading] = useState(false);
  const [diagnosticsLoading, setDiagnosticsLoading] = useState(false);
  const [snapBusy, setSnapBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [mapBusyId, setMapBusyId] = useState<number | null>(null);
  const [activeSegmentId, setActiveSegmentId] = useState<number | null>(null);
  const showSegmentSeqRef = useRef(0);

  const [snapModalOpen, setSnapModalOpen] = useState(false);
  const [snapStartedMs, setSnapStartedMs] = useState(0);
  const [snapPhase, setSnapPhase] = useState<GisSnapPhaseId>('snap');
  const [snapFailed, setSnapFailed] = useState(false);
  const [snapError, setSnapError] = useState<string | null>(null);
  const [snapResult, setSnapResult] = useState<GiopConductorSnapResult | null>(null);
  const [unpromotedBeforeSnap, setUnpromotedBeforeSnap] = useState<number | null>(null);
  const [unpromotedAfterSnap, setUnpromotedAfterSnap] = useState<number | null>(null);
  const [lastSnapResult, setLastSnapResult] = useState<GiopConductorSnapResult | null>(null);

  const card = isLightMode ? 'border-slate-200 bg-white' : 'border-premium-border/45 bg-premium-card';
  const muted = isLightMode ? 'text-slate-500' : 'text-premium-muted';
  const shell = isLightMode ? 'bg-slate-50 border-slate-200' : 'bg-premium-surface/40 border-premium-border/50';

  const loadDiagnostics = useCallback(async () => {
    if (!enabled || !expanded || !showImportQueue) return;
    setDiagnosticsLoading(true);
    try {
      const diagnostics = await getGisEndpointDiagnostics();
      setEndpointDiagnostics(diagnostics);
    } catch {
      // Keep last snapshot; diagnostics are supplemental to the steward queue.
    } finally {
      setDiagnosticsLoading(false);
    }
  }, [enabled, expanded, showImportQueue]);

  const load = useCallback(async (opts?: { refreshDiagnostics?: boolean }) => {
    if (!enabled || !expanded || !showImportQueue) return;
    setLoading(true);
    if (opts?.refreshDiagnostics) {
      void loadDiagnostics();
    }
    try {
      const [sum, page] = await Promise.all([
        getGisUnpromotedSummary(),
        listGisUnpromotedSegments({
          reason: reasonFilter || undefined,
          limit: PAGE_SIZE,
          offset: pageOffset,
        }),
      ]);
      setSummary(sum);
      setSegments(page.segments);
      setTotal(page.total);
      setStatus('');
      return sum;
    } catch (err) {
      setStatus(err instanceof Error ? err.message : 'Failed to load import queue');
      return null;
    } finally {
      setLoading(false);
    }
  }, [enabled, expanded, reasonFilter, pageOffset, showImportQueue, loadDiagnostics]);

  useEffect(() => {
    setPageOffset(0);
  }, [reasonFilter]);

  useEffect(() => {
    void load();
  }, [load]);

  // Diagnostics are heavy — load once when the panel opens (not on every page/filter change).
  useEffect(() => {
    if (!enabled || !expanded || !showImportQueue) return;
    void loadDiagnostics();
  }, [enabled, expanded, showImportQueue, loadDiagnostics]);

  const handleSnap = async () => {
    const before = summary?.total_unpromoted ?? null;
    setUnpromotedBeforeSnap(before);
    setUnpromotedAfterSnap(null);
    setSnapBusy(true);
    setSnapFailed(false);
    setSnapError(null);
    setSnapResult(null);
    setSnapPhase('snap');
    const started = Date.now();
    setSnapStartedMs(started);
    setSnapModalOpen(true);

    try {
      const result = await snapGisConductors();
      setSnapPhase('refresh');
      setSnapResult(result);
      setLastSnapResult(result);

      setSnapPhase('reload');
      const refreshed = await load({ refreshDiagnostics: true });
      setUnpromotedAfterSnap(refreshed?.total_unpromoted ?? result.import_status?.total_unpromoted ?? null);

      setStatus(
        `Snap complete: ${result.segments_snapped.toLocaleString()} updated · ${result.segments_unresolved.toLocaleString()} unresolved (skipped)`,
      );
    } catch (err) {
      setSnapFailed(true);
      setSnapError(err instanceof Error ? err.message : 'Snap failed');
      setStatus(err instanceof Error ? err.message : 'Snap failed');
    } finally {
      setSnapBusy(false);
    }
  };

  const showSegmentOnMap = async (seg: GiopUnpromotedSegment) => {
    if (seg.longitude == null || seg.latitude == null) return;
    const requestId = ++showSegmentSeqRef.current;
    setMapBusyId(seg.id);
    setActiveSegmentId(seg.id);

    queueMapViewportCommand({
      type: 'fly_to',
      center: { lon: seg.longitude, lat: seg.latitude },
      zoom: 17,
      duration: 700,
    });

    try {
      const payload = await getGisUnpromotedSegmentGeojson(seg.id);
      if (requestId !== showSegmentSeqRef.current) return;

      const highlight: ImportSegmentHighlightState = {
        segmentId: payload.segment_id,
        label: payload.label,
        geojson: payload.geojson,
        bbox: payload.bbox ?? undefined,
      };
      setImportSegmentHighlight(highlight);

      if (networkGeometryMode === 'master') {
        setStatus('Map highlight hidden in Master mode — switch to Both or GIS import to preview.');
      } else {
        setStatus('');
      }

      if (payload.bbox) {
        queueMapViewportCommand({
          type: 'fit_bounds',
          bbox: payload.bbox,
          max_zoom: 18,
        });
      }
    } catch (err) {
      if (requestId !== showSegmentSeqRef.current) return;
      setStatus(err instanceof Error ? err.message : 'Map highlight failed');
      setImportSegmentHighlight(null);
      setActiveSegmentId(null);
    } finally {
      if (requestId === showSegmentSeqRef.current) {
        setMapBusyId(null);
      }
    }
  };

  const estimateSec = snapEligibleEstimateSec(summary?.conductor_segments);

  if (!enabled) return null;

  if (!showImportQueue) {
    return (
      <GisEndpointFixProposalsPanel
        isLightMode={isLightMode}
        enabled={enabled}
        dataTier={dataTier}
      />
    );
  }

  return (
    <>
      <GisImportSnapModal
        open={snapModalOpen}
        startedMs={snapStartedMs}
        estimateSec={estimateSec}
        phase={snapPhase}
        isRunning={snapBusy}
        isFailed={snapFailed}
        errorMessage={snapError}
        result={snapResult}
        unpromotedBefore={unpromotedBeforeSnap}
        unpromotedAfter={unpromotedAfterSnap}
        isLightMode={isLightMode}
        onClose={() => setSnapModalOpen(false)}
      />

      <details
        className={`rounded-xl border text-sm group ${card}`}
        onToggle={(event) => setExpanded((event.currentTarget as HTMLDetailsElement).open)}
      >
        <summary
          className={`cursor-pointer list-none px-3 py-2 font-medium flex items-center justify-between gap-2 ${
            isLightMode ? 'text-slate-800' : 'text-premium-text-secondary'
          }`}
        >
          <span>GIS import queue</span>
          <span className={`text-xs font-normal ${muted}`}>
            {summary
              ? `${summary.total_unpromoted.toLocaleString()} unpromoted${
                  summary.pct_promoted != null ? ` · ${summary.pct_promoted}% in master` : ''
                }`
              : expanded && loading
                ? 'Loading…'
                : 'Expand to load'}
          </span>
        </summary>

        <div className="px-3 pb-3 space-y-3 border-t border-slate-200/80 dark:border-premium-border/70 pt-3">
          <p className={`text-xs ${muted}`}>
            Raw GPKG conductors not yet in master. Magenta map overlay = GIS geometry; master lines
            appear after successful promote.
          </p>

          {summary && <GisImportPipelineMetrics summary={summary} isLightMode={isLightMode} />}

          <GisImportEndpointDiagnostics
            diagnostics={endpointDiagnostics}
            loading={diagnosticsLoading}
            isLightMode={isLightMode}
          />

          <GisEndpointFixProposalsPanel
            isLightMode={isLightMode}
            enabled={enabled}
            dataTier={dataTier}
            defaultDistrict={segments[0]?.district ?? ''}
          />

          <details className={`rounded-lg border text-xs ${shell}`}>
            <summary
              className={`cursor-pointer list-none px-3 py-2 font-medium flex items-center justify-between gap-2 ${
                isLightMode ? 'text-slate-700' : 'text-premium-text-secondary'
              }`}
            >
              <span>Steward workflow</span>
              <span className={`text-[10px] font-normal shrink-0 ${muted}`}>
                {WORKFLOW_STEPS.length} steps · expand
              </span>
            </summary>
            <ol className={`list-decimal list-inside space-y-0.5 px-3 pb-2.5 pt-0.5 ${muted}`}>
              {WORKFLOW_STEPS.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ol>
          </details>

          {summary && (
            <div className="flex flex-wrap gap-2">
              {Object.entries(summary.by_reason)
                .sort(([, a], [, b]) => (b ?? 0) - (a ?? 0))
                .map(([reason, count]) => {
                  const key = reason as GiopUnpromotedSegmentReason;
                  const selected = reasonFilter === key;
                  return (
                    <button
                      key={reason}
                      type="button"
                      title={`${REASON_HELP[key] ?? reason}\nFix: ${REASON_FIX_HINT[key] ?? 'review'}`}
                      onClick={() =>
                        setReasonFilter((prev) => (prev === key ? '' : key))
                      }
                      className={`rounded-full border px-2 py-0.5 text-xs text-left ${
                        selected
                          ? isLightMode
                            ? 'border-cyan-600 bg-cyan-50 text-cyan-900'
                            : 'border-premium-accent/50 bg-premium-accent/10 text-premium-accent'
                          : isLightMode
                            ? 'border-slate-200 text-slate-600 hover:bg-slate-50'
                            : 'border-premium-border/40 text-premium-muted hover:bg-premium-hover'
                      }`}
                    >
                      <span className="font-medium">{REASON_LABELS[key] ?? reason}</span>
                      <span className="opacity-80">
                        {' '}
                        · {count?.toLocaleString()} ({reasonPct(count ?? 0, summary.total_unpromoted)})
                      </span>
                    </button>
                  );
                })}
            </div>
          )}

          {reasonFilter && (
            <div
              className={`flex gap-2 items-start rounded-lg border px-2.5 py-2 text-xs ${
                isLightMode ? 'border-cyan-200 bg-cyan-50/60 text-cyan-900' : 'border-cyan-900/40 bg-cyan-950/20 text-cyan-100'
              }`}
            >
              <Info className="h-3.5 w-3.5 shrink-0 mt-0.5" />
              <div>
                <p className="font-medium">{REASON_LABELS[reasonFilter]}</p>
                <p className="opacity-90 mt-0.5">{REASON_HELP[reasonFilter]}</p>
                <p className="opacity-75 mt-1">
                  Typical fix: <span className="font-mono">{REASON_FIX_HINT[reasonFilter]}</span>
                </p>
              </div>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={loading || snapBusy}
              onClick={() => void load({ refreshDiagnostics: true })}
              className={`rounded border text-xs py-1 px-2 disabled:opacity-50 ${
                isLightMode
                  ? 'border-slate-300 text-slate-700 hover:bg-slate-100'
                  : 'border-premium-border/50 text-premium-text-secondary hover:bg-premium-hover'
              }`}
            >
              {loading ? 'Refreshing…' : 'Refresh'}
            </button>
            <button
              type="button"
              disabled={snapBusy || loading}
              onClick={() => void handleSnap()}
              className={`rounded text-xs py-1 px-2 disabled:opacity-50 giop-btn-primary ${
                isLightMode ? 'giop-btn-primary--light' : 'giop-btn-primary--dark'
              }`}
            >
              {snapBusy ? 'Snapping…' : 'Run endpoint snap'}
            </button>
            {snapBusy && (
              <span className={`text-xs ${muted}`}>
                Typical {Math.ceil(estimateSec / 60)}m on full national dataset…
              </span>
            )}
          </div>

          {status && !snapBusy && (
            <p className={`text-xs ${muted}`} role="status">
              {status}
            </p>
          )}

          {lastSnapResult && !snapBusy && (
            <p className={`text-xs ${muted}`}>
              Last snap: {lastSnapResult.segments_snapped.toLocaleString()} updated · tolerance{' '}
              {lastSnapResult.tolerance_m}m
              {lastSnapResult.import_status?.duration_ms != null
                ? ` · stats refresh ${Math.round(lastSnapResult.import_status.duration_ms / 1000)}s`
                : ''}
            </p>
          )}

          {loading && segments.length === 0 && (
            <p className={`text-xs ${muted}`}>Loading unpromoted segments…</p>
          )}

          {!loading && segments.length === 0 && (
            <p className={`text-xs ${muted}`}>
              {total === 0 ? 'All conductor segments are promoted.' : 'No segments match the filter.'}
            </p>
          )}

          {segments.length > 0 && (
            <div>
              <div
                className={`max-h-56 overflow-y-auto overflow-x-auto rounded-lg border ${
                  isLightMode ? 'border-slate-200' : 'border-premium-border/40'
                }`}
              >
                <table className="w-full text-xs">
                  <thead
                    className={`sticky top-0 z-[1] ${
                      isLightMode ? 'bg-white text-slate-500' : 'bg-premium-card text-premium-muted'
                    }`}
                  >
                    <tr>
                      <th className="text-right py-1.5 pl-2 pr-1 font-medium w-9 tabular-nums">#</th>
                      <th className="text-left py-1.5 pr-2 font-medium">Layer</th>
                      <th className="text-left py-1.5 pr-2 font-medium">District</th>
                      <th className="text-left py-1.5 pr-2 font-medium">Reason</th>
                      <th className="text-left py-1.5 pr-2 font-medium">Endpoints</th>
                      <th className="text-right py-1.5 pr-2 font-medium">Map</th>
                    </tr>
                  </thead>
                  <tbody>
                    {segments.map((seg, index) => (
                      <tr
                        key={seg.id}
                        className={`${
                          isLightMode ? 'border-t border-slate-100' : 'border-t border-premium-border/30'
                        } ${activeSegmentId === seg.id ? (isLightMode ? 'bg-cyan-50/80' : 'bg-cyan-950/30') : ''}`}
                      >
                        <td className={`py-1.5 pl-2 pr-1 text-right tabular-nums ${muted}`}>
                          {pageOffset + index + 1}
                        </td>
                        <td className="py-1.5 pr-2">{seg.source_layer}</td>
                        <td className="py-1.5 pr-2">{seg.district ?? '—'}</td>
                        <td className="py-1.5 pr-2" title={REASON_HELP[seg.reason]}>
                          {REASON_LABELS[seg.reason] ?? seg.reason}
                        </td>
                        <td className="py-1.5 pr-2 font-mono truncate max-w-[12rem]">
                          {seg.originating_node_id ?? '—'} → {seg.end_node_id ?? '—'}
                        </td>
                        <td className="py-1.5 pr-2 text-right">
                          {seg.longitude != null && seg.latitude != null ? (
                            <button
                              type="button"
                              disabled={mapBusyId === seg.id}
                              className={`underline disabled:opacity-50 ${
                                isLightMode ? 'text-cyan-700' : 'text-premium-accent'
                              }`}
                              onClick={() => void showSegmentOnMap(seg)}
                            >
                              {mapBusyId === seg.id
                                ? 'Loading…'
                                : activeSegmentId === seg.id
                                  ? 'Shown'
                                  : 'Show'}
                            </button>
                          ) : (
                            '—'
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {total > 0 && (
                <div className={`mt-2 flex flex-wrap items-center justify-between gap-2 text-xs ${muted}`}>
                  <span>
                    {pageOffset + 1}–{Math.min(pageOffset + segments.length, total).toLocaleString()} of{' '}
                    {total.toLocaleString()}
                    {reasonFilter ? ` (${REASON_LABELS[reasonFilter]})` : ''}
                  </span>
                  {total > PAGE_SIZE && (
                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        disabled={loading || pageOffset === 0}
                        onClick={() => setPageOffset((prev) => Math.max(0, prev - PAGE_SIZE))}
                        className={`rounded border px-2 py-0.5 disabled:opacity-40 ${
                          isLightMode
                            ? 'border-slate-300 text-slate-700 hover:bg-slate-100'
                            : 'border-premium-border/50 text-premium-text-secondary hover:bg-premium-hover'
                        }`}
                      >
                        Previous
                      </button>
                      <button
                        type="button"
                        disabled={loading || pageOffset + PAGE_SIZE >= total}
                        onClick={() => setPageOffset((prev) => prev + PAGE_SIZE)}
                        className={`rounded border px-2 py-0.5 disabled:opacity-40 ${
                          isLightMode
                            ? 'border-slate-300 text-slate-700 hover:bg-slate-100'
                            : 'border-premium-border/50 text-premium-text-secondary hover:bg-premium-hover'
                        }`}
                      >
                        Next
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </details>
    </>
  );
}
