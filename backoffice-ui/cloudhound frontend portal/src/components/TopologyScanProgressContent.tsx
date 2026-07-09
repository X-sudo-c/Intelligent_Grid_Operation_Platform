import { CheckCircle2, Circle, Loader2, XCircle } from 'lucide-react';
import type { GiopTopologyScanProgress } from '../api/giop-api';
import {
  TOPOLOGY_SCAN_PHASE_DEFS,
  formatScanElapsed,
  formatScanEta,
  isTopologyScanTerminal,
} from './topologyScanShared';

export interface TopologyScanProgressContentProps {
  runId: string;
  progress: GiopTopologyScanProgress | null;
  pollError: string | null;
  isLightMode: boolean;
  localStartedMs: number;
  compact?: boolean;
  onCancel?: () => void;
  cancelBusy?: boolean;
  /** Soft white monochrome chrome for the master scan modal. */
  softMono?: boolean;
}

export function TopologyScanProgressContent({
  runId,
  progress,
  pollError,
  isLightMode,
  localStartedMs,
  compact = false,
  onCancel,
  cancelBusy = false,
  softMono = false,
}: TopologyScanProgressContentProps) {
  const phases = progress?.phases?.length
    ? progress.phases
    : TOPOLOGY_SCAN_PHASE_DEFS.map((p) => ({ id: p.id, label: p.label }));
  const completed = new Set(progress?.completed_phases ?? []);
  const isFailed = progress?.status === 'failed';
  const isDone = progress?.status === 'completed';
  const isRunning = !isDone && !isFailed && (!progress || progress.status === 'running');
  const current = progress?.current_phase ?? 'auto_clear';
  const pct = isDone ? 100 : Math.max(0, Math.min(99, progress?.progress_pct ?? 0));
  const muted = softMono
    ? 'text-slate-400'
    : isLightMode
      ? 'text-slate-500'
      : 'text-premium-muted';
  const eta = formatScanEta(progress?.eta_seconds);
  const geomStep =
    current === 'geometric' && progress?.geometric_step
      ? ` · ${progress.geometric_step.replace(/_/g, ' ')}`
      : '';

  return (
    <div className={compact ? 'space-y-3' : 'space-y-3.5'}>
      <div className="space-y-1.5">
        <div className="flex items-center justify-between gap-2 text-xs">
          <span className={`${muted} ${softMono ? 'tracking-tight' : ''}`}>
            Run {runId.slice(0, 8)} · {formatScanElapsed(progress?.started_at, localStartedMs)} elapsed
            {eta ? ` · ${eta}` : ''}
            {geomStep}
          </span>
          {!compact && !softMono && (
            <span className={`font-medium ${isDone ? 'text-emerald-600' : 'text-cyan-600'}`}>
              {isDone ? '100%' : `${pct}%`}
            </span>
          )}
        </div>
        {!compact && (
          <div
            className={`h-1.5 rounded-full overflow-hidden ${
              softMono
                ? 'bg-slate-100 border border-slate-200/80'
                : isLightMode
                  ? 'bg-slate-100'
                  : 'bg-slate-800'
            }`}
          >
            <div
              className={`h-full transition-all duration-500 ${
                softMono
                  ? isFailed
                    ? 'bg-slate-500'
                    : isDone
                      ? 'bg-slate-700'
                      : 'bg-gradient-to-r from-slate-300 via-slate-500 to-slate-700'
                  : isFailed
                    ? 'bg-red-500'
                    : isDone
                      ? 'bg-emerald-500'
                      : 'bg-cyan-500'
              }`}
              style={{ width: `${pct}%` }}
            />
          </div>
        )}
        {compact && (
          <div
            className={`h-1.5 rounded-full overflow-hidden ${isLightMode ? 'bg-slate-100' : 'bg-slate-800'}`}
          >
            <div
              className={`h-full transition-all duration-500 ${isDone ? 'bg-emerald-500' : 'bg-cyan-500'}`}
              style={{ width: `${pct}%` }}
            />
          </div>
        )}
      </div>

      {!compact && (
        <ul className="space-y-1">
          {phases.map((phase, idx) => {
            const done = completed.has(phase.id);
            const active = !done && current === phase.id && isRunning;
            const Icon = done
              ? CheckCircle2
              : active
                ? Loader2
                : isFailed && current === phase.id
                  ? XCircle
                  : Circle;
            return (
              <li
                key={phase.id}
                className={`flex items-center gap-2 text-xs ${
                  softMono
                    ? done
                      ? 'text-slate-700'
                      : active
                        ? 'text-slate-900'
                        : 'text-slate-300'
                    : done
                      ? isLightMode
                        ? 'text-emerald-700'
                        : 'text-emerald-400'
                      : active
                        ? isLightMode
                          ? 'text-cyan-800'
                          : 'text-cyan-300'
                        : muted
                }`}
              >
                {softMono ? (
                  <span
                    className={`inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-sm border text-[9px] ${
                      done
                        ? 'border-slate-300 bg-slate-100 text-slate-600'
                        : active
                          ? 'border-slate-400 bg-white text-slate-800 shadow-sm'
                          : 'border-slate-200 text-slate-300'
                    }`}
                  >
                    {String(idx + 1).padStart(2, '0')}
                  </span>
                ) : (
                  <Icon className={`h-3.5 w-3.5 shrink-0 ${active ? 'animate-spin' : ''}`} />
                )}
                <span>{phase.label}</span>
                {active && softMono ? (
                  <span className="ml-auto text-[10px] text-slate-500">Active</span>
                ) : null}
                {done && softMono ? (
                  <span className="ml-auto text-[10px] text-slate-400">Done</span>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      {isDone && progress && (
        <p className={`text-xs ${softMono ? 'text-slate-600' : isLightMode ? 'text-emerald-700' : 'text-emerald-400'}`}>
          {(progress.orphans_found ?? 0).toLocaleString()} orphans ·{' '}
          {(progress.dangling_found ?? 0).toLocaleString()} dangling ·{' '}
          {(progress.auto_cleared ?? 0).toLocaleString()} auto-cleared
        </p>
      )}

      {isFailed && (
        <p className={`text-xs ${softMono ? 'text-slate-700' : isLightMode ? 'text-red-700' : 'text-red-300'}`}>
          {progress?.error_message ?? 'Topology scan failed'}
        </p>
      )}

      {pollError && !isTopologyScanTerminal(progress?.status) && (
        <p className={`text-xs ${softMono ? 'text-slate-500' : isLightMode ? 'text-amber-700' : 'text-amber-300'}`}>
          {pollError}
        </p>
      )}

      {isRunning && onCancel ? (
        <button
          type="button"
          disabled={cancelBusy}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onCancel();
          }}
          className={`rounded-md border px-2.5 py-1 text-xs font-medium disabled:opacity-50 ${
            softMono
              ? 'border-slate-300 bg-white text-slate-600 hover:bg-slate-50'
              : isLightMode
                ? 'border-red-200 text-red-700 hover:bg-red-50'
                : 'border-premium-danger-border/40 text-premium-danger-fg hover:bg-premium-danger-bg'
          }`}
        >
          {cancelBusy ? 'Cancelling…' : 'Cancel scan'}
        </button>
      ) : null}
    </div>
  );
}
