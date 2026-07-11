import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  aiScanGisEndpointFixProposals,
  applyGisEndpointFixProposals,
  bulkReviewGisEndpointFixProposals,
  generateGisEndpointFixProposals,
  getActiveGisEndpointFixAiDistrictRun,
  getGisEndpointFixProposalSummary,
  getGisEndpointFixProposalMapPreview,
  getLatestGisEndpointFixAiScan,
  listGisEndpointFixProposals,
  reviewGisEndpointFixProposals,
  startGisEndpointFixDistrictAiScan,
  type GiopEndpointFixAiDistrictRun,
  type GiopEndpointFixAiReview,
  type GiopEndpointFixAiScanRecord,
  type GiopEndpointFixAiTranscriptEntry,
  type GiopEndpointFixProposal,
  type GiopEndpointFixDataTier,
  type GiopEndpointFixTier,
} from '../api/giop-api';
import { useGiopMapOverlay } from '../context/GiopMapOverlayContext';
import { endpointAssetKindLabel } from '../lib/gisEndpointAssetKind';
import {
  formatEndpointFixAiThoughts,
  sanitizeEndpointFixTranscript,
  summarizeEndpointFixAiReviews,
} from '../lib/gisEndpointFixAiDisplay';
import {
  districtNamesFromPlaces,
  loadPlacesIndex,
} from '../hooks/useGiopMapSearchCatalog';
import {
  bboxFromEndpointFixGeojson,
  type ImportSegmentHighlightState,
} from '../lib/giopImportSegmentHighlight';

interface GisEndpointFixProposalsPanelProps {
  isLightMode: boolean;
  enabled: boolean;
  dataTier?: GiopEndpointFixDataTier;
  defaultDistrict?: string;
}

const PAGE_SIZE = 20;
const AI_SCAN_BATCH_OPTIONS = [10, 50, 100] as const;

export type EndpointFixAiReasoningDepth = 'quick' | 'deep';
export type EndpointFixAiBatchSize = (typeof AI_SCAN_BATCH_OPTIONS)[number];

function topologyAlignBadge(
  proposal: GiopEndpointFixProposal,
  isLightMode: boolean,
): { label: string; className: string; title: string } {
  const maxGap = proposal.max_gap_m;
  if (proposal.topology_aligned || proposal.topology_noop) {
    return {
      label: proposal.topology_noop ? 'noop' : 'aligned',
      className: isLightMode
        ? 'text-emerald-800 bg-emerald-50'
        : 'text-emerald-200 bg-emerald-950/40',
      title: proposal.topology_noop
        ? 'IDs already match geometry at both ends — no ID change needed; promote when ready.'
        : 'Line ends already within 1 m of proposed nodes — safe for Memgraph after promote.',
    };
  }
  if (proposal.topology_ready) {
    return {
      label: 'snap OK',
      className: isLightMode
        ? 'text-sky-800 bg-sky-50'
        : 'text-sky-200 bg-sky-950/40',
      title: `Apply will snap geometry to nodes (max gap ${maxGap?.toFixed(1) ?? '?'} m) so MRIDs match the line.`,
    };
  }
  return {
    label: 'reject',
    className: isLightMode ? 'text-red-800 bg-red-50' : 'text-red-200 bg-red-950/40',
    title: `Gap too large for snap (${maxGap?.toFixed(1) ?? '?'} m) — geometry and logical link would disagree after apply.`,
  };
}

function confidenceBadge(
  confidence: string | null | undefined,
  agrees: boolean | null | undefined,
  isLightMode: boolean,
): string {
  if (agrees === false) {
    return isLightMode ? 'text-amber-800 bg-amber-50' : 'text-amber-200 bg-amber-950/40';
  }
  if (confidence === 'high') {
    return isLightMode ? 'text-emerald-800 bg-emerald-50' : 'text-emerald-200 bg-emerald-950/40';
  }
  if (confidence === 'low') {
    return isLightMode ? 'text-red-800 bg-red-50' : 'text-red-200 bg-red-950/40';
  }
  return isLightMode ? 'text-slate-700 bg-slate-100' : 'text-slate-200 bg-slate-800/60';
}

function AiReviewsSummary({
  reviews,
  isLightMode,
  muted,
}: {
  reviews: GiopEndpointFixAiReview[];
  isLightMode: boolean;
  muted: string;
}) {
  if (!reviews.length) return null;
  const shell = isLightMode ? 'border-slate-200 bg-white' : 'border-premium-border/50 bg-premium-surface/30';
  const disagrees = reviews.filter((r) => r.agree === false).slice(0, 8);
  return (
    <div className={`rounded-lg border p-2 text-xs space-y-2 ${shell}`}>
      <p className={muted}>{summarizeEndpointFixAiReviews(reviews)}</p>
      {disagrees.length > 0 && (
        <ul className={`space-y-1 ${isLightMode ? 'text-slate-700' : 'text-premium-text-secondary'}`}>
          {disagrees.map((r, idx) => (
            <li key={r.proposal_id ?? `${r.segment_id}-${idx}`}>
              <span className="font-mono">#{r.segment_id ?? '?'}</span>
              {r.rationale ? ` — ${r.rationale}` : ' — flagged for review'}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function TranscriptBlock({
  transcript,
  isLightMode,
  muted,
}: {
  transcript: GiopEndpointFixAiTranscriptEntry[];
  isLightMode: boolean;
  muted: string;
}) {
  if (!transcript.length) return null;
  const shell = isLightMode ? 'border-slate-200 bg-slate-50/90' : 'border-premium-border/50 bg-premium-surface/30';
  return (
    <div className={`rounded-lg border p-2 space-y-2 max-h-64 overflow-y-auto text-xs ${shell}`}>
      {transcript.map((entry, idx) => {
        if (entry.role === 'assistant') {
          return (
            <div key={idx} className="space-y-1">
              {entry.content && (
                <p className={`whitespace-pre-wrap ${isLightMode ? 'text-slate-800' : 'text-premium-text'}`}>
                  <span className={`font-medium ${muted}`}>Assistant · </span>
                  {entry.content}
                </p>
              )}
              {entry.tool_calls?.map((tc, tci) => (
                <p key={tci} className={muted}>
                  <span className="font-mono text-cyan-700 dark:text-cyan-300">{tc.name}</span>
                  {tc.arguments ? `(${tc.arguments.slice(0, 120)}${tc.arguments.length > 120 ? '…' : ''})` : ''}
                </p>
              ))}
            </div>
          );
        }
        if (entry.role === 'tool') {
          return (
            <p key={idx} className={`whitespace-pre-wrap font-mono ${muted}`}>
              <span className="font-sans font-medium">Tool result · </span>
              {entry.content}
            </p>
          );
        }
        return null;
      })}
    </div>
  );
}

export function GisEndpointFixProposalsPanel({
  isLightMode,
  enabled,
  dataTier = 'gis',
  defaultDistrict = '',
}: GisEndpointFixProposalsPanelProps) {
  const { queueMapViewportCommand, setImportSegmentHighlight, setNetworkGeometryMode } =
    useGiopMapOverlay();
  const [district, setDistrict] = useState(defaultDistrict);
  const [districtOptions, setDistrictOptions] = useState<string[]>([]);
  const [districtsLoading, setDistrictsLoading] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [geometryScanning, setGeometryScanning] = useState(false);
  const [status, setStatus] = useState('');
  const [summaryPending, setSummaryPending] = useState(0);
  const [summaryApproved, setSummaryApproved] = useState(0);
  const [tierCounts, setTierCounts] = useState({ tier_a: 0, tier_b: 0 });
  const [proposals, setProposals] = useState<GiopEndpointFixProposal[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [tierFilter, setTierFilter] = useState<GiopEndpointFixTier | ''>('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [activePreviewId, setActivePreviewId] = useState<string | null>(null);
  const [mapBusyId, setMapBusyId] = useState<number | null>(null);
  const [aiScan, setAiScan] = useState<GiopEndpointFixAiScanRecord | null>(null);
  const [showThoughts, setShowThoughts] = useState(false);
  const [aiReasoningDepth, setAiReasoningDepth] = useState<EndpointFixAiReasoningDepth>('quick');
  const [aiBatchSize, setAiBatchSize] = useState<EndpointFixAiBatchSize>(50);
  const [districtRun, setDistrictRun] = useState<GiopEndpointFixAiDistrictRun | null>(null);
  const panelRef = useRef<HTMLDetailsElement | null>(null);
  const showOnMapRef = useRef<(proposal: GiopEndpointFixProposal) => Promise<void>>(async () => {});

  const card = isLightMode
    ? 'border-slate-200 bg-white/90'
    : 'border-premium-border/60 bg-premium-card/90';
  const muted = isLightMode ? 'text-slate-500' : 'text-premium-muted';
  const shell = isLightMode ? 'border-slate-200 bg-slate-50/80' : 'border-premium-border/50 bg-premium-surface/40';

  const districtTrim = district.trim();

  const isStaging = dataTier === 'staging';

  const aiTranscript = useMemo(
    () => sanitizeEndpointFixTranscript(aiScan?.transcript ?? []),
    [aiScan?.transcript],
  );
  const aiThoughtsText = useMemo(
    () => formatEndpointFixAiThoughts(aiScan?.thoughts),
    [aiScan?.thoughts],
  );

  const workspaceKeyRef = useRef('');

  const loadLatestScan = useCallback(async () => {
    if (!districtTrim) return;
    try {
      const scan = await getLatestGisEndpointFixAiScan(districtTrim, dataTier);
      setAiScan(scan);
    } catch {
      setAiScan(null);
    }
  }, [districtTrim, dataTier]);

  const fetchProposalData = useCallback(async () => {
    const [page, summary] = await Promise.all([
      listGisEndpointFixProposals({
        data_tier: dataTier,
        district: districtTrim,
        status: 'pending',
        tier: tierFilter || undefined,
        limit: PAGE_SIZE,
        offset,
      }),
      getGisEndpointFixProposalSummary(districtTrim, dataTier),
    ]);
    setProposals(page.proposals);
    setTotal(page.total);
    setSummaryPending(summary.pending);
    setSummaryApproved(summary.approved);
    setTierCounts({
      tier_a: summary.by_status_tier?.['pending:tier_a'] ?? 0,
      tier_b: summary.by_status_tier?.['pending:tier_b'] ?? 0,
    });
    setSelected(new Set());
    await loadLatestScan();
    return summary;
  }, [districtTrim, dataTier, loadLatestScan, offset, tierFilter]);

  const runGeometryScan = useCallback(async () => {
    setGeometryScanning(true);
    try {
      return await generateGisEndpointFixProposals({
        district: districtTrim,
        data_tier: dataTier,
        replace_pending: false,
      });
    } finally {
      setGeometryScanning(false);
    }
  }, [districtTrim, dataTier]);

  const refresh = useCallback(async () => {
    if (!enabled || !districtTrim) return;
    setLoading(true);
    try {
      await fetchProposalData();
    } catch (err) {
      setStatus(err instanceof Error ? err.message : 'Failed to load proposals');
    } finally {
      setLoading(false);
    }
  }, [districtTrim, enabled, fetchProposalData]);

  const loadDistrictWorkspace = useCallback(
    async (options?: { autoGenerateIfEmpty?: boolean }) => {
      if (!enabled || !districtTrim) return;
      setLoading(true);
      if (options?.autoGenerateIfEmpty) setStatus('');
      try {
        if (options?.autoGenerateIfEmpty) {
          const summary = await getGisEndpointFixProposalSummary(districtTrim, dataTier);
          if (summary.pending === 0) {
            setStatus(`Scanning geometry for ${districtTrim} (up to 5,000 segments)…`);
            const result = await runGeometryScan();
            if (result.inserted > 0) {
              setStatus(
                `Generated ${result.inserted.toLocaleString()} proposals · ${result.tier_a_pending.toLocaleString()} Tier A pending`,
              );
            } else {
              setStatus(`No new endpoint fixes found in ${districtTrim}.`);
            }
          }
        }
        await fetchProposalData();
      } catch (err) {
        setStatus(err instanceof Error ? err.message : 'Failed to load district');
      } finally {
        setLoading(false);
      }
    },
    [dataTier, districtTrim, enabled, fetchProposalData, runGeometryScan],
  );

  useEffect(() => {
    if (!enabled || !districtTrim) return;
    const workspaceKey = `${expanded}:${dataTier}:${districtTrim}`;
    const openedOrSwitchedDistrict = workspaceKeyRef.current !== workspaceKey;
    workspaceKeyRef.current = workspaceKey;
    if (!expanded) return;
    if (!isStaging) setNetworkGeometryMode('both');
    void loadDistrictWorkspace({ autoGenerateIfEmpty: openedOrSwitchedDistrict });
  }, [dataTier, districtTrim, enabled, expanded, isStaging, loadDistrictWorkspace, offset, setNetworkGeometryMode, tierFilter]);

  const handleTierFilter = (tier: GiopEndpointFixTier | '') => {
    setTierFilter(tier);
    setOffset(0);
    setSelected(new Set());
  };

  useEffect(() => {
    setDistrict((prev) => prev || defaultDistrict);
  }, [defaultDistrict]);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    setDistrictsLoading(true);
    void loadPlacesIndex()
      .then((places) => {
        if (cancelled) return;
        setDistrictOptions(districtNamesFromPlaces(places));
      })
      .finally(() => {
        if (!cancelled) setDistrictsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [enabled]);

  const districtSelectOptions = useMemo(() => {
    const options = [...districtOptions];
    const current = district.trim();
    if (current && !options.some((name) => name.toLowerCase() === current.toLowerCase())) {
      options.unshift(current);
    }
    return options;
  }, [district, districtOptions]);

  useEffect(() => {
    if (!expanded || isStaging || proposals.length === 0 || activePreviewId) return;
    void showOnMapRef.current(proposals[0]);
  }, [activePreviewId, expanded, isStaging, proposals]);

  useEffect(() => {
    if (!districtTrim || !expanded) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const run = await getActiveGisEndpointFixAiDistrictRun(districtTrim, dataTier);
        if (!cancelled) setDistrictRun(run);
      } catch {
        if (!cancelled) setDistrictRun((prev) => (prev?.status === 'running' ? prev : null));
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 4000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [districtTrim, expanded, dataTier]);

  useEffect(() => {
    if (districtRun?.status !== 'running') return;
    const timer = window.setInterval(() => void refresh(), 12000);
    return () => window.clearInterval(timer);
  }, [districtRun?.status, districtRun?.id, refresh]);

  const allSelected = useMemo(
    () => proposals.length > 0 && proposals.every((p) => selected.has(p.id)),
    [proposals, selected],
  );

  const toggleAll = () => {
    if (allSelected) setSelected(new Set());
    else setSelected(new Set(proposals.map((p) => p.id)));
  };

  const handleGenerate = async () => {
    if (!districtTrim) {
      setStatus('Select a district first');
      return;
    }
    if (geometryScanning) return;
    setBusy(true);
    setStatus(`Scanning geometry for ${districtTrim} (adds new rows only, up to 5,000)…`);
    try {
      const result = await runGeometryScan();
      setStatus(
        result.inserted > 0
          ? `Generated ${result.inserted.toLocaleString()} proposals · ${result.tier_a_pending.toLocaleString()} Tier A pending`
          : `No new proposals — ${result.pending_total.toLocaleString()} already pending`,
      );
      setOffset(0);
      await refresh();
    } catch (err) {
      setStatus(err instanceof Error ? err.message : 'Geometry scan failed');
    } finally {
      setBusy(false);
    }
  };

  const handleAiScan = async () => {
    if (!districtTrim) {
      setStatus('Enter an ECG district name first');
      return;
    }
    setBusy(true);
    setStatus('');
    setShowThoughts(true);
    try {
      const result = await aiScanGisEndpointFixProposals({
        district: districtTrim,
        data_tier: dataTier,
        limit: aiBatchSize,
        unscanned_only: true,
        mode: 'tiered',
        reasoning_depth: aiReasoningDepth,
      });
      setAiScan({
        ...result,
        id: result.scan_id,
        status: result.configured || (result.auto_reviewed ?? 0) > 0 ? 'completed' : 'failed',
      });
      const auto = result.auto_reviewed ?? 0;
      const llm = result.llm_reviewed ?? 0;
      setStatus(
        result.configured || auto > 0
          ? `AI reviewed ${result.proposals_reviewed} proposal(s)${auto ? ` · ${auto} auto` : ''}${llm ? ` · ${llm} LLM` : ''} · ${result.reasoning_depth ?? aiReasoningDepth} · ${result.model ?? 'rules/flash'}`
          : 'Cleanup LLM not configured — set GIOP_CLEANUP_LLM_API_KEY',
      );
      await refresh();
    } catch (err) {
      setStatus(err instanceof Error ? err.message : 'AI scan failed');
    } finally {
      setBusy(false);
    }
  };

  const handleDistrictAiScan = async () => {
    if (!districtTrim) {
      setStatus('Enter an ECG district name first');
      return;
    }
    setBusy(true);
    setStatus('');
    try {
      const run = await startGisEndpointFixDistrictAiScan({
        district: districtTrim,
        data_tier: dataTier,
        batch_size: aiBatchSize,
        reasoning_depth: aiReasoningDepth,
      });
      setDistrictRun(run);
      setStatus(
        `District AI scan started · ${run.total_pending.toLocaleString()} unscanned · batches of ${run.batch_size}`,
      );
    } catch (err) {
      setStatus(err instanceof Error ? err.message : 'District AI scan failed');
    } finally {
      setBusy(false);
    }
  };

  const handleBulkApprove = async (filter: 'tier_a' | 'ai_high' | 'ai_agrees') => {
    if (!districtTrim) return;
    setBusy(true);
    try {
      const result = await bulkReviewGisEndpointFixProposals({ district: districtTrim, data_tier: dataTier, filter });
      const label =
        filter === 'tier_a' ? 'Tier A' : filter === 'ai_high' ? 'AI high confidence' : 'AI agrees';
      setStatus(`Bulk approved ${result.updated.toLocaleString()} row(s) · ${label}`);
      await refresh();
    } catch (err) {
      setStatus(err instanceof Error ? err.message : 'Bulk approve failed');
    } finally {
      setBusy(false);
    }
  };

  const handleReview = useCallback(async (approve: boolean) => {
    const ids = [...selected];
    if (ids.length === 0) {
      setStatus('Select at least one row');
      return;
    }
    setBusy(true);
    try {
      await reviewGisEndpointFixProposals({
        proposal_ids: ids,
        data_tier: dataTier,
        status: approve ? 'approved' : 'rejected',
      });
      setStatus(approve ? `Approved ${ids.length} row(s)` : `Rejected ${ids.length} row(s)`);
      await refresh();
    } catch (err) {
      setStatus(err instanceof Error ? err.message : 'Review failed');
    } finally {
      setBusy(false);
    }
  }, [dataTier, refresh, selected]);

  const handleApplyApproved = async () => {
    if (!districtTrim) return;
    setBusy(true);
    try {
      const result = await applyGisEndpointFixProposals({ district: districtTrim, data_tier: dataTier });
      setStatus(
        isStaging
          ? `Applied ${result.applied.toLocaleString()} approved fix(es) to staging line segments`
          : `Applied IDs + snapped geometry (${result.applied.toLocaleString()} row(s)) — promote for Memgraph trace`,
      );
      await refresh();
    } catch (err) {
      setStatus(err instanceof Error ? err.message : 'Apply failed');
    } finally {
      setBusy(false);
    }
  };

  const showOnMap = useCallback(async (proposal: GiopEndpointFixProposal) => {
    if (isStaging) return;
    setMapBusyId(proposal.segment_id);
    setActivePreviewId(proposal.id);
    try {
      // Endpoint-fix overlays are GeoJSON; Both mode also shows GIS gap context under them.
      setNetworkGeometryMode('both');
      const preview = await getGisEndpointFixProposalMapPreview(proposal.id);
      const focusBbox = bboxFromEndpointFixGeojson(preview.geojson) ?? preview.bbox ?? undefined;
      const state: ImportSegmentHighlightState = {
        segmentId: preview.segment_id,
        label: preview.label,
        geojson: preview.geojson,
        bbox: focusBbox,
      };
      setImportSegmentHighlight(state);
      if (focusBbox) {
        queueMapViewportCommand({
          type: 'fit_bounds',
          bbox: focusBbox,
          max_zoom: 22,
          padding: 28,
          min_span: 0.00008,
        });
      }
    } catch (err) {
      setStatus(err instanceof Error ? err.message : 'Map highlight failed');
    } finally {
      setMapBusyId(null);
    }
  }, [isStaging, queueMapViewportCommand, setImportSegmentHighlight, setNetworkGeometryMode]);

  showOnMapRef.current = showOnMap;

  const selectAndPreview = useCallback(
    (proposal: GiopEndpointFixProposal, opts?: { exclusive?: boolean }) => {
      setSelected((prev) => {
        if (opts?.exclusive) return new Set([proposal.id]);
        const next = new Set(prev);
        next.add(proposal.id);
        return next;
      });
      void showOnMap(proposal);
    },
    [showOnMap],
  );

  const toggleOne = useCallback(
    (id: string) => {
      const proposal = proposals.find((p) => p.id === id);
      setSelected((prev) => {
        const next = new Set(prev);
        if (next.has(id)) {
          next.delete(id);
          return next;
        }
        next.add(id);
        return next;
      });
      if (proposal && !selected.has(id)) {
        void showOnMap(proposal);
      }
    },
    [proposals, selected, showOnMap],
  );

  const focusProposalIndex = useCallback(
    (index: number) => {
      if (index < 0 || index >= proposals.length) return;
      selectAndPreview(proposals[index], { exclusive: true });
    },
    [proposals, selectAndPreview],
  );

  const handleApproveAndNext = useCallback(async () => {
    const ids = [...selected];
    if (ids.length === 0) {
      setStatus('Select at least one proposal');
      return;
    }
    const lastId = ids[ids.length - 1];
    const lastIdx = proposals.findIndex((p) => p.id === lastId);
    setBusy(true);
    try {
      await reviewGisEndpointFixProposals({
        proposal_ids: ids,
        data_tier: dataTier,
        status: 'approved',
      });
      setStatus(`Approved ${ids.length} row(s)`);
      const approved = new Set(ids);
      const next =
        lastIdx >= 0
          ? proposals.slice(lastIdx + 1).find((p) => !approved.has(p.id))
          : undefined;
      await refresh();
      if (next) {
        selectAndPreview(next, { exclusive: true });
      } else {
        setSelected(new Set());
        setActivePreviewId(null);
      }
    } catch (err) {
      setStatus(err instanceof Error ? err.message : 'Review failed');
    } finally {
      setBusy(false);
    }
  }, [dataTier, proposals, refresh, selectAndPreview, selected]);

  useEffect(() => {
    if (!expanded || isStaging) return;
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (
        target
        && (target.tagName === 'INPUT'
          || target.tagName === 'TEXTAREA'
          || target.tagName === 'SELECT'
          || target.isContentEditable)
      ) {
        return;
      }
      const panel = panelRef.current;
      if (!panel?.open) return;
      const key = event.key.toLowerCase();
      if (key === 'a' && !event.metaKey && !event.ctrlKey) {
        event.preventDefault();
        void handleReview(true);
        return;
      }
      if (key === 'r' && !event.metaKey && !event.ctrlKey) {
        event.preventDefault();
        void handleReview(false);
        return;
      }
      if (key === 'm' && !event.metaKey && !event.ctrlKey) {
        const id = activePreviewId ?? [...selected][0];
        const proposal = proposals.find((p) => p.id === id) ?? proposals[0];
        if (proposal) {
          event.preventDefault();
          void showOnMapRef.current(proposal);
        }
        return;
      }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const currentId = activePreviewId ?? [...selected][0] ?? null;
        const idx = currentId ? proposals.findIndex((p) => p.id === currentId) : -1;
        const nextIdx =
          event.key === 'ArrowDown'
            ? Math.min(proposals.length - 1, Math.max(0, idx + 1))
            : Math.max(0, idx <= 0 ? 0 : idx - 1);
        focusProposalIndex(nextIdx);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [
    activePreviewId,
    expanded,
    focusProposalIndex,
    handleReview,
    isStaging,
    proposals,
    selected,
  ]);

  return (
    <details
      ref={panelRef}
      className={`rounded-xl border text-sm group ${card}`}
      onToggle={(event) => setExpanded((event.currentTarget as HTMLDetailsElement).open)}
    >
      <summary
        className={`cursor-pointer list-none px-3 py-2 font-medium flex items-center justify-between gap-2 ${
          isLightMode ? 'text-slate-800' : 'text-premium-text-secondary'
        }`}
      >
        <span>{isStaging ? 'Staging endpoint fix proposals' : 'Endpoint fix proposals'}</span>
        <span className={`text-xs font-normal ${muted}`}>
          {summaryPending > 0
            ? `${summaryPending.toLocaleString()} pending`
            : expanded
              ? 'Geometry → from/to review'
              : 'Expand'}
          {summaryApproved > 0 ? ` · ${summaryApproved} approved` : ''}
        </span>
      </summary>

      <div className="px-3 pb-3 space-y-3 border-t border-slate-200/80 dark:border-premium-border/70 pt-3">
        <p className={`text-xs ${muted}`}>
          {isStaging ? (
            <>
              Compare field-capture line geometry with assigned connectivity nodes. Pick a district to
              auto-scan unpromoted lines, run AI scan for steward reasoning, review each row, then apply
              approved fixes to <span className="font-mono">staging.ac_line_segments</span>.
            </>
          ) : (
            <>
              Geometry-first repair: scan finds the pole/transformer at each line end, you approve the
              IDs, apply writes IDs and snaps geometry so logical links match the wire. Map preview
              shows <span className="font-medium">magenta = after snap</span> (what Memgraph will trace),{' '}
              <span className="font-medium">gray = as-built</span>, dashed = gap before repair. Then
              promote to master.
            </>
          )}
        </p>

        {!isStaging && (
          <div
            className={`flex flex-wrap items-center gap-1.5 rounded-lg border px-2 py-1.5 text-[11px] ${shell}`}
            aria-label="Endpoint fix workflow"
          >
            <span className={summaryPending > 0 ? (isLightMode ? 'text-fuchsia-800 font-semibold' : 'text-fuchsia-200 font-semibold') : muted}>
              Pending
            </span>
            <span className={muted}>→</span>
            <span className={summaryApproved > 0 ? (isLightMode ? 'text-emerald-800 font-semibold' : 'text-emerald-200 font-semibold') : muted}>
              Approved
            </span>
            <span className={muted}>→</span>
            <span className={muted}>Applied + snapped</span>
            <span className={muted}>→</span>
            <span className={isLightMode ? 'text-amber-800' : 'text-amber-200'}>
              Promote → Memgraph trace
            </span>
          </div>
        )}

        <div className="flex flex-wrap gap-2 items-end">
          <label className={`text-xs flex flex-col gap-1 ${muted}`}>
            District
            <select
              value={district}
              disabled={districtsLoading && districtOptions.length === 0}
              onChange={(e) => {
                setDistrict(e.target.value);
                setOffset(0);
                setTierFilter('');
                setSelected(new Set());
              }}
              className={`rounded border px-2 py-1 text-xs min-w-[160px] max-w-[220px] ${
                isLightMode
                  ? 'border-slate-300 bg-white text-slate-800'
                  : 'border-premium-border/50 bg-premium-surface text-premium-text'
              }`}
            >
              <option value="">
                {districtsLoading && districtOptions.length === 0
                  ? 'Loading districts…'
                  : 'Select district…'}
              </option>
              {districtSelectOptions.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            disabled={busy || geometryScanning || loading || !districtTrim}
            onClick={() => void handleGenerate()}
            className="rounded border px-2 py-1 text-xs giop-btn-primary disabled:opacity-50"
          >
            {busy || geometryScanning ? 'Scanning…' : 'Re-scan geometry'}
          </button>
          <label className={`text-xs flex flex-col gap-1 ${muted}`}>
            Batch
            <select
              value={aiBatchSize}
              disabled={busy}
              onChange={(e) => setAiBatchSize(Number(e.target.value) as EndpointFixAiBatchSize)}
              className={`rounded border px-2 py-1 text-xs ${
                isLightMode
                  ? 'border-slate-300 bg-white text-slate-800'
                  : 'border-premium-border/50 bg-premium-surface text-premium-text'
              }`}
            >
              {AI_SCAN_BATCH_OPTIONS.map((n) => (
                <option key={n} value={n}>
                  {n} rows
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            disabled={busy || !districtTrim || summaryPending === 0}
            onClick={() => void handleAiScan()}
            className={`rounded border px-2 py-1 text-xs disabled:opacity-50 ${
              isLightMode
                ? 'border-violet-600 text-violet-800 hover:bg-violet-50'
                : 'border-violet-500/50 text-violet-200 hover:bg-violet-950/40'
            }`}
          >
            AI scan once
          </button>
          <button
            type="button"
            disabled={busy || !districtTrim || summaryPending === 0 || districtRun?.status === 'running'}
            onClick={() => void handleDistrictAiScan()}
            className={`rounded border px-2 py-1 text-xs disabled:opacity-50 ${
              isLightMode
                ? 'border-indigo-600 text-indigo-800 hover:bg-indigo-50'
                : 'border-indigo-500/50 text-indigo-200 hover:bg-indigo-950/40'
            }`}
          >
            Scan all district
          </button>
          <div
            className={`flex rounded border overflow-hidden text-xs ${
              isLightMode ? 'border-slate-300' : 'border-premium-border/50'
            }`}
            role="group"
            aria-label="AI reasoning depth"
          >
            {(['quick', 'deep'] as const).map((depth) => {
              const on = aiReasoningDepth === depth;
              const label = depth === 'quick' ? 'Quick' : 'Deep';
              return (
                <button
                  key={depth}
                  type="button"
                  disabled={busy}
                  title={
                    depth === 'quick'
                      ? 'Flash batch scan — fast triage'
                      : 'Pro agent + geometry tools — slower, more thorough'
                  }
                  onClick={() => setAiReasoningDepth(depth)}
                  className={`px-2 py-1 disabled:opacity-50 ${
                    on
                      ? isLightMode
                        ? 'bg-violet-100 text-violet-900'
                        : 'bg-violet-950/50 text-violet-100'
                      : isLightMode
                        ? 'bg-white text-slate-600 hover:bg-slate-50'
                        : 'bg-premium-surface text-premium-muted hover:bg-premium-surface/80'
                  }`}
                >
                  {label}
                </button>
              );
            })}
          </div>
          <button
            type="button"
            disabled={busy || summaryApproved === 0}
            onClick={() => void handleApplyApproved()}
            className={`rounded border px-2 py-1 text-xs disabled:opacity-50 ${
              isLightMode
                ? 'border-emerald-600 text-emerald-800 hover:bg-emerald-50'
                : 'border-emerald-700 text-emerald-300 hover:bg-emerald-950/40'
            }`}
          >
            Apply approved
          </button>
        </div>

        {districtRun?.status === 'running' && (
          <div className="space-y-1">
            <div className="flex justify-between text-xs">
              <span className={muted}>
                District scan · batch {districtRun.batch_size}
                {districtRun.swarm_workers ? ` · ${districtRun.swarm_workers} workers` : ''}
                {' · '}
                {districtRun.batches_completed} done
              </span>
              <span className={muted}>{districtRun.progress_pct ?? 0}%</span>
            </div>
            <div
              className={`h-1.5 rounded-full overflow-hidden ${isLightMode ? 'bg-slate-100' : 'bg-slate-800'}`}
            >
              <div
                className="h-full bg-indigo-500 transition-all duration-500"
                style={{ width: `${districtRun.progress_pct ?? 0}%` }}
              />
            </div>
            <p className={`text-xs ${muted}`}>
              {(districtRun.total_pending - (districtRun.remaining_unscanned ?? 0)).toLocaleString()} /{' '}
              {districtRun.total_pending.toLocaleString()} reviewed
            </p>
          </div>
        )}

        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            disabled={busy || !districtTrim}
            onClick={() => void handleBulkApprove('tier_a')}
            className="rounded border px-2 py-0.5 text-xs disabled:opacity-50 border-emerald-600/50"
          >
            Bulk approve Tier A
          </button>
          <button
            type="button"
            disabled={busy || !districtTrim}
            onClick={() => void handleBulkApprove('ai_high')}
            className="rounded border px-2 py-0.5 text-xs disabled:opacity-50 border-violet-600/50"
          >
            Bulk approve AI high
          </button>
          <button
            type="button"
            disabled={busy || !districtTrim}
            onClick={() => void handleBulkApprove('ai_agrees')}
            className="rounded border px-2 py-0.5 text-xs disabled:opacity-50 border-violet-600/50"
          >
            Bulk approve AI agrees
          </button>
        </div>

        {(aiScan?.thoughts || (aiScan?.transcript?.length ?? 0) > 0) && (
          <div className="space-y-2">
            <button
              type="button"
              onClick={() => setShowThoughts((v) => !v)}
              className={`text-xs underline ${muted}`}
            >
              {showThoughts ? 'Hide' : 'Show'} AI thoughts
              {aiScan?.model ? ` · ${aiScan.model}` : ''}
            </button>
            {showThoughts && (
              <>
                {aiScan?.thoughts && formatEndpointFixAiThoughts(aiScan.thoughts) && (
                  <p
                    className={`text-xs rounded-lg border p-2 whitespace-pre-wrap ${
                      isLightMode
                        ? 'border-violet-200 bg-violet-50/80 text-violet-950'
                        : 'border-violet-500/30 bg-violet-950/20 text-violet-100'
                    }`}
                  >
                    {formatEndpointFixAiThoughts(aiScan.thoughts)}
                  </p>
                )}
                {(aiScan?.reviews?.length ?? 0) > 0 && (
                  <AiReviewsSummary
                    reviews={aiScan.reviews ?? []}
                    isLightMode={isLightMode}
                    muted={muted}
                  />
                )}
                {sanitizeEndpointFixTranscript(aiScan?.transcript ?? []).length > 0 && (
                  <TranscriptBlock
                    transcript={sanitizeEndpointFixTranscript(aiScan?.transcript ?? [])}
                    isLightMode={isLightMode}
                    muted={muted}
                  />
                )}
              </>
            )}
          </div>
        )}

        <div className="flex flex-wrap gap-2 items-center">
          {(['', 'tier_a', 'tier_b'] as const).map((tier) => {
            const label =
              tier === ''
                ? `All tiers (${summaryPending})`
                : tier === 'tier_a'
                  ? `Tier A (${tierCounts.tier_a})`
                  : `Tier B (${tierCounts.tier_b})`;
            const on = tierFilter === tier;
            return (
              <button
                key={tier || 'all'}
                type="button"
                disabled={loading}
                onClick={(e) => {
                  e.stopPropagation();
                  handleTierFilter(tier);
                }}
                className={`rounded-full border px-2 py-0.5 text-xs disabled:opacity-50 ${
                  on
                    ? isLightMode
                      ? 'border-fuchsia-600 bg-fuchsia-50 text-fuchsia-900'
                      : 'border-fuchsia-500/50 bg-fuchsia-950/30 text-fuchsia-200'
                    : isLightMode
                      ? 'border-slate-200 text-slate-600 hover:bg-slate-50'
                      : 'border-premium-border/40 text-premium-muted hover:bg-premium-hover'
                }`}
              >
                {label}
              </button>
            );
          })}
          {tierFilter && !loading && (
            <span className={`text-xs ${muted}`}>
              Showing {proposals.length} of {total.toLocaleString()}{' '}
              {tierFilter === 'tier_a' ? 'Tier A' : 'Tier B'}
            </span>
          )}
        </div>

        {status && <p className={`text-xs ${muted}`}>{status}</p>}
        {geometryScanning && (
          <p className={`text-xs ${isLightMode ? 'text-amber-700' : 'text-amber-200'}`}>
            Geometry scan in progress — up to 5,000 segments per batch (typically 10–30s).
          </p>
        )}

        {loading ? (
          <p className={`text-xs ${muted}`}>Loading proposals…</p>
        ) : proposals.length === 0 ? (
          <p className={`text-xs ${muted}`}>
            {!districtTrim
              ? 'Select a district to start.'
              : tierFilter === 'tier_a'
                ? `No Tier A proposals in ${districtTrim} (${tierCounts.tier_b} Tier B pending).`
                : tierFilter === 'tier_b'
                  ? `No Tier B proposals in ${districtTrim} (${tierCounts.tier_a} Tier A pending).`
                  : loading
                    ? 'Scanning geometry…'
                    : 'No pending proposals — none found for this district.'}
          </p>
        ) : (
          <>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                disabled={busy}
                onClick={() => void handleReview(true)}
                className="rounded bg-emerald-700 px-2 py-0.5 text-xs text-white disabled:opacity-50"
              >
                Approve selected
              </button>
              {!isStaging && (
                <button
                  type="button"
                  disabled={busy || selected.size === 0}
                  onClick={() => void handleApproveAndNext()}
                  className={`rounded border px-2 py-0.5 text-xs disabled:opacity-50 ${
                    isLightMode
                      ? 'border-emerald-700 text-emerald-800 hover:bg-emerald-50'
                      : 'border-emerald-600 text-emerald-300 hover:bg-emerald-950/40'
                  }`}
                >
                  Approve + next
                </button>
              )}
              <button
                type="button"
                disabled={busy}
                onClick={() => void handleReview(false)}
                className="rounded bg-slate-600 px-2 py-0.5 text-xs text-white disabled:opacity-50"
              >
                Reject selected
              </button>
              <span className={`text-xs self-center ${muted}`}>
                {selected.size} selected · {total.toLocaleString()} pending
                {!isStaging ? ' · A/R/M · ↑↓' : ''}
              </span>
            </div>

            <div className={`overflow-x-auto rounded-lg border ${shell}`}>
              <table className="w-full text-xs">
                <thead>
                  <tr className={muted}>
                    <th className="p-2 w-8">
                      <input type="checkbox" checked={allSelected} onChange={toggleAll} aria-label="Select all" />
                    </th>
                    <th className="p-2 text-left">{isStaging ? 'Line' : 'Seg'}</th>
                    <th className="p-2 text-left">Line start (FROM)</th>
                    <th className="p-2 text-left">Line end (TO)</th>
                    <th className="p-2 text-left">Align</th>
                    <th className="p-2 text-left">Tier</th>
                    <th className="p-2 text-left">AI</th>
                    <th className="p-2 text-left">Map</th>
                  </tr>
                </thead>
                <tbody>
                  {proposals.map((p) => {
                    const rowActive = activePreviewId === p.id || selected.has(p.id);
                    return (
                    <tr
                      key={p.id}
                      className={`${
                        isLightMode ? 'border-t border-slate-100' : 'border-t border-premium-border/30'
                      } ${
                        rowActive
                          ? isLightMode
                            ? 'bg-fuchsia-50/70'
                            : 'bg-fuchsia-950/25'
                          : ''
                      } ${!isStaging ? 'cursor-pointer' : ''}`}
                      onClick={(e) => {
                        if (isStaging) return;
                        const tag = (e.target as HTMLElement).tagName;
                        if (tag === 'INPUT' || tag === 'BUTTON' || tag === 'A') return;
                        selectAndPreview(p, { exclusive: true });
                      }}
                    >
                      <td className="p-2">
                        <input
                          type="checkbox"
                          checked={selected.has(p.id)}
                          onChange={() => toggleOne(p.id)}
                          aria-label={`Select segment ${p.segment_id}`}
                        />
                      </td>
                      <td className="p-2 font-mono">
                        {isStaging
                          ? (p.segment_mrid?.slice(0, 8) ?? '—')
                          : p.segment_id}
                      </td>
                      <td className="p-2">
                        <span className="line-through opacity-60">{p.current_from ?? '—'}</span>
                        <span className="mx-1">→</span>
                        <span className="font-medium text-fuchsia-700 dark:text-fuchsia-300">
                          {p.proposed_from}
                        </span>
                        {p.proposed_from_kind && (
                          <span
                            className={`ml-1 rounded px-1 py-0.5 text-[10px] ${
                              isLightMode ? 'bg-teal-50 text-teal-800' : 'bg-teal-950/50 text-teal-200'
                            }`}
                          >
                            {endpointAssetKindLabel(p.proposed_from_kind)}
                          </span>
                        )}
                        {p.start_dist_m != null && (
                          <span className={`block ${muted}`}>{p.start_dist_m.toFixed(1)} m</span>
                        )}
                      </td>
                      <td className="p-2">
                        <span className="line-through opacity-60">{p.current_to ?? '—'}</span>
                        <span className="mx-1">→</span>
                        <span className="font-medium text-fuchsia-700 dark:text-fuchsia-300">
                          {p.proposed_to}
                        </span>
                        {p.proposed_to_kind && (
                          <span
                            className={`ml-1 rounded px-1 py-0.5 text-[10px] ${
                              isLightMode ? 'bg-teal-50 text-teal-800' : 'bg-teal-950/50 text-teal-200'
                            }`}
                          >
                            {endpointAssetKindLabel(p.proposed_to_kind)}
                          </span>
                        )}
                        {p.end_dist_m != null && (
                          <span className={`block ${muted}`}>{p.end_dist_m.toFixed(1)} m</span>
                        )}
                      </td>
                      <td className="p-2">
                        {(() => {
                          const badge = topologyAlignBadge(p, isLightMode);
                          return (
                            <span
                              className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-medium ${badge.className}`}
                              title={badge.title}
                            >
                              {badge.label}
                            </span>
                          );
                        })()}
                      </td>
                      <td className="p-2">{p.tier}</td>
                      <td className="p-2 max-w-[180px]">
                        {p.ai_rationale ? (
                          <>
                            <span
                              className={`inline-block rounded px-1 py-0.5 text-[10px] font-medium mb-0.5 ${confidenceBadge(
                                p.ai_confidence,
                                p.ai_agrees,
                                isLightMode,
                              )}`}
                            >
                              {p.ai_agrees === false ? 'disagrees' : p.ai_confidence ?? 'reviewed'}
                            </span>
                            <span className={`block ${muted}`} title={p.ai_rationale}>
                              {p.ai_rationale}
                            </span>
                          </>
                        ) : (
                          <span className={muted}>—</span>
                        )}
                      </td>
                      <td className="p-2">
                        {isStaging ? (
                          <span className={muted}>—</span>
                        ) : (
                          <button
                            type="button"
                            disabled={mapBusyId === p.segment_id}
                            onClick={(e) => {
                              e.stopPropagation();
                              void showOnMap(p);
                            }}
                            className="underline disabled:opacity-50"
                          >
                            {mapBusyId === p.segment_id ? '…' : activePreviewId === p.id ? 'Showing' : 'Show'}
                          </button>
                        )}
                      </td>
                    </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {total > PAGE_SIZE && (
              <div className="flex gap-2 justify-end">
                <button
                  type="button"
                  disabled={offset === 0}
                  onClick={() => setOffset((o) => Math.max(0, o - PAGE_SIZE))}
                  className="text-xs underline disabled:opacity-40"
                >
                  Previous
                </button>
                <button
                  type="button"
                  disabled={offset + PAGE_SIZE >= total}
                  onClick={() => setOffset((o) => o + PAGE_SIZE)}
                  className="text-xs underline disabled:opacity-40"
                >
                  Next
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </details>
  );
}
