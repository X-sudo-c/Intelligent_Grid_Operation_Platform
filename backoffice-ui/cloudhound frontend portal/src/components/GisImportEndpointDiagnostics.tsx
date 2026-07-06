import type { GiopEndpointDiagnostics } from '../api/giop-api';
import { ENDPOINT_CLASS_HELP, ENDPOINT_CLASS_LABELS, reasonPct } from '../lib/gisImportShared';

interface GisImportEndpointDiagnosticsProps {
  diagnostics: GiopEndpointDiagnostics | null;
  loading?: boolean;
  isLightMode: boolean;
}

function ClassColumn({
  title,
  counts,
  total,
  isLightMode,
}: {
  title: string;
  counts: Record<string, number | undefined>;
  total: number;
  isLightMode: boolean;
}) {
  const muted = isLightMode ? 'text-slate-500' : 'text-premium-muted';
  const entries = Object.entries(counts)
    .filter(([, n]) => (n ?? 0) > 0)
    .sort(([, a], [, b]) => (b ?? 0) - (a ?? 0));

  if (entries.length === 0) {
    return (
      <div>
        <p className={`text-xs font-medium mb-1 ${isLightMode ? 'text-slate-700' : 'text-premium-text-secondary'}`}>
          {title}
        </p>
        <p className={`text-xs ${muted}`}>No data</p>
      </div>
    );
  }

  return (
    <div>
      <p className={`text-xs font-medium mb-1.5 ${isLightMode ? 'text-slate-700' : 'text-premium-text-secondary'}`}>
        {title}
      </p>
      <ul className={`space-y-1 text-xs ${muted}`}>
        {entries.map(([cls, count]) => (
          <li key={cls} title={ENDPOINT_CLASS_HELP[cls] ?? cls}>
            <span className={isLightMode ? 'text-slate-700' : 'text-premium-text-secondary'}>
              {ENDPOINT_CLASS_LABELS[cls] ?? cls}
            </span>
            {' · '}
            <span className="tabular-nums">{count?.toLocaleString()}</span>
            <span className="opacity-75"> ({reasonPct(count ?? 0, total)})</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function GisImportEndpointDiagnostics({
  diagnostics,
  loading,
  isLightMode,
}: GisImportEndpointDiagnosticsProps) {
  const shell = isLightMode ? 'bg-slate-50 border-slate-200' : 'bg-premium-surface/40 border-premium-border/50';
  const muted = isLightMode ? 'text-slate-500' : 'text-premium-muted';

  if (loading && !diagnostics) {
    return (
      <div className={`rounded-lg border px-3 py-2 text-xs ${shell} ${muted}`}>
        Analyzing endpoint IDs…
      </div>
    );
  }

  if (!diagnostics) return null;

  const total = diagnostics.unpromoted_segments ?? 0;
  const orig = diagnostics.originating ?? {};
  const end = diagnostics.end ?? {};

  return (
    <div className={`rounded-lg border px-3 py-2 text-xs space-y-2 ${shell}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className={`font-medium ${isLightMode ? 'text-slate-700' : 'text-premium-text-secondary'}`}>
          Endpoint ID diagnostics
        </p>
        {diagnostics.endpoint_alias_rows != null && diagnostics.endpoint_alias_rows > 0 && (
          <span className={`tabular-nums ${muted}`}>
            {diagnostics.endpoint_alias_rows.toLocaleString()} pole ID aliases registered
          </span>
        )}
      </div>
      <p className={muted}>
        Why unpromoted endpoint strings fail lookup — geometry can still draw on the map. Run{' '}
        <code className="text-[10px]">promote_topology.sh</code> to merge pole aliases (e.g.{' '}
        <code className="text-[10px]">P107/b23/6</code> → <code className="text-[10px]">P107/1/b23/6</code>).
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <ClassColumn title="Source (start) IDs" counts={orig} total={total} isLightMode={isLightMode} />
        <ClassColumn title="Target (end) IDs" counts={end} total={total} isLightMode={isLightMode} />
      </div>
    </div>
  );
}
