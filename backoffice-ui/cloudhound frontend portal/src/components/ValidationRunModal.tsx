import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import type { GiopValidationProgress } from '../api/giop-api';
import { ValidationRunProgressContent } from './ValidationRunProgressContent';
import { isValidationTerminal } from './validationRunShared';

export interface ValidationRunModalProps {
  open: boolean;
  runId: string;
  mode: 'deterministic' | 'agent';
  isLightMode: boolean;
  localStartedMs: number;
  progress: GiopValidationProgress | null;
  pollError: string | null;
  awaitingProgress?: boolean;
  onClose: () => void;
  onRunInBackground: () => void;
}

const AUTO_CLOSE_MS = 4500;

export function ValidationRunModal({
  open,
  runId,
  mode,
  isLightMode,
  localStartedMs,
  progress,
  pollError,
  awaitingProgress = false,
  onClose,
  onRunInBackground,
}: ValidationRunModalProps) {
  const [autoCloseSec, setAutoCloseSec] = useState<number | null>(null);

  const isTerminal = isValidationTerminal(progress);
  const isRunning = !isTerminal && (runId === 'pending' || awaitingProgress || !progress || progress.status === 'running');

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
    : 'bg-slate-900 border-slate-700 text-slate-100';

  const modal = (
    <div
      className={`fixed inset-0 z-[9999] flex items-center justify-center p-4 ${overlay}`}
      role="dialog"
      aria-modal="true"
      aria-labelledby="validation-run-title"
    >
      <div className={`w-full max-w-lg rounded-xl border shadow-2xl ${panel}`}>
        <div className="flex items-start justify-between gap-3 p-4 border-b border-inherit">
          <div>
            <h2 id="validation-run-title" className="text-base font-semibold">
              {mode === 'agent' ? 'Agent validation cycle' : 'Validation cycle'}
            </h2>
            {isTerminal && progress?.status === 'completed' && autoCloseSec !== null && (
              <p className={`text-xs mt-0.5 ${isLightMode ? 'text-slate-500' : 'text-slate-400'}`}>
                Closing in {autoCloseSec}s…
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            className={`p-1 rounded ${isLightMode ? 'hover:bg-slate-100' : 'hover:bg-slate-800'}`}
            aria-label="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-4 max-h-[70vh] overflow-y-auto">
          <ValidationRunProgressContent
            runId={runId}
            mode={mode}
            progress={progress}
            pollError={pollError}
            isLightMode={isLightMode}
            localStartedMs={localStartedMs}
            awaitingProgress={awaitingProgress}
          />
        </div>

        <div className="p-4 border-t border-inherit flex justify-end gap-2">
          {isRunning && (
            <button
              type="button"
              onClick={onRunInBackground}
              className={`text-xs px-3 py-1.5 rounded border ${isLightMode ? 'border-slate-300' : 'border-slate-600'}`}
            >
              Run in background
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            className={
              isTerminal
                ? 'text-xs px-3 py-1.5 rounded bg-cyan-700 text-white hover:bg-cyan-600'
                : `text-xs px-3 py-1.5 rounded border ${isLightMode ? 'border-slate-300' : 'border-slate-600'}`
            }
          >
            {isTerminal ? 'Done' : 'Close'}
          </button>
        </div>
      </div>
    </div>
  );

  return createPortal(modal, document.body);
}
