import { useCallback, useEffect, useState } from 'react';
import {
  createOutage,
  getTopologyImpact,
  listOutages,
  patchOutage,
  restoreOutage,
  type GiopOutage,
  type GiopTopologyPayload,
} from '../api/giop-api';
import { useGiopMapOverlay } from '../context/GiopMapOverlayContext';

interface GiopOutagesTabProps {
  isLightMode: boolean;
}

export function GiopOutagesTab({ isLightMode }: GiopOutagesTabProps) {
  const { focusOnMap } = useGiopMapOverlay();
  const [outages, setOutages] = useState<GiopOutage[]>([]);
  const [loading, setLoading] = useState(true);
  const [summary, setSummary] = useState('');
  const [affectedArea, setAffectedArea] = useState('');
  const [assetMrid, setAssetMrid] = useState('');
  const [status, setStatus] = useState('');
  const [impact, setImpact] = useState<GiopTopologyPayload | null>(null);
  const [impactLoading, setImpactLoading] = useState(false);
  const [mapBusy, setMapBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setOutages(await listOutages());
    } catch {
      setOutages([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const showFaultOnMap = async (mrid: string, impactPayload?: GiopTopologyPayload | null) => {
    setMapBusy(true);
    setStatus('');
    try {
      await focusOnMap(mrid, { impact: impactPayload ?? null });
      setStatus('Opened on map');
    } catch (err) {
      setStatus(err instanceof Error ? err.message : 'Could not focus map');
    } finally {
      setMapBusy(false);
    }
  };

  const card = isLightMode ? 'border-slate-200 bg-white' : 'border-slate-700 bg-slate-900/40';
  const btnSecondary = `text-xs px-2 py-1 rounded text-white disabled:opacity-50 ${
    isLightMode ? 'bg-slate-600 hover:bg-slate-500' : 'bg-slate-700 hover:bg-slate-600'
  }`;

  return (
    <div className="h-full overflow-auto p-6">
      <h3 className={`text-sm font-semibold mb-4 ${isLightMode ? 'text-slate-800' : 'text-slate-200'}`}>
        Outage Visibility
      </h3>
      <div className={`rounded-lg border p-4 mb-6 ${card}`}>
        <input
          value={summary}
          onChange={(e) => setSummary(e.target.value)}
          placeholder="Outage summary"
          className="w-full text-sm rounded border px-2 py-1 mb-2 bg-transparent"
        />
        <input
          value={affectedArea}
          onChange={(e) => setAffectedArea(e.target.value)}
          placeholder="Affected area"
          className="w-full text-sm rounded border px-2 py-1 mb-2 bg-transparent"
        />
        <input
          value={assetMrid}
          onChange={(e) => setAssetMrid(e.target.value)}
          placeholder="Fault asset mrid (connectivity node UUID)"
          className="w-full text-sm rounded border px-2 py-1 mb-2 bg-transparent font-mono text-xs"
        />
        <div className="flex flex-wrap gap-2 mb-2">
          <button
            type="button"
            className="text-xs px-3 py-1.5 bg-slate-700 rounded text-white disabled:opacity-50"
            disabled={impactLoading || !assetMrid.trim()}
            onClick={async () => {
              setImpactLoading(true);
              setStatus('');
              try {
                const data = await getTopologyImpact(assetMrid.trim());
                setImpact(data);
                setStatus(
                  `Downstream estimate: ${data.metrics?.downstream_nodes ?? data.nodes.length} nodes · ${data.metrics?.edge_count ?? data.edges.length} lines`,
                );
              } catch (err) {
                setImpact(null);
                setStatus(err instanceof Error ? err.message : 'Impact estimate failed');
              } finally {
                setImpactLoading(false);
              }
            }}
          >
            {impactLoading ? 'Estimating…' : 'Estimate downstream impact'}
          </button>
          <button
            type="button"
            className={btnSecondary}
            disabled={mapBusy || !assetMrid.trim()}
            onClick={() => void showFaultOnMap(assetMrid.trim(), impact)}
          >
            {mapBusy ? 'Opening…' : impact ? 'Show impact on map' : 'Show on map'}
          </button>
        </div>
        {impact && (
          <p className="text-xs text-slate-500 mb-2">
            Seed {impact.start_mrid ?? assetMrid} · total {impact.metrics?.total_nodes ?? impact.nodes.length} nodes
            {impact.metrics?.truncated ? ' (truncated)' : ''}
          </p>
        )}
        <button
          type="button"
          className="text-xs px-3 py-1.5 bg-amber-700 rounded text-white"
          onClick={async () => {
            if (!summary.trim()) return;
            try {
              await createOutage({
                summary,
                affected_area: affectedArea,
                customers_affected: 100,
                is_published: true,
                create_ticket: true,
              });
              setSummary('');
              setAffectedArea('');
              setStatus('Outage published');
              await load();
            } catch (err) {
              setStatus(err instanceof Error ? err.message : 'Create failed');
            }
          }}
        >
          Publish outage
        </button>
      </div>
      {status && <p className="text-xs text-slate-500 mb-2">{status}</p>}
      {loading && <p className="text-sm text-slate-500">Loading…</p>}
      <div className="space-y-3">
        {outages.map((o) => (
          <div key={o.id} className={`rounded-lg border p-3 text-sm ${card}`}>
            <div className="flex justify-between gap-2">
              <span className="font-mono text-xs">{o.reference}</span>
              <span className={`text-xs ${o.status === 'ACTIVE' ? 'text-red-400' : 'text-green-400'}`}>
                {o.status}
              </span>
            </div>
            <p className="mt-1">{o.summary}</p>
            <p className="text-xs text-slate-500 mt-1">
              {o.affected_area ?? '—'} · {o.customers_affected} customers
              {o.is_published ? ' · published' : ''}
            </p>
            <div className="flex flex-wrap gap-2 mt-2">
              <button
                type="button"
                className={btnSecondary}
                onClick={async () => {
                  try {
                    await patchOutage(o.id, { is_published: !o.is_published });
                    await load();
                  } catch (err) {
                    setStatus(err instanceof Error ? err.message : 'Update failed');
                  }
                }}
              >
                {o.is_published ? 'Unpublish' : 'Publish'}
              </button>
              {o.status !== 'RESTORED' && o.status !== 'CANCELLED' && (
                <button
                  type="button"
                  className="text-xs px-2 py-1 bg-green-800 rounded text-white"
                  onClick={async () => {
                    try {
                      await restoreOutage(o.id);
                      setStatus(`Outage ${o.reference} restored`);
                      await load();
                    } catch (err) {
                      setStatus(err instanceof Error ? err.message : 'Restore failed');
                    }
                  }}
                >
                  Mark restored
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
