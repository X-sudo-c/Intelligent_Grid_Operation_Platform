import { useEffect, useState } from 'react';
import { getLineage, type GiopLineageEvent } from '../api/giop-api';
import {
  diffLineageStates,
  formatLineageValue,
  LINEAGE_SOURCE_LABELS,
} from '../lib/giopLineageDiff';

interface GiopLineageTimelineProps {
  assetMrid: string | null | undefined;
  isLightMode: boolean;
  limit?: number;
  compact?: boolean;
}

function sourceLabel(source: string): string {
  return LINEAGE_SOURCE_LABELS[source] ?? source.replace(/_/g, ' ');
}

export function GiopLineageTimeline({
  assetMrid,
  isLightMode,
  limit = 20,
  compact = false,
}: GiopLineageTimelineProps) {
  const [events, setEvents] = useState<GiopLineageEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [expandedId, setExpandedId] = useState<number | null>(null);

  useEffect(() => {
    if (!assetMrid) {
      setEvents([]);
      setExpandedId(null);
      return;
    }
    setLoading(true);
    void getLineage(assetMrid, limit)
      .then(setEvents)
      .catch(() => setEvents([]))
      .finally(() => setLoading(false));
  }, [assetMrid, limit]);

  if (!assetMrid) return null;

  const border = isLightMode ? 'border-slate-200 bg-slate-50' : 'border-slate-700 bg-slate-900/50';
  const muted = isLightMode ? 'text-slate-500' : 'text-slate-400';
  const diffBg = isLightMode ? 'bg-white border-slate-200' : 'bg-slate-950 border-slate-800';

  return (
    <div className={`${compact ? 'mt-2' : 'mt-4'} rounded-lg border p-3 ${border}`}>
      <p className={`text-xs font-semibold uppercase tracking-wide mb-2 ${muted}`}>
        Lineage
      </p>
      {loading && <p className={`text-xs ${muted}`}>Loading…</p>}
      {!loading && events.length === 0 && (
        <p className={`text-xs ${muted}`}>No lineage events for this asset.</p>
      )}
      <ul className={`space-y-2 ${compact ? 'max-h-48' : 'max-h-64'} overflow-auto`}>
        {events.map((ev) => {
          const changes = diffLineageStates(ev.before_state, ev.after_state);
          const open = expandedId === ev.id;
          return (
            <li key={ev.id} className="text-xs border-l-2 border-cyan-600 pl-2">
              <button
                type="button"
                className="w-full text-left"
                onClick={() => setExpandedId(open ? null : ev.id)}
              >
                <span className="font-medium">{ev.action_type}</span>
                <span className={`ml-2 ${muted}`}>{sourceLabel(ev.source_type)}</span>
                {ev.operator_id && (
                  <span className={`ml-2 font-mono ${muted}`}>{ev.operator_id}</span>
                )}
                {changes.length > 0 && (
                  <span className={`ml-2 ${muted}`}>({changes.length} change{changes.length === 1 ? '' : 's'})</span>
                )}
                {ev.created_at && (
                  <p className={muted}>{new Date(ev.created_at).toLocaleString()}</p>
                )}
              </button>
              {open && (
                <div className={`mt-2 rounded border p-2 space-y-2 ${diffBg}`}>
                  {ev.provenance_ref && (
                    <p className={`font-mono ${muted}`}>{ev.provenance_ref}</p>
                  )}
                  {changes.length === 0 ? (
                    <p className={muted}>No field-level diff (insert or snapshot-only event).</p>
                  ) : (
                    <table className="w-full text-left">
                      <thead>
                        <tr className={muted}>
                          <th className="pr-2 pb-1 font-normal">Field</th>
                          <th className="pr-2 pb-1 font-normal">Before</th>
                          <th className="pb-1 font-normal">After</th>
                        </tr>
                      </thead>
                      <tbody>
                        {changes.map((c) => (
                          <tr key={c.field} className="align-top">
                            <td className="pr-2 py-0.5 font-mono text-cyan-700 dark:text-cyan-400">{c.field}</td>
                            <td className="pr-2 py-0.5 break-all">{formatLineageValue(c.before)}</td>
                            <td className="py-0.5 break-all">{formatLineageValue(c.after)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
