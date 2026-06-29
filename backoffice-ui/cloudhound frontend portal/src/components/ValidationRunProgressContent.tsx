import { CheckCircle2, Circle, Loader2, XCircle } from 'lucide-react';
import type { GiopValidationProgress } from '../api/giop-api';
import { VALIDATION_PHASE_DEFS, formatValidationElapsed } from './validationRunShared';

export { VALIDATION_PHASE_DEFS, formatValidationElapsed } from './validationRunShared';

export interface ValidationRunProgressContentProps {
  runId: string;
  mode: 'deterministic' | 'agent';
  progress: GiopValidationProgress | null;
  pollError: string | null;
  isLightMode: boolean;
  localStartedMs: number;
  compact?: boolean;
  /** True while waiting for first progress payload after run id is known */
  awaitingProgress?: boolean;
}

function resolveActivePhase(current: string): string {
  if (current === 'queued' || current === 'starting') return 'validator';
  if (current === 'completed') return 'kpi';
  return current;
}

function phaseProgressPct(completed: Set<string>, phaseCount: number, isDone: boolean): number {
  if (isDone) return 100;
  if (phaseCount === 0) return 0;
  return Math.min(99, Math.round((completed.size / phaseCount) * 100));
}

export function ValidationRunProgressContent({
  runId,
  mode,
  progress,
  pollError,
  isLightMode,
  localStartedMs,
  compact = false,
  awaitingProgress = false,
}: ValidationRunProgressContentProps) {
  const phases = VALIDATION_PHASE_DEFS.filter(
    (p) => !('agentOnly' in p && p.agentOnly) || mode === 'agent',
  );
  const completed = new Set(progress?.completed_phases ?? []);
  const isFailed = progress?.status === 'failed';
  const isDone = progress?.status === 'completed';
  const isRunning =
    !isDone &&
    !isFailed &&
    (runId === 'pending' ||
      awaitingProgress ||
      !progress ||
      progress.status === 'running' ||
      progress.status === 'pending');
  const current = resolveActivePhase(
    progress?.current_phase ?? (runId === 'pending' ? 'queued' : 'starting'),
  );
  const muted = isLightMode ? 'text-slate-500' : 'text-slate-400';
  const pct = phaseProgressPct(completed, phases.length, isDone);

  return (
    <div className={compact ? 'space-y-3' : 'space-y-4'}>
      <div className="space-y-1.5">
        <div className="flex items-center justify-between gap-2 text-xs">
          <span className={muted}>
            Run {runId === 'pending' ? '…' : runId.slice(0, 8)}
            {' · '}
            {formatValidationElapsed(progress?.started_at, localStartedMs)} elapsed
          </span>
          {!compact && (
            <span className={`font-medium ${isDone ? 'text-emerald-600' : 'text-cyan-600'}`}>
              {isDone ? '100%' : `${pct}%`}
            </span>
          )}
        </div>
        {!compact && (
          <div
            className={`h-1.5 rounded-full overflow-hidden ${isLightMode ? 'bg-slate-100' : 'bg-slate-800'}`}
          >
            <div
              className={`h-full transition-all duration-500 ease-out rounded-full ${
                isFailed ? 'bg-rose-500' : isDone ? 'bg-emerald-500' : 'bg-cyan-500'
              }`}
              style={{ width: `${isDone ? 100 : Math.max(pct, isRunning ? 8 : 0)}%` }}
            />
          </div>
        )}
      </div>

      {pollError && (
        <p className="text-xs text-amber-600 dark:text-amber-400">
          Live progress unavailable ({pollError}). Retrying…
        </p>
      )}

      {isRunning && (
        <div className="flex items-center gap-2 text-sm text-cyan-600 dark:text-cyan-400">
          <Loader2 className="w-4 h-4 animate-spin shrink-0" />
          <span>
            {runId === 'pending'
              ? 'Starting validation run on sync-service…'
              : awaitingProgress
                ? 'Connecting to live progress…'
                : progress?.phase_detail ?? 'Running validation pipeline…'}
          </span>
        </div>
      )}

      {isFailed && (
        <div className="flex items-start gap-2 text-sm text-rose-600 dark:text-rose-400">
          <XCircle className="w-4 h-4 shrink-0 mt-0.5" />
          <span>{progress?.error_message ?? 'Validation run failed.'}</span>
        </div>
      )}

      {isDone && (
        <div
          className={`flex items-start gap-3 text-sm rounded-lg p-3 ${
            isLightMode ? 'bg-emerald-50 border border-emerald-200' : 'bg-emerald-950/40 border border-emerald-800/50'
          }`}
        >
          <CheckCircle2 className="w-5 h-5 text-emerald-500 shrink-0 mt-0.5" />
          <div>
            <p className="font-semibold text-emerald-700 dark:text-emerald-300">Validation completed</p>
            <p className={`text-xs mt-0.5 ${muted}`}>
              KPI snapshot saved · {formatValidationElapsed(progress?.started_at, localStartedMs)} total
            </p>
          </div>
        </div>
      )}

      <ul className="space-y-1.5">
        {phases.map((phase) => {
          const done = isDone || completed.has(phase.id);
          const active = !isDone && current === phase.id && isRunning;
          return (
            <li
              key={phase.id}
              className={`flex items-start gap-2 text-sm rounded-lg p-2 transition-colors ${
                active
                  ? isLightMode
                    ? 'bg-cyan-50 border border-cyan-200'
                    : 'bg-cyan-950/40 border border-cyan-800/50'
                  : done
                    ? isLightMode
                      ? 'bg-emerald-50/50'
                      : 'bg-emerald-950/20'
                    : ''
              }`}
            >
              {done ? (
                <CheckCircle2 className="w-4 h-4 text-emerald-500 shrink-0 mt-0.5" />
              ) : active ? (
                <Loader2 className="w-4 h-4 text-cyan-500 animate-spin shrink-0 mt-0.5" />
              ) : (
                <Circle className={`w-4 h-4 shrink-0 mt-0.5 ${muted}`} />
              )}
              <div>
                <p className="font-medium">{phase.label}</p>
                {!compact && <p className={`text-xs ${muted}`}>{phase.detail}</p>}
              </div>
            </li>
          );
        })}
      </ul>

      {(progress?.steps?.length ?? 0) > 0 && (
        <div>
          <p className={`text-xs font-medium mb-1 ${muted}`}>Recent activity</p>
          <ul className={`text-xs space-y-0.5 max-h-24 overflow-y-auto font-mono ${muted}`}>
            {[...(progress?.steps ?? [])].reverse().slice(0, 6).map((step, i) => (
              <li key={`${step.created_at}-${i}`}>{stepLabel(step)}</li>
            ))}
          </ul>
        </div>
      )}

      {isDone && progress?.kpi && (
        <div className={`grid grid-cols-2 gap-2 text-xs rounded-lg p-3 ${isLightMode ? 'bg-slate-50' : 'bg-slate-800/60'}`}>
          <div>
            <span className={muted}>Topology validity</span>
            <p className="font-semibold text-base">{progress.kpi.topology_validity_pct?.toFixed(1) ?? '—'}%</p>
          </div>
          <div>
            <span className={muted}>Completeness</span>
            <p className="font-semibold text-base">{progress.kpi.completeness_pct?.toFixed(1) ?? '—'}%</p>
          </div>
          <div>
            <span className={muted}>Open exceptions</span>
            <p className="font-semibold text-base">
              {(progress.kpi.open_exception_count ?? 0).toLocaleString()}
            </p>
          </div>
          <div>
            <span className={muted}>Critical open</span>
            <p className="font-semibold text-base">{progress.kpi.critical_exception_count ?? 0}</p>
          </div>
          {progress.kpi.export_blocked && (
            <div className="col-span-2 text-amber-700 dark:text-amber-300">
              Export blocked — topology below threshold
            </div>
          )}
        </div>
      )}

      {isDone && progress?.agent_summary?.content && (
        <div className={`text-xs rounded-lg p-2 ${isLightMode ? 'bg-slate-50' : 'bg-slate-800/60'}`}>
          <p className={`font-medium mb-1 ${muted}`}>AI briefing</p>
          <p className="whitespace-pre-wrap line-clamp-4">{progress.agent_summary.content}</p>
        </div>
      )}
    </div>
  );
}

function stepLabel(step: NonNullable<GiopValidationProgress['steps']>[number]): string {
  return `${step.agent_name ?? 'Agent'} · ${step.tool_name ?? 'step'}`;
}
