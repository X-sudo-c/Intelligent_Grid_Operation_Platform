import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import type { GiopConductorSnapResult } from '../api/giop-api';
import { GisImportSnapProgressContent } from './GisImportSnapProgressContent';
import type { GisSnapPhaseId } from '../lib/gisImportShared';

export interface GisImportSnapModalProps {
  open: boolean;
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
  onClose: () => void;
}

const AUTO_CLOSE_MS = 8000;

export function GisImportSnapModal({
  open,
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
  onClose,
}: GisImportSnapModalProps) {
  const [autoCloseSec, setAutoCloseSec] = useState<number | null>(null);
  const isDone = !isRunning && !isFailed && result != null;

  useEffect(() => {
    if (!open || !isDone) {
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
  }, [open, isDone, onClose]);

  if (!open) return null;

  const shell = isLightMode
    ? 'bg-white border-slate-200 text-slate-800'
    : 'bg-premium-card border-premium-border/70 text-premium-text-secondary';
  const muted = isLightMode ? 'text-slate-500' : 'text-premium-muted';

  return createPortal(
    <div
      className="fixed inset-0 z-[1200] flex items-center justify-center p-4 bg-black/40 backdrop-blur-[1px]"
      role="dialog"
      aria-modal="true"
      aria-labelledby="gis-snap-title"
    >
      <div className={`w-full max-w-md rounded-xl border shadow-xl ${shell}`}>
        <div className="flex items-start justify-between gap-3 px-4 pt-4 pb-2">
          <div>
            <h2 id="gis-snap-title" className="text-base font-semibold">
              Endpoint snap
            </h2>
            <p className={`text-xs mt-0.5 ${muted}`}>
              {isRunning
                ? 'Aligning GIS conductor endpoints to resolved poles…'
                : isFailed
                  ? 'Snap did not complete'
                  : 'Snap finished — review results below'}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className={`shrink-0 rounded p-1 ${isLightMode ? 'hover:bg-slate-100' : 'hover:bg-premium-hover'}`}
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="px-4 pb-4">
          <GisImportSnapProgressContent
            startedMs={startedMs}
            estimateSec={estimateSec}
            phase={phase}
            isRunning={isRunning}
            isFailed={isFailed}
            errorMessage={errorMessage}
            result={result}
            unpromotedBefore={unpromotedBefore}
            unpromotedAfter={unpromotedAfter}
            isLightMode={isLightMode}
          />
        </div>

        <div
          className={`flex items-center justify-end gap-2 px-4 py-3 border-t ${isLightMode ? 'border-slate-200' : 'border-premium-border/60'}`}
        >
          {isDone && autoCloseSec != null && (
            <span className={`text-xs ${muted}`}>Closing in {autoCloseSec}s</span>
          )}
          <button
            type="button"
            onClick={onClose}
            className={`rounded text-xs py-1.5 px-3 ${
              isLightMode
                ? 'border border-slate-300 hover:bg-slate-50'
                : 'border border-premium-border/50 hover:bg-premium-hover'
            }`}
          >
            {isRunning ? 'Run in background' : 'Close'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
