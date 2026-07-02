import { AnimatePresence, motion } from 'framer-motion';
import { ChevronDown, Database, Layers } from 'lucide-react';
import { useState } from 'react';
import { PremiumMetricCard } from './PremiumCard';
import { ease, fadeUpItem, staggerContainer } from '../lib/motion';
import type { GiopDqSummary, GiopTopologyDqSummary } from '../api/giop-api';

export type DqDataTier = 'master' | 'staging';

const TIER_META: Record<
  DqDataTier,
  {
    label: string;
    subtitle: string;
    accent: string;
    accentSoft: string;
    glow: string;
    nodeLabel: string;
  }
> = {
  master: {
    label: 'Master',
    subtitle: 'Approved national network',
    accent: '#8FA4B8',
    accentSoft: 'rgba(143, 164, 184, 0.12)',
    glow: 'rgba(143, 164, 184, 0.14)',
    nodeLabel: 'Approved nodes',
  },
  staging: {
    label: 'Staging',
    subtitle: 'Field captures awaiting release',
    accent: '#A39E98',
    accentSoft: 'rgba(163, 158, 152, 0.12)',
    glow: 'rgba(163, 158, 152, 0.12)',
    nodeLabel: 'Staging nodes',
  },
};

interface DqDataTierSwitchProps {
  tier: DqDataTier;
  onTierChange: (tier: DqDataTier) => void;
  isLightMode: boolean;
  disabled?: boolean;
}

export function DqDataTierSwitch({
  tier,
  onTierChange,
  isLightMode,
  disabled = false,
}: DqDataTierSwitchProps) {
  const options: Array<{ id: DqDataTier; icon: typeof Database }> = [
    { id: 'master', icon: Database },
    { id: 'staging', icon: Layers },
  ];

  return (
    <div
      className={`relative inline-flex p-1 rounded-xl border ${
        isLightMode
          ? 'bg-slate-100/90 border-slate-200 shadow-inner'
          : 'bg-premium-surface border-premium-border/50 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]'
      }`}
      role="tablist"
      aria-label="Data quality tier"
    >
      {options.map(({ id, icon: Icon }) => {
        const active = tier === id;
        const meta = TIER_META[id];
        return (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={active}
            disabled={disabled}
            onClick={() => onTierChange(id)}
            className={`relative z-10 flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors duration-300 disabled:opacity-50 ${
              active
                ? isLightMode
                  ? 'text-slate-900'
                  : 'text-white'
                : isLightMode
                  ? 'text-slate-500 hover:text-slate-700'
                  : 'text-premium-muted hover:text-premium-text-secondary'
            }`}
          >
            <Icon className="h-4 w-4" style={{ color: active ? meta.accent : undefined }} />
            {meta.label}
          </button>
        );
      })}
      <motion.div
        layoutId="dq-tier-pill"
        className="absolute top-1 bottom-1 rounded-lg"
        style={{
          width: 'calc(50% - 4px)',
          left: tier === 'master' ? 4 : 'calc(50%)',
          background: isLightMode
            ? `linear-gradient(135deg, ${TIER_META[tier].accentSoft}, white)`
            : `linear-gradient(135deg, ${TIER_META[tier].accentSoft}, rgba(22,22,22,0.98))`,
          boxShadow: isLightMode
            ? `0 4px 14px ${TIER_META[tier].glow}, inset 0 1px 0 rgba(255,255,255,0.8)`
            : `0 2px 12px ${TIER_META[tier].glow}, inset 0 1px 0 rgba(255,255,255,0.04)`,
          border: `1px solid ${isLightMode ? 'rgba(255,255,255,0.9)' : 'rgba(255,255,255,0.08)'}`,
        }}
        transition={{ type: 'spring', stiffness: 420, damping: 34 }}
      />
    </div>
  );
}

function AnimatedValue({ value }: { value: string | number }) {
  return (
    <motion.span
      key={String(value)}
      initial={{ opacity: 0, y: 8, filter: 'blur(4px)' }}
      animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
      exit={{ opacity: 0, y: -6, filter: 'blur(4px)' }}
      transition={{ duration: 0.35, ease: ease.smooth }}
      className="inline-block tabular-nums"
    >
      {value}
    </motion.span>
  );
}

function formatAgo(iso?: string | null): string {
  if (!iso) return 'live';
  const ts = new Date(iso).getTime();
  if (Number.isNaN(ts)) return 'unknown';
  const secs = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (secs < 60) return 'just now';
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

const SEVERITY_ORDER = ['critical', 'major', 'minor', 'warning'] as const;

function CompactStat({
  label,
  value,
  accent,
  isLightMode,
}: {
  label: string;
  value: string | number;
  accent?: string;
  isLightMode: boolean;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-lg border px-2 py-1 text-xs tabular-nums ${
        isLightMode
          ? 'border-slate-200 bg-slate-50 text-slate-700'
          : 'border-premium-border/70 bg-premium-card/90 text-slate-200'
      }`}
    >
      <span className={isLightMode ? 'text-slate-500' : 'text-premium-muted'}>{label}</span>
      <span className="font-semibold" style={accent ? { color: accent } : undefined}>
        {value}
      </span>
    </span>
  );
}

interface DqTierMetricsPanelProps {
  tier: DqDataTier;
  onTierChange: (tier: DqDataTier) => void;
  isLightMode: boolean;
  topoSummary: GiopTopologyDqSummary | null;
  summary: GiopDqSummary | null;
  topoLoading: boolean;
  topoRevalidating: boolean;
  topoLiveBusy: boolean;
  scanBusy: boolean;
  onRefreshLive: () => void;
  onRunTopologyScan: () => void;
}

export function DqTierMetricsPanel({
  tier,
  onTierChange,
  isLightMode,
  topoSummary,
  summary,
  topoLoading,
  topoRevalidating,
  topoLiveBusy,
  scanBusy,
  onRefreshLive,
  onRunTopologyScan,
}: DqTierMetricsPanelProps) {
  const [metricsExpanded, setMetricsExpanded] = useState(false);
  const meta = TIER_META[tier];
  const muted = isLightMode ? 'text-slate-500' : 'text-premium-muted';
  const card = isLightMode ? 'border-slate-200 bg-white' : 'border-premium-border/70 bg-premium-card';

  const statusLine = topoRevalidating
    ? 'Updating…'
    : topoSummary?.source === 'live'
      ? 'Live · just computed'
      : tier === 'staging'
        ? 'Live from staging tables'
        : `As of last scan · ${formatAgo(topoSummary?.scanned_at)}`;

  return (
    <motion.div
      layout
      className={`rounded-xl border overflow-hidden ${card}`}
      style={{
        boxShadow: isLightMode
          ? `0 0 0 1px rgba(0,0,0,0.02), 0 12px 40px -12px ${meta.glow}`
          : `0 0 0 1px rgba(255,255,255,0.04), 0 16px 48px -16px ${meta.glow}`,
      }}
    >
      <div
        className="h-1 w-full"
        style={{
          background: `linear-gradient(90deg, transparent, ${meta.accent}, transparent)`,
        }}
      />
      <div className="px-3 py-2.5 space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2 min-w-0">
            <DqDataTierSwitch
              tier={tier}
              onTierChange={onTierChange}
              isLightMode={isLightMode}
              disabled={topoLoading && !topoSummary}
            />
            <button
              type="button"
              onClick={() => setMetricsExpanded((v) => !v)}
              className={`inline-flex items-center gap-1 rounded-lg border px-2 py-1.5 text-xs font-medium transition-colors ${
                isLightMode
                  ? 'border-slate-200 text-slate-600 hover:bg-slate-50'
                  : 'border-slate-700 text-premium-text-secondary hover:bg-premium-hover/60'
              }`}
              aria-expanded={metricsExpanded}
            >
              Metrics
              <ChevronDown
                className={`h-3.5 w-3.5 transition-transform ${metricsExpanded ? 'rotate-180' : ''}`}
              />
            </button>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            <button
              type="button"
              disabled={topoLiveBusy || scanBusy}
              onClick={onRefreshLive}
              className={`rounded-lg border text-xs py-1 px-2 disabled:opacity-50 transition-colors ${
                isLightMode
                  ? 'border-slate-300 text-slate-700 hover:bg-slate-100'
                  : 'border-premium-border/50 text-premium-text-secondary hover:bg-premium-hover'
              }`}
            >
              {topoLiveBusy ? '…' : 'Refresh live'}
            </button>
            <AnimatePresence mode="wait">
              {tier === 'master' && (
                <motion.button
                  key="scan"
                  type="button"
                  disabled={scanBusy}
                  onClick={onRunTopologyScan}
                  initial={{ opacity: 0, scale: 0.96 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.96 }}
                  className={`rounded-lg text-xs py-1 px-2 disabled:opacity-50 giop-btn-primary ${
                    isLightMode ? 'giop-btn-primary--light' : 'giop-btn-primary--dark'
                  }`}
                >
                  {scanBusy ? '…' : 'Scan → queue'}
                </motion.button>
              )}
            </AnimatePresence>
          </div>
        </div>

        {!metricsExpanded && topoSummary && (
          <div className="flex flex-wrap gap-1.5">
            <CompactStat
              isLightMode={isLightMode}
              label={tier === 'staging' ? 'Nodes' : 'Approved'}
              value={topoSummary.live.approved_nodes.toLocaleString()}
              accent={meta.accent}
            />
            <CompactStat
              isLightMode={isLightMode}
              label="Orphans"
              value={topoSummary.live.orphan_nodes.toLocaleString()}
              accent="#A39E98"
            />
            <CompactStat
              isLightMode={isLightMode}
              label="Open"
              value={summary?.open_total ?? 0}
            />
            <CompactStat
              isLightMode={isLightMode}
              label="Major"
              value={summary?.open_by_severity?.major ?? 0}
              accent="#A39E98"
            />
          </div>
        )}

        <AnimatePresence initial={false}>
          {metricsExpanded && (
            <motion.div
              key="expanded-metrics"
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              transition={{ duration: 0.28, ease: ease.smooth }}
              className="overflow-hidden space-y-3"
            >
              <div>
                <h3 className="text-sm font-semibold">
                  {meta.label} topology DQ <span className={muted}>(Ghana bbox)</span>
                </h3>
                <p className={`text-xs ${muted}`}>
                  {meta.subtitle} · {statusLine}
                </p>
              </div>

        {topoLoading && !topoSummary ? (
          <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
            {Array.from({ length: 5 }).map((_, i) => (
              <div
                key={i}
                className={`h-12 rounded-lg animate-pulse ${isLightMode ? 'bg-slate-100' : 'bg-slate-800/60'}`}
              />
            ))}
          </div>
        ) : topoSummary ? (
          <AnimatePresence mode="wait">
            <motion.div
              key={tier}
              variants={staggerContainer}
              initial="hidden"
              animate="visible"
              exit="hidden"
              className="grid grid-cols-2 md:grid-cols-5 gap-2"
            >
              {[
                {
                  label: meta.nodeLabel,
                  value: topoSummary.live.approved_nodes.toLocaleString(),
                  color: 'info' as const,
                },
                {
                  label: 'Orphan nodes',
                  value: topoSummary.live.orphan_nodes.toLocaleString(),
                  color: 'warning' as const,
                },
                {
                  label: 'Orphan ratio',
                  value: `${(topoSummary.live.orphan_ratio * 100).toFixed(1)}%`,
                  color: 'default' as const,
                },
                {
                  label: 'Dangling lines',
                  value: topoSummary.live.dangling_lines.toLocaleString(),
                  color: 'danger' as const,
                },
                {
                  label: 'Open topo exceptions',
                  value: (topoSummary.exception_queue?.open_topology_total ?? 0).toLocaleString(),
                  color: 'default' as const,
                },
              ].map((item) => (
                <motion.div key={item.label} variants={fadeUpItem}>
                  <PremiumMetricCard
                    isLightMode={isLightMode}
                    label={item.label}
                    value={<AnimatedValue value={item.value} />}
                    color={item.color}
                  />
                </motion.div>
              ))}
            </motion.div>
          </AnimatePresence>
        ) : null}

        {topoSummary?.export_blocked?.blocked && (
          <p className={`text-xs ${isLightMode ? 'text-amber-700' : 'text-premium-warn-fg'}`}>
            {tier === 'master' ? 'Exports' : 'Bulk release'} in this bbox are blocked:{' '}
            {(topoSummary.export_blocked.reasons ?? []).join('; ')}
          </p>
        )}

        <div className="grid grid-cols-2 md:grid-cols-5 gap-2 pt-1 border-t border-dashed border-slate-200/80 dark:border-premium-border/70/80">
          <PremiumMetricCard
            isLightMode={isLightMode}
            label="Open total"
            value={<AnimatedValue value={summary?.open_total ?? '—'} />}
          />
          {SEVERITY_ORDER.map((sev) => (
            <PremiumMetricCard
              key={sev}
              isLightMode={isLightMode}
              label={sev}
              value={<AnimatedValue value={summary?.open_by_severity?.[sev] ?? 0} />}
              color={
                sev === 'critical'
                  ? 'danger'
                  : sev === 'major'
                    ? 'warning'
                    : sev === 'minor'
                      ? 'info'
                      : 'default'
              }
            />
          ))}
        </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </motion.div>
  );
}
