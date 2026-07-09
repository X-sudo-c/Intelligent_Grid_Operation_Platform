import { useEffect, useState } from 'react';
import { getHealthMetrics, type GiopHealthMetrics } from '../api/giop-api';

interface GiopApmWidgetProps {
  isLightMode: boolean;
}

const STATUS_COLOR = {
  green: 'bg-emerald-500',
  amber: 'bg-amber-500',
  red: 'bg-red-500',
} as const;

function formatMs(value: number | undefined): string {
  if (value === undefined || Number.isNaN(value)) return '—';
  if (value >= 1000) return `${(value / 1000).toFixed(1)}s`;
  return `${value.toFixed(0)}ms`;
}

function buildTooltip(metrics: GiopHealthMetrics): string {
  const lines = [
    `Interactive p95: ${formatMs(metrics.latency_p95_interactive_ms ?? metrics.latency_p95_ms)}`,
    `Map p95: ${formatMs(metrics.latency_p95_map_ms)}`,
    `Copilot p95: ${formatMs(metrics.latency_p95_copilot_ms)}`,
    `API p95: ${formatMs(metrics.latency_p95_api_ms)}`,
  ];
  const slow = metrics.slowest_routes?.[0];
  if (slow) {
    lines.push(`Slowest: ${slow.route} (${formatMs(slow.latency_p95_ms)})`);
  }
  return lines.join('\n');
}

export function GiopApmWidget({ isLightMode }: GiopApmWidgetProps) {
  const [metrics, setMetrics] = useState<GiopHealthMetrics | null>(null);

  useEffect(() => {
    const load = () => {
      void getHealthMetrics()
        .then(setMetrics)
        .catch(() => setMetrics(null));
    };
    load();
    const timer = window.setInterval(load, 15000);
    return () => window.clearInterval(timer);
  }, []);

  if (!metrics) return null;

  const interactiveP95 =
    metrics.latency_p95_interactive_ms ?? metrics.latency_p95_ms;
  const mapP95 = metrics.latency_p95_map_ms;
  const copilotP95 = metrics.latency_p95_copilot_ms;

  return (
    <div
      className={`flex items-center gap-2 text-xs rounded-lg px-2 py-1 border ${
        isLightMode ? 'border-slate-200 bg-white' : 'border-premium-border/70 bg-premium-surface/90'
      }`}
      title={buildTooltip(metrics)}
    >
      <span className={`h-2 w-2 rounded-full shrink-0 ${STATUS_COLOR[metrics.status]}`} />
      <span className={isLightMode ? 'text-slate-600' : 'text-premium-text-secondary'}>
        p95 {formatMs(interactiveP95)}
      </span>
      {mapP95 !== undefined && mapP95 > 0 ? (
        <span className={isLightMode ? 'text-slate-500' : 'text-premium-muted'}>
          map {formatMs(mapP95)}
        </span>
      ) : null}
      {copilotP95 !== undefined && copilotP95 > 0 ? (
        <span className={isLightMode ? 'text-slate-500' : 'text-premium-muted'}>
          ai {formatMs(copilotP95)}
        </span>
      ) : null}
      <span className={isLightMode ? 'text-slate-500' : 'text-premium-muted'}>
        err {metrics.error_rate_pct.toFixed(1)}%
      </span>
    </div>
  );
}
