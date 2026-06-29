import { useCallback, useEffect, useRef } from 'react';
import type { LogFileInfo, LogTail } from './api';

export interface LogPanelState {
  open: boolean;
  minimized: boolean;
  x: number;
  y: number;
}

interface LogPanelProps {
  state: LogPanelState;
  onStateChange: (patch: Partial<LogPanelState>) => void;
  selectedLog: string | null;
  logTail: LogTail | null;
  logLoading: boolean;
  logFiles: LogFileInfo[];
  onSelectLog: (name: string | null) => void;
  activityLines: string[];
  statusLine: string | null;
  busy: boolean;
}

function Spinner() {
  return (
    <span
      className="inline-block h-3.5 w-3.5 rounded-full border-2 border-slate-500 border-t-cyan-400 animate-spin"
      aria-hidden
    />
  );
}

export function LogPanel({
  state,
  onStateChange,
  selectedLog,
  logTail,
  logLoading,
  logFiles,
  onSelectLog,
  activityLines,
  statusLine,
  busy,
}: LogPanelProps) {
  const preRef = useRef<HTMLPreElement>(null);
  const dragRef = useRef<{ px: number; py: number; ox: number; oy: number } | null>(null);

  const scrollToBottom = useCallback(() => {
    const el = preRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);

  useEffect(() => {
    if (state.open && !state.minimized) scrollToBottom();
  }, [logTail?.lines, activityLines, state.open, state.minimized, scrollToBottom]);

  const onHeaderPointerDown = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest('button, select')) return;
    dragRef.current = { px: e.clientX, py: e.clientY, ox: state.x, oy: state.y };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };

  const onHeaderPointerMove = (e: React.PointerEvent) => {
    if (!dragRef.current) return;
    const dx = e.clientX - dragRef.current.px;
    const dy = e.clientY - dragRef.current.py;
    onStateChange({
      x: Math.max(8, dragRef.current.ox + dx),
      y: Math.max(8, dragRef.current.oy + dy),
    });
  };

  const onHeaderPointerUp = () => {
    dragRef.current = null;
  };

  if (!state.open) return null;

  if (state.minimized) {
    return (
      <div
        className="fixed z-50 flex items-center gap-2 rounded-lg border border-slate-700 bg-slate-900/95 px-3 py-2 shadow-xl backdrop-blur"
        style={{ left: state.x, bottom: 16 }}
      >
        {busy && <Spinner />}
        <span className="text-xs text-slate-300 max-w-[200px] truncate">
          {statusLine || selectedLog || 'Logs'}
        </span>
        <PanelBtn label="Expand" onClick={() => onStateChange({ minimized: false })} />
        <PanelBtn label="×" onClick={() => onStateChange({ open: false })} />
      </div>
    );
  }

  const logText = logTail?.lines.join('\n') ?? '';
  const activityText = activityLines.join('\n');
  const combined =
    activityText && logText
      ? `${activityText}\n\n--- ${selectedLog ?? 'log'} ---\n${logText}`
      : activityText || logText || '(no output yet)';

  return (
    <div
      className="fixed z-50 flex w-[min(640px,calc(100vw-24px))] flex-col rounded-xl border border-slate-700 bg-slate-900/95 shadow-2xl backdrop-blur"
      style={{ left: state.x, top: state.y, maxHeight: 'min(70vh, 520px)' }}
      role="dialog"
      aria-label="Log viewer"
    >
      <div
        className="flex cursor-grab active:cursor-grabbing items-center gap-2 border-b border-slate-800 px-3 py-2 select-none"
        onPointerDown={onHeaderPointerDown}
        onPointerMove={onHeaderPointerMove}
        onPointerUp={onHeaderPointerUp}
      >
        <span className="text-slate-600">⠿</span>
        <span className="text-xs font-semibold uppercase tracking-wider text-slate-400">Logs</span>
        {busy && <Spinner />}
        {statusLine && (
          <span className="ml-1 flex-1 truncate text-xs text-cyan-400/90">{statusLine}</span>
        )}
        <select
          value={selectedLog ?? ''}
          onChange={(e) => onSelectLog(e.target.value || null)}
          className="ml-auto max-w-[180px] truncate rounded border border-slate-700 bg-slate-800 px-2 py-1 text-xs text-slate-300"
        >
          <option value="">Activity only</option>
          {logFiles.map((f) => (
            <option key={f.name} value={f.name}>
              {f.name}
            </option>
          ))}
        </select>
        <PanelBtn label="−" title="Minimize" onClick={() => onStateChange({ minimized: true })} />
        <PanelBtn label="×" title="Close" onClick={() => onStateChange({ open: false })} />
      </div>

      {logTail && (
        <p className="border-b border-slate-800/80 px-3 py-1 text-[10px] text-slate-600">
          {logTail.path} · last {logTail.lines.length} of {logTail.total_lines} lines
          {logLoading ? ' · refreshing…' : ''}
        </p>
      )}

      <pre
        ref={preRef}
        className="flex-1 overflow-auto p-3 font-mono text-[11px] leading-relaxed text-slate-300"
      >
        {combined}
      </pre>
    </div>
  );
}

export function LogFab({
  onClick,
  busy,
}: {
  onClick: () => void;
  busy: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="fixed bottom-5 right-5 z-40 flex items-center gap-2 rounded-full border border-slate-600 bg-slate-800/95 px-4 py-2.5 text-sm text-slate-200 shadow-lg backdrop-blur hover:bg-slate-700"
    >
      {busy && <Spinner />}
      Logs
    </button>
  );
}

function PanelBtn({
  label,
  title,
  onClick,
}: {
  label: string;
  title?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className="rounded px-1.5 py-0.5 text-xs text-slate-400 hover:bg-slate-800 hover:text-slate-200"
    >
      {label}
    </button>
  );
}

export function ActionButton({
  label,
  loadingLabel,
  loading,
  disabled,
  color,
  onClick,
  className = '',
}: {
  label: string;
  loadingLabel?: string;
  loading?: boolean;
  disabled?: boolean;
  color: 'emerald' | 'amber' | 'slate' | 'violet' | 'cyan' | 'red';
  onClick: () => void;
  className?: string;
}) {
  const colors: Record<string, string> = {
    emerald: 'bg-emerald-900 hover:bg-emerald-800',
    amber: 'bg-amber-900 hover:bg-amber-800',
    slate: 'bg-slate-700 hover:bg-slate-600',
    violet: 'bg-violet-900 hover:bg-violet-800',
    cyan: 'bg-cyan-900 hover:bg-cyan-800',
    red: 'bg-red-900 hover:bg-red-800',
  };
  const isDisabled = Boolean(disabled) || Boolean(loading);
  return (
    <button
      type="button"
      disabled={isDisabled}
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 rounded text-white disabled:cursor-not-allowed disabled:opacity-50 ${colors[color]} ${className}`}
    >
      {loading && <Spinner />}
      {loading ? (loadingLabel ?? `${label}…`) : label}
    </button>
  );
}

export function StatusToast({ message, busy }: { message: string; busy: boolean }) {
  if (!message && !busy) return null;
  const showWorking = busy && !message;
  return (
    <div
      className={`flex items-center gap-2 rounded-lg border px-4 py-2 text-sm ${
        busy && message
          ? 'border-cyan-800/60 bg-cyan-950/40 text-cyan-200'
          : 'border-slate-800 bg-slate-900/60 text-slate-400'
      }`}
    >
      {busy && message && <Spinner />}
      <span>{message || (showWorking ? 'Working…' : '')}</span>
    </div>
  );
}
