import type { GiopDqQueueItem } from '../api/giop-api';
import {
  formatDqCoordinates,
  queueItemDuplicateDetected,
} from '../lib/giopDqLocationClusters';

interface DqQueueRecordSummaryProps {
  item: GiopDqQueueItem;
  isLightMode: boolean;
  compact?: boolean;
}

function humanizeKind(kind?: string | null): string | null {
  if (!kind) return null;
  return kind.replaceAll('_', ' ');
}

export function DqQueueRecordSummary({
  item,
  isLightMode,
  compact = false,
}: DqQueueRecordSummaryProps) {
  const ctx = item.record_context ?? {};
  const muted = isLightMode ? 'text-slate-500' : 'text-premium-muted';
  const panel = isLightMode
    ? 'bg-slate-50/90 border-slate-200'
    : 'bg-premium-surface/80 border-premium-border/40';
  const photoUrl = item.photo_url ?? ctx.photo_url;
  const coords = formatDqCoordinates(item.longitude ?? null, item.latitude ?? null);
  const duplicateDetected = queueItemDuplicateDetected(item);
  const duplicateCount = item.colocated_staging_count ?? 0;

  const fields: Array<{ label: string; value: string; mono?: boolean; href?: string }> = [];
  const push = (label: string, value: unknown, opts?: { mono?: boolean; href?: string }) => {
    if (value === null || value === undefined || value === '') return;
    fields.push({
      label,
      value: String(value),
      mono: opts?.mono,
      href: opts?.href,
    });
  };

  push('MRID', item.mrid, { mono: true });
  push('Validation', item.validation);
  push('Lifecycle', item.lifecycle_state ?? ctx.lifecycle_state);
  push('Asset kind', humanizeKind(item.asset_kind ?? ctx.asset_kind));
  push('Submitted by', item.submitted_by ?? ctx.submitted_by, { mono: true });
  push('Work order', item.work_order_id ?? ctx.work_order_id, { mono: true });
  push('Operating utility', item.operating_utility ?? ctx.operating_utility);
  push('Substation', item.substation_name ?? ctx.substation_name);
  push('Boundary feeder', item.boundary_feeder_id ?? ctx.boundary_feeder_id, { mono: true });
  if (coords) push('Coordinates', coords, { mono: true });
  if (item.updated_at) {
    const ts = new Date(item.updated_at);
    push('Captured', Number.isNaN(ts.getTime()) ? item.updated_at : ts.toLocaleString());
  }

  return (
    <div className={`mt-2 rounded-lg border ${panel} ${compact ? 'p-2' : 'p-3'}`}>
      {duplicateDetected ? (
        <p className={`text-xs mb-2 ${muted}`}>
          <span className={`font-medium ${isLightMode ? 'text-amber-600' : 'text-premium-warn-fg'}`}>
            {duplicateCount > 1
              ? `${duplicateCount} captures share this map pin — review for duplicates`
              : 'Possible near-duplicate detected by validation'}
          </span>
        </p>
      ) : item.open_exception_count > 0 ? (
        <p className={`text-xs mb-2 ${muted}`}>
          <span className={`font-medium ${isLightMode ? 'text-amber-600' : 'text-premium-warn-fg'}`}>
            {item.open_exception_count} open issue{item.open_exception_count === 1 ? '' : 's'}
          </span>
          {item.blocking_open_count > 0 ? (
            <span className="ml-2 text-red-600 dark:text-red-400">
              · {item.blocking_open_count} blocking release
            </span>
          ) : null}
        </p>
      ) : (
        <p className={`text-xs mb-2 text-emerald-600 dark:text-emerald-400 font-medium`}>
          No open data-quality issues — ready for steward review
        </p>
      )}

      {fields.length > 0 && (
        <dl
          className={`grid gap-x-3 gap-y-1.5 ${
            compact ? 'grid-cols-1 sm:grid-cols-2' : 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-3'
          }`}
        >
          {fields.map((field) => (
            <div key={`${field.label}-${field.value}`} className="min-w-0">
              <dt className={`text-[10px] uppercase tracking-wide font-medium ${muted}`}>
                {field.label}
              </dt>
              <dd
                className={`text-xs truncate ${
                  field.mono ? 'font-mono' : ''
                } ${isLightMode ? 'text-slate-800' : 'text-premium-text-secondary'}`}
                title={field.value}
              >
                {field.href ? (
                  <a
                    href={field.href}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-premium-accent hover:underline"
                    onClick={(e) => e.stopPropagation()}
                  >
                    {field.value}
                  </a>
                ) : (
                  field.value
                )}
              </dd>
            </div>
          ))}
        </dl>
      )}

      {photoUrl && (
        <a
          href={photoUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-block mt-2"
          onClick={(e) => e.stopPropagation()}
        >
          <img
            src={photoUrl}
            alt="Field capture"
            className="h-20 w-auto max-w-full rounded-md border border-slate-200 dark:border-premium-border/70 object-cover"
            loading="lazy"
          />
        </a>
      )}
    </div>
  );
}
