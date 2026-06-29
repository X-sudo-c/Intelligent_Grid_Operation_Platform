import { useCallback, useEffect, useState } from 'react';
import {
  approveAsset,
  getStagingAssets,
  listConflicts,
  listInspections,
  patchAssetName,
  patchAssetVoltage,
  rejectAsset,
  repairTopology,
  resolveConflict,
  type GiopConflictProposal,
  type GiopStagingAsset,
  type GiopInspection,
  type GiopTopologyRepairResult,
} from '../api/giop-api';
import { countValidationStats } from '../lib/giopGraphAdapter';
import { useGiopSelection } from '../context/GiopSelectionContext';
import { useDebouncedCallback } from '../hooks/useDebouncedCallback';
import { GHANA_VOLTAGE_OPTIONS } from '../lib/giopSldTheme';
import { GiopLineageTimeline } from './GiopLineageTimeline';

interface GiopOperationsTabProps {
  isLightMode: boolean;
  onRefreshTopology?: () => void;
  onMapRefresh?: () => void;
  refreshToken?: number;
}

function validationBadgeClass(validation?: string): string {
  if (validation === 'APPROVED') return 'bg-green-900 text-green-300';
  if (validation === 'IN_CONFLICT') return 'bg-red-900 text-red-300';
  if (validation === 'PENDING_FIELD') return 'bg-amber-900 text-amber-300';
  if (validation === 'STAGED') return 'bg-blue-900 text-blue-300';
  if (validation === 'REJECTED') return 'bg-slate-700 text-slate-300';
  return 'bg-slate-800 text-slate-300';
}

export function GiopOperationsTab({
  isLightMode,
  onRefreshTopology,
  onMapRefresh,
  refreshToken = 0,
}: GiopOperationsTabProps) {
  const { setSelection } = useGiopSelection();
  const [assets, setAssets] = useState<GiopStagingAsset[]>([]);
  const [inspectionsByAsset, setInspectionsByAsset] = useState<Record<string, GiopInspection>>({});
  const [conflicts, setConflicts] = useState<GiopConflictProposal[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState('Idle');
  const [repairTarget, setRepairTarget] = useState<string | null>(null);
  const [repairPreview, setRepairPreview] = useState<GiopTopologyRepairResult | null>(null);
  const [repairBusy, setRepairBusy] = useState(false);
  const [showRejected, setShowRejected] = useState(false);
  const [rejectingMrid, setRejectingMrid] = useState<string | null>(null);
  const [rejectBusyMrid, setRejectBusyMrid] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState('');
  const [selectedMrids, setSelectedMrids] = useState<Set<string>>(() => new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [confirmation, setConfirmation] = useState<{
    type: 'success' | 'error';
    message: string;
  } | null>(null);

  const loadAssets = useCallback(async (options?: { silent?: boolean }) => {
    if (!options?.silent) {
      setLoading(true);
    }
    setError(null);
    try {
      const rows = await getStagingAssets({ includeRejected: showRejected });
      setAssets(rows);
      const inspections = await listInspections().catch(() => [] as GiopInspection[]);
      const byAsset: Record<string, GiopInspection> = {};
      for (const row of inspections) {
        if (!byAsset[row.asset_mrid]) byAsset[row.asset_mrid] = row;
      }
      setInspectionsByAsset(byAsset);
      const conflictRows = await listConflicts().catch(() => [] as GiopConflictProposal[]);
      setConflicts(conflictRows);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load staging assets');
    } finally {
      if (!options?.silent) {
        setLoading(false);
      }
    }
  }, [showRejected]);

  useEffect(() => {
    void loadAssets();
  }, [loadAssets, refreshToken]);

  const stats = countValidationStats(assets);
  const total = assets.length || 1;

  const debouncedPatchName = useDebouncedCallback(async (mrid: string, name: string) => {
    try {
      await patchAssetName(mrid, name);
      setStatus(`Saved name for ${mrid.slice(0, 8)}…`);
    } catch (err) {
      setStatus(err instanceof Error ? err.message : 'Name update failed');
    }
  }, 500);

  const handleVoltageChange = async (mrid: string, voltage: string) => {
    setStatus('Saving voltage…');
    try {
      await patchAssetVoltage(mrid, voltage);
      setStatus(`Voltage updated for ${mrid.slice(0, 8)}…`);
      await loadAssets();
    } catch (err) {
      setStatus(err instanceof Error ? err.message : 'Voltage update failed');
    }
  };

  const handleApprove = async (mrid: string) => {
    setStatus('Approving…');
    try {
      await approveAsset(mrid);
      await loadAssets();
      onRefreshTopology?.();
      onMapRefresh?.();
      setSelectedMrids((prev) => {
        const next = new Set(prev);
        next.delete(mrid);
        return next;
      });
      setStatus('Asset promoted to master');
    } catch (err) {
      setStatus(err instanceof Error ? err.message : 'Approve failed');
    }
  };

  const approvableMrids = assets
    .filter((row) => row.validation === 'PENDING_FIELD' || row.validation === 'STAGED')
    .map((row) => row.mrid);

  const toggleSelectAll = () => {
    if (selectedMrids.size >= approvableMrids.length && approvableMrids.length > 0) {
      setSelectedMrids(new Set());
    } else {
      setSelectedMrids(new Set(approvableMrids));
    }
  };

  const toggleSelect = (mrid: string) => {
    setSelectedMrids((prev) => {
      const next = new Set(prev);
      if (next.has(mrid)) next.delete(mrid);
      else next.add(mrid);
      return next;
    });
  };

  const handleBulkApprove = async () => {
    const mrids = [...selectedMrids];
    if (!mrids.length) return;
    setBulkBusy(true);
    setStatus(`Approving ${mrids.length} asset(s)…`);
    let ok = 0;
    let failed = 0;
    for (const mrid of mrids) {
      try {
        await approveAsset(mrid);
        ok += 1;
      } catch {
        failed += 1;
      }
    }
    await loadAssets();
    onRefreshTopology?.();
    onMapRefresh?.();
    setSelectedMrids(new Set());
    setBulkBusy(false);
    setStatus(
      failed > 0
        ? `Bulk approve: ${ok} promoted, ${failed} failed`
        : `Bulk approve: ${ok} asset(s) promoted to master`,
    );
  };

  const handleReject = async (mrid: string, assetName?: string) => {
    setRejectBusyMrid(mrid);
    setConfirmation(null);
    setStatus('Rejecting asset…');
    try {
      await rejectAsset(mrid, rejectReason.trim() || undefined);
      setRejectingMrid(null);
      setRejectReason('');
      await loadAssets({ silent: true });
      onMapRefresh?.();
      const label = assetName?.trim() || mrid.slice(0, 8);
      setConfirmation({
        type: 'success',
        message: `"${label}" was rejected. The list has been updated and the field technician will be notified.`,
      });
      setStatus('Idle');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Reject failed';
      setConfirmation({ type: 'error', message });
      setStatus(message);
    } finally {
      setRejectBusyMrid(null);
    }
  };

  const handleRepairPreview = async () => {
    const mrid = repairTarget || assets[0]?.mrid;
    if (!mrid) return;
    setRepairBusy(true);
    setStatus('Previewing topology repair…');
    try {
      const preview = await repairTopology(mrid, { dryRun: true });
      setRepairPreview(preview);
      const count = preview.result.proposed?.length ?? 0;
      setStatus(`Preview: ${count} proposed link(s) for ${mrid.slice(0, 8)}…`);
    } catch (err) {
      setRepairPreview(null);
      setStatus(err instanceof Error ? err.message : 'Preview failed');
    } finally {
      setRepairBusy(false);
    }
  };

  const handleRepairApply = async () => {
    const mrid = repairTarget || assets[0]?.mrid;
    if (!mrid) return;
    setRepairBusy(true);
    setStatus('Applying topology repair…');
    try {
      const result = await repairTopology(mrid, { dryRun: false });
      setRepairPreview(null);
      const count = result.result.applied?.length ?? 0;
      setStatus(`Repair applied: ${count} segment link(s) for ${mrid.slice(0, 8)}…`);
      onRefreshTopology?.();
    } catch (err) {
      setStatus(err instanceof Error ? err.message : 'Repair failed');
    } finally {
      setRepairBusy(false);
    }
  };

  const handleResolveConflict = async (
    conflictId: string,
    resolution: 'master' | 'field' | 'discard',
  ) => {
    setStatus(`Resolving conflict (${resolution})…`);
    try {
      await resolveConflict(conflictId, resolution);
      await loadAssets();
      onRefreshTopology?.();
      setStatus('Conflict resolved');
    } catch (err) {
      setStatus(err instanceof Error ? err.message : 'Resolve failed');
    }
  };

  return (
    <div className="h-full overflow-auto p-6 space-y-6">
      <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
        {[
          { label: 'Pending field', value: stats.pending, color: '#f59e0b' },
          { label: 'Staged', value: stats.staged, color: '#3b82f6' },
          { label: 'In conflict', value: stats.conflict, color: '#ef4444' },
          { label: 'Rejected', value: stats.rejected, color: '#64748b' },
          { label: 'Other', value: stats.other, color: '#94a3b8' },
        ].map((item) => (
          <div
            key={item.label}
            className={`rounded-xl border p-4 ${isLightMode ? 'border-slate-200 bg-white' : 'border-[#283246]/75 bg-[#0f141d]'}`}
          >
            <p className={`text-xs uppercase tracking-wide ${isLightMode ? 'text-slate-500' : 'text-[#93a0b8]'}`}>{item.label}</p>
            <p className="text-2xl font-light mt-1" style={{ color: item.color }}>{item.value}</p>
            <p className={`text-xs mt-1 ${isLightMode ? 'text-slate-400' : 'text-[#6b7a94]'}`}>
              {((item.value / total) * 100).toFixed(0)}% of queue
            </p>
          </div>
        ))}
      </div>

      {confirmation && (
        <div
          className={`rounded-xl border px-4 py-3 flex items-start justify-between gap-3 text-sm ${
            confirmation.type === 'success'
              ? isLightMode
                ? 'border-emerald-200 bg-emerald-50 text-emerald-900'
                : 'border-emerald-800/60 bg-emerald-950/40 text-emerald-100'
              : isLightMode
                ? 'border-red-200 bg-red-50 text-red-900'
                : 'border-red-900/50 bg-red-950/40 text-red-100'
          }`}
        >
          <div>
            <p className="font-semibold">
              {confirmation.type === 'success' ? 'Rejection confirmed' : 'Rejection failed'}
            </p>
            <p className="mt-1 text-xs opacity-90">{confirmation.message}</p>
          </div>
          <button
            type="button"
            className={`shrink-0 text-xs px-2 py-1 rounded ${
              isLightMode ? 'bg-white/80 hover:bg-white' : 'bg-slate-800 hover:bg-slate-700'
            }`}
            onClick={() => setConfirmation(null)}
          >
            Dismiss
          </button>
        </div>
      )}

      <div className="flex items-center justify-between gap-4">
        <div>
          <h3 className={`text-sm font-semibold ${isLightMode ? 'text-slate-800' : 'text-slate-200'}`}>Asset Verification</h3>
          <p className={`text-xs ${isLightMode ? 'text-slate-500' : 'text-slate-400'}`}>{status}</p>
        </div>
        <button
          type="button"
          disabled={repairBusy}
          onClick={() => void handleRepairPreview()}
          className="px-3 py-1.5 bg-slate-700 hover:bg-slate-600 disabled:opacity-50 rounded text-xs font-medium text-white"
        >
          Preview repair
        </button>
        <button
          type="button"
          disabled={repairBusy}
          onClick={() => void handleRepairApply()}
          className="px-3 py-1.5 bg-amber-700 hover:bg-amber-600 disabled:opacity-50 rounded text-xs font-medium text-white"
        >
          Apply repair
        </button>
        <button
          type="button"
          disabled={bulkBusy || selectedMrids.size === 0}
          onClick={() => void handleBulkApprove()}
          className="px-3 py-1.5 bg-emerald-800 hover:bg-emerald-700 disabled:opacity-50 rounded text-xs font-medium text-white"
        >
          {bulkBusy ? 'Approving…' : `Approve selected (${selectedMrids.size})`}
        </button>
        <label className={`flex items-center gap-2 text-xs ${isLightMode ? 'text-slate-600' : 'text-slate-400'}`}>
          <input
            type="checkbox"
            checked={showRejected}
            onChange={(e) => setShowRejected(e.target.checked)}
          />
          Show rejected
        </label>
      </div>

      {error && <p className="text-sm text-red-400">{error}</p>}

      {conflicts.length > 0 && (
        <div className={`rounded-xl border overflow-hidden ${isLightMode ? 'border-red-200' : 'border-red-900/50'}`}>
          <div className={`px-4 py-2 text-xs font-semibold uppercase ${isLightMode ? 'bg-red-50 text-red-800' : 'bg-red-950/40 text-red-300'}`}>
            Open conflicts ({conflicts.length})
          </div>
          <table className="w-full text-sm text-left">
            <thead className={`text-xs uppercase ${isLightMode ? 'bg-slate-100 text-slate-500' : 'bg-slate-900 text-slate-400'}`}>
              <tr>
                <th className="px-4 py-2">Asset</th>
                <th className="px-4 py-2">Server updated</th>
                <th className="px-4 py-2">Actions</th>
              </tr>
            </thead>
            <tbody className={`divide-y ${isLightMode ? 'divide-slate-200' : 'divide-slate-800'}`}>
              {conflicts.map((c) => (
                <tr key={c.id}>
                  <td className="px-4 py-2 font-mono text-xs">{c.asset_name || c.asset_mrid}</td>
                  <td className="px-4 py-2 text-xs text-slate-500">
                    {c.server_updated_at ? new Date(c.server_updated_at).toLocaleString() : '—'}
                  </td>
                  <td className="px-4 py-2 space-x-1">
                    <button type="button" className="text-xs px-2 py-0.5 bg-slate-700 rounded text-white" onClick={() => void handleResolveConflict(c.id, 'master')}>Keep master</button>
                    <button type="button" className="text-xs px-2 py-0.5 bg-emerald-800 rounded text-white" onClick={() => void handleResolveConflict(c.id, 'field')}>Accept field</button>
                    <button type="button" className="text-xs px-2 py-0.5 bg-slate-600 rounded text-white" onClick={() => void handleResolveConflict(c.id, 'discard')}>Discard</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {repairPreview && (repairPreview.result.proposed?.length ?? 0) > 0 && (
        <div className={`rounded-xl border p-3 text-xs ${isLightMode ? 'border-amber-200 bg-amber-50' : 'border-amber-900/50 bg-amber-950/30'}`}>
          <p className="font-semibold mb-2">Repair preview ({repairPreview.result.proposed?.length} proposed)</p>
          <ul className="space-y-1 font-mono max-h-32 overflow-auto">
            {repairPreview.result.proposed?.map((item, i) => (
              <li key={i}>{JSON.stringify(item)}</li>
            ))}
          </ul>
        </div>
      )}

      {repairTarget && (
        <GiopLineageTimeline assetMrid={repairTarget} isLightMode={isLightMode} compact />
      )}

      <div className={`rounded-xl border overflow-hidden ${isLightMode ? 'border-slate-200' : 'border-slate-800'}`}>
        <table className="w-full text-sm text-left">
          <thead className={`text-xs uppercase sticky top-0 ${isLightMode ? 'bg-slate-100 text-slate-500' : 'bg-slate-900 text-slate-400'}`}>
            <tr>
              <th className="px-4 py-3 w-10">
                <input
                  type="checkbox"
                  aria-label="Select all approvable assets"
                  checked={
                    approvableMrids.length > 0 && selectedMrids.size === approvableMrids.length
                  }
                  disabled={approvableMrids.length === 0}
                  onChange={toggleSelectAll}
                />
              </th>
              <th className="px-4 py-3">Asset MRID</th>
              <th className="px-4 py-3">Name</th>
              <th className="px-4 py-3">Type</th>
              <th className="px-4 py-3">Voltage</th>
              <th className="px-4 py-3">Validation</th>
              <th className="px-4 py-3">Submitted by</th>
              <th className="px-4 py-3">AI validation</th>
              <th className="px-4 py-3">Actions</th>
            </tr>
          </thead>
          <tbody className={`divide-y ${isLightMode ? 'divide-slate-200' : 'divide-slate-800'}`}>
            {loading && (
              <tr>
                <td colSpan={9} className="px-4 py-6 text-slate-500">Loading staging assets…</td>
              </tr>
            )}
            {!loading && assets.length === 0 && (
              <tr>
                <td colSpan={9} className="px-4 py-6 text-slate-500">No pending field assets</td>
              </tr>
            )}
            {assets.map((row) => {
              const canApprove = row.validation === 'PENDING_FIELD' || row.validation === 'STAGED';
              const canReject =
                row.validation === 'PENDING_FIELD' ||
                row.validation === 'STAGED' ||
                row.validation === 'IN_CONFLICT';
              const isRejecting = rejectingMrid === row.mrid;
              const isRejectBusy = rejectBusyMrid === row.mrid;
              return (
                <tr
                  key={row.mrid}
                  className={`cursor-pointer ${isLightMode ? 'hover:bg-slate-50' : 'hover:bg-slate-900/60'} ${
                    isRejectBusy ? (isLightMode ? 'bg-amber-50/80' : 'bg-amber-950/20') : ''
                  }`}
                  onClick={() => {
                    setRepairTarget(row.mrid);
                    const coords = row.geom?.coordinates;
                    setSelection(row.mrid, {
                      name: row.name,
                      coordinates: coords ?? null,
                      source: 'table',
                    });
                  }}
                >
                  <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
                    {canApprove && (
                      <input
                        type="checkbox"
                        checked={selectedMrids.has(row.mrid)}
                        aria-label={`Select ${row.mrid}`}
                        onChange={() => toggleSelect(row.mrid)}
                      />
                    )}
                  </td>
                  <td className="px-4 py-3 font-mono text-xs">{row.mrid}</td>
                  <td className="px-4 py-3">
                    <input
                      type="text"
                      defaultValue={row.name ?? ''}
                      className={`w-full rounded px-2 py-1 text-sm border ${isLightMode ? 'bg-white border-slate-300' : 'bg-slate-900 border-slate-700'}`}
                      onClick={(e) => e.stopPropagation()}
                      onChange={(e) => {
                        const value = e.target.value.trim();
                        if (value) void debouncedPatchName(row.mrid, value);
                      }}
                    />
                  </td>
                  <td className="px-4 py-3 text-xs text-slate-400">
                    {row.asset_kind?.replaceAll('_', ' ') ?? '—'}
                  </td>
                  <td className="px-4 py-3">
                    {row.nominal_voltage ? (
                      <select
                        value={row.nominal_voltage}
                        className={`rounded px-2 py-1 text-xs border ${isLightMode ? 'bg-white border-slate-300' : 'bg-slate-900 border-slate-700'}`}
                        onClick={(e) => e.stopPropagation()}
                        onChange={(e) => void handleVoltageChange(row.mrid, e.target.value)}
                      >
                        {GHANA_VOLTAGE_OPTIONS.map((v) => (
                          <option key={v} value={v}>
                            {v}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <span className="text-xs text-slate-500">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <span className={`px-2 py-0.5 rounded text-xs ${validationBadgeClass(row.validation)}`}>
                      {row.validation ?? '—'}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-xs text-slate-400 font-mono">
                    {row.submitted_by ?? '—'}
                  </td>
                  <td className="px-4 py-3 text-xs text-slate-400">
                    {inspectionsByAsset[row.mrid]?.ai_validation_status ?? '—'}
                  </td>
                  <td className="px-4 py-3 space-y-1">
                    {canApprove && (
                      <button
                        type="button"
                        className="text-xs px-2 py-0.5 bg-emerald-800 hover:bg-emerald-700 rounded text-white mr-1"
                        onClick={(e) => {
                          e.stopPropagation();
                          void handleApprove(row.mrid);
                        }}
                      >
                        Approve → Master
                      </button>
                    )}
                    {canReject && !isRejecting && (
                      <button
                        type="button"
                        className="text-xs px-2 py-0.5 bg-red-900 hover:bg-red-800 rounded text-white"
                        onClick={(e) => {
                          e.stopPropagation();
                          setRejectingMrid(row.mrid);
                          setRejectReason('');
                        }}
                      >
                        Reject
                      </button>
                    )}
                    {isRejecting && (
                      <div className="space-y-1" onClick={(e) => e.stopPropagation()}>
                        {isRejectBusy ? (
                          <p className="text-xs text-amber-600 dark:text-amber-300 flex items-center gap-2">
                            <span
                              className="inline-block h-3 w-3 rounded-full border-2 border-current border-t-transparent animate-spin"
                              aria-hidden
                            />
                            Rejecting and refreshing list…
                          </p>
                        ) : (
                          <>
                            <input
                              type="text"
                              placeholder="Reason (optional)"
                              value={rejectReason}
                              onChange={(e) => setRejectReason(e.target.value)}
                              className={`w-full rounded px-2 py-1 text-xs border ${isLightMode ? 'bg-white border-slate-300' : 'bg-slate-900 border-slate-700'}`}
                            />
                            <div className="flex gap-1">
                              <button
                                type="button"
                                className="text-xs px-2 py-0.5 bg-red-800 rounded text-white disabled:opacity-50"
                                disabled={rejectBusyMrid !== null}
                                onClick={() => void handleReject(row.mrid, row.name)}
                              >
                                Confirm reject
                              </button>
                              <button
                                type="button"
                                className="text-xs px-2 py-0.5 bg-slate-700 rounded text-white disabled:opacity-50"
                                disabled={rejectBusyMrid !== null}
                                onClick={() => setRejectingMrid(null)}
                              >
                                Cancel
                              </button>
                            </div>
                          </>
                        )}
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
