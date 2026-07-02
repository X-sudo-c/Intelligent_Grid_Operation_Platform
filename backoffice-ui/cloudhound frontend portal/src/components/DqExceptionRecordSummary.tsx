import type { GiopDqException } from '../api/giop-api';
import { buildDqExceptionFields } from '../lib/giopDqExceptionPresent';

interface DqExceptionRecordSummaryProps {
  item: GiopDqException;
  isLightMode: boolean;
  compact?: boolean;
}

export function DqExceptionRecordSummary({
  item,
  isLightMode,
  compact = false,
}: DqExceptionRecordSummaryProps) {
  const fields = buildDqExceptionFields(item);
  const muted = isLightMode ? 'text-slate-500' : 'text-premium-muted';
  const panel = isLightMode
    ? 'bg-slate-50/90 border-slate-200'
    : 'bg-premium-surface/80 border-premium-border/40';
  const photoUrl = item.record_context?.photo_url;

  return (
    <div className={`mt-2 rounded-lg border ${panel} ${compact ? 'p-2' : 'p-3'}`}>
      {item.rule_description && (
        <p className={`text-xs mb-2 ${muted}`}>
          <span className={`font-medium ${isLightMode ? 'text-slate-600' : 'text-premium-text-secondary'}`}>Rule: </span>
          {item.rule_description}
          {item.blocks_promotion ? (
            <span className={`ml-2 ${isLightMode ? 'text-amber-600' : 'text-premium-warn-fg'}`}>
              · blocks promotion
            </span>
          ) : null}
        </p>
      )}

      <p className={`text-sm font-medium ${isLightMode ? 'text-slate-800' : 'text-premium-text'}`}>
        {item.error_message}
      </p>

      {fields.length > 0 && (
        <dl
          className={`mt-2 grid gap-x-3 gap-y-1.5 ${
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
                    className={`hover:underline ${isLightMode ? 'text-cyan-600' : 'text-premium-accent'}`}
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
