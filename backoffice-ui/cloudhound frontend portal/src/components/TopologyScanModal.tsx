import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Radio, X } from 'lucide-react';
import type { GiopTopologyScanProgress } from '../api/giop-api';
import { TopologyScanGlobe } from './TopologyScanGlobe';
import { TopologyScanProgressContent } from './TopologyScanProgressContent';
import { isTopologyScanTerminal } from './topologyScanShared';

export interface TopologyScanModalProps {
  open: boolean;
  runId: string;
  isLightMode: boolean;
  localStartedMs: number;
  progress: GiopTopologyScanProgress | null;
  pollError: string | null;
  onClose: () => void;
  onRunInBackground: () => void;
  onCancel?: () => void;
  cancelBusy?: boolean;
}

const AUTO_CLOSE_MS = 5000;

export function TopologyScanModal({
  open,
  runId,
  isLightMode,
  localStartedMs,
  progress,
  pollError,
  onClose,
  onRunInBackground,
  onCancel,
  cancelBusy = false,
}: TopologyScanModalProps) {
  const [autoCloseSec, setAutoCloseSec] = useState<number | null>(null);
  const isTerminal = isTopologyScanTerminal(progress?.status);
  const isRunning = !isTerminal;
  const isFailed = progress?.status === 'failed';
  const isDone = progress?.status === 'completed';
  const progress01 = isDone
    ? 1
    : isFailed
      ? Math.max(0, Math.min(0.99, (progress?.progress_pct ?? 0) / 100))
      : Math.max(0.02, Math.min(0.99, (progress?.progress_pct ?? 0) / 100));
  const pct = isDone ? 100 : Math.max(0, Math.min(99, progress?.progress_pct ?? 0));

  useEffect(() => {
    if (!open || !isTerminal || progress?.status === 'failed') {
      setAutoCloseSec(null);
      return;
    }
    setAutoCloseSec(Math.ceil(AUTO_CLOSE_MS / 1000));
    const tick = window.setInterval(() => {
      setAutoCloseSec((s) => (s === null || s <= 1 ? null : s - 1));
    }, 1000);
    const closeTimer = window.setTimeout(() => onClose(), AUTO_CLOSE_MS);
    return () => {
      window.clearInterval(tick);
      window.clearTimeout(closeTimer);
    };
  }, [open, isTerminal, progress?.status, onClose]);

  if (!open) return null;

  const statusLabel = isDone
    ? 'Scan complete — Ghana snapshot ready'
    : isFailed
      ? 'Scan stopped'
      : progress01 < 0.2
        ? 'Acquiring global grid…'
        : progress01 < 0.7
          ? 'Locking Ghana operating window…'
          : 'Finalizing topology checks…';

  // Soft monochrome — white shades, not neon chrome
  const modal = (
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center p-3 sm:p-6"
      role="dialog"
      aria-modal="true"
      aria-labelledby="topology-scan-title"
    >
      <button
        type="button"
        className="absolute inset-0 bg-slate-900/40 backdrop-blur-[2px]"
        aria-label="Dismiss overlay"
        onClick={onRunInBackground}
      />

      <div
        className="relative w-full max-w-xl overflow-hidden rounded-2xl border border-white/80 shadow-[0_25px_80px_-20px_rgba(15,23,42,0.35)]"
        style={{
          background:
            'linear-gradient(165deg, #ffffff 0%, #f8fafc 42%, #f1f5f9 100%)',
        }}
      >
        <span className="pointer-events-none absolute top-2.5 left-2.5 h-3.5 w-3.5 border-l border-t border-slate-300/90" />
        <span className="pointer-events-none absolute top-2.5 right-2.5 h-3.5 w-3.5 border-r border-t border-slate-300/90" />
        <span className="pointer-events-none absolute bottom-2.5 left-2.5 h-3.5 w-3.5 border-b border-l border-slate-300/90" />
        <span className="pointer-events-none absolute bottom-2.5 right-2.5 h-3.5 w-3.5 border-b border-r border-slate-300/90" />

        <div className="relative flex items-center justify-between gap-3 px-4 pt-4 pb-2">
          <div className="flex items-center gap-2.5 min-w-0">
            <span className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-slate-200 bg-white text-slate-500 shadow-sm">
              <Radio className="h-3.5 w-3.5" />
            </span>
            <div className="min-w-0">
              <p className="text-[10px] tracking-[0.18em] uppercase text-slate-400 font-medium">
                GIOP · Topology scan
              </p>
              <h2
                id="topology-scan-title"
                className="text-sm sm:text-base font-semibold text-slate-800 tracking-tight truncate"
              >
                Master topology scan
              </h2>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <span
              className={`hidden sm:inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] tracking-wider uppercase ${
                isFailed
                  ? 'border-slate-300 text-slate-600 bg-slate-100'
                  : isDone
                    ? 'border-slate-300 text-slate-700 bg-white'
                    : 'border-slate-200 text-slate-500 bg-white'
              }`}
            >
              <span
                className={`h-1.5 w-1.5 rounded-full ${
                  isRunning
                    ? 'bg-slate-400 animate-pulse'
                    : isDone
                      ? 'bg-slate-700'
                      : 'bg-slate-400'
                }`}
              />
              {isRunning ? 'Live' : isDone ? 'Complete' : 'Failed'}
            </span>
            <button
              type="button"
              onClick={onClose}
              className="rounded-md p-1.5 text-slate-400 hover:text-slate-700 hover:bg-slate-100"
              aria-label="Close"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        <div
          className="relative mx-3 h-56 sm:h-64 overflow-hidden rounded-xl border border-slate-200/90"
          style={{
            background:
              'linear-gradient(180deg, #f8fafc 0%, #eef2f7 55%, #e2e8f0 100%)',
          }}
        >
          <TopologyScanGlobe
            isLightMode={isLightMode}
            progress01={progress01}
            spinning={isRunning}
            monochrome
          />
          <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white to-transparent" />
          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-slate-200/40 to-transparent" />

          <div className="absolute bottom-3 left-3 right-3 flex items-end justify-between gap-3">
            <div>
              <p className="text-[11px] text-slate-600">
                {statusLabel}
                {isRunning ? (
                  <span className="ml-2 inline-block h-1.5 w-1.5 rounded-full bg-amber-500/80 align-middle animate-pulse" />
                ) : null}
              </p>
              {isTerminal && progress?.status === 'completed' && autoCloseSec !== null && (
                <p className="text-[10px] text-slate-400 mt-0.5">Closing in {autoCloseSec}s</p>
              )}
            </div>
            <div className="text-right">
              <p className="font-mono text-lg text-slate-700 tabular-nums leading-none">
                {isDone ? '100' : pct}
                <span className="text-xs text-slate-400">%</span>
              </p>
              <p className="text-[10px] text-slate-400 mt-0.5 font-mono">{runId.slice(0, 8)}</p>
            </div>
          </div>
        </div>

        <div className="px-4 pt-3 pb-2">
          <TopologyScanProgressContent
            runId={runId}
            progress={progress}
            pollError={pollError}
            isLightMode
            localStartedMs={localStartedMs}
            onCancel={onCancel}
            cancelBusy={cancelBusy}
            softMono
          />
        </div>

        <div className="flex items-center justify-between gap-2 px-4 pb-4 pt-1">
          <p className="text-[10px] tracking-wider uppercase text-slate-400">
            National Ghana bbox
          </p>
          <div className="flex items-center gap-2">
            {isRunning && (
              <button
                type="button"
                onClick={onRunInBackground}
                className="rounded-md border border-slate-200 bg-white px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-50 hover:border-slate-300"
              >
                Run in background
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              className="rounded-md border border-slate-300 bg-slate-800 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-700 shadow-sm"
            >
              {isRunning ? 'Hide' : 'Close'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );

  return createPortal(modal, document.body);
}
