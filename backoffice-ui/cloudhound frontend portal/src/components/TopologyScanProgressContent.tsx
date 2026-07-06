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
}

export function TopologyScanProgressContent({
  runId,
  progress,
  pollError,
  isLightMode,
  localStartedMs,
  compact = false,
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
  const muted = isLightMode ? 'text-slate-500' : 'text-premium-muted';
  const eta = formatScanEta(progress?.eta_seconds);

  return (
    <div className={compact ? 'space-y-3' : 'space-y-4'}>
      <div className="space-y-1.5">
        <div className="flex items-center justify-between gap-2 text-xs">
          <span className={muted}>
            Run {runId.slice(0, 8)} · {formatScanElapsed(progress?.started_at, localStartedMs)} elapsed
            {eta ? ` · ${eta}` : ''}
          </span>
          {!compact && (
            <span className={`font-medium ${isDone ? 'text-emerald-600' : 'text-cyan-600'}`}>
              {isDone ? '100%' : `${pct}%`}
            </span>
          )}
        </div>
        {!compact && (
          <div
            className={`h-2 rounded-full overflow-hidden ${isLightMode ? 'bg-slate-100' : 'bg-slate-800'}`}
          >
            <div
              className={`h-full transition-all duration-500 ${
                isFailed ? 'bg-red-500' : isDone ? 'bg-emerald-500' : 'bg-cyan-500'
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
        <ul className="space-y-1.5">
          {phases.map((phase) => {
            const done = completed.has(phase.id);
            const active = !done && current === phase.id && isRunning;
            const Icon = done ? CheckCircle2 : active ? Loader2 : isFailed && current === phase.id ? XCircle : Circle;
            return (
              <li
                key={phase.id}
                className={`flex items-center gap-2 text-xs ${
                  done
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
                <Icon className={`h-3.5 w-3.5 shrink-0 ${active ? 'animate-spin' : ''}`} />
                <span>{phase.label}</span>
              </li>
            );
          })}
        </ul>
      )}

      {isDone && progress && (
        <p className={`text-xs ${isLightMode ? 'text-emerald-700' : 'text-emerald-400'}`}>
          {(progress.orphans_found ?? 0).toLocaleString()} orphans ·{' '}
          {(progress.dangling_found ?? 0).toLocaleString()} dangling ·{' '}
          {(progress.auto_cleared ?? 0).toLocaleString()} auto-cleared
        </p>
      )}

      {isFailed && (
        <p className={`text-xs ${isLightMode ? 'text-red-700' : 'text-red-300'}`}>
          {progress?.error_message ?? 'Topology scan failed'}
        </p>
      )}

      {pollError && !isTopologyScanTerminal(progress?.status) && (
        <p className={`text-xs ${isLightMode ? 'text-amber-700' : 'text-amber-300'}`}>{pollError}</p>
      )}
    </div>
  );
}
