import { useState } from 'react';
import { runEnergyBalance, type GiopEnergyBalanceResult } from '../api/giop-api';

interface GiopInsightsTabProps {
  isLightMode: boolean;
}

export function GiopInsightsTab({ isLightMode }: GiopInsightsTabProps) {
  const [zoneKey, setZoneKey] = useState('FEEDER-ACC-01');
  const [periodStart, setPeriodStart] = useState(
    new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 16),
  );
  const [periodEnd, setPeriodEnd] = useState(new Date().toISOString().slice(0, 16));
  const [nominal, setNominal] = useState('');
  const [result, setResult] = useState<GiopEnergyBalanceResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const data = await runEnergyBalance({
        zoneKey,
        periodStart: new Date(periodStart).toISOString(),
        periodEnd: new Date(periodEnd).toISOString(),
        nominalInjectionKwh: nominal ? parseFloat(nominal) : undefined,
      });
      setResult(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Balance failed');
      setResult(null);
    } finally {
      setBusy(false);
    }
  };

  const inputClass = `rounded px-2 py-1.5 text-sm border w-full ${
    isLightMode ? 'bg-white border-slate-300' : 'bg-slate-900 border-slate-700'
  }`;

  return (
    <div className="h-full overflow-auto p-6 max-w-3xl space-y-4">
      <h3 className={`text-sm font-semibold ${isLightMode ? 'text-slate-800' : 'text-premium-text-secondary'}`}>
        Energy accounting
      </h3>
      <div className="grid grid-cols-2 gap-3">
        <div className="col-span-2">
          <label className="text-xs text-slate-500 block mb-1">Feeder / zone key</label>
          <input className={inputClass} value={zoneKey} onChange={(e) => setZoneKey(e.target.value)} />
        </div>
        <div>
          <label className="text-xs text-slate-500 block mb-1">Period start</label>
          <input type="datetime-local" className={inputClass} value={periodStart} onChange={(e) => setPeriodStart(e.target.value)} />
        </div>
        <div>
          <label className="text-xs text-slate-500 block mb-1">Period end</label>
          <input type="datetime-local" className={inputClass} value={periodEnd} onChange={(e) => setPeriodEnd(e.target.value)} />
        </div>
        <div className="col-span-2">
          <label className="text-xs text-slate-500 block mb-1">Nominal injection kWh (optional)</label>
          <input type="number" className={inputClass} value={nominal} onChange={(e) => setNominal(e.target.value)} />
        </div>
      </div>
      <button
        type="button"
        disabled={busy}
        onClick={() => void run()}
        className="px-4 py-1.5 bg-violet-600 hover:bg-violet-500 rounded text-sm text-white disabled:opacity-50"
      >
        Run balance
      </button>
      {error && <p className="text-xs text-red-400">{error}</p>}
      {result && (
        <div className={`rounded-lg border p-4 text-sm space-y-1 ${isLightMode ? 'border-slate-200' : 'border-premium-border/70'}`}>
          <p>
            In: <strong>{result.energy_in_kwh}</strong> kWh · Out: <strong>{result.energy_out_kwh}</strong> kWh
          </p>
          <p>
            Variance: <strong>{result.variance_pct}%</strong>
            {result.anomaly_flag && (
              <span className="ml-2 text-red-400 font-medium">Anomaly</span>
            )}
          </p>
          <p className="text-xs text-slate-500">Meters in zone: {result.meter_count ?? 0}</p>
        </div>
      )}
    </div>
  );
}
