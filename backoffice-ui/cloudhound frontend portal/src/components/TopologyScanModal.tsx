import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import type { GiopTopologyScanProgress } from '../api/giop-api';
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
}: TopologyScanModalProps) {
  const [autoCloseSec, setAutoCloseSec] = useState<number | null>(null);
  const isTerminal = isTopologyScanTerminal(progress?.status);
  const isRunning = !isTerminal;

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

  const overlay = isLightMode ? 'bg-slate-900/50' : 'bg-black/70';
  const panel = isLightMode
    ? 'bg-white border-slate-200 text-slate-900'
    : 'bg-premium-surface border-premium-border/70 text-premium-text';

  const modal = (
    <div
      className={`fixed inset-0 z-[9999] flex items-center justify-center p-4 ${overlay}`}
      role="dialog"
      aria-modal="true"
      aria-labelledby="topology-scan-title"
    >
      <div className={`w-full max-w-lg rounded-xl border shadow-2xl ${panel}`}>
        <div className="flex items-start justify-between gap-3 p-4 border-b border-inherit">
          <div>
            <h2 id="topology-scan-title" className="text-base font-semibold">
              Master topology scan
            </h2>
            <p className={`text-xs mt-0.5 ${isLightMode ? 'text-slate-500' : 'text-premium-muted'}`}>
              National Ghana bbox · updates metrics snapshot and exception queue
            </p>
            {isTerminal && progress?.status === 'completed' && autoCloseSec !== null && (
              <p className={`text-xs mt-0.5 ${isLightMode ? 'text-slate-500' : 'text-premium-muted'}`}>
                Closing in {autoCloseSec}s…
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            className={`rounded-lg p-1.5 ${isLightMode ? 'hover:bg-slate-100' : 'hover:bg-premium-hover'}`}
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="p-4">
          <TopologyScanProgressContent
            runId={runId}
            progress={progress}
            pollError={pollError}
            isLightMode={isLightMode}
            localStartedMs={localStartedMs}
          />
        </div>

        <div className="flex items-center justify-end gap-2 p-4 border-t border-inherit">
          {isRunning && (
            <button
              type="button"
              onClick={onRunInBackground}
              className={`rounded-lg border text-xs py-1.5 px-3 ${
                isLightMode
                  ? 'border-slate-300 text-slate-700 hover:bg-slate-50'
                  : 'border-premium-border/50 text-premium-text-secondary hover:bg-premium-hover'
              }`}
            >
              Run in background
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            className={`rounded-lg text-xs py-1.5 px-3 giop-btn-primary ${
              isLightMode ? 'giop-btn-primary--light' : 'giop-btn-primary--dark'
            }`}
          >
            {isRunning ? 'Hide' : 'Close'}
          </button>
        </div>
      </div>
    </div>
  );

  return createPortal(modal, document.body);
}
