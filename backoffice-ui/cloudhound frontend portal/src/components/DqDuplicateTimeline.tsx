import type { DuplicateTimelineEntry } from '../lib/giopDqDuplicateDiff';

interface DqDuplicateTimelineProps {
  entries: DuplicateTimelineEntry[];
  isLightMode: boolean;
  onSelect: (mrid: string) => void;
}

function formatWhen(updatedAt: string | null): string {
  if (!updatedAt) return 'Unknown time';
  const ts = new Date(updatedAt);
  return Number.isNaN(ts.getTime()) ? updatedAt : ts.toLocaleString();
}

export function DqDuplicateTimeline({
  entries,
  isLightMode,
  onSelect,
}: DqDuplicateTimelineProps) {
  if (entries.length < 2) return null;
  const muted = isLightMode ? 'text-slate-500' : 'text-premium-muted';
  const rail = isLightMode ? 'border-slate-200 bg-slate-50/80' : 'border-premium-border/40 bg-premium-card/70';

  return (
    <div className={`rounded-lg border px-2.5 py-2 ${rail}`}>
      <p className={`text-xs font-medium mb-2 ${muted}`}>Capture timeline (oldest → newest)</p>
      <ol className="relative pl-3 space-y-2 before:absolute before:left-[0.4rem] before:top-1 before:bottom-1 before:w-px before:bg-slate-300 dark:before:bg-premium-border/60">
        {entries.map((entry) => (
          <li key={entry.mrid} className="relative pl-3">
            <span
              className={`absolute left-0 top-1.5 h-2 w-2 rounded-full ring-2 ${
                entry.isActive
                  ? 'bg-premium-accent ring-premium-accent/20 dark:ring-premium-accent/25'
                  : entry.hasOpenIssues
                    ? 'bg-premium-warn-fg ring-premium-warn-border/40 dark:ring-premium-warn-border/50'
                    : 'bg-premium-muted-dim ring-premium-border/40 dark:ring-premium-border/50'
              }`}
            />
            <button
              type="button"
              onClick={() => onSelect(entry.mrid)}
              className={`text-left w-full text-xs rounded px-2 py-1 transition-colors ${
                entry.isActive
                  ? isLightMode
                    ? 'bg-cyan-50 text-cyan-950 ring-1 ring-cyan-300'
                    : 'bg-premium-accent/[0.08] text-premium-text ring-1 ring-premium-accent/15'
                  : isLightMode
                    ? 'hover:bg-white text-slate-700'
                    : 'hover:bg-premium-hover/50 text-premium-text-secondary'
              }`}
            >
              <span className="font-medium">{entry.name || entry.mrid.slice(0, 8)}</span>
              <span className={`block ${muted}`}>{formatWhen(entry.updatedAt)}</span>
              {entry.validation ? (
                <span className={`block ${muted}`}>{entry.validation}</span>
              ) : null}
            </button>
          </li>
        ))}
      </ol>
    </div>
  );
}
