import { useCallback, useEffect, useState } from 'react';
import {
  searchLineage,
  type GiopLineageEvent,
} from '../api/giop-api';
import { GiopLineageTimeline } from './GiopLineageTimeline';
import { useGiopMapOverlay } from '../context/GiopMapOverlayContext';
import { giopLog } from '../lib/giopDebugLog';
import { LINEAGE_SOURCE_LABELS } from '../lib/giopLineageDiff';

interface GiopAuditTabProps {
  isLightMode: boolean;
}

const SOURCE_OPTIONS = Object.keys(LINEAGE_SOURCE_LABELS);

export function GiopAuditTab({ isLightMode }: GiopAuditTabProps) {
  const { focusOnMap } = useGiopMapOverlay();
  const [assetMrid, setAssetMrid] = useState('');
  const [sourceType, setSourceType] = useState('');
  const [actionType, setActionType] = useState('');
  const [events, setEvents] = useState<GiopLineageEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [focusMrid, setFocusMrid] = useState<string | null>(null);

  const runSearch = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const rows = await searchLineage({
        assetMrid: assetMrid.trim() || undefined,
        sourceType: sourceType || undefined,
        actionType: actionType.trim() || undefined,
        limit: 100,
      });
      setEvents(rows);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Search failed');
      setEvents([]);
    } finally {
      setLoading(false);
    }
  }, [actionType, assetMrid, sourceType]);

  useEffect(() => {
    void runSearch();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- initial ledger load only
  }, []);

  const inputClass = isLightMode
    ? 'bg-white border-slate-300 text-slate-900'
    : 'bg-premium-surface border-premium-border/70 text-premium-text';

  return (
    <div className="space-y-4">
      <div className={`rounded-lg border p-4 ${isLightMode ? 'border-slate-200' : 'border-premium-border/70'}`}>
        <h3 className="text-sm font-semibold mb-3">Audit ledger search</h3>
        <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
          <label className="text-xs space-y-1">
            <span className={isLightMode ? 'text-slate-600' : 'text-slate-400'}>Asset MRID</span>
            <input
              type="text"
              value={assetMrid}
              onChange={(e) => setAssetMrid(e.target.value)}
              placeholder="UUID"
              className={`w-full rounded border px-2 py-1.5 text-sm font-mono ${inputClass}`}
            />
          </label>
          <label className="text-xs space-y-1">
            <span className={isLightMode ? 'text-slate-600' : 'text-slate-400'}>Source type</span>
            <select
              value={sourceType}
              onChange={(e) => setSourceType(e.target.value)}
              className={`w-full rounded border px-2 py-1.5 text-sm ${inputClass}`}
            >
              <option value="">All sources</option>
              {SOURCE_OPTIONS.map((s) => (
                <option key={s} value={s}>
                  {LINEAGE_SOURCE_LABELS[s] ?? s}
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs space-y-1">
            <span className={isLightMode ? 'text-slate-600' : 'text-slate-400'}>Action contains</span>
            <input
              type="text"
              value={actionType}
              onChange={(e) => setActionType(e.target.value)}
              placeholder="PROMOTE, FIELD_CAPTURE…"
              className={`w-full rounded border px-2 py-1.5 text-sm ${inputClass}`}
            />
          </label>
          <div className="flex items-end">
            <button
              type="button"
              onClick={() => void runSearch()}
              className="w-full rounded bg-cyan-700 hover:bg-cyan-600 text-white text-sm py-1.5 px-3"
            >
              Search
            </button>
          </div>
        </div>
        {error && <p className="mt-2 text-xs text-red-500">{error}</p>}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className={`rounded-lg border overflow-hidden ${isLightMode ? 'border-slate-200' : 'border-premium-border/70'}`}>
          <div className={`px-3 py-2 text-xs font-semibold uppercase ${isLightMode ? 'bg-slate-100 text-slate-600' : 'bg-slate-800 text-slate-400'}`}>
            Recent events {loading ? '(loading…)' : `(${events.length})`}
          </div>
          <div className="max-h-[28rem] overflow-auto">
            <table className="w-full text-xs">
              <thead className={isLightMode ? 'bg-slate-50 text-slate-600' : 'bg-slate-900 text-slate-400'}>
                <tr>
                  <th className="text-left px-3 py-2">Time</th>
                  <th className="text-left px-3 py-2">Action</th>
                  <th className="text-left px-3 py-2">Source</th>
                  <th className="text-left px-3 py-2">Asset</th>
                </tr>
              </thead>
              <tbody>
                {events.map((ev) => (
                  <tr
                    key={ev.id}
                    className={`border-t cursor-pointer ${focusMrid === ev.target_mrid ? (isLightMode ? 'bg-cyan-50' : 'bg-cyan-950/30') : ''} ${isLightMode ? 'border-slate-200 hover:bg-slate-50' : 'border-slate-800 hover:bg-slate-900/50'}`}
                    onClick={() => {
                      setFocusMrid(ev.target_mrid);
                      giopLog.audit.info('lineage row focus', { mrid: ev.target_mrid, action: ev.action_type });
                      void focusOnMap(ev.target_mrid);
                    }}
                  >
                    <td className="px-3 py-2 whitespace-nowrap">
                      {ev.created_at ? new Date(ev.created_at).toLocaleString() : '—'}
                    </td>
                    <td className="px-3 py-2 font-medium">{ev.action_type}</td>
                    <td className="px-3 py-2">{LINEAGE_SOURCE_LABELS[ev.source_type] ?? ev.source_type}</td>
                    <td className="px-3 py-2 font-mono truncate max-w-[10rem]" title={ev.target_mrid}>
                      {ev.target_mrid.slice(0, 8)}…
                    </td>
                  </tr>
                ))}
                {!loading && events.length === 0 && (
                  <tr>
                    <td colSpan={4} className="px-3 py-6 text-center text-slate-500">
                      No lineage events match your filters.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        <div>
          {focusMrid ? (
            <GiopLineageTimeline assetMrid={focusMrid} isLightMode={isLightMode} limit={30} />
          ) : (
            <div className={`rounded-lg border p-6 text-sm text-center ${isLightMode ? 'border-slate-200 text-slate-500' : 'border-slate-700 text-slate-400'}`}>
              Select an event to inspect before/after snapshots.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
