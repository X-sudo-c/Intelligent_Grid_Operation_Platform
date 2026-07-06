import { CheckCircle2, Circle, Loader2, XCircle } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { GiopConductorSnapResult } from '../api/giop-api';
import {
  GIS_SNAP_PHASE_DEFS,
  formatImportElapsed,
  formatSnapEta,
  type GisSnapPhaseId,
} from '../lib/gisImportShared';
import { GisImportSnapResultCard } from './GisImportPipelineMetrics';

export interface GisImportSnapProgressContentProps {
  startedMs: number;
  estimateSec: number;
  phase: GisSnapPhaseId;
  isRunning: boolean;
  isFailed: boolean;
  errorMessage?: string | null;
  result: GiopConductorSnapResult | null;
  unpromotedBefore?: number | null;
  unpromotedAfter?: number | null;
  isLightMode: boolean;
  compact?: boolean;
}

export function GisImportSnapProgressContent({
  startedMs,
  estimateSec,
  phase,
  isRunning,
  isFailed,
  errorMessage,
  result,
  unpromotedBefore,
  unpromotedAfter,
  isLightMode,
  compact = false,
}: GisImportSnapProgressContentProps) {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!isRunning) return;
    const id = window.setInterval(() => setTick((n) => n + 1), 1000);
    return () => window.clearInterval(id);
  }, [isRunning]);

  const muted = isLightMode ? 'text-slate-500' : 'text-premium-muted';
  const isDone = !isRunning && !isFailed && result != null;
  const phaseIndex = GIS_SNAP_PHASE_DEFS.findIndex((p) => p.id === phase);
  const pct = isDone
    ? 100
    : isFailed
      ? Math.max(0, (phaseIndex / GIS_SNAP_PHASE_DEFS.length) * 100)
      : Math.min(95, ((phaseIndex + 0.5) / GIS_SNAP_PHASE_DEFS.length) * 100);
  const eta = isRunning ? formatSnapEta(startedMs, estimateSec) : null;

  return (
    <div className={compact ? 'space-y-3' : 'space-y-4'}>
      <div className="space-y-1.5">
        <div className="flex items-center justify-between gap-2 text-xs">
          <span className={muted}>
            {formatImportElapsed(startedMs)} elapsed
            {eta ? ` · ${eta}` : ''}
          </span>
          {!compact && (
            <span className={`font-medium ${isDone ? 'text-emerald-600' : isFailed ? 'text-red-600' : 'text-cyan-600'}`}>
              {isDone ? '100%' : `${Math.round(pct)}%`}
            </span>
          )}
        </div>
        <div
          className={`${compact ? 'h-1.5' : 'h-2'} rounded-full overflow-hidden ${isLightMode ? 'bg-slate-100' : 'bg-slate-800'}`}
        >
          <div
            className={`h-full transition-all duration-500 ${
              isFailed ? 'bg-red-500' : isDone ? 'bg-emerald-500' : 'bg-cyan-500'
            } ${isRunning && !isFailed ? 'giop-indeterminate-bar' : ''}`}
            style={isRunning && !isFailed ? undefined : { width: `${pct}%` }}
          />
        </div>
      </div>

      {!compact && (
        <ul className="space-y-1.5">
          {GIS_SNAP_PHASE_DEFS.map((step, idx) => {
            const done = isDone || idx < phaseIndex;
            const active = isRunning && !isFailed && step.id === phase;
            const failed = isFailed && step.id === phase;
            const Icon = done
              ? CheckCircle2
              : active
                ? Loader2
                : failed
                  ? XCircle
                  : Circle;
            return (
              <li
                key={step.id}
                className={`flex items-center gap-2 text-xs ${
                  done
                    ? isLightMode
                      ? 'text-emerald-700'
                      : 'text-emerald-400'
                    : active
                      ? isLightMode
                        ? 'text-cyan-800'
                        : 'text-cyan-300'
                      : failed
                        ? isLightMode
                          ? 'text-red-700'
                          : 'text-red-300'
                        : muted
                }`}
              >
                <Icon className={`h-3.5 w-3.5 shrink-0 ${active ? 'animate-spin' : ''}`} />
                <span>{step.label}</span>
              </li>
            );
          })}
        </ul>
      )}

      {isDone && result && (
        <GisImportSnapResultCard
          result={result}
          unpromotedBefore={unpromotedBefore}
          unpromotedAfter={unpromotedAfter}
          isLightMode={isLightMode}
        />
      )}

      {isFailed && (
        <p className={`text-xs ${isLightMode ? 'text-red-700' : 'text-red-300'}`}>
          {errorMessage ?? 'Endpoint snap failed'}
        </p>
      )}

      {isRunning && (
        <p className={`text-xs ${muted}`}>
          Snap only affects segments with both pole IDs resolved. Unresolved rows stay in the queue until
          lookup is fixed, then run <code className="font-mono text-[10px]">promote_topology.sh</code>.
        </p>
      )}
    </div>
  );
}
