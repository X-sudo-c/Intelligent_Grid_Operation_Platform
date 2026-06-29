import { useCallback, useEffect, useState } from 'react';
import {
  discardDlq,
  getSapIntegrationStatus,
  listDlq,
  retryDlq,
  syncSapCustomers,
  type GiopDlqItem,
  type GiopSapIntegrationStatus,
} from '../api/giop-api';

interface GiopDlqTabProps {
  isLightMode: boolean;
}

export function GiopDlqTab({ isLightMode }: GiopDlqTabProps) {
  const [items, setItems] = useState<GiopDlqItem[]>([]);
  const [sapStatus, setSapStatus] = useState<GiopSapIntegrationStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [sapBusy, setSapBusy] = useState(false);
  const [status, setStatus] = useState('');

  const card = isLightMode ? 'border-slate-200 bg-white' : 'border-slate-700 bg-slate-900/40';

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [dlq, sap] = await Promise.all([
        listDlq('OPEN'),
        getSapIntegrationStatus().catch(() => null),
      ]);
      setItems(dlq);
      setSapStatus(sap);
    } catch {
      setItems([]);
      setSapStatus(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const handleRetry = async (id: string) => {
    setStatus('Retrying…');
    try {
      await retryDlq(id);
      setStatus('Retried');
      await load();
    } catch (err) {
      setStatus(err instanceof Error ? err.message : 'Retry failed');
    }
  };

  const handleDiscard = async (id: string) => {
    try {
      await discardDlq(id);
      await load();
    } catch (err) {
      setStatus(err instanceof Error ? err.message : 'Discard failed');
    }
  };

  const handleSapSync = async () => {
    setSapBusy(true);
    setStatus('');
    try {
      const result = await syncSapCustomers();
      setStatus(
        `SAP sync (${result.mode}): ${result.upserted}/${result.fetched} upserted` +
          (result.failed ? `, ${result.failed} failed → DLQ` : ''),
      );
      await load();
    } catch (err) {
      setStatus(err instanceof Error ? err.message : 'SAP sync failed');
    } finally {
      setSapBusy(false);
    }
  };

  return (
    <div className="h-full overflow-auto p-6 space-y-6">
      <div className={`rounded-lg border p-4 ${card}`}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 className={`text-sm font-semibold ${isLightMode ? 'text-slate-800' : 'text-slate-200'}`}>
              SAP customer sync
            </h3>
            <p className={`text-xs mt-1 ${isLightMode ? 'text-slate-500' : 'text-slate-400'}`}>
              Mock mode pulls sample customers into <code className="text-xs">customer_accounts</code>.
              Swap env vars for live S/4HANA OData when ECG provides an endpoint.
            </p>
          </div>
          <button
            type="button"
            disabled={sapBusy || sapStatus?.enabled === false}
            className="text-xs px-3 py-1.5 bg-indigo-700 hover:bg-indigo-600 disabled:opacity-50 rounded text-white shrink-0"
            onClick={() => void handleSapSync()}
          >
            {sapBusy ? 'Syncing…' : 'Sync customers from SAP'}
          </button>
        </div>
        {sapStatus && (
          <dl className={`mt-3 grid grid-cols-2 md:grid-cols-4 gap-2 text-xs ${isLightMode ? 'text-slate-600' : 'text-slate-400'}`}>
            <div>
              <dt className="opacity-70">Mode</dt>
              <dd className="font-medium">{sapStatus.mock_mode ? 'mock' : 'live'}</dd>
            </div>
            <div>
              <dt className="opacity-70">SAP-linked accounts</dt>
              <dd className="font-medium">
                {sapStatus.customer_accounts_sap_linked} / {sapStatus.customer_accounts_total}
              </dd>
            </div>
            <div>
              <dt className="opacity-70">Open SAP DLQ</dt>
              <dd className="font-medium">{sapStatus.open_sap_dlq_count}</dd>
            </div>
            <div>
              <dt className="opacity-70">Last run</dt>
              <dd className="font-medium">
                {sapStatus.last_run
                  ? `${sapStatus.last_run.status} · ${sapStatus.last_run.upserted} upserted`
                  : '—'}
              </dd>
            </div>
          </dl>
        )}
      </div>

      <div>
        <h3 className={`text-sm font-semibold mb-4 ${isLightMode ? 'text-slate-800' : 'text-slate-200'}`}>
          Integration DLQ
        </h3>
        {status && <p className="text-xs text-slate-500 mb-2">{status}</p>}
        {loading && <p className="text-sm text-slate-500">Loading…</p>}
        {!loading && items.length === 0 && (
          <p className="text-sm text-slate-500">No open DLQ items.</p>
        )}
        <div className="space-y-3">
          {items.map((item) => (
            <div key={item.id} className={`rounded-lg border p-3 text-sm ${card}`}>
              <div className="flex justify-between gap-2">
                <span className="font-mono text-xs">{item.source}</span>
                <span className="text-xs text-slate-500">retries {item.retry_count}</span>
              </div>
              <p className="text-xs text-red-400 mt-1">{item.error_message}</p>
              <pre className="text-xs mt-2 overflow-auto max-h-24 opacity-70">
                {JSON.stringify(item.payload, null, 2)}
              </pre>
              <div className="flex gap-2 mt-2">
                <button
                  type="button"
                  className="text-xs px-2 py-1 bg-emerald-800 rounded text-white"
                  onClick={() => void handleRetry(item.id)}
                >
                  Retry
                </button>
                <button
                  type="button"
                  className="text-xs px-2 py-1 bg-slate-700 rounded text-white"
                  onClick={() => void handleDiscard(item.id)}
                >
                  Discard
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
