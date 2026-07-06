import type { GiopConductorSnapResult, GiopUnpromotedSegmentSummary } from '../api/giop-api';
import { formatDurationMs } from '../lib/gisImportShared';

interface GisImportPipelineMetricsProps {
  summary: GiopUnpromotedSegmentSummary;
  isLightMode: boolean;
}

export function GisImportPipelineMetrics({ summary, isLightMode }: GisImportPipelineMetricsProps) {
  const conductors = summary.conductor_segments;
  const master = summary.master_lines;
  const unpromoted = summary.total_unpromoted;
  const actionable = summary.actionable_unpromoted ?? unpromoted;
  const customerEquipment = summary.customer_equipment_unpromoted ?? 0;
  const pct = summary.pct_promoted;
  const hasPipeline = conductors != null && master != null && pct != null;

  const shell = isLightMode ? 'bg-slate-50 border-slate-200' : 'bg-premium-surface/40 border-premium-border/50';
  const muted = isLightMode ? 'text-slate-500' : 'text-premium-muted';
  const strong = isLightMode ? 'text-slate-800' : 'text-premium-text-secondary';

  if (!hasPipeline) {
    return (
      <div className={`rounded-lg border px-3 py-2 text-xs ${shell}`}>
        <p className={muted}>
          {unpromoted.toLocaleString()} unpromoted segments
          {summary.refreshed_at ? ` · stats ${new Date(summary.refreshed_at).toLocaleString()}` : ''}
        </p>
      </div>
    );
  }

  const promoted = Math.max(0, conductors - unpromoted);

  return (
    <div className={`rounded-lg border px-3 py-2.5 space-y-2 ${shell}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className={`text-xs font-medium ${strong}`}>Import pipeline</span>
        <span className={`text-[10px] ${muted}`}>
          {summary.source === 'cached' ? 'Cached rollup' : 'Live query'}
          {summary.refreshed_at
            ? ` · ${new Date(summary.refreshed_at).toLocaleString()}`
            : ''}
        </span>
      </div>

      <div className="grid grid-cols-3 gap-2 text-center">
        <div>
          <p className={`text-lg font-semibold tabular-nums ${strong}`}>{pct}%</p>
          <p className={`text-[10px] uppercase tracking-wide ${muted}`}>Promoted</p>
        </div>
        <div>
          <p className={`text-lg font-semibold tabular-nums ${strong}`}>
            {master.toLocaleString()}
          </p>
          <p className={`text-[10px] uppercase tracking-wide ${muted}`}>Master lines</p>
        </div>
        <div>
          <p className={`text-lg font-semibold tabular-nums ${isLightMode ? 'text-amber-700' : 'text-amber-400'}`}>
            {unpromoted.toLocaleString()}
          </p>
          <p className={`text-[10px] uppercase tracking-wide ${muted}`}>Unpromoted</p>
        </div>
      </div>

      <div className="space-y-1">
        <div className={`h-2 rounded-full overflow-hidden ${isLightMode ? 'bg-slate-200' : 'bg-slate-800'}`}>
          <div
            className="h-full bg-emerald-500 transition-all duration-700"
            style={{ width: `${Math.min(100, Math.max(0, pct))}%` }}
          />
        </div>
        <p className={`text-[10px] ${muted}`}>
          {promoted.toLocaleString()} of {conductors.toLocaleString()} GIS conductors in master ·{' '}
          {actionable.toLocaleString()} blocked (pole lookup)
          {customerEquipment > 0
            ? ` · ${customerEquipment.toLocaleString()} LV service endpoints (informational)`
            : ''}
        </p>
      </div>
    </div>
  );
}

export function GisImportSnapResultCard({
  result,
  unpromotedBefore,
  unpromotedAfter,
  isLightMode,
}: {
  result: GiopConductorSnapResult;
  unpromotedBefore?: number | null;
  unpromotedAfter?: number | null;
  isLightMode: boolean;
}) {
  const shell = isLightMode ? 'bg-emerald-50 border-emerald-200' : 'bg-emerald-950/30 border-emerald-800/50';
  const muted = isLightMode ? 'text-emerald-800/70' : 'text-emerald-300/80';
  const strong = isLightMode ? 'text-emerald-900' : 'text-emerald-200';
  const refreshMs = result.import_status?.duration_ms;
  const delta =
    unpromotedBefore != null && unpromotedAfter != null
      ? unpromotedBefore - unpromotedAfter
      : null;

  return (
    <div className={`rounded-lg border px-3 py-2.5 text-xs space-y-2 ${shell}`}>
      <p className={`font-medium ${strong}`}>Endpoint snap complete</p>
      <dl className={`grid grid-cols-2 gap-x-3 gap-y-1 ${muted}`}>
        <dt>Geometry updated</dt>
        <dd className={`text-right tabular-nums ${strong}`}>{result.segments_snapped.toLocaleString()}</dd>
        <dt>Already aligned</dt>
        <dd className={`text-right tabular-nums ${strong}`}>
          {result.segments_already_aligned.toLocaleString()}
        </dd>
        {(result.segments_span_rejected ?? 0) > 0 && (
          <>
            <dt>Span rejected</dt>
            <dd className="text-right tabular-nums">{result.segments_span_rejected!.toLocaleString()}</dd>
          </>
        )}
        {(result.segments_move_rejected ?? 0) > 0 && (
          <>
            <dt>Move rejected</dt>
            <dd className="text-right tabular-nums">{result.segments_move_rejected!.toLocaleString()}</dd>
          </>
        )}
        <dt>Unresolved (skipped)</dt>
        <dd className="text-right tabular-nums">{result.segments_unresolved.toLocaleString()}</dd>
        <dt>Tolerance</dt>
        <dd className="text-right tabular-nums">{result.tolerance_m}m</dd>
        {refreshMs != null && (
          <>
            <dt>Stats refresh</dt>
            <dd className="text-right tabular-nums">{formatDurationMs(refreshMs)}</dd>
          </>
        )}
      </dl>
      {delta != null && delta !== 0 && (
        <p className={strong}>
          Queue {delta > 0 ? 'down' : 'up'} {Math.abs(delta).toLocaleString()} after refresh
        </p>
      )}
      {delta === 0 && unpromotedAfter != null && (
        <p className={muted}>Queue count unchanged — snap fixes geometry; promote adds master lines.</p>
      )}
    </div>
  );
}
