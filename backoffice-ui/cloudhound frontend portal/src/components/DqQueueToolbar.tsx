import { ChevronLeft, ChevronRight, Filter, RefreshCw } from 'lucide-react';

const SEVERITY_OPTIONS = ['critical', 'major', 'minor', 'warning'] as const;
const STATUS_OPTIONS = ['ALL', 'OPEN', 'CLEAR', 'DEFERRED', 'QUARANTINED', 'RESOLVED', 'REJECTED'] as const;
const DOMAIN_OPTIONS = ['', 'topology', 'spatial', 'asset', 'voltage'] as const;
const PAGE_SIZES = [25, 50, 100, 200] as const;

interface DqQueueToolbarProps {
  isLightMode: boolean;
  statusFilter: string;
  duplicatesOnly: boolean;
  severityFilter: string;
  domainFilter: string;
  onStatusFilterChange: (value: string) => void;
  onDuplicatesOnlyChange: (value: boolean) => void;
  onSeverityFilterChange: (value: string) => void;
  onDomainFilterChange: (value: string) => void;
  onRefresh: () => void;
  loading?: boolean;
  statusMessage?: string;
  page: number;
  pageSize: number;
  total: number;
  onPageChange: (page: number) => void;
  onPageSizeChange: (size: number) => void;
}

export function DqQueueToolbar({
  isLightMode,
  statusFilter,
  duplicatesOnly,
  severityFilter,
  domainFilter,
  onStatusFilterChange,
  onDuplicatesOnlyChange,
  onSeverityFilterChange,
  onDomainFilterChange,
  onRefresh,
  loading = false,
  statusMessage,
  page,
  pageSize,
  total,
  onPageChange,
  onPageSizeChange,
}: DqQueueToolbarProps) {
  const muted = isLightMode ? 'text-slate-500' : 'text-premium-muted';
  const inputClass = isLightMode
    ? 'bg-white border-slate-200 text-slate-900'
    : 'bg-premium-surface border-premium-border/70 text-premium-text';
  const bar = isLightMode
    ? 'border-slate-200/90 bg-white/95 backdrop-blur-sm'
    : 'border-premium-border/45 bg-premium-sidebar/95 backdrop-blur-sm';

  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const from = total === 0 ? 0 : page * pageSize + 1;
  const to = Math.min(total, (page + 1) * pageSize);

  return (
    <div
      className={`shrink-0 rounded-xl border px-3 py-2.5 space-y-2 shadow-sm ${bar}`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <div className={`flex items-center gap-1.5 text-xs font-medium ${muted}`}>
          <Filter className="h-3.5 w-3.5" />
          Queue filters
        </div>
        <select
          aria-label="Status filter"
          value={statusFilter}
          onChange={(e) => onStatusFilterChange(e.target.value)}
          className={`rounded-lg border px-2 py-1.5 text-xs ${inputClass}`}
        >
          {STATUS_OPTIONS.map((s) => (
            <option key={s} value={s}>
              {s === 'ALL'
                ? 'All captures'
                : s === 'OPEN'
                  ? 'Has open issues'
                  : s === 'CLEAR'
                    ? 'No open issues'
                    : s}
            </option>
          ))}
        </select>
        <label
          className={`inline-flex items-center gap-1.5 rounded-lg border px-2 py-1.5 text-xs cursor-pointer ${
            duplicatesOnly
              ? isLightMode
                ? 'border-amber-400 bg-amber-50 text-amber-950'
                : 'giop-chip-warn--dark'
              : inputClass
          }`}
        >
          <input
            type="checkbox"
            className="rounded border-slate-300"
            checked={duplicatesOnly}
            onChange={(e) => onDuplicatesOnlyChange(e.target.checked)}
          />
          Duplicates only
        </label>
        <select
          aria-label="Severity filter"
          value={severityFilter}
          onChange={(e) => onSeverityFilterChange(e.target.value)}
          className={`rounded-lg border px-2 py-1.5 text-xs ${inputClass}`}
        >
          <option value="">All severities</option>
          {SEVERITY_OPTIONS.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <select
          aria-label="Domain filter"
          value={domainFilter}
          onChange={(e) => onDomainFilterChange(e.target.value)}
          className={`rounded-lg border px-2 py-1.5 text-xs ${inputClass}`}
        >
          <option value="">All domains</option>
          {DOMAIN_OPTIONS.filter(Boolean).map((d) => (
            <option key={d} value={d}>
              {d}
            </option>
          ))}
        </select>
        <button
          type="button"
          disabled={loading}
          onClick={onRefresh}
          className={`inline-flex items-center gap-1.5 rounded-lg text-xs font-medium py-1.5 px-2.5 disabled:opacity-50 giop-btn-primary ${
            isLightMode ? 'giop-btn-primary--light' : 'giop-btn-primary--dark'
          }`}
        >
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
          Refresh
        </button>
        {statusMessage ? (
          <span className={`text-xs truncate max-w-[12rem] ${muted}`} title={statusMessage}>
            {statusMessage}
          </span>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
        <p className={muted}>
          {total === 0 ? (
            'No staging captures in queue'
          ) : (
            <>
              Showing <span className="font-semibold text-slate-700 dark:text-premium-text-secondary">{from}–{to}</span>{' '}
              of <span className="font-semibold text-slate-700 dark:text-premium-text-secondary">{total.toLocaleString()}</span>
            </>
          )}
        </p>
        <div className="flex items-center gap-2">
          <label className={`flex items-center gap-1.5 ${muted}`}>
            Per page
            <select
              value={pageSize}
              onChange={(e) => onPageSizeChange(Number(e.target.value))}
              className={`rounded-lg border px-1.5 py-1 text-xs ${inputClass}`}
            >
              {PAGE_SIZES.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
          <div className="flex items-center gap-0.5">
            <button
              type="button"
              disabled={page <= 0 || loading}
              onClick={() => onPageChange(page - 1)}
              className={`p-1 rounded-lg border disabled:opacity-40 ${inputClass}`}
              aria-label="Previous page"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <span className={`min-w-[4.5rem] text-center tabular-nums ${muted}`}>
              {page + 1} / {pageCount}
            </span>
            <button
              type="button"
              disabled={page >= pageCount - 1 || loading || total === 0}
              onClick={() => onPageChange(page + 1)}
              className={`p-1 rounded-lg border disabled:opacity-40 ${inputClass}`}
              aria-label="Next page"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
