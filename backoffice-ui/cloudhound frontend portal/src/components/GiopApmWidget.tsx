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

  return (
    <div
      className={`flex items-center gap-3 text-xs rounded-lg px-2 py-1 border ${
        isLightMode ? 'border-slate-200 bg-white' : 'border-premium-border/70 bg-premium-surface/90'
      }`}
      title="Sync-service APM"
    >
      <span className={`h-2 w-2 rounded-full ${STATUS_COLOR[metrics.status]}`} />
      <span className={isLightMode ? 'text-slate-600' : 'text-premium-text-secondary'}>
        p95 {metrics.latency_p95_ms.toFixed(0)}ms
      </span>
      <span className={isLightMode ? 'text-slate-500' : 'text-premium-muted'}>
        err {metrics.error_rate_pct.toFixed(1)}%
      </span>
    </div>
  );
}
