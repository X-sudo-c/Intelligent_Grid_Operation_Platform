import { useCallback, useEffect, useState } from 'react';
import {
  convertCaseToTicket,
  convertCaseToWorkOrder,
  createCase,
  listCases,
  type GiopContactCase,
} from '../api/giop-api';
import { useGiopMapOverlay } from '../context/GiopMapOverlayContext';

interface GiopCasesTabProps {
  isLightMode: boolean;
}

const CHANNELS = ['PHONE', 'WEB', 'WALK_IN', 'EMAIL', 'SMS', 'MOBILE_APP'];

export function GiopCasesTab({ isLightMode }: GiopCasesTabProps) {
  const { focusOnMap } = useGiopMapOverlay();
  const [cases, setCases] = useState<GiopContactCase[]>([]);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState('');
  const [channel, setChannel] = useState('PHONE');
  const [summary, setSummary] = useState('');
  const [classification, setClassification] = useState('GENERAL');
  const [mapBusyId, setMapBusyId] = useState<string | null>(null);

  const showOnMap = useCallback(
    async (c: GiopContactCase) => {
      const mrid = c.asset_mrid ?? c.meter_mrid;
      if (!mrid) {
        setStatus(`Case ${c.reference} has no linked asset to locate`);
        return;
      }
      setMapBusyId(c.id);
      try {
        await focusOnMap(mrid, { name: c.summary, coordinates: null });
        setStatus(`Opened ${c.reference} on map`);
      } catch (err) {
        setStatus(err instanceof Error ? err.message : 'Could not focus map');
      } finally {
        setMapBusyId(null);
      }
    },
    [focusOnMap],
  );

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setCases(await listCases());
    } catch {
      setCases([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const handleCreate = async () => {
    if (!summary.trim()) return;
    setStatus('Creating…');
    try {
      await createCase({ channel, summary, classification });
      setSummary('');
      setStatus('Case created');
      await load();
    } catch (err) {
      setStatus(err instanceof Error ? err.message : 'Create failed');
    }
  };

  const card = isLightMode ? 'border-slate-200 bg-white' : 'border-premium-border/70 bg-premium-card';

  return (
    <div className="h-full overflow-auto p-6">
      <h3 className={`text-sm font-semibold mb-4 ${isLightMode ? 'text-slate-800' : 'text-premium-text-secondary'}`}>
        Contact Centre Cases
      </h3>
      <div className={`rounded-lg border p-4 mb-6 ${card}`}>
        <p className="text-xs text-slate-500 mb-2">New case intake</p>
        <div className="flex flex-wrap gap-2 mb-2">
          <select
            value={channel}
            onChange={(e) => setChannel(e.target.value)}
            className="text-sm rounded border px-2 py-1 bg-transparent"
          >
            {CHANNELS.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
          <input
            value={classification}
            onChange={(e) => setClassification(e.target.value)}
            placeholder="Classification"
            className="text-sm rounded border px-2 py-1 flex-1 min-w-[120px] bg-transparent"
          />
        </div>
        <textarea
          value={summary}
          onChange={(e) => setSummary(e.target.value)}
          placeholder="Case summary"
          className="w-full text-sm rounded border px-2 py-1 mb-2 bg-transparent min-h-[60px]"
        />
        <button
          type="button"
          onClick={() => void handleCreate()}
          className="text-xs px-3 py-1.5 bg-cyan-700 rounded text-white"
        >
          Create case
        </button>
      </div>
      {status && <p className="text-xs text-slate-500 mb-2">{status}</p>}
      {loading && <p className="text-sm text-slate-500">Loading…</p>}
      <div className="space-y-3">
        {cases.map((c) => (
          <div key={c.id} className={`rounded-lg border p-3 text-sm ${card}`}>
            <div className="flex justify-between gap-2">
              <span className="font-mono text-xs">{c.reference}</span>
              <span className="text-xs text-amber-400">{c.status}</span>
            </div>
            <p className="mt-1">{c.summary}</p>
            <p className="text-xs text-slate-500 mt-1">
              {c.channel} · {c.classification} · P{c.priority}
            </p>
            <div className="flex gap-2 mt-2">
              <button
                type="button"
                className="text-xs px-2 py-1 bg-slate-700 rounded text-white"
                onClick={async () => {
                  try {
                    await convertCaseToTicket(c.id);
                    setStatus(`Ticket created from ${c.reference}`);
                  } catch (err) {
                    setStatus(err instanceof Error ? err.message : 'Convert failed');
                  }
                }}
              >
                → Ticket
              </button>
              <button
                type="button"
                className="text-xs px-2 py-1 bg-emerald-800 rounded text-white"
                onClick={async () => {
                  try {
                    await convertCaseToWorkOrder(c.id);
                    setStatus(`Work order created from ${c.reference}`);
                  } catch (err) {
                    setStatus(err instanceof Error ? err.message : 'Convert failed');
                  }
                }}
              >
                → Work order
              </button>
              {(c.asset_mrid || c.meter_mrid) && (
                <button
                  type="button"
                  disabled={mapBusyId === c.id}
                  className="text-xs px-2 py-1 bg-slate-700 rounded text-white disabled:opacity-40"
                  onClick={() => void showOnMap(c)}
                >
                  {mapBusyId === c.id ? 'Opening…' : 'Show on map'}
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
