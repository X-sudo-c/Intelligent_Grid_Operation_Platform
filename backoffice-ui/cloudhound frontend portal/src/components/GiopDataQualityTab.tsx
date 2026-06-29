import { useCallback, useEffect, useRef, useState } from 'react';
import {
  approveCleanupRequest,
  generateCleanupPlan,
  getAgentsStatus,
  getDqSummary,
  getLatestKpis,
  getTopologyDqSummary,
  listDqExceptions,
  listPendingApprovals,
  listApprovedProposals,
  publishTopologyProposal,
  rejectCleanupRequest,
  resolveDqException,
  runDqChecks,
  runTopologyDqScan,
  runValidationCycle,
  type GiopValidationProgress,
  listTopologyDqRuns,
  type GiopAgentsStatus,
  type GiopApprovalRequest,
  type GiopTopologyProposal,
  type GiopDqException,
  type GiopDqSummary,
  type GiopKpiSnapshot,
  type GiopTopologyDqSummary,
} from '../api/giop-api';
import { useGiopMapOverlay } from '../context/GiopMapOverlayContext';
import { dqExceptionMapMrid } from '../lib/giopDqMapFocus';
import { clearSwCache, readSwCache, writeSwCache } from '../lib/giopSwCache';
import { ValidationRunModal } from './ValidationRunModal';
import { ValidationRunProgressContent } from './ValidationRunProgressContent';
import {
  fetchValidationRunProgressOnce,
  useValidationRunProgress,
} from '../hooks/useValidationRunProgress';
import { isValidationTerminal } from './validationRunShared';

function topoSummaryCacheKey(mode: 'snapshot' | 'live'): string {
  return `dq-topology-summary:${mode}`;
}

/** Guard against stale/corrupt session cache or API shape drift (e.g. export_gate vs export_blocked). */
function normalizeTopoSummary(raw: unknown): GiopTopologyDqSummary | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Partial<GiopTopologyDqSummary> & {
    export_gate?: GiopTopologyDqSummary['export_blocked'];
  };
  const live = o.live;
  const exportBlocked = o.export_blocked ?? o.export_gate;
  if (!live || typeof live.approved_nodes !== 'number' || !exportBlocked) return null;
  return {
    live: {
      approved_nodes: live.approved_nodes ?? 0,
      orphan_nodes: live.orphan_nodes ?? 0,
      orphan_ratio: live.orphan_ratio ?? 0,
      dangling_lines: live.dangling_lines ?? 0,
      lines_with_unapproved_endpoints: live.lines_with_unapproved_endpoints ?? 0,
    },
    exception_queue: o.exception_queue ?? {},
    export_blocked: {
      blocked: Boolean(exportBlocked.blocked),
      reasons: Array.isArray(exportBlocked.reasons) ? exportBlocked.reasons : [],
      caps: exportBlocked.caps ?? { open_topology_exceptions: 0, orphan_ratio: 0 },
    },
    source: o.source,
    scanned_at: o.scanned_at,
    run_id: o.run_id,
  };
}

function readTopoSummaryCache(): GiopTopologyDqSummary | null {
  const cached = normalizeTopoSummary(readSwCache(topoSummaryCacheKey('snapshot')));
  if (!cached) clearSwCache(topoSummaryCacheKey('snapshot'));
  return cached;
}

interface GiopDataQualityTabProps {
  isLightMode: boolean;
}

const SEVERITY_ORDER = ['critical', 'major', 'minor', 'warning'];

function formatAgo(iso?: string | null): string {
  if (!iso) return 'never scanned';
  const ts = new Date(iso).getTime();
  if (Number.isNaN(ts)) return 'unknown';
  const secs = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (secs < 60) return 'just now';
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

function severityBadge(severity: string): string {
  switch (severity) {
    case 'critical':
      return 'bg-red-900 text-red-200';
    case 'major':
      return 'bg-amber-900 text-amber-200';
    case 'minor':
      return 'bg-blue-900 text-blue-200';
    default:
      return 'bg-slate-700 text-slate-200';
  }
}

export function GiopDataQualityTab({ isLightMode }: GiopDataQualityTabProps) {
  const { focusOnMap, sideMap } = useGiopMapOverlay();
  const [mapBusyId, setMapBusyId] = useState<string | null>(null);
  const [exceptions, setExceptions] = useState<GiopDqException[]>([]);
  const [summary, setSummary] = useState<GiopDqSummary | null>(null);
  const [topoSummary, setTopoSummary] = useState<GiopTopologyDqSummary | null>(readTopoSummaryCache);
  const [topoLoading, setTopoLoading] = useState(() => readTopoSummaryCache() === null);
  const [topoRevalidating, setTopoRevalidating] = useState(false);
  const [topoLiveBusy, setTopoLiveBusy] = useState(false);
  const [statusFilter, setStatusFilter] = useState('OPEN');
  const [severityFilter, setSeverityFilter] = useState('');
  const [domainFilter, setDomainFilter] = useState('');
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [scanBusy, setScanBusy] = useState(false);
  const [validationBusy, setValidationBusy] = useState(false);
  const [validationModalOpen, setValidationModalOpen] = useState(false);
  const [validationRunId, setValidationRunId] = useState<string | null>(null);
  const [validationRunMode, setValidationRunMode] = useState<'deterministic' | 'agent'>('deterministic');
  const [validationRunStartedMs, setValidationRunStartedMs] = useState(0);
  const [validationAwaitingProgress, setValidationAwaitingProgress] = useState(false);
  const [validationTerminalProgress, setValidationTerminalProgress] = useState<GiopValidationProgress | null>(null);
  const terminalHandledRef = useRef<string | null>(null);
  const [agentsStatus, setAgentsStatus] = useState<GiopAgentsStatus | null>(null);
  const [approvals, setApprovals] = useState<GiopApprovalRequest[]>([]);
  const [approvedProposals, setApprovedProposals] = useState<GiopTopologyProposal[]>([]);
  const [kpis, setKpis] = useState<GiopKpiSnapshot | null>(null);
  const activeMapCardRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!sideMap.open) return;
    activeMapCardRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [sideMap.open, sideMap.mrid]);

  const card = isLightMode ? 'border-slate-200 bg-white' : 'border-slate-700 bg-slate-900/40';
  const muted = isLightMode ? 'text-slate-500' : 'text-slate-400';
  const inputClass = isLightMode
    ? 'bg-white border-slate-300 text-slate-900'
    : 'bg-slate-900 border-slate-700 text-slate-100';

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [rows, sum, pending, readyToPublish, kpiSnap] = await Promise.all([
        listDqExceptions({
          status: statusFilter === 'ALL' ? undefined : statusFilter,
          severity: severityFilter || undefined,
          domain: domainFilter || undefined,
          limit: 200,
        }),
        getDqSummary().catch(() => null),
        listPendingApprovals().catch(() => []),
        listApprovedProposals().catch(() => []),
        getLatestKpis().catch(() => null),
      ]);
      setExceptions(Array.isArray(rows) ? rows : []);
      setSummary(sum);
      setApprovals(pending);
      setApprovedProposals(readyToPublish);
      setKpis(kpiSnap);
    } catch (err) {
      setStatus(err instanceof Error ? err.message : 'Failed to load exceptions');
      setExceptions([]);
    } finally {
      setLoading(false);
    }
  }, [statusFilter, severityFilter, domainFilter]);

  // The topology summary is served from the last scan snapshot by default (a
  // cheap indexed read), so it never blocks the exception list. 'live' forces a
  // fresh national recompute for the explicit "Refresh live" action.
  const loadTopo = useCallback(async (mode: 'snapshot' | 'live' = 'snapshot') => {
    const cacheKey = topoSummaryCacheKey(mode);
    const cached = mode === 'snapshot' ? normalizeTopoSummary(readSwCache(cacheKey)) : null;
    const hadCache = cached !== null;

    if (mode === 'live') {
      setTopoLiveBusy(true);
    } else if (cached) {
      setTopoSummary(cached);
      setTopoLoading(false);
      setTopoRevalidating(true);
    } else {
      setTopoLoading(true);
    }

    try {
      const topo = normalizeTopoSummary(await getTopologyDqSummary({ mode }));
      if (topo) {
        writeSwCache(cacheKey, topo);
        setTopoSummary(topo);
      } else if (!hadCache && mode === 'snapshot') {
        setTopoSummary(null);
      }
    } catch {
      if (!hadCache && mode === 'snapshot') setTopoSummary(null);
    } finally {
      if (mode === 'live') setTopoLiveBusy(false);
      else {
        setTopoLoading(false);
        setTopoRevalidating(false);
      }
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    void loadTopo();
  }, [loadTopo]);

  useEffect(() => {
    getAgentsStatus()
      .then(setAgentsStatus)
      .catch(() => setAgentsStatus(null));
  }, []);

  const resetValidationRun = useCallback((resetProgress?: () => void) => {
    terminalHandledRef.current = null;
    setValidationAwaitingProgress(false);
    setValidationTerminalProgress(null);
    setValidationBusy(false);
    setValidationRunId(null);
    resetProgress?.();
  }, []);

  const handleValidationComplete = useCallback(
    async (progress: GiopValidationProgress) => {
      if (terminalHandledRef.current === progress.run_id) return;
      terminalHandledRef.current = progress.run_id;
      setValidationAwaitingProgress(false);
      setValidationTerminalProgress(progress);
      if (progress.kpi) setKpis(progress.kpi);
      if (progress.status === 'completed') {
        setStatus(`Validation run ${progress.run_id.slice(0, 8)} completed`);
      } else if (progress.status === 'failed') {
        setStatus(progress.error_message ?? 'Validation run failed');
      }
      setValidationBusy(false);
      await load();
    },
    [load],
  );

  const {
    progress: validationProgress,
    pollError: validationPollError,
    reset: resetValidationProgress,
  } = useValidationRunProgress(
    validationRunId,
    validationBusy && !!validationRunId,
    (p) => void handleValidationComplete(p),
  );

  const finalizeValidationRun = useCallback(() => {
    resetValidationRun(resetValidationProgress);
  }, [resetValidationRun, resetValidationProgress]);

  const validationDisplayProgress = validationTerminalProgress ?? validationProgress;

  const handleValidationModalClose = useCallback(() => {
    setValidationModalOpen(false);
    if (isValidationTerminal(validationDisplayProgress)) {
      finalizeValidationRun();
    }
  }, [validationDisplayProgress, finalizeValidationRun]);

  const handleValidationRunInBackground = useCallback(() => {
    setValidationModalOpen(false);
  }, []);

  const handleValidationRun = async (mode: 'deterministic' | 'agent' = 'deterministic') => {
    resetValidationProgress();
    terminalHandledRef.current = null;
    setValidationTerminalProgress(null);
    setValidationBusy(true);
    setValidationRunMode(mode);
    setValidationRunStartedMs(Date.now());
    setValidationRunId('pending');
    setValidationAwaitingProgress(false);
    setValidationModalOpen(true);
    setStatus('');
    try {
      const result = await runValidationCycle({ mode, runType: 'full_cycle', async: true });
      setValidationRunId(result.run_id);
      setValidationAwaitingProgress(true);
      try {
        const immediate = await fetchValidationRunProgressOnce(result.run_id);
        setValidationAwaitingProgress(false);
        if (isValidationTerminal(immediate)) {
          await handleValidationComplete(immediate);
        } else {
          setStatus(`Validation run ${result.run_id.slice(0, 8)} · ${immediate.current_phase ?? 'running'}…`);
        }
      } catch {
        setValidationAwaitingProgress(false);
        setStatus(`Validation run ${result.run_id.slice(0, 8)} started…`);
      }
      if (result.status === 'completed' && result.kpi && !result.async) {
        await handleValidationComplete({
          run_id: result.run_id,
          status: 'completed',
          kpi: result.kpi,
        });
      }
    } catch (err) {
      finalizeValidationRun();
      setValidationModalOpen(false);
      setStatus(err instanceof Error ? err.message : 'Validation run failed');
    }
  };

  const handleResolve = async (
    item: GiopDqException,
    action: 'RESOLVED' | 'DEFERRED' | 'QUARANTINED' | 'REJECTED',
  ) => {
    setBusyId(item.id);
    setStatus('');
    try {
      await resolveDqException(item.id, action);
      await load();
    } catch (err) {
      setStatus(err instanceof Error ? err.message : 'Action failed');
    } finally {
      setBusyId(null);
    }
  };

  const handleRecheck = async (item: GiopDqException) => {
    setBusyId(item.id);
    try {
      await runDqChecks(item.record_mrid, item.record_type === 'connectivity_node' ? 'staging' : 'master');
      await load();
    } catch (err) {
      setStatus(err instanceof Error ? err.message : 'Re-check failed');
    } finally {
      setBusyId(null);
    }
  };

  const handleShowOnMap = useCallback(
    async (item: GiopDqException) => {
      const mrid = dqExceptionMapMrid(item);
      if (!mrid?.trim()) {
        setStatus('No map location available for this exception');
        return;
      }
      setMapBusyId(item.id);
      setStatus('');
      try {
        await focusOnMap(mrid, {
          name: item.asset_name ?? undefined,
        });
      } catch (err) {
        setStatus(err instanceof Error ? err.message : 'Could not open map preview');
      } finally {
        setMapBusyId(null);
      }
    },
    [focusOnMap],
  );

  const handleSuggestFix = async (item: GiopDqException) => {
    setBusyId(item.id);
    setStatus('');
    try {
      await generateCleanupPlan(item.id);
      setStatus('Cleanup plan proposed — check Approvals inbox');
      const pending = await listPendingApprovals();
      setApprovals(pending);
    } catch (err) {
      setStatus(err instanceof Error ? err.message : 'Could not generate cleanup plan');
    } finally {
      setBusyId(null);
    }
  };

  const handleApproval = async (approvalId: string, approved: boolean) => {
    setBusyId(approvalId);
    try {
      if (approved) await approveCleanupRequest(approvalId);
      else await rejectCleanupRequest(approvalId);
      setStatus(
        approved
          ? 'Proposal approved — publish to master when ready'
          : 'Cleanup proposal rejected',
      );
      await load();
    } catch (err) {
      setStatus(err instanceof Error ? err.message : 'Approval action failed');
    } finally {
      setBusyId(null);
    }
  };

  const handlePublishProposal = async (proposalId: string) => {
    setBusyId(proposalId);
    try {
      await publishTopologyProposal(proposalId);
      setStatus('Topology change published to master');
      await load();
      await loadTopo('live');
    } catch (err) {
      setStatus(err instanceof Error ? err.message : 'Publish failed');
    } finally {
      setBusyId(null);
    }
  };

  const formatChangeSummary = (summary?: Record<string, unknown> | null) => {
    if (!summary) return null;
    const changes = summary.proposed_changes;
    const skipped = summary.skipped;
    if (typeof changes === 'number') {
      const parts = [`${changes} proposed segment change(s)`];
      if (typeof skipped === 'number' && skipped > 0) parts.push(`${skipped} skipped`);
      return parts.join(', ');
    }
    if (typeof summary.error === 'string') return summary.error;
    if (typeof summary.note === 'string') return summary.note;
    return null;
  };

  const handleTopologyScan = async () => {
    setScanBusy(true);
    setStatus('Queuing master topology scan (Ghana bbox)…');
    try {
      const queued = await runTopologyDqScan();
      setStatus(`Scan ${queued.run_id.slice(0, 8)}… running (may take several minutes)`);
      for (let i = 0; i < 120; i += 1) {
        await new Promise((r) => window.setTimeout(r, 5000));
        const runs = await listTopologyDqRuns(5);
        const run = runs.find((r) => r.id === queued.run_id);
        if (!run || run.status === 'running') continue;
        if (run.status === 'failed') {
          setStatus(run.error_message ?? 'Topology scan failed');
          break;
        }
        setStatus(
          `Scan complete: ${run.orphans_found.toLocaleString()} orphans, ` +
            `${run.dangling_found.toLocaleString()} dangling, ` +
            `${run.auto_cleared.toLocaleString()} auto-cleared`,
        );
        clearSwCache(topoSummaryCacheKey('snapshot'));
        await Promise.all([load(), loadTopo()]);
        break;
      }
    } catch (err) {
      setStatus(err instanceof Error ? err.message : 'Topology scan failed');
    } finally {
      setScanBusy(false);
    }
  };

  return (
    <div className="h-full overflow-auto p-6 space-y-6">
      <ValidationRunModal
        open={validationModalOpen}
        runId={validationRunId ?? 'pending'}
        mode={validationRunMode}
        isLightMode={isLightMode}
        localStartedMs={validationRunStartedMs}
        progress={validationDisplayProgress}
        pollError={validationPollError}
        awaitingProgress={validationAwaitingProgress}
        onClose={handleValidationModalClose}
        onRunInBackground={handleValidationRunInBackground}
      />
      {!topoSummary && topoLoading && (
        <div className={`rounded-lg border p-4 ${card}`}>
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-sm font-semibold">Master topology DQ (Ghana bbox)</h3>
            <span className={`text-xs ${muted}`}>Loading last scan…</span>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mt-3">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className={`h-10 rounded animate-pulse ${isLightMode ? 'bg-slate-100' : 'bg-slate-800/60'}`} />
            ))}
          </div>
        </div>
      )}
      {topoSummary && (
        <div className={`rounded-lg border p-4 space-y-3 ${card}`}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h3 className="text-sm font-semibold">Master topology DQ (Ghana bbox)</h3>
              <p className={`text-xs ${muted}`}>
                {topoRevalidating
                  ? 'Updating…'
                  : topoSummary.source === 'live'
                    ? 'Live · just computed'
                    : `As of last scan · ${formatAgo(topoSummary.scanned_at)}`}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={topoLiveBusy || scanBusy}
                onClick={() => void loadTopo('live')}
                className={`rounded border text-sm py-1.5 px-3 disabled:opacity-50 ${
                  isLightMode
                    ? 'border-slate-300 text-slate-700 hover:bg-slate-100'
                    : 'border-slate-600 text-slate-200 hover:bg-slate-800'
                }`}
                title="Recompute live counts now (slower)"
              >
                {topoLiveBusy ? 'Computing…' : 'Refresh live'}
              </button>
              <button
                type="button"
                disabled={scanBusy}
                onClick={() => void handleTopologyScan()}
                className="rounded bg-cyan-700 hover:bg-cyan-600 disabled:opacity-50 text-white text-sm py-1.5 px-3"
              >
                {scanBusy ? 'Scanning…' : 'Run topology scan → queue'}
              </button>
            </div>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3 text-sm">
            <div>
              <p className={`text-xs ${muted}`}>Approved nodes</p>
              <p className="font-semibold">{topoSummary.live.approved_nodes.toLocaleString()}</p>
            </div>
            <div>
              <p className={`text-xs ${muted}`}>Orphan nodes</p>
              <p className="font-semibold text-amber-600">{topoSummary.live.orphan_nodes.toLocaleString()}</p>
            </div>
            <div>
              <p className={`text-xs ${muted}`}>Orphan ratio</p>
              <p className="font-semibold">{(topoSummary.live.orphan_ratio * 100).toFixed(1)}%</p>
            </div>
            <div>
              <p className={`text-xs ${muted}`}>Dangling lines</p>
              <p className="font-semibold text-red-600">{topoSummary.live.dangling_lines.toLocaleString()}</p>
            </div>
            <div>
              <p className={`text-xs ${muted}`}>Open topo exceptions</p>
              <p className="font-semibold">
                {(topoSummary.exception_queue?.open_topology_total ?? 0).toLocaleString()}
              </p>
            </div>
          </div>
          {topoSummary.export_blocked?.blocked && (
            <p className="text-xs text-amber-700 dark:text-amber-300">
              Exports in this bbox are blocked:{' '}
              {(topoSummary.export_blocked.reasons ?? []).join('; ')}
            </p>
          )}
        </div>
      )}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <div className={`rounded-lg border p-3 ${card}`}>
          <p className={`text-xs ${muted}`}>Open total</p>
          <p className="text-2xl font-semibold">{summary?.open_total ?? '—'}</p>
        </div>
        {SEVERITY_ORDER.map((sev) => (
          <div key={sev} className={`rounded-lg border p-3 ${card}`}>
            <p className={`text-xs capitalize ${muted}`}>{sev}</p>
            <p className="text-2xl font-semibold">{summary?.open_by_severity?.[sev] ?? 0}</p>
          </div>
        ))}
      </div>

      {(kpis || approvals.length > 0 || approvedProposals.length > 0 || validationBusy) && (
        <div className={`rounded-lg border p-4 space-y-3 ${card}`}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h3 className="text-sm font-semibold">Agent KPIs &amp; approvals</h3>
              {agentsStatus && (
                <p className={`text-xs mt-0.5 ${muted}`}>
                  Engine: {agentsStatus.engine}
                  {' · '}
                  LLM: {agentsStatus.llm_configured ? `connected (${agentsStatus.llm_model})` : 'rules-only (no API key)'}
                </p>
              )}
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                disabled={validationBusy}
                onClick={() => void handleValidationRun('deterministic')}
                className="rounded border border-cyan-700 text-cyan-700 dark:text-cyan-300 text-xs py-1 px-2 disabled:opacity-50"
              >
                {validationBusy ? 'Running…' : 'Run validation cycle'}
              </button>
              <button
                type="button"
                disabled={validationBusy}
                onClick={() => void handleValidationRun('agent')}
                className="rounded bg-cyan-700 text-white text-xs py-1 px-2 disabled:opacity-50"
              >
                Run agent cycle
              </button>
            </div>
          </div>
          {validationBusy && validationRunId && validationRunId !== 'pending' && !validationModalOpen && (
            <div
              className={`rounded-lg border p-3 ${
                isLightMode ? 'border-cyan-200 bg-cyan-50/80' : 'border-cyan-800/50 bg-cyan-950/30'
              }`}
            >
              <div className="flex items-center justify-between gap-2 mb-2">
                <p className="text-xs font-semibold text-cyan-800 dark:text-cyan-200">
                  Validation cycle in progress
                </p>
                <button
                  type="button"
                  className="text-xs text-cyan-700 dark:text-cyan-300 underline"
                  onClick={() => setValidationModalOpen(true)}
                >
                  Show details
                </button>
              </div>
              <ValidationRunProgressContent
                runId={validationRunId}
                mode={validationRunMode}
                progress={validationDisplayProgress}
                pollError={validationPollError}
                isLightMode={isLightMode}
                localStartedMs={validationRunStartedMs}
                awaitingProgress={validationAwaitingProgress}
                compact
              />
            </div>
          )}
          {kpis && (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
              <div>
                <span className={muted}>Topology validity</span>
                <p className="font-semibold">{kpis.topology_validity_pct?.toFixed(1) ?? '—'}%</p>
              </div>
              <div>
                <span className={muted}>Completeness</span>
                <p className="font-semibold">{kpis.completeness_pct?.toFixed(1) ?? '—'}%</p>
              </div>
              <div>
                <span className={muted}>Critical open</span>
                <p className="font-semibold">{kpis.critical_exception_count ?? 0}</p>
              </div>
              <div>
                <span className={muted}>Pending approvals</span>
                <p className="font-semibold">{kpis.pending_approval_count ?? approvals.length}</p>
              </div>
            </div>
          )}
          {kpis?.escalation && kpis.escalation.length > 0 && (
            <ul className="text-xs text-amber-700 dark:text-amber-300 space-y-1">
              {kpis.escalation.map((e) => (
                <li key={e.code}>{e.message}</li>
              ))}
            </ul>
          )}
          {approvals.length > 0 && (
            <div className="space-y-2">
              <p className={`text-xs font-medium ${muted}`}>Approvals inbox ({approvals.length})</p>
              {approvals.map((a) => (
                <div
                  key={a.id}
                  className={`rounded border p-2 text-xs ${isLightMode ? 'border-slate-200' : 'border-slate-700'}`}
                >
                  <p className="font-medium">
                    {a.rule_code ?? 'Cleanup'} · {a.severity ?? a.cleanup_mode}
                  </p>
                  <p className={muted}>{a.rationale ?? a.error_message}</p>
                  {formatChangeSummary(a.change_summary as Record<string, unknown> | null) && (
                    <p className="text-cyan-700 dark:text-cyan-300 mt-1">
                      Dry-run: {formatChangeSummary(a.change_summary as Record<string, unknown> | null)}
                    </p>
                  )}
                  {a.target_mrid && (
                    <p className={`${muted} mt-0.5`}>Target MRID: {a.target_mrid.slice(0, 8)}…</p>
                  )}
                  <div className="flex gap-2 mt-2">
                    <button
                      type="button"
                      disabled={busyId === a.id}
                      onClick={() => void handleApproval(a.id, true)}
                      className="px-2 py-0.5 rounded bg-emerald-700 text-white disabled:opacity-50"
                    >
                      Approve proposal
                    </button>
                    <button
                      type="button"
                      disabled={busyId === a.id}
                      onClick={() => void handleApproval(a.id, false)}
                      className="px-2 py-0.5 rounded bg-slate-600 text-white disabled:opacity-50"
                    >
                      Reject
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
          {approvedProposals.length > 0 && (
            <div className="space-y-2">
              <p className={`text-xs font-medium ${muted}`}>
                Ready to publish ({approvedProposals.length})
              </p>
              {approvedProposals.map((p) => (
                <div
                  key={p.id}
                  className={`rounded border p-2 text-xs ${isLightMode ? 'border-emerald-200 bg-emerald-50/50' : 'border-emerald-900/50 bg-emerald-950/20'}`}
                >
                  <p className="font-medium">
                    {p.rule_code ?? 'Topology repair'} · {p.severity ?? 'approved'}
                  </p>
                  <p className={muted}>{p.ai_rationale ?? p.exception_message}</p>
                  {formatChangeSummary(p.change_summary as Record<string, unknown> | null) && (
                    <p className="text-emerald-700 dark:text-emerald-300 mt-1">
                      Dry-run: {formatChangeSummary(p.change_summary as Record<string, unknown> | null)}
                    </p>
                  )}
                  <div className="flex gap-2 mt-2">
                    <button
                      type="button"
                      disabled={busyId === p.id}
                      onClick={() => void handlePublishProposal(p.id)}
                      className="px-2 py-0.5 rounded bg-cyan-700 text-white disabled:opacity-50"
                    >
                      Publish to master
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <div className={`rounded-lg border p-4 ${card}`}>
        <div className="flex flex-wrap items-end gap-3">
          <label className="text-xs space-y-1">
            <span className={muted}>Status</span>
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className={`block rounded border px-2 py-1.5 text-sm ${inputClass}`}
            >
              {['OPEN', 'DEFERRED', 'QUARANTINED', 'RESOLVED', 'REJECTED', 'ALL'].map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs space-y-1">
            <span className={muted}>Severity</span>
            <select
              value={severityFilter}
              onChange={(e) => setSeverityFilter(e.target.value)}
              className={`block rounded border px-2 py-1.5 text-sm ${inputClass}`}
            >
              <option value="">All</option>
              {SEVERITY_ORDER.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs space-y-1">
            <span className={muted}>Domain</span>
            <select
              value={domainFilter}
              onChange={(e) => setDomainFilter(e.target.value)}
              className={`block rounded border px-2 py-1.5 text-sm ${inputClass}`}
            >
              <option value="">All</option>
              <option value="topology">topology</option>
              <option value="spatial">spatial</option>
              <option value="asset">asset</option>
              <option value="voltage">voltage</option>
            </select>
          </label>
          <button
            type="button"
            onClick={() => void load()}
            className="rounded bg-cyan-700 hover:bg-cyan-600 text-white text-sm py-1.5 px-3"
          >
            Refresh
          </button>
          {status && <span className="text-xs text-slate-500">{status}</span>}
        </div>
      </div>

      {loading && <p className="text-sm text-slate-500">Loading exceptions…</p>}
      {!loading && exceptions.length === 0 && (
        <p className="text-sm text-slate-500">No exceptions match the current filters.</p>
      )}

      <div className="space-y-3">
        {exceptions.map((item) => {
          const isBusy = busyId === item.id;
          const isOpen = item.status === 'OPEN';
          const mapMrid = dqExceptionMapMrid(item);
          const isOnMap = sideMap.open && sideMap.mrid === mapMrid;
          return (
            <div
              key={item.id}
              ref={isOnMap ? activeMapCardRef : undefined}
              className={`rounded-lg border p-3 text-sm transition-colors ${
                isOnMap
                  ? isLightMode
                    ? 'border-cyan-500 bg-cyan-50 ring-2 ring-cyan-400/50 shadow-sm'
                    : 'border-cyan-500 bg-cyan-950/35 ring-2 ring-cyan-500/35 shadow-md'
                  : card
              }`}
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className={`px-2 py-0.5 rounded text-xs ${severityBadge(item.severity)}`}>
                    {item.severity}
                  </span>
                  <span className="font-mono text-xs">{item.rule_code}</span>
                  <span className={`text-xs ${muted}`}>· {item.domain}</span>
                  {isOnMap && (
                    <span
                      className={`px-2 py-0.5 rounded text-xs font-medium ${
                        isLightMode ? 'bg-cyan-600 text-white' : 'bg-cyan-500 text-slate-900'
                      }`}
                    >
                      On map
                    </span>
                  )}
                  {!isOpen && (
                    <span className={`text-xs ${muted}`}>· {item.status}</span>
                  )}
                </div>
                <span className={`text-xs ${muted}`}>
                  {item.asset_name || item.record_mrid?.slice(0, 8) || '—'}
                </span>
              </div>
              <p className="mt-1">{item.error_message}</p>
              {item.details && (
                <pre className={`text-xs mt-2 overflow-auto max-h-24 ${muted}`}>
                  {JSON.stringify(item.details, null, 2)}
                </pre>
              )}
              <div className="flex flex-wrap gap-2 mt-2">
                <button
                  type="button"
                  disabled={mapBusyId === item.id}
                  className="text-xs px-2 py-1 bg-slate-700 rounded text-white disabled:opacity-50"
                  onClick={() => void handleShowOnMap(item)}
                >
                  {mapBusyId === item.id ? 'Opening…' : 'Show on map'}
                </button>
                <button
                  type="button"
                  disabled={isBusy}
                  className="text-xs px-2 py-1 bg-cyan-800 rounded text-white disabled:opacity-50"
                  onClick={() => void handleRecheck(item)}
                >
                  Re-check
                </button>
                {isOpen && (
                  <button
                    type="button"
                    disabled={isBusy}
                    className="text-xs px-2 py-1 bg-indigo-800 rounded text-white disabled:opacity-50"
                    onClick={() => void handleSuggestFix(item)}
                  >
                    Suggest fix
                  </button>
                )}
                {isOpen && (
                  <>
                    <button
                      type="button"
                      disabled={isBusy}
                      className="text-xs px-2 py-1 bg-emerald-800 rounded text-white disabled:opacity-50"
                      onClick={() => void handleResolve(item, 'RESOLVED')}
                    >
                      Resolve
                    </button>
                    <button
                      type="button"
                      disabled={isBusy}
                      className="text-xs px-2 py-1 bg-amber-800 rounded text-white disabled:opacity-50"
                      onClick={() => void handleResolve(item, 'DEFERRED')}
                    >
                      Defer
                    </button>
                    <button
                      type="button"
                      disabled={isBusy}
                      className="text-xs px-2 py-1 bg-purple-800 rounded text-white disabled:opacity-50"
                      onClick={() => void handleResolve(item, 'QUARANTINED')}
                    >
                      Quarantine
                    </button>
                    <button
                      type="button"
                      disabled={isBusy}
                      className="text-xs px-2 py-1 bg-red-900 rounded text-white disabled:opacity-50"
                      onClick={() => void handleResolve(item, 'REJECTED')}
                    >
                      Reject
                    </button>
                  </>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
