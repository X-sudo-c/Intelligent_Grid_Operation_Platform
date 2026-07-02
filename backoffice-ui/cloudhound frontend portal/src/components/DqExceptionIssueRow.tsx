import type { GiopDqException } from '../api/giop-api';
import { buildDqIssueDetailFields } from '../lib/giopDqExceptionPresent';

interface DqExceptionIssueRowProps {
  item: GiopDqException;
  isLightMode: boolean;
  busy?: boolean;
  onSuggestFix?: () => void;
  onResolve?: (action: 'RESOLVED' | 'DEFERRED' | 'QUARANTINED' | 'REJECTED') => void;
}

function severityClass(severity: string, isLightMode: boolean): string {
  if (isLightMode) {
    switch (severity) {
      case 'critical':
        return 'bg-red-100 text-red-800';
      case 'major':
        return 'bg-amber-100 text-amber-900';
      case 'minor':
        return 'bg-blue-100 text-blue-900';
      default:
        return 'bg-slate-100 text-slate-700';
    }
  }
  switch (severity) {
    case 'critical':
      return 'bg-premium-danger-bg text-premium-danger-fg border border-premium-danger-border/40';
    case 'major':
      return 'bg-premium-warn-bg text-premium-warn-fg border border-premium-warn-border/40';
    case 'minor':
      return 'bg-premium-accent-subtle text-premium-accent border border-premium-accent/25';
    default:
      return 'bg-premium-hover text-premium-muted border border-premium-border/40';
  }
}

const actionBtn = (isLightMode: boolean) =>
  isLightMode
    ? 'px-1.5 py-0.5 rounded border border-slate-200 bg-white text-slate-700 hover:bg-slate-50 disabled:opacity-50'
    : 'px-1.5 py-0.5 rounded border border-premium-border/50 bg-premium-card text-premium-text-secondary hover:bg-premium-hover disabled:opacity-50';

export function DqExceptionIssueRow({
  item,
  isLightMode,
  busy = false,
  onSuggestFix,
  onResolve,
}: DqExceptionIssueRowProps) {
  const muted = isLightMode ? 'text-slate-500' : 'text-premium-muted';
  const panel = isLightMode
    ? 'border-slate-200/90 bg-white/80'
    : 'border-premium-border/40 bg-premium-surface/80';
  const detailFields = buildDqIssueDetailFields(item);
  const isOpen = item.status === 'OPEN';
  const btn = actionBtn(isLightMode);

  return (
    <li
      className={`rounded-md border px-2.5 py-2 text-xs ${panel}`}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className={`px-1.5 py-0.5 rounded ${severityClass(item.severity, isLightMode)}`}>
              {item.severity}
            </span>
            <span className="font-mono">{item.rule_code}</span>
            {item.blocks_promotion ? (
              <span className={isLightMode ? 'text-amber-600' : 'text-premium-warn-fg'}>
                blocks release
              </span>
            ) : null}
            {!isOpen ? <span className={muted}>· {item.status}</span> : null}
          </div>
          <p className={`${isLightMode ? 'text-slate-800' : 'text-premium-text'}`}>
            {item.error_message}
          </p>
          {item.rule_description ? (
            <p className={muted}>{item.rule_description}</p>
          ) : null}
          {detailFields.length > 0 && (
            <p className={`${muted} font-mono truncate`} title={detailFields.map((f) => `${f.label}: ${f.value}`).join(' · ')}>
              {detailFields.map((f) => `${f.label}: ${f.value}`).join(' · ')}
            </p>
          )}
        </div>
        {isOpen && (onSuggestFix || onResolve) ? (
          <div className="flex flex-wrap gap-1 shrink-0 max-w-[11rem] justify-end">
            {onSuggestFix ? (
              <button type="button" disabled={busy} className={btn} onClick={onSuggestFix}>
                Suggest
              </button>
            ) : null}
            {onResolve ? (
              <>
                <button
                  type="button"
                  disabled={busy}
                  className={btn}
                  onClick={() => onResolve('RESOLVED')}
                >
                  Resolve
                </button>
                <button
                  type="button"
                  disabled={busy}
                  className={btn}
                  onClick={() => onResolve('DEFERRED')}
                >
                  Defer
                </button>
              </>
            ) : null}
          </div>
        ) : null}
      </div>
    </li>
  );
}
