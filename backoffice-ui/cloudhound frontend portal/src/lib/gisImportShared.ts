import type { GiopConductorSnapResult, GiopUnpromotedSegmentReason } from '../api/giop-api';

export const GIS_SNAP_PHASE_DEFS = [
  { id: 'snap', label: 'Snap endpoints onto resolved poles' },
  { id: 'refresh', label: 'Refresh import pipeline statistics' },
  { id: 'reload', label: 'Reload steward queue' },
] as const;

export type GisSnapPhaseId = (typeof GIS_SNAP_PHASE_DEFS)[number]['id'];

export const REASON_LABELS: Record<GiopUnpromotedSegmentReason, string> = {
  missing_endpoints: 'Missing endpoints',
  customer_equipment_originating: 'Customer / meter (source)',
  customer_equipment_end: 'Customer / meter (target)',
  unresolved_originating: 'Unresolved source ID',
  unresolved_end: 'Unresolved target ID',
  same_endpoint: 'Same endpoint',
  invalid_geom: 'Invalid geometry',
  eligible_unpromoted: 'Eligible, not promoted',
};

export const REASON_HELP: Record<GiopUnpromotedSegmentReason, string> = {
  missing_endpoints:
    'Start or end pole ID is blank in the GPKG. Fix source data or lookup before promote.',
  customer_equipment_originating:
    'Source endpoint is a customer meter or service label — expected on LV/service drops, not a pole lookup failure.',
  customer_equipment_end:
    'Target endpoint is a customer meter or service label — expected on service_line_lvle; import meters (IMPORT_METERS=1) to graph them later.',
  unresolved_originating:
    'Source pole ID is not in district lookup. Snap cannot run until the pole is mapped.',
  unresolved_end:
    'Target pole ID is not in district lookup. Fix lookup or GPKG IDs, then re-promote.',
  same_endpoint:
    'Both endpoints resolve to the same node. Usually a data entry or topology error.',
  invalid_geom:
    'Line geometry is missing or not a linestring. Re-import or repair geometry in GIS.',
  eligible_unpromoted:
    'Passes promote rules but not yet in master. Run promote_topology.sh after snap.',
};

export const REASON_FIX_HINT: Record<GiopUnpromotedSegmentReason, string> = {
  missing_endpoints: 'GIS source edit',
  customer_equipment_originating: 'LV service (informational)',
  customer_equipment_end: 'IMPORT_METERS=1 (optional)',
  unresolved_originating: 'Lookup / GPKG ID',
  unresolved_end: 'Lookup / GPKG ID',
  same_endpoint: 'GIS review',
  invalid_geom: 'Geometry repair',
  eligible_unpromoted: 'promote_topology.sh',
};

export function formatImportElapsed(startedMs: number): string {
  const sec = Math.max(0, Math.floor((Date.now() - startedMs) / 1000));
  if (sec < 60) return `${sec}s`;
  return `${Math.floor(sec / 60)}m ${sec % 60}s`;
}

export function formatDurationMs(ms?: number | null): string | null {
  if (ms == null || ms < 0) return null;
  if (ms < 1000) return `${ms}ms`;
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  return `${Math.floor(sec / 60)}m ${sec % 60}s`;
}

export function snapEligibleEstimateSec(conductorSegments?: number | null): number {
  // After 00108: set-based snap + skip import-status MV refresh (~7–15s national).
  const n = conductorSegments ?? 1_900_000;
  if (n >= 1_500_000) return 30;
  if (n >= 500_000) return 20;
  return 10;
}

export function formatSnapEta(startedMs: number, estimateSec: number): string | null {
  const elapsed = Math.floor((Date.now() - startedMs) / 1000);
  const remaining = estimateSec - elapsed;
  if (remaining <= 0) return 'Still working — large national dataset';
  if (remaining < 60) return `~${remaining}s typical remaining`;
  return `~${Math.ceil(remaining / 60)}m typical remaining`;
}

export function snapResultSummary(result: GiopConductorSnapResult): string {
  const parts = [
    `${result.segments_snapped.toLocaleString()} geometry updated`,
    `${result.segments_already_aligned.toLocaleString()} already aligned`,
  ];
  if (result.segments_span_rejected != null && result.segments_span_rejected > 0) {
    parts.push(`${result.segments_span_rejected.toLocaleString()} span rejected`);
  }
  if (result.segments_move_rejected != null && result.segments_move_rejected > 0) {
    parts.push(`${result.segments_move_rejected.toLocaleString()} move rejected`);
  }
  parts.push(`${result.segments_unresolved.toLocaleString()} unresolved (skipped)`);
  return parts.join(' · ');
}

export function reasonPct(count: number, total: number): string {
  if (total <= 0) return '0%';
  return `${((100 * count) / total).toFixed(1)}%`;
}

export const ENDPOINT_CLASS_LABELS: Record<string, string> = {
  missing: 'Blank ID',
  pole_resolved: 'Pole resolved',
  pole_alias_pending: 'Alias pending rebuild',
  customer_equipment: 'Customer / meter label',
  generic_short_id: 'Generic short ID (P1…)',
  pole_id_unmatched: 'Pole-like, not in lookup',
  other_unmatched: 'Other unmatched',
};

export const ENDPOINT_CLASS_HELP: Record<string, string> = {
  missing: 'Endpoint field empty in GPKG conductor row.',
  pole_resolved: 'ID matches gis.unique_id_lookup (includes alias merge after promote).',
  pole_alias_pending: 'Known alias (e.g. P107/b23/6) waiting for lookup rebuild.',
  customer_equipment: 'LV/service endpoint — customer meter, premises, breaker, etc.',
  generic_short_id: 'Locally reused IDs like P1/P2 — ambiguous nationally.',
  pole_id_unmatched: 'Structured pole ID not found — typo, missing pole, or wrong layer.',
  other_unmatched: 'Non-pole text not classified above.',
};
