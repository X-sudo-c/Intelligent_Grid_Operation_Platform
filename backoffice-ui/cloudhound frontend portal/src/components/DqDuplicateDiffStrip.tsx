import type { DuplicateDiffField } from '../lib/giopDqDuplicateDiff';

interface DqDuplicateDiffStripProps {
  fields: DuplicateDiffField[];
  isLightMode: boolean;
  peerCount: number;
}

export function DqDuplicateDiffStrip({
  fields,
  isLightMode,
  peerCount,
}: DqDuplicateDiffStripProps) {
  const muted = isLightMode ? 'text-slate-500' : 'text-premium-muted';
  const panel = isLightMode
    ? 'border-amber-200 bg-white/90'
    : 'border-premium-border/40 bg-premium-card/70';
  const differing = fields.filter((f) => f.differs);

  if (fields.length === 0) {
    return (
      <p className={`text-xs ${muted}`}>
        Load all {peerCount} records on this page to compare capture fields.
      </p>
    );
  }

  return (
    <div className={`rounded-lg border px-2.5 py-2 space-y-2 ${panel}`}>
      <div className="flex flex-wrap items-center gap-2">
        <p className={`text-xs font-medium ${isLightMode ? 'text-amber-900' : 'text-premium-warn-fg'}`}>
          Field diff
        </p>
        {differing.length === 0 ? (
          <span className={`text-xs ${muted}`}>All loaded captures match on compared fields</span>
        ) : (
          <span className={`text-xs ${isLightMode ? 'text-amber-700' : 'text-premium-warn-fg-muted'}`}>
            {differing.length} field{differing.length === 1 ? '' : 's'} differ across this stack
          </span>
        )}
      </div>
      <ul className="space-y-1">
        {fields.map((field) => (
          <li
            key={field.key}
            className={`text-xs rounded px-2 py-1 ${
              field.differs
                ? isLightMode
                  ? 'bg-amber-50 text-amber-950 ring-1 ring-amber-200'
                  : 'bg-premium-warn-bg/70 text-premium-text border border-premium-warn-border/30'
                : muted
            }`}
          >
            <span className="font-medium">{field.label}: </span>
            <span className={field.differs ? 'font-semibold' : ''}>{field.activeValue}</span>
            {field.differs ? (
              <span className={`ml-1.5 ${muted}`}>
                (others: {[...new Set(field.otherValues)].join(' · ')})
              </span>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
