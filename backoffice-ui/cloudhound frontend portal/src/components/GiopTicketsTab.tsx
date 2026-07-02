import { useCallback, useEffect, useState } from 'react';
import { listTickets, patchTicket, type GiopTroubleTicket } from '../api/giop-api';
import { useGiopMapOverlay } from '../context/GiopMapOverlayContext';

interface GiopTicketsTabProps {
  isLightMode: boolean;
}

export function GiopTicketsTab({ isLightMode }: GiopTicketsTabProps) {
  const { focusOnMap } = useGiopMapOverlay();
  const [tickets, setTickets] = useState<GiopTroubleTicket[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('');
  const [status, setStatus] = useState('');
  const [mapBusyId, setMapBusyId] = useState<string | null>(null);

  const showOnMap = useCallback(
    async (t: GiopTroubleTicket) => {
      const mrid = t.asset_mrid ?? t.meter_mrid;
      if (!mrid) {
        setStatus(`Ticket ${t.reference} has no linked asset to locate`);
        return;
      }
      setMapBusyId(t.id);
      try {
        await focusOnMap(mrid, { name: t.summary, coordinates: null });
        setStatus(`Opened ${t.reference} on map`);
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
      setTickets(await listTickets(filter || undefined));
    } catch {
      setTickets([]);
    } finally {
      setLoading(false);
    }
  }, [filter]);

  useEffect(() => {
    void load();
  }, [load]);

  const card = isLightMode ? 'border-slate-200 bg-white' : 'border-premium-border/70 bg-premium-card';

  return (
    <div className="h-full overflow-auto p-6">
      <h3 className={`text-sm font-semibold mb-4 ${isLightMode ? 'text-slate-800' : 'text-premium-text-secondary'}`}>
        Trouble Tickets
      </h3>
      <div className="flex gap-2 mb-4">
        <select
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className="text-sm rounded border px-2 py-1 bg-transparent"
        >
          <option value="">All statuses</option>
          <option value="NEW">NEW</option>
          <option value="ASSIGNED">ASSIGNED</option>
          <option value="IN_PROGRESS">IN_PROGRESS</option>
          <option value="RESOLVED">RESOLVED</option>
          <option value="CLOSED">CLOSED</option>
        </select>
        <button type="button" onClick={() => void load()} className="text-xs px-2 py-1 bg-slate-700 rounded text-white">
          Refresh
        </button>
      </div>
      {status && <p className="text-xs text-slate-500 mb-2">{status}</p>}
      {loading && <p className="text-sm text-slate-500">Loading…</p>}
      <div className="space-y-3">
        {tickets.map((t) => (
          <div key={t.id} className={`rounded-lg border p-3 text-sm ${card}`}>
            <div className="flex justify-between gap-2">
              <span className="font-mono text-xs">{t.reference}</span>
              <span className="text-xs text-cyan-400">{t.status}</span>
            </div>
            <p className="mt-1">{t.summary}</p>
            <p className="text-xs text-slate-500 mt-1">
              {t.source} · {t.ticket_type} · {t.severity} · P{t.priority}
            </p>
            <div className="flex flex-wrap gap-2 mt-2">
              {t.status !== 'IN_PROGRESS' && t.status !== 'CLOSED' && (
                <button
                  type="button"
                  className="text-xs px-2 py-1 bg-cyan-800 rounded text-white"
                  onClick={async () => {
                    try {
                      await patchTicket(t.id, { status: 'IN_PROGRESS', assigned_to: 'ops.demo' });
                      setStatus(`Ticket ${t.reference} in progress`);
                      await load();
                    } catch (err) {
                      setStatus(err instanceof Error ? err.message : 'Update failed');
                    }
                  }}
                >
                  Start work
                </button>
              )}
              {(t.asset_mrid || t.meter_mrid) && (
                <button
                  type="button"
                  disabled={mapBusyId === t.id}
                  className="text-xs px-2 py-1 bg-slate-700 rounded text-white disabled:opacity-40"
                  onClick={() => void showOnMap(t)}
                >
                  {mapBusyId === t.id ? 'Opening…' : 'Show on map'}
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
