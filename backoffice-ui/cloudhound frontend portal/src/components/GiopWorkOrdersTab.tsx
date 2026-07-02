import { useCallback, useEffect, useState } from 'react';
import {
  createWorkOrder,
  listWorkOrders,
  patchWorkOrder,
  type GiopWorkOrder,
} from '../api/giop-api';
import { useGiopMapOverlay } from '../context/GiopMapOverlayContext';

interface GiopWorkOrdersTabProps {
  isLightMode: boolean;
  workOrders?: GiopWorkOrder[];
  onRefresh?: () => void;
}

export function GiopWorkOrdersTab({
  isLightMode,
  workOrders: workOrdersProp,
  onRefresh,
}: GiopWorkOrdersTabProps) {
  const { focusOnMap } = useGiopMapOverlay();
  const [orders, setOrders] = useState<GiopWorkOrder[]>(workOrdersProp ?? []);
  const [loading, setLoading] = useState(!workOrdersProp);
  const [summary, setSummary] = useState('');
  const [status, setStatus] = useState('');
  const [mapBusyId, setMapBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setOrders(await listWorkOrders());
    } catch {
      setOrders([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (workOrdersProp) {
      setOrders(workOrdersProp);
      setLoading(false);
    }
  }, [workOrdersProp]);

  useEffect(() => {
    if (!workOrdersProp) void load();
  }, [load, workOrdersProp]);

  const card = isLightMode ? 'border-slate-200 bg-white' : 'border-premium-border/70 bg-premium-card';

  const showOnMap = async (wo: GiopWorkOrder) => {
    const mrid = wo.asset_mrid;
    if (!mrid) {
      setStatus('Work order has no linked asset — set asset_mrid to show on map');
      return;
    }
    setMapBusyId(wo.id);
    try {
      const coords =
        wo.longitude != null && wo.latitude != null
          ? ([wo.longitude, wo.latitude] as [number, number])
          : undefined;
      await focusOnMap(mrid, { name: wo.summary, coordinates: coords ?? null });
      setStatus(`Opened ${wo.reference} on map`);
    } catch (err) {
      setStatus(err instanceof Error ? err.message : 'Could not focus map');
    } finally {
      setMapBusyId(null);
    }
  };

  return (
    <div className="h-full overflow-auto p-6">
      <h3 className={`text-sm font-semibold mb-4 ${isLightMode ? 'text-slate-800' : 'text-premium-text-secondary'}`}>
        Work Order Dispatch
      </h3>
      <div className={`rounded-lg border p-4 mb-6 ${card}`}>
        <input
          value={summary}
          onChange={(e) => setSummary(e.target.value)}
          placeholder="Work order summary"
          className="w-full text-sm rounded border px-2 py-1 mb-2 bg-transparent"
        />
        <button
          type="button"
          className="text-xs px-3 py-1.5 bg-emerald-700 rounded text-white"
          onClick={async () => {
            if (!summary.trim()) return;
            try {
              await createWorkOrder({
                summary,
                work_type: 'MAINTENANCE',
                assigned_user: 'tech.demo',
                assigned_crew: 'CREW-DEMO',
              });
              setSummary('');
              setStatus('Work order dispatched');
              await load();
              onRefresh?.();
            } catch (err) {
              setStatus(err instanceof Error ? err.message : 'Dispatch failed');
            }
          }}
        >
          Dispatch
        </button>
      </div>
      {status && <p className="text-xs text-slate-500 mb-2">{status}</p>}
      {loading && <p className="text-sm text-slate-500">Loading…</p>}
      <div className="space-y-3">
        {orders.map((wo) => (
          <div key={wo.id} className={`rounded-lg border p-3 text-sm ${card}`}>
            <div className="flex justify-between gap-2">
              <span className="font-mono text-xs">{wo.reference}</span>
              <span className="text-xs text-emerald-400">{wo.status}</span>
            </div>
            <p className="mt-1">{wo.summary}</p>
            <p className="text-xs text-slate-500 mt-1">
              {wo.work_type} · crew {wo.assigned_crew ?? '—'} · {wo.assigned_user ?? 'unassigned'}
              {wo.asset_mrid ? ` · asset ${wo.asset_mrid.slice(0, 8)}…` : ''}
            </p>
            <div className="flex flex-wrap gap-2 mt-2">
              {wo.asset_mrid && (
                <button
                  type="button"
                  className="text-xs px-2 py-1 bg-violet-800 rounded text-white disabled:opacity-50"
                  disabled={mapBusyId === wo.id}
                  onClick={() => void showOnMap(wo)}
                >
                  {mapBusyId === wo.id ? 'Opening…' : 'Show on map'}
                </button>
              )}
              {wo.status === 'DISPATCHED' && (
                <button
                  type="button"
                  className="text-xs px-2 py-1 bg-slate-700 rounded text-white"
                  onClick={async () => {
                    try {
                      await patchWorkOrder(wo.id, { status: 'ACCEPTED' });
                      await load();
                      onRefresh?.();
                    } catch (err) {
                      setStatus(err instanceof Error ? err.message : 'Update failed');
                    }
                  }}
                >
                  Mark accepted
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
