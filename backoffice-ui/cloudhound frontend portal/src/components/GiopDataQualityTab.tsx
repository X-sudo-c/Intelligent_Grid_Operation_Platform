import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  approveCleanupRequest,
  generateCleanupPlan,
  getAgentsStatus,
  getDqSummary,
  getLatestKpis,
  getTopologyDqSummary,
  listDqQueue,
  listPendingApprovals,
  listApprovedProposals,
  publishTopologyProposal,
  rejectCleanupRequest,
  releaseDqAssetToOperations,
  resolveDqException,
  runDqChecks,
  runTopologyDqScan,
  cancelTopologyDqScan,
  runValidationCycle,
  getActiveTopologyScan,
  type GiopTopologyScanProgress,
  type GiopValidationProgress,
  type GiopAgentsStatus,
  type GiopApprovalRequest,
  type GiopTopologyProposal,
  type GiopDqException,
  type GiopDqQueueItem,
  type GiopDqSummary,
  type GiopKpiSnapshot,
  type GiopTopologyDqSummary,
} from '../api/giop-api';
import { useGiopMapOverlay } from '../context/GiopMapOverlayContext';
import {
  formatDqCoordinates,
  partitionDqQueueItems,
  queueItemDuplicateDetected,
  type DqQueueLocationCluster,
} from '../lib/giopDqLocationClusters';
import { clearSwCache, readSwCache, writeSwCache } from '../lib/giopSwCache';
import { ValidationRunModal } from './ValidationRunModal';
import { ValidationRunProgressContent } from './ValidationRunProgressContent';
import {
  fetchValidationRunProgressOnce,
  useValidationRunProgress,
} from '../hooks/useValidationRunProgress';
import { isValidationTerminal } from './validationRunShared';
import {
  DqDataTierSwitch,
  DqTierMetricsPanel,
  type DqDataTier,
} from './DqTierMetricsPanel';
import { DqExceptionIssueRow } from './DqExceptionIssueRow';
import { DqQueueRecordSummary } from './DqQueueRecordSummary';
import { DqQueueToolbar } from './DqQueueToolbar';
import { DqDuplicateDiffStrip } from './DqDuplicateDiffStrip';
import { DqDuplicateTimeline } from './DqDuplicateTimeline';
import { DqDuplicatePhotoCompare } from './DqDuplicatePhotoCompare';
import {
  buildDuplicateClusterOverlay,
  buildSingletonNearDuplicateOverlay,
  clusterDuplicateMode,
  duplicateFlyCoordinatesForCluster,
  duplicateFlyCoordinatesForMrid,
} from '../lib/giopDuplicateFan';
import {
  buildDuplicateDiffFields,
  buildDuplicateTimeline,
  collectDuplicatePhotos,
} from '../lib/giopDqDuplicateDiff';
import { DUPLICATE_CLUSTER_ZOOM } from '../lib/giopMapLayers';
import { GiopImportQueuePanel } from './GiopImportQueuePanel';
import { TopologyScanModal } from './TopologyScanModal';
import { useTopologyScanProgress } from '../hooks/useTopologyScanProgress';

function topoSummaryCacheKey(tier: DqDataTier, mode: 'snapshot' | 'live'): string {
  return `dq-topology-summary:${tier}:${mode}`;
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

function readTopoSummaryCache(tier: DqDataTier = 'master'): GiopTopologyDqSummary | null {
  const cached = normalizeTopoSummary(readSwCache(topoSummaryCacheKey(tier, 'snapshot')));
  if (!cached) clearSwCache(topoSummaryCacheKey(tier, 'snapshot'));
  return cached;
}

interface GiopDataQualityTabProps {
  isLightMode: boolean;
}

function severityBadge(severity: string, isLightMode: boolean): string {
  if (isLightMode) {
    switch (severity) {
      case 'critical':
        return 'bg-red-100 text-red-800';
      case 'major':
        return 'bg-amber-100 text-amber-900';
      case 'minor':
        return 'bg-blue-100 text-blue-900';
      default:
        return 'bg-slate-100 text-slate-700';
    }
  }
  switch (severity) {
    case 'critical':
      return 'bg-premium-danger-bg text-premium-danger-fg border border-premium-danger-border/40';
    case 'major':
      return 'bg-premium-warn-bg text-premium-warn-fg border border-premium-warn-border/40';
    case 'minor':
      return 'bg-premium-accent-subtle text-premium-accent border border-premium-accent/25';
    default:
      return 'bg-premium-hover text-premium-muted border border-premium-border/40';
  }
}

export function GiopDataQualityTab({ isLightMode }: GiopDataQualityTabProps) {
  const {
    focusOnMap,
    sideMap,
    bumpSidePanelFly,
    setDuplicateClusterOverlay,
    clearDuplicateClusterOverlay,
  } = useGiopMapOverlay();
  const [mapBusyId, setMapBusyId] = useState<string | null>(null);
  const [queueItems, setQueueItems] = useState<GiopDqQueueItem[]>([]);
  const [dqTier, setDqTier] = useState<DqDataTier>('master');
  const [summaryByTier, setSummaryByTier] = useState<Partial<Record<DqDataTier, GiopDqSummary>>>({});
  const [topoByTier, setTopoByTier] = useState<Partial<Record<DqDataTier, GiopTopologyDqSummary>>>(() => {
    const master = readTopoSummaryCache('master');
    return master ? { master } : {};
  });
  const [topoLoadingTier, setTopoLoadingTier] = useState<DqDataTier | null>(() =>
    readTopoSummaryCache('master') ? null : 'master',
  );
  const [topoRevalidatingTier, setTopoRevalidatingTier] = useState<DqDataTier | null>(null);
  const [topoLiveBusy, setTopoLiveBusy] = useState(false);
  const [statusFilter, setStatusFilter] = useState('ALL');
  const [duplicatesOnly, setDuplicatesOnly] = useState(false);
  const [severityFilter, setSeverityFilter] = useState('');
  const [domainFilter, setDomainFilter] = useState('');
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(50);
  const [totalQueueItems, setTotalQueueItems] = useState(0);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState('');
  const [queueError, setQueueError] = useState<string | null>(null);
  type DqWorkspaceView = 'queue' | 'topology' | 'import' | 'approvals';
  const [workspaceView, setWorkspaceView] = useState<DqWorkspaceView>('queue');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [releaseBusyMrid, setReleaseBusyMrid] = useState<string | null>(null);
  const [scanBusy, setScanBusy] = useState(false);
  const [scanRunId, setScanRunId] = useState<string | null>(null);
  const [scanModalOpen, setScanModalOpen] = useState(false);
  const [scanStartedMs, setScanStartedMs] = useState(0);
  const [cancelScanBusy, setCancelScanBusy] = useState(false);
  const scanTerminalHandledRef = useRef<string | null>(null);
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
  const [reviewMrid, setReviewMrid] = useState<string | null>(null);
  const activeMapCardRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!reviewMrid) return;
    activeMapCardRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [reviewMrid]);

  const card = isLightMode ? 'border-slate-200 bg-white' : 'border-premium-border/45 bg-premium-card';
  const muted = isLightMode ? 'text-slate-500' : 'text-premium-muted';

  const topoSummary = topoByTier[dqTier] ?? null;
  const summary = summaryByTier[dqTier] ?? null;
  const topoLoading = topoLoadingTier === dqTier;
  const topoRevalidating = topoRevalidatingTier === dqTier;

  const loadSummaryForTier = useCallback(async (tier: DqDataTier) => {
    try {
      const sum = await getDqSummary({ tier });
      setSummaryByTier((prev) => ({ ...prev, [tier]: sum }));
    } catch {
      setSummaryByTier((prev) => ({ ...prev, [tier]: undefined }));
    }
  }, []);

  const loadQueue = useCallback(async () => {
    setLoading(true);
    setQueueError(null);
    try {
      const pageData = await listDqQueue({
        status: statusFilter === 'ALL' ? undefined : statusFilter,
        duplicatesOnly,
        severity: severityFilter || undefined,
        domain: domainFilter || undefined,
        limit: pageSize,
        offset: page * pageSize,
      });
      setQueueItems(Array.isArray(pageData.items) ? pageData.items : []);
      setTotalQueueItems(pageData.total ?? 0);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load queue';
      setQueueError(message);
      setStatus(message);
      setQueueItems([]);
      setTotalQueueItems(0);
    } finally {
      setLoading(false);
    }
  }, [statusFilter, duplicatesOnly, severityFilter, domainFilter, page, pageSize]);

  const loadExtras = useCallback(async () => {
    try {
      const [pending, readyToPublish, kpiSnap] = await Promise.all([
        listPendingApprovals().catch(() => []),
        listApprovedProposals().catch(() => []),
        getLatestKpis().catch(() => null),
      ]);
      setApprovals(pending);
      setApprovedProposals(readyToPublish);
      setKpis(kpiSnap);
    } catch {
      /* sidebar extras are non-blocking */
    }
  }, []);

  const load = useCallback(async () => {
    await Promise.all([loadQueue(), loadExtras()]);
  }, [loadQueue, loadExtras]);

  useEffect(() => {
    setPage(0);
  }, [statusFilter, duplicatesOnly, severityFilter, domainFilter, pageSize]);

  const queueLookup = useMemo(
    () => new Map(queueItems.map((item) => [item.mrid, item])),
    [queueItems],
  );

  useEffect(() => {
    if (!reviewMrid) {
      clearDuplicateClusterOverlay();
      return;
    }
    const { clusters, singletons } = partitionDqQueueItems(queueItems);
    const cluster = clusters.find(
      (entry) =>
        entry.items.some((item) => item.mrid === reviewMrid) ||
        entry.peers.some((peer) => peer.mrid === reviewMrid),
    );
    if (cluster) {
      setDuplicateClusterOverlay(
        buildDuplicateClusterOverlay(cluster, reviewMrid, queueLookup, isLightMode),
      );
      return;
    }
    const singleton = singletons.find((item) => item.mrid === reviewMrid);
    if (singleton && queueItemDuplicateDetected(singleton)) {
      const overlay = buildSingletonNearDuplicateOverlay(singleton, queueLookup, isLightMode);
      if (overlay) {
        setDuplicateClusterOverlay(overlay);
        return;
      }
    }
    clearDuplicateClusterOverlay();
  }, [
    reviewMrid,
    queueItems,
    queueLookup,
    isLightMode,
    setDuplicateClusterOverlay,
    clearDuplicateClusterOverlay,
  ]);

  useEffect(() => {
    return () => {
      clearDuplicateClusterOverlay();
    };
  }, [clearDuplicateClusterOverlay]);

  const loadTopo = useCallback(async (tier: DqDataTier, mode: 'snapshot' | 'live' = 'snapshot') => {
    const cacheKey = topoSummaryCacheKey(tier, mode);
    const cached = mode === 'snapshot' ? normalizeTopoSummary(readSwCache(cacheKey)) : null;
    const hadCache = cached !== null;

    if (mode === 'live') {
      setTopoLiveBusy(true);
    } else if (cached) {
      setTopoByTier((prev) => ({ ...prev, [tier]: cached }));
      setTopoLoadingTier(null);
      setTopoRevalidatingTier(tier);
    } else {
      setTopoLoadingTier(tier);
    }

    try {
      const topo = normalizeTopoSummary(await getTopologyDqSummary({ mode, tier }));
      if (topo) {
        writeSwCache(cacheKey, topo);
        setTopoByTier((prev) => ({ ...prev, [tier]: topo }));
      } else if (!hadCache && mode === 'snapshot') {
        setTopoByTier((prev) => ({ ...prev, [tier]: undefined }));
      }
    } catch {
      if (!hadCache && mode === 'snapshot') {
        setTopoByTier((prev) => ({ ...prev, [tier]: undefined }));
      }
    } finally {
      if (mode === 'live') setTopoLiveBusy(false);
      else {
        setTopoLoadingTier(null);
        setTopoRevalidatingTier(null);
      }
    }
  }, []);

  const handleScanComplete = useCallback(
    async (progress: GiopTopologyScanProgress) => {
      if (scanTerminalHandledRef.current === progress.run_id) return;
      scanTerminalHandledRef.current = progress.run_id;
      if (progress.status === 'completed') {
        setStatus(
          `Scan complete: ${(progress.orphans_found ?? 0).toLocaleString()} orphans, ` +
            `${(progress.dangling_found ?? 0).toLocaleString()} dangling, ` +
            `${(progress.auto_cleared ?? 0).toLocaleString()} auto-cleared`,
        );
        clearSwCache(topoSummaryCacheKey('master', 'snapshot'));
        await Promise.all([load(), loadTopo('master'), loadSummaryForTier('master')]);
      } else if (progress.status === 'failed') {
        setStatus(progress.error_message ?? 'Topology scan failed');
      }
      setScanBusy(false);
    },
    [load, loadTopo, loadSummaryForTier],
  );

  const {
    progress: scanProgress,
    pollError: scanPollError,
    reset: resetScanProgress,
  } = useTopologyScanProgress(scanRunId, Boolean(scanRunId), (p) => {
    void handleScanComplete(p);
  });

  const beginTopologyScan = useCallback(async () => {
    if (scanBusy && scanRunId) {
      setScanModalOpen(true);
      return;
    }
    setScanBusy(true);
    scanTerminalHandledRef.current = null;
    resetScanProgress();
    try {
      const queued = await runTopologyDqScan();
      setScanRunId(queued.run_id);
      setScanStartedMs(Date.now());
      setScanModalOpen(true);
      const estMin = Math.max(1, Math.ceil((queued.estimate_seconds ?? 420) / 60));
      setStatus(
        queued.message ??
          `Scan ${queued.run_id.slice(0, 8)}… running (~${estMin} min estimated)`,
      );
    } catch (err) {
      setStatus(err instanceof Error ? err.message : 'Topology scan failed');
      setScanBusy(false);
    }
  }, [scanBusy, scanRunId, resetScanProgress]);

  const handleCancelTopologyScan = useCallback(async () => {
    if (!scanRunId || cancelScanBusy) return;
    setCancelScanBusy(true);
    setStatus('Cancelling topology scan…');
    try {
      const result = await cancelTopologyDqScan(scanRunId);
      setStatus(result.message ?? 'Topology scan cancelled');
      setScanBusy(false);
      // Leave runId so the progress poll can show the failed/cancelled state.
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to cancel topology scan';
      setStatus(
        /not found|404/i.test(message)
          ? 'Cancel endpoint missing — restart sync-service, then try Cancel again.'
          : message,
      );
    } finally {
      setCancelScanBusy(false);
    }
  }, [scanRunId, cancelScanBusy]);

  useEffect(() => {
    void (async () => {
      try {
        const { active } = await getActiveTopologyScan();
        if (active?.run_id && active.status === 'running') {
          setScanRunId(active.run_id);
          setScanStartedMs(
            active.started_at ? new Date(active.started_at).getTime() : Date.now(),
          );
          setScanBusy(true);
        }
      } catch {
        /* non-blocking */
      }
    })();
  }, []);

  useEffect(() => {
    void loadQueue();
  }, [loadQueue]);

  useEffect(() => {
    void loadExtras();
  }, [loadExtras]);

  useEffect(() => {
    void loadTopo(dqTier);
    void loadSummaryForTier(dqTier);
  }, [dqTier, loadTopo, loadSummaryForTier]);

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

  const handleReleaseToOperations = async (mrid: string) => {
    setReleaseBusyMrid(mrid);
    setStatus('');
    try {
      await releaseDqAssetToOperations(mrid);
      setStatus(`Released ${mrid.slice(0, 8)}… to Operations`);
      await load();
    } catch (err) {
      setStatus(err instanceof Error ? err.message : 'Release to Operations failed');
    } finally {
      setReleaseBusyMrid(null);
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

  const focusQueueReview = useCallback(
    async (item: GiopDqQueueItem) => {
      if (!item.mrid?.trim()) {
        setStatus('No map location available for this capture');
        return;
      }
      setReviewMrid(item.mrid);
      setStatus('');
      const duplicateCluster = queueItemDuplicateDetected(item);
      const flyCoordinates = duplicateCluster
        ? duplicateFlyCoordinatesForMrid(queueItems, item.mrid, queueLookup)
        : null;
      try {
        await focusOnMap(item.mrid, {
          name: item.name ?? undefined,
          coordinates:
            item.longitude != null && item.latitude != null
              ? [item.longitude, item.latitude]
              : null,
          sidePanel: true,
          source: 'table',
          duplicateCluster,
          flyCoordinates,
        });
      } catch (err) {
        setStatus(err instanceof Error ? err.message : 'Could not focus map on record');
      }
    },
    [focusOnMap, queueItems, queueLookup],
  );

  const handleShowQueueOnMap = useCallback(
    async (item: GiopDqQueueItem) => {
      setMapBusyId(item.mrid);
      try {
        await focusQueueReview(item);
      } finally {
        setMapBusyId(null);
      }
    },
    [focusQueueReview],
  );

  useEffect(() => {
    // Keep review selection in sync when the queue refreshes, but do not auto-pick
    // the first item — let stewards choose what to put on the map.
    if (!reviewMrid) return;
    if (queueItems.some((q) => q.mrid === reviewMrid)) return;
    setReviewMrid(null);
  }, [queueItems, reviewMrid]);

  useEffect(() => {
    if (!sideMap.mrid) return;
    if (queueItems.some((q) => q.mrid === sideMap.mrid)) {
      setReviewMrid(sideMap.mrid);
    }
  }, [sideMap.mrid, queueItems]);

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
      await loadTopo('master', 'live');
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

  const handleTopologyScan = () => {
    void beginTopologyScan();
  };

  const handleRefreshLive = () => {
    if (dqTier === 'master') {
      void beginTopologyScan();
      return;
    }
    void loadTopo(dqTier, 'live');
  };

  const validationBadgeClass = (validation?: string): string => {
    if (isLightMode) {
      if (validation === 'IN_CONFLICT') return 'bg-red-100 text-red-800';
      if (validation === 'PENDING_FIELD') return 'bg-amber-100 text-amber-900';
      return 'bg-slate-100 text-slate-700';
    }
    if (validation === 'IN_CONFLICT') return 'bg-red-950/35 text-red-300/90 border border-red-900/25';
    if (validation === 'PENDING_FIELD') {
      return 'bg-premium-warn-bg text-premium-warn-fg border border-premium-warn-border/40';
    }
    return 'bg-premium-hover text-premium-muted border border-premium-border/40';
  };

  const reviewSelectionClass = isLightMode
    ? 'border-cyan-500 bg-cyan-50 ring-1 ring-cyan-400/40 shadow-sm'
    : 'border-premium-accent/35 bg-premium-accent/[0.07] ring-1 ring-premium-accent/15';

  const reviewTabActiveClass = isLightMode
    ? 'border-cyan-500 bg-cyan-50 text-cyan-950 ring-1 ring-cyan-400/50 font-medium'
    : 'border-premium-accent/40 bg-premium-accent/[0.1] text-premium-text ring-1 ring-premium-accent/20 font-medium';

  const renderQueueCard = (
    item: GiopDqQueueItem,
    nested = false,
    options?: { inspector?: boolean },
  ) => {
    const inspector = options?.inspector ?? false;
    const isReviewing = reviewMrid === item.mrid;
    const duplicateDetected = queueItemDuplicateDetected(item);
    return (
      <div
        key={item.mrid}
        ref={isReviewing && (!nested || inspector) ? activeMapCardRef : undefined}
        role={inspector ? undefined : 'button'}
        tabIndex={inspector ? undefined : 0}
        onClick={inspector ? undefined : () => void focusQueueReview(item)}
        onKeyDown={
          inspector
            ? undefined
            : (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  void focusQueueReview(item);
                }
              }
        }
        className={`rounded-lg border text-sm transition-colors ${
          inspector ? '' : 'cursor-pointer'
        } ${nested ? 'p-2.5' : 'p-3'} ${
          isReviewing
            ? reviewSelectionClass
            : nested
              ? isLightMode
                ? 'border-slate-200 bg-white hover:border-slate-300'
                : 'border-premium-border/45 bg-premium-card/90 hover:border-premium-border-subtle/60'
              : `${card} hover:border-premium-accent/25`
        }`}
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2 flex-wrap">
            <span className={`px-2 py-0.5 rounded text-xs ${validationBadgeClass(item.validation)}`}>
              {item.validation}
            </span>
            {duplicateDetected && (
              <span className="text-xs px-2 py-0.5 rounded bg-premium-warn-bg text-premium-warn-fg border border-premium-warn-border/40">
                Duplicate detected
              </span>
            )}
            {item.open_exception_count > 0 ? (
              <span className={`px-2 py-0.5 rounded text-xs ${severityBadge('major', isLightMode)}`}>
                {item.open_exception_count} issue{item.open_exception_count === 1 ? '' : 's'}
              </span>
            ) : !duplicateDetected ? (
              <span
                className={`text-xs px-2 py-0.5 rounded ${
                  isLightMode
                    ? 'bg-emerald-100 text-emerald-800'
                    : 'bg-emerald-950/30 text-emerald-300/90 border border-emerald-900/25'
                }`}
              >
                Clean
              </span>
            ) : null}
            {isReviewing && (
              <span
                className={`px-2 py-0.5 rounded text-xs font-medium ${
                  isLightMode ? 'bg-cyan-600 text-white' : 'bg-premium-accent/20 text-premium-accent border border-premium-accent/25'
                }`}
              >
                On map
              </span>
            )}
          </div>
          <span className={`text-xs font-semibold ${isLightMode ? 'text-slate-800' : 'text-premium-text-secondary'}`}>
            {item.name || 'Unnamed capture'}
          </span>
        </div>

        <DqQueueRecordSummary item={item} isLightMode={isLightMode} compact={nested} />

        {item.exceptions.length > 0 && (
          <div className="mt-2">
            <p className={`text-xs font-medium mb-1.5 ${muted}`}>
              Validation issues ({item.open_exception_count || item.exceptions.length})
            </p>
            <ul className="space-y-1.5">
              {item.exceptions.map((ex) => (
                <DqExceptionIssueRow
                  key={ex.id}
                  item={ex}
                  isLightMode={isLightMode}
                  busy={busyId === ex.id}
                  onSuggestFix={
                    ex.status === 'OPEN' ? () => void handleSuggestFix(ex) : undefined
                  }
                  onResolve={
                    ex.status === 'OPEN'
                      ? (action) => void handleResolve(ex, action)
                      : undefined
                  }
                />
              ))}
            </ul>
          </div>
        )}

        <div className="flex flex-wrap gap-2 mt-2" onClick={(e) => e.stopPropagation()}>
          <button
            type="button"
            disabled={mapBusyId === item.mrid}
            className={`text-xs px-2 py-1 rounded disabled:opacity-50 ${
              isLightMode
                ? 'bg-slate-700 text-white'
                : 'border border-premium-border/50 bg-premium-hover text-premium-text-secondary hover:bg-premium-hover-strong'
            }`}
            onClick={() => void handleShowQueueOnMap(item)}
          >
            {mapBusyId === item.mrid ? 'Panning…' : 'Show on map'}
          </button>
          <button
            type="button"
            disabled={busyId === item.mrid}
            className={`text-xs px-2 py-1 rounded disabled:opacity-50 giop-btn-primary ${
              isLightMode ? 'giop-btn-primary--light' : 'giop-btn-primary--dark'
            }`}
            onClick={async () => {
              setBusyId(item.mrid);
              try {
                await runDqChecks(item.mrid, 'staging');
                await load();
              } catch (err) {
                setStatus(err instanceof Error ? err.message : 'Re-check failed');
              } finally {
                setBusyId(null);
              }
            }}
          >
            Re-check
          </button>
          {item.can_release_to_operations && (
            <button
              type="button"
              disabled={releaseBusyMrid === item.mrid}
              className="text-xs px-2 py-1 bg-blue-800 rounded text-white disabled:opacity-50"
              onClick={() => void handleReleaseToOperations(item.mrid)}
            >
              {releaseBusyMrid === item.mrid ? 'Releasing…' : 'Release to Operations'}
            </button>
          )}
        </div>
      </div>
    );
  };

  const { clusters, singletons } = useMemo(
    () => partitionDqQueueItems(queueItems),
    [queueItems],
  );

  const focusDuplicateClusterPeer = useCallback(
    async (cluster: DqQueueLocationCluster, mrid: string) => {
      if (!mrid.trim()) return;
      const peer = cluster.peers.find((p) => p.mrid === mrid);
      const queueItem = queueLookup.get(mrid);
      const center: [number, number] | null =
        cluster.longitude != null && cluster.latitude != null
          ? [cluster.longitude, cluster.latitude]
          : null;
      const flyCoordinates =
        duplicateFlyCoordinatesForCluster(cluster, mrid, queueLookup) ?? center;

      setReviewMrid(mrid);
      setStatus('');

      const overlay = buildDuplicateClusterOverlay(cluster, mrid, queueLookup, isLightMode);
      if (overlay) setDuplicateClusterOverlay(overlay);

      if (flyCoordinates) {
        bumpSidePanelFly(flyCoordinates, true, DUPLICATE_CLUSTER_ZOOM);
      }

      try {
        await focusOnMap(mrid, {
          name: peer?.name ?? queueItem?.name ?? undefined,
          coordinates: center,
          sidePanel: true,
          source: 'table',
          duplicateCluster: true,
          flyCoordinates,
        });
      } catch (err) {
        setStatus(err instanceof Error ? err.message : 'Could not focus map on record');
      }
    },
    [bumpSidePanelFly, focusOnMap, isLightMode, queueLookup, setDuplicateClusterOverlay],
  );

  const selectClusterPeer = useCallback(
    (cluster: DqQueueLocationCluster, mrid: string) => {
      void focusDuplicateClusterPeer(cluster, mrid);
    },
    [focusDuplicateClusterPeer],
  );

  const renderQueueCluster = (cluster: DqQueueLocationCluster) => {
    const coords = formatDqCoordinates(cluster.longitude, cluster.latitude);
    const openIssues = cluster.items.reduce((sum, item) => sum + item.open_exception_count, 0);
    const itemsByMrid = new Map(cluster.items.map((item) => [item.mrid, item]));
    const uniquePeers = cluster.peers.filter(
      (peer, index, peers) => peers.findIndex((p) => p.mrid === peer.mrid) === index,
    );
    const peerMrids = new Set(uniquePeers.map((p) => p.mrid));
    const activeMrid =
      reviewMrid && peerMrids.has(reviewMrid)
        ? reviewMrid
        : uniquePeers[0]?.mrid ?? cluster.items[0]?.mrid ?? null;
    const activeItem = activeMrid ? itemsByMrid.get(activeMrid) : undefined;
    const activePeer = uniquePeers.find((p) => p.mrid === activeMrid);
    const loadedPeers = cluster.items;
    const diffFields =
      activeMrid && loadedPeers.length > 1
        ? buildDuplicateDiffFields(loadedPeers, activeMrid)
        : [];
    const timeline =
      activeMrid && loadedPeers.length > 1
        ? buildDuplicateTimeline(loadedPeers, activeMrid)
        : [];
    const photos =
      activeMrid && loadedPeers.length > 1
        ? collectDuplicatePhotos(loadedPeers, activeMrid)
        : [];
    const duplicateMode = clusterDuplicateMode(cluster);

    return (
      <div
        key={cluster.locationKey}
        className={`rounded-lg border overflow-hidden ${
          isLightMode
            ? 'border-amber-300 bg-amber-50/60'
            : 'border-premium-warn-border/35 bg-premium-warn-bg-subtle'
        }`}
      >
        <div
          className={`px-3 py-2.5 border-b flex flex-wrap items-start justify-between gap-2 ${
            isLightMode
              ? 'border-amber-200 bg-amber-100/80'
              : 'border-premium-warn-border/25 bg-premium-warn-bg/60'
          }`}
        >
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span
                className={`inline-flex items-center justify-center min-w-[1.75rem] h-7 px-2 rounded-full text-xs font-semibold ${
                  isLightMode
                    ? 'bg-amber-500 text-white'
                    : 'bg-premium-warn-bg text-premium-warn-fg border border-premium-warn-border/50'
                }`}
                title="Records at this coordinate"
              >
                {cluster.colocatedCount}
              </span>
              <p className="text-sm font-semibold">
                {duplicateMode === 'near'
                  ? `${cluster.colocatedCount} near-duplicate capture${cluster.colocatedCount === 1 ? '' : 's'}`
                  : `${cluster.colocatedCount} staging captures share one map pin`}
              </p>
              <span
                className={`text-xs px-2 py-0.5 rounded ${
                  isLightMode
                    ? 'bg-amber-200 text-amber-950'
                    : 'bg-premium-hover text-premium-warn-fg-muted border border-premium-warn-border/30'
                }`}
              >
                {duplicateMode === 'exact'
                  ? 'Exact pin stack'
                  : duplicateMode === 'near'
                    ? 'Near duplicate'
                    : 'Exact + near'}
              </span>
            </div>
            <p className={`text-xs mt-1 ${muted}`}>
              {coords ? `${coords} · ` : ''}
              {openIssues} open issue{openIssues === 1 ? '' : 's'} in this stack
              {duplicateMode !== 'exact' ? ' · fan map shows offset pins + distance line' : ' · fan map shows offset pins'}
            </p>
          </div>
          <button
            type="button"
            disabled={!activeMrid || mapBusyId === activeMrid}
            className={`text-xs px-2 py-1 rounded disabled:opacity-50 shrink-0 ${
              isLightMode
                ? 'bg-slate-700 text-white'
                : 'border border-premium-border/50 bg-premium-hover text-premium-text-secondary hover:bg-premium-hover-strong'
            }`}
            onClick={() => {
              if (activeMrid) {
                setMapBusyId(activeMrid);
                void focusDuplicateClusterPeer(cluster, activeMrid).finally(() =>
                  setMapBusyId(null),
                );
              }
            }}
          >
            {mapBusyId === activeMrid ? 'Panning…' : 'Show pin on map'}
          </button>
        </div>
        <div className="px-3 py-2">
          <p className={`text-xs font-medium mb-1.5 ${muted}`}>
            Select a record to inspect ({uniquePeers.length})
          </p>
          <ul className="flex flex-wrap gap-1.5 mb-3" role="tablist" aria-label="Records at this location">
            {uniquePeers.map((peer) => {
              const isActive = peer.mrid === activeMrid;
              const queueItem = itemsByMrid.get(peer.mrid);
              return (
                <li key={peer.mrid} role="presentation">
                  <button
                    type="button"
                    role="tab"
                    aria-selected={isActive}
                    className={`text-xs px-2 py-1 rounded border transition-colors ${
                      isActive
                        ? reviewTabActiveClass
                        : queueItem
                          ? isLightMode
                            ? 'border-amber-400 bg-white text-amber-950 hover:bg-amber-50'
                            : 'border-premium-warn-border/40 bg-premium-warn-bg/50 text-premium-warn-fg hover:bg-premium-warn-bg'
                          : isLightMode
                            ? 'border-slate-200 bg-white text-slate-600 hover:border-cyan-400'
                            : 'border-premium-border/45 bg-premium-card/80 text-premium-text-secondary hover:border-premium-accent/30 hover:bg-premium-hover/60'
                    }`}
                    title={peer.mrid}
                    onClick={() => selectClusterPeer(cluster, peer.mrid)}
                  >
                    {peer.name || peer.mrid.slice(0, 8)}
                    {peer.validation ? ` · ${peer.validation}` : ''}
                  </button>
                </li>
              );
            })}
          </ul>
          {loadedPeers.length > 1 ? (
            <div className="space-y-2 mb-3">
              <DqDuplicateDiffStrip
                fields={diffFields}
                isLightMode={isLightMode}
                peerCount={uniquePeers.length}
              />
              <DqDuplicateTimeline
                entries={timeline}
                isLightMode={isLightMode}
                onSelect={(mrid) => selectClusterPeer(cluster, mrid)}
              />
              <DqDuplicatePhotoCompare
                photos={photos}
                isLightMode={isLightMode}
                onSelect={(mrid) => selectClusterPeer(cluster, mrid)}
              />
            </div>
          ) : null}
          {activeItem ? (
            renderQueueCard(activeItem, true, { inspector: true })
          ) : activeMrid && activePeer ? (
            <div
              className={`rounded-lg border p-3 text-sm ${
                isLightMode ? 'border-slate-200 bg-white' : 'border-premium-border/45 bg-premium-card/90'
              }`}
            >
              <p className="font-medium">{activePeer.name || 'Unnamed capture'}</p>
              <p className={`text-xs mt-1 ${muted}`}>
                Full capture details are not on this page. Increase per-page size or refresh.
              </p>
              <button
                type="button"
                className={`text-xs px-2 py-1 mt-2 rounded ${
                  isLightMode
                    ? 'bg-slate-700 text-white'
                    : 'border border-premium-border/50 bg-premium-hover text-premium-text-secondary hover:bg-premium-hover-strong'
                }`}
                onClick={() =>
                  void focusOnMap(activeMrid, {
                    name: activePeer.name ?? undefined,
                    coordinates:
                      cluster.longitude != null && cluster.latitude != null
                        ? [cluster.longitude, cluster.latitude]
                        : null,
                    sidePanel: true,
                    source: 'table',
                  })
                }
              >
                Show on map
              </button>
            </div>
          ) : null}
        </div>
      </div>
    );
  };

  const filtersActive =
    statusFilter !== 'ALL' || duplicatesOnly || Boolean(severityFilter) || Boolean(domainFilter);
  const pendingApprovalCount = approvals.length + approvedProposals.length;

  const workspaceTabs: Array<{ id: DqWorkspaceView; label: string; badge?: number }> = [
    { id: 'queue', label: 'Queue' },
    { id: 'topology', label: 'Topology health' },
    { id: 'import', label: dqTier === 'master' ? 'Import pipeline' : 'Endpoint fixes' },
    {
      id: 'approvals',
      label: 'Approvals',
      badge: pendingApprovalCount > 0 ? pendingApprovalCount : undefined,
    },
  ];

  const renderApprovalsPanel = () => (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        {agentsStatus && (
          <p className={`text-xs ${muted}`}>
            Engine: {agentsStatus.engine}
            {' · '}
            Copilot:{' '}
            {agentsStatus.llm_configured
              ? agentsStatus.llm_reachable === false
                ? `unreachable (${agentsStatus.llm_model})`
                : agentsStatus.llm_model ?? 'connected'
              : 'rules-only'}
            {agentsStatus.cleanup_llm_distinct ? (
              <>
                {' · '}
                Cleanup agent:{' '}
                {agentsStatus.cleanup_llm_configured
                  ? agentsStatus.cleanup_llm_reachable === false
                    ? `unreachable (${agentsStatus.cleanup_llm_model})`
                    : agentsStatus.cleanup_llm_model ?? 'connected'
                  : 'rules-only'}
              </>
            ) : null}
            {agentsStatus.llm_configured && agentsStatus.llm_tool_count
              ? ` · ${agentsStatus.llm_tool_count} tools`
              : ''}
          </p>
        )}
        <div className="flex gap-2 ml-auto">
          <button
            type="button"
            disabled={validationBusy}
            onClick={() => void handleValidationRun('deterministic')}
            className={`rounded border text-xs py-1 px-2 disabled:opacity-50 ${
              isLightMode
                ? 'border-slate-300 text-slate-700 hover:bg-slate-100'
                : 'border-premium-border/50 text-premium-text-secondary hover:bg-premium-hover'
            }`}
          >
            {validationBusy ? 'Running…' : 'Run validation cycle'}
          </button>
          <button
            type="button"
            disabled={validationBusy}
            onClick={() => void handleValidationRun('agent')}
            className={`rounded text-xs py-1 px-2 disabled:opacity-50 giop-btn-primary ${
              isLightMode ? 'giop-btn-primary--light' : 'giop-btn-primary--dark'
            }`}
          >
            Run agent cycle
          </button>
        </div>
      </div>
      {validationBusy && validationRunId && validationRunId !== 'pending' && !validationModalOpen && (
        <div
          className={`rounded-lg border p-3 ${
            isLightMode
              ? 'border-cyan-200 bg-cyan-50/80'
              : 'border-premium-accent/25 bg-premium-accent/[0.06]'
          }`}
        >
          <div className="flex items-center justify-between gap-2 mb-2">
            <p
              className={`text-xs font-semibold ${
                isLightMode ? 'text-cyan-800' : 'text-premium-text'
              }`}
            >
              Validation cycle in progress
            </p>
            <button
              type="button"
              className={`text-xs underline ${
                isLightMode ? 'text-cyan-700' : 'text-premium-accent'
              }`}
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
        <ul className={`text-xs space-y-1 ${isLightMode ? 'text-amber-700' : 'text-premium-warn-fg'}`}>
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
              className={`rounded border p-2 text-xs ${isLightMode ? 'border-slate-200' : 'border-premium-border/70'}`}
            >
              <p className="font-medium">
                {a.rule_code ?? 'Cleanup'} · {a.severity ?? a.cleanup_mode}
              </p>
              <p className={muted}>{a.rationale ?? a.error_message}</p>
              {formatChangeSummary(a.change_summary as Record<string, unknown> | null) && (
                <p className={`mt-1 ${isLightMode ? 'text-cyan-700' : 'text-premium-accent'}`}>
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
              className={`rounded border p-2 text-xs ${isLightMode ? 'border-emerald-200 bg-emerald-50/50' : 'border-premium-success-border/50 bg-premium-success-bg/80'}`}
            >
              <p className="font-medium">
                {p.rule_code ?? 'Topology repair'} · {p.severity ?? 'approved'}
              </p>
              <p className={muted}>{p.ai_rationale ?? p.exception_message}</p>
              {formatChangeSummary(p.change_summary as Record<string, unknown> | null) && (
                <p className={`mt-1 ${isLightMode ? 'text-emerald-700' : 'text-premium-success-fg'}`}>
                  Dry-run: {formatChangeSummary(p.change_summary as Record<string, unknown> | null)}
                </p>
              )}
              <div className="flex gap-2 mt-2">
                <button
                  type="button"
                  disabled={busyId === p.id}
                  onClick={() => void handlePublishProposal(p.id)}
                  className="px-2 py-0.5 rounded bg-premium-hover-strong border border-premium-border/50 text-premium-text-secondary hover:bg-premium-hover disabled:opacity-50"
                >
                  Publish to master
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
      {!kpis && approvals.length === 0 && approvedProposals.length === 0 && !validationBusy && (
        <p className={`text-sm ${muted}`}>
          No pending approvals or KPI snapshot yet. Run a validation or agent cycle to populate this
          view.
        </p>
      )}
    </div>
  );

  return (
    <div className="h-full min-h-0 flex flex-col overflow-hidden">
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

      {scanRunId && (
        <TopologyScanModal
          open={scanModalOpen}
          runId={scanRunId}
          isLightMode={isLightMode}
          localStartedMs={scanStartedMs}
          progress={scanProgress}
          pollError={scanPollError}
          onClose={() => setScanModalOpen(false)}
          onRunInBackground={() => setScanModalOpen(false)}
          onCancel={() => void handleCancelTopologyScan()}
          cancelBusy={cancelScanBusy}
        />
      )}

      <div
        className={`shrink-0 px-4 pt-3 pb-2 space-y-2 border-b ${
          isLightMode ? 'border-slate-200/70' : 'border-premium-border/45'
        }`}
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <p className={`text-sm font-semibold ${isLightMode ? 'text-slate-900' : 'text-premium-text'}`}>
              Data quality
            </p>
            <p className={`text-xs ${muted}`}>
              Review captures → resolve issues → release to Operations
            </p>
          </div>
          <div
            className={`inline-flex p-1 rounded-xl border ${
              isLightMode
                ? 'bg-slate-100/90 border-slate-200'
                : 'bg-premium-surface border-premium-border/50'
            }`}
            role="tablist"
            aria-label="Data quality workspace"
          >
            {workspaceTabs.map((tab) => {
              const active = workspaceView === tab.id;
              return (
                <button
                  key={tab.id}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  onClick={() => setWorkspaceView(tab.id)}
                  className={`relative px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                    active
                      ? isLightMode
                        ? 'bg-white text-slate-900 shadow-sm'
                        : 'bg-premium-card text-premium-text shadow-sm'
                      : isLightMode
                        ? 'text-slate-500 hover:text-slate-700'
                        : 'text-premium-muted hover:text-premium-text-secondary'
                  }`}
                >
                  {tab.label}
                  {tab.badge != null ? (
                    <span
                      className={`ml-1.5 inline-flex min-w-[1.1rem] justify-center rounded-full px-1 text-[10px] font-semibold ${
                        isLightMode ? 'bg-amber-100 text-amber-900' : 'bg-premium-warn-bg text-premium-warn-fg'
                      }`}
                    >
                      {tab.badge}
                    </span>
                  ) : null}
                </button>
              );
            })}
          </div>
        </div>

        {pendingApprovalCount > 0 && workspaceView !== 'approvals' && (
          <button
            type="button"
            onClick={() => setWorkspaceView('approvals')}
            className={`w-full text-left rounded-lg border px-3 py-2 text-xs transition-colors ${
              isLightMode
                ? 'border-amber-300 bg-amber-50 text-amber-950 hover:bg-amber-100/80'
                : 'border-premium-warn-border/40 bg-premium-warn-bg text-premium-warn-fg hover:bg-premium-warn-bg/80'
            }`}
          >
            <span className="font-semibold">
              {approvals.length > 0
                ? `${approvals.length} cleanup proposal${approvals.length === 1 ? '' : 's'} awaiting approval`
                : null}
              {approvals.length > 0 && approvedProposals.length > 0 ? ' · ' : null}
              {approvedProposals.length > 0
                ? `${approvedProposals.length} ready to publish`
                : null}
            </span>
            <span className="ml-2 underline">Open Approvals</span>
          </button>
        )}
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain px-4 pb-4 pt-3 space-y-3">
        {workspaceView === 'topology' && (
          <DqTierMetricsPanel
            tier={dqTier}
            onTierChange={setDqTier}
            isLightMode={isLightMode}
            topoSummary={topoSummary}
            summary={summary}
            topoLoading={topoLoading}
            topoRevalidating={topoRevalidating}
            topoLiveBusy={topoLiveBusy}
            scanBusy={scanBusy}
            scanProgress={scanProgress}
            scanPollError={scanPollError}
            scanStartedMs={scanStartedMs}
            onRefreshLive={handleRefreshLive}
            onRunTopologyScan={handleTopologyScan}
            onCancelTopologyScan={() => void handleCancelTopologyScan()}
            cancelScanBusy={cancelScanBusy}
          />
        )}

        {workspaceView === 'import' && (
          <GiopImportQueuePanel
            isLightMode={isLightMode}
            enabled
            dataTier={dqTier === 'staging' ? 'staging' : 'gis'}
            showImportQueue={dqTier === 'master'}
          />
        )}

        {workspaceView === 'approvals' && (
          <div className={`rounded-xl border p-3 text-sm ${card}`}>{renderApprovalsPanel()}</div>
        )}

        {workspaceView === 'queue' && (
          <>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <DqDataTierSwitch
                tier={dqTier}
                onTierChange={setDqTier}
                isLightMode={isLightMode}
                disabled={topoLoading && !topoSummary}
              />
              <p className={`text-xs ${muted}`}>
                {dqTier === 'master'
                  ? 'Master topology exceptions'
                  : 'Staging: field submissions awaiting validation'}
              </p>
            </div>

            <div
              className={`sticky top-0 z-10 -mx-4 px-4 py-2 border-b backdrop-blur-sm ${
                isLightMode
                  ? 'bg-white/95 border-slate-200/80'
                  : 'bg-premium-bg/95 border-premium-border/45'
              }`}
            >
              <DqQueueToolbar
                isLightMode={isLightMode}
                statusFilter={statusFilter}
                duplicatesOnly={duplicatesOnly}
                severityFilter={severityFilter}
                domainFilter={domainFilter}
                onStatusFilterChange={setStatusFilter}
                onDuplicatesOnlyChange={setDuplicatesOnly}
                onSeverityFilterChange={setSeverityFilter}
                onDomainFilterChange={setDomainFilter}
                onRefresh={() => void loadQueue()}
                loading={loading}
                statusMessage={status || undefined}
                page={page}
                pageSize={pageSize}
                total={totalQueueItems}
                onPageChange={setPage}
                onPageSizeChange={setPageSize}
              />
            </div>

            {loading && (
              <div className="space-y-2 py-1" aria-busy="true" aria-label="Loading queue">
                {[0, 1, 2].map((i) => (
                  <div
                    key={i}
                    className={`h-20 rounded-lg border animate-pulse ${
                      isLightMode ? 'border-slate-200 bg-slate-100/80' : 'border-premium-border/40 bg-premium-surface'
                    }`}
                  />
                ))}
              </div>
            )}

            {!loading && queueError && (
              <div
                className={`rounded-lg border px-3 py-2 text-sm ${
                  isLightMode
                    ? 'border-red-200 bg-red-50 text-red-800'
                    : 'border-premium-danger-border/40 bg-premium-danger-bg text-premium-danger-fg'
                }`}
              >
                <p className="font-medium">Could not load queue</p>
                <p className="text-xs mt-0.5 opacity-90">{queueError}</p>
                <button
                  type="button"
                  className="mt-2 text-xs underline"
                  onClick={() => void loadQueue()}
                >
                  Retry
                </button>
              </div>
            )}

            {!loading && !queueError && queueItems.length === 0 && (
              <div
                className={`rounded-lg border px-3 py-4 text-sm ${
                  isLightMode ? 'border-slate-200 bg-slate-50 text-slate-600' : 'border-premium-border/45 bg-premium-surface text-premium-muted'
                }`}
              >
                {filtersActive ? (
                  <>
                    <p className="font-medium">No matches for the current filters</p>
                    <p className="text-xs mt-1">
                      Clear filters or broaden severity / domain to see more records.
                    </p>
                    <button
                      type="button"
                      className="mt-2 text-xs underline"
                      onClick={() => {
                        setStatusFilter('ALL');
                        setDuplicatesOnly(false);
                        setSeverityFilter('');
                        setDomainFilter('');
                      }}
                    >
                      Clear all filters
                    </button>
                  </>
                ) : dqTier === 'master' ? (
                  <>
                    <p className="font-medium">No open topology exceptions</p>
                    <p className="text-xs mt-1">
                      Run <strong>Scan → queue</strong> from Topology health if you expect new issues.
                    </p>
                  </>
                ) : (
                  <>
                    <p className="font-medium">No staging captures in queue</p>
                    <p className="text-xs mt-1">
                      Field submissions appear here as PENDING_FIELD after capture.
                    </p>
                  </>
                )}
              </div>
            )}

            {!loading && !queueError && queueItems.length > 0 && !reviewMrid && (
              <p className={`text-xs ${muted}`}>
                Select a capture to review it on the map. Map stays idle until you choose one.
              </p>
            )}

            <div className="space-y-2">
              {clusters.map((cluster) => renderQueueCluster(cluster))}
              {singletons.map((item) => renderQueueCard(item))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
