import { useCallback, useEffect, useState } from 'react';
import {
  generateRegulatoryReport,
  getRegulatoryMetrics,
  type GiopRegulatoryMetrics,
} from '../api/giop-api';

interface GiopReportsTabProps {
  isLightMode: boolean;
}

function defaultPeriod() {
  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - 30);
  return {
    start: start.toISOString().slice(0, 10),
    end: end.toISOString().slice(0, 10),
  };
}

export function GiopReportsTab({ isLightMode }: GiopReportsTabProps) {
  const defaults = defaultPeriod();
  const [periodStart, setPeriodStart] = useState(defaults.start);
  const [periodEnd, setPeriodEnd] = useState(defaults.end);
  const [metrics, setMetrics] = useState<GiopRegulatoryMetrics | null>(null);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState('');

  const loadMetrics = useCallback(async () => {
    setLoading(true);
    try {
      setMetrics(
        await getRegulatoryMetrics(
          `${periodStart}T00:00:00Z`,
          `${periodEnd}T23:59:59Z`,
        ),
      );
    } catch (err) {
      setMetrics(null);
      setStatus(err instanceof Error ? err.message : 'Metrics failed');
    } finally {
      setLoading(false);
    }
  }, [periodStart, periodEnd]);

  useEffect(() => {
    void loadMetrics();
  }, [loadMetrics]);

  const card = isLightMode ? 'border-slate-200 bg-white' : 'border-premium-border/70 bg-premium-card';

  const downloadBlob = (content: string, mime: string, ext: string) => {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `regulatory-metrics-${periodStart}-${periodEnd}.${ext}`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const downloadJson = () => {
    if (!metrics) return;
    downloadBlob(JSON.stringify(metrics, null, 2), 'application/json', 'json');
  };

  const downloadCsv = () => {
    if (!metrics) return;
    const escape = (value: string) => `"${value.replace(/"/g, '""')}"`;
    const rows: Array<[string, string]> = [
      ['period_start', `${periodStart}T00:00:00Z`],
      ['period_end', `${periodEnd}T23:59:59Z`],
      ['outage_count', String(metrics.outage_count)],
      ['saidi_minutes', String(metrics.saidi_minutes)],
      ['saifi_interruptions_per_customer', String(metrics.saifi_interruptions_per_customer)],
      ['caidi_minutes', String(metrics.caidi_minutes)],
      ['customer_minutes_interrupted', String(metrics.customer_minutes_interrupted)],
      ['customers_affected_total', String(metrics.customers_affected_total)],
    ];
    if (metrics.methodology_note) rows.push(['methodology_note', metrics.methodology_note]);
    const csv = ['metric,value', ...rows.map(([k, v]) => `${escape(k)},${escape(v)}`)].join('\r\n');
    downloadBlob(csv, 'text/csv;charset=utf-8', 'csv');
  };

  return (
    <div className="h-full overflow-auto p-6">
      <h3 className={`text-sm font-semibold mb-4 ${isLightMode ? 'text-slate-800' : 'text-premium-text-secondary'}`}>
        Regulatory Reporting
      </h3>
      <div className={`rounded-lg border p-4 mb-6 ${card}`}>
        <div className="flex flex-wrap gap-2 mb-2">
          <input
            type="date"
            value={periodStart}
            onChange={(e) => setPeriodStart(e.target.value)}
            className="text-sm rounded border px-2 py-1 bg-transparent"
          />
          <span className="text-slate-500 self-center">to</span>
          <input
            type="date"
            value={periodEnd}
            onChange={(e) => setPeriodEnd(e.target.value)}
            className="text-sm rounded border px-2 py-1 bg-transparent"
          />
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => void loadMetrics()}
            className="text-xs px-3 py-1.5 bg-cyan-700 rounded text-white"
          >
            Refresh metrics
          </button>
          <button
            type="button"
            onClick={async () => {
              try {
                const report = await generateRegulatoryReport({
                  periodStart: `${periodStart}T00:00:00Z`,
                  periodEnd: `${periodEnd}T23:59:59Z`,
                });
                setMetrics(report.metrics);
                setStatus(`Report ${report.id} saved`);
              } catch (err) {
                setStatus(err instanceof Error ? err.message : 'Generate failed');
              }
            }}
            className="text-xs px-3 py-1.5 bg-slate-700 rounded text-white"
          >
            Generate snapshot
          </button>
          <button
            type="button"
            onClick={downloadCsv}
            disabled={!metrics}
            className="text-xs px-3 py-1.5 bg-emerald-700 rounded text-white disabled:opacity-40"
          >
            Download CSV
          </button>
          <button
            type="button"
            onClick={downloadJson}
            disabled={!metrics}
            className="text-xs px-3 py-1.5 bg-emerald-800 rounded text-white disabled:opacity-40"
          >
            Download JSON
          </button>
        </div>
      </div>
      {status && <p className="text-xs text-slate-500 mb-2">{status}</p>}
      {loading && <p className="text-sm text-slate-500">Loading…</p>}
      {metrics && (
        <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
          {[
            ['Outages', metrics.outage_count],
            ['SAIDI (min)', metrics.saidi_minutes],
            ['SAIFI', metrics.saifi_interruptions_per_customer],
            ['CAIDI (min)', metrics.caidi_minutes],
            ['CMI', metrics.customer_minutes_interrupted],
            ['Customers affected', metrics.customers_affected_total],
          ].map(([label, value]) => (
            <div key={label} className={`rounded-lg border p-3 ${card}`}>
              <p className="text-xs text-slate-500">{label}</p>
              <p className="text-lg font-semibold mt-1">{value}</p>
            </div>
          ))}
        </div>
      )}
      {metrics?.methodology_note && (
        <p className="text-xs text-slate-500 mt-4">{metrics.methodology_note}</p>
      )}
    </div>
  );
}
