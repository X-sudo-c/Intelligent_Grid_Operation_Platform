/**
 * GIOP sync-service API client
 */

import type { TerritoryGeoJson } from '../lib/giopTerritoryHighlight';

const SYNC_BASE = import.meta.env.VITE_SYNC_URL || '/api/v1';
const OCR_BASE = import.meta.env.VITE_OCR_URL || '/ocr-api/api/v1';

export interface GiopTraceNode {
  mrid: string;
  name: string;
  type?: string[];
  connected: boolean;
  traced: boolean;
  validation?: string;
}

export interface GiopTraceEdge {
  mrid: string;
  source: string;
  target: string;
  phases?: string;
  voltage?: string;
  source_lon?: number;
  source_lat?: number;
  target_lon?: number;
  target_lat?: number;
  /** Simplified LineString [[lon, lat], ...] from ac_line_segments.geom when available. */
  coordinates?: [number, number][];
}

export interface GiopTraceResponse {
  nodes: GiopTraceNode[];
  edges: GiopTraceEdge[];
  start_mrid: string;
  scope?: 'traced' | 'full';
  graph_totals?: { nodes: number; edges: number };
  bounds?: {
    max_hops: number;
    max_nodes: number;
    max_edges: number;
    truncated: boolean;
    mode: 'traced' | 'full_bounded' | 'viewport_fallback';
    edges_truncated?: boolean;
  };
  bbox?: { west: number; south: number; east: number; north: number };
}

export interface GiopGraphChunkNode {
  mrid: string;
  name: string;
  lon: number;
  lat: number;
  validation?: string;
  connected: boolean;
  traced: boolean;
}

export interface GiopGraphChunkResponse {
  nodes: GiopGraphChunkNode[];
  edges: GiopTraceEdge[];
  bbox: { west: number; south: number; east: number; north: number };
  truncated: boolean;
  edges_truncated?: boolean;
  limit: number;
  edge_limit?: number;
}

export interface GiopStagingAsset {
  mrid: string;
  name?: string;
  validation?: string;
  nominal_voltage?: string;
  asset_kind?: string;
  work_order_id?: string | null;
  photo_url?: string | null;
  submitted_by?: string | null;
  geom?: { type: string; coordinates: [number, number] } | null;
}

export interface GiopStagingResponse {
  assets: GiopStagingAsset[];
}

export interface GiopOcrResult {
  extracted_serial?: string;
  extracted_kwh?: number;
  meter_mrid?: string;
  serial_confidence?: number;
  kwh_confidence?: number;
  registry_match?: boolean;
  detail?: string;
}

export interface GiopH3CoverageFeature {
  type: 'Feature';
  geometry: { type: 'Polygon'; coordinates: number[][][] };
  properties: {
    h3: string;
    resolution: number;
    verified_count: number;
    staged_count: number;
    reference_count: number;
    assigned_to?: string | null;
    status?: string | null;
  };
}

export interface GiopH3CoverageResponse {
  type: 'FeatureCollection';
  resolution: number;
  features: GiopH3CoverageFeature[];
  cell_count: number;
}

async function fetchJson<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(url, options);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    const detail = (err as { detail?: string }).detail || res.statusText;
    throw new Error(detail || `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export interface GiopTopologyPayload {
  nodes: GiopTraceNode[];
  edges: GiopTraceEdge[];
  start_mrid?: string;
  metrics?: Record<string, number | boolean | string | null | undefined>;
}

export interface GiopTopologyHealth {
  status: string;
  metrics: {
    node_count: number;
    edge_count: number;
    edge_ratio: number;
    orphan_count: number;
    component_count?: number | null;
    largest_component_nodes?: number | null;
    graph_analysis?: string;
  };
}

export async function getTopologyHealth(): Promise<GiopTopologyHealth> {
  return fetchJson<GiopTopologyHealth>(`${SYNC_BASE}/topology/health`);
}

export async function getTopologyGaps(params?: {
  limit?: number;
  west?: number;
  south?: number;
  east?: number;
  north?: number;
}): Promise<GiopTopologyPayload> {
  const query = new URLSearchParams();
  if (params?.limit != null) query.set('limit', String(params.limit));
  if (params?.west != null) query.set('west', String(params.west));
  if (params?.south != null) query.set('south', String(params.south));
  if (params?.east != null) query.set('east', String(params.east));
  if (params?.north != null) query.set('north', String(params.north));
  const suffix = query.toString() ? `?${query}` : '';
  return fetchJson<GiopTopologyPayload>(`${SYNC_BASE}/topology/gaps${suffix}`);
}

export async function getTopologyImpact(
  startMrid: string,
  maxNodes = 5000,
): Promise<GiopTopologyPayload> {
  const query = new URLSearchParams({
    start_mrid: startMrid,
    max_nodes: String(maxNodes),
  });
  return fetchJson<GiopTopologyPayload>(`${SYNC_BASE}/topology/impact?${query}`);
}

export async function getTrace(
  startMrid: string,
  scope: 'traced' | 'full' = 'traced',
  options?: { maxHops?: number; maxNodes?: number },
): Promise<GiopTraceResponse> {
  const query = new URLSearchParams({ start_mrid: startMrid, scope });
  if (options?.maxHops != null) query.set('max_hops', String(options.maxHops));
  if (options?.maxNodes != null) query.set('max_nodes', String(options.maxNodes));
  return fetchJson<GiopTraceResponse>(`${SYNC_BASE}/trace?${query}`);
}

export async function getGraphChunk(params: {
  west: number;
  south: number;
  east: number;
  north: number;
  limit?: number;
  startMrid?: string;
}): Promise<GiopGraphChunkResponse> {
  const query = new URLSearchParams({
    west: String(params.west),
    south: String(params.south),
    east: String(params.east),
    north: String(params.north),
    limit: String(params.limit ?? 2000),
  });
  if (params.startMrid) query.set('start_mrid', params.startMrid);
  return fetchJson<GiopGraphChunkResponse>(`${SYNC_BASE}/graph/chunk?${query}`);
}

export async function getH3Coverage(params: {
  west: number;
  south: number;
  east: number;
  north: number;
  res?: number;
  includeReference?: boolean;
}): Promise<GiopH3CoverageResponse> {
  const query = new URLSearchParams({
    west: String(params.west),
    south: String(params.south),
    east: String(params.east),
    north: String(params.north),
    res: String(params.res ?? 8),
    include_reference: String(params.includeReference ?? true),
  });
  return fetchJson<GiopH3CoverageResponse>(`${SYNC_BASE}/h3/coverage?${query}`);
}

export const TERRITORY_H3_RES = 9;

export interface GiopH3Status {
  endpoints_ready: boolean;
  h3_available: boolean;
  import_error?: string | null;
  default_res: number;
}

export async function getH3Status(): Promise<GiopH3Status> {
  return fetchJson<GiopH3Status>(`${SYNC_BASE}/h3/status`);
}

export function formatH3ApiError(err: unknown, context: string): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg === 'Not Found' || msg.includes('404')) {
    return (
      `${context}: sync-service is running old code (H3 routes missing). ` +
      'In OVERSEEYER: Stop then Start sync-service. If Stop fails, run ' +
      'sudo pkill -f "uvicorn main:app.*--port 5000" then Start again.'
    );
  }
  if (msg.includes('H3 spatial index unavailable') || msg.includes('503')) {
    return `${context}: pip install -r sync-service/requirements.txt then restart sync-service.`;
  }
  return `${context}: ${msg}`;
}

export interface GiopH3AssignmentFeature {
  type: 'Feature';
  geometry: { type: 'Polygon'; coordinates: number[][][] };
  properties: {
    h3: string;
    resolution: number;
    assigned_to?: string | null;
    status: string;
    note?: string | null;
    updated_at?: string | null;
  };
}

export interface GiopH3AssignmentsGeoJson {
  type: 'FeatureCollection';
  features: GiopH3AssignmentFeature[];
  cell_count: number;
  bbox?: [number, number, number, number] | null;
}

export interface GiopH3CellAt {
  h3: string;
  resolution: number;
  geometry: { type: 'Polygon'; coordinates: number[][][] };
}

export interface GiopH3GridGeoJson {
  type: 'FeatureCollection';
  resolution: number;
  features: Array<{
    type: 'Feature';
    geometry: { type: 'Polygon'; coordinates: number[][][] };
    properties: { h3: string; resolution: number };
  }>;
  cell_count: number;
  truncated?: boolean;
}

export type GiopAssignmentStatus = 'ASSIGNED' | 'IN_PROGRESS' | 'DONE' | 'BLOCKED';

export async function getH3AssignmentsGeoJson(params?: {
  assignedTo?: string;
  status?: string;
}): Promise<GiopH3AssignmentsGeoJson> {
  const query = new URLSearchParams();
  if (params?.assignedTo) query.set('assigned_to', params.assignedTo);
  if (params?.status) query.set('status', params.status);
  const suffix = query.toString() ? `?${query}` : '';
  return fetchJson<GiopH3AssignmentsGeoJson>(`${SYNC_BASE}/h3/assignments/geojson${suffix}`);
}

export async function getH3CellAt(
  lat: number,
  lng: number,
  res = TERRITORY_H3_RES,
): Promise<GiopH3CellAt> {
  const query = new URLSearchParams({
    lat: String(lat),
    lng: String(lng),
    res: String(res),
  });
  return fetchJson<GiopH3CellAt>(`${SYNC_BASE}/h3/cell-at?${query}`);
}

export async function getH3GridGeoJson(params: {
  west: number;
  south: number;
  east: number;
  north: number;
  res?: number;
}): Promise<GiopH3GridGeoJson> {
  const query = new URLSearchParams({
    west: String(params.west),
    south: String(params.south),
    east: String(params.east),
    north: String(params.north),
    res: String(params.res ?? TERRITORY_H3_RES),
  });
  return fetchJson<GiopH3GridGeoJson>(`${SYNC_BASE}/h3/grid/geojson?${query}`);
}

export async function batchAssignH3Cells(payload: {
  h3_indexes: string[];
  assigned_to: string;
  resolution?: number;
  status?: GiopAssignmentStatus;
  note?: string;
}): Promise<{ assignments: unknown[]; count: number }> {
  return fetchJson(`${SYNC_BASE}/h3/assignments/batch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      resolution: TERRITORY_H3_RES,
      status: 'ASSIGNED',
      ...payload,
    }),
  });
}

export async function deleteH3Assignments(h3_indexes: string[]): Promise<{ deleted: number }> {
  return fetchJson(`${SYNC_BASE}/h3/assignments`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ h3_indexes }),
  });
}

export interface GiopAssetLocation {
  mrid: string;
  name?: string | null;
  validation?: string | null;
  longitude?: number | null;
  latitude?: number | null;
  boundary_feeder_id?: string | null;
  nominal_voltage?: string | null;
  tier?: 'master' | 'staging';
}

export async function getAssetLocation(mrid: string): Promise<GiopAssetLocation> {
  return fetchJson(`${SYNC_BASE}/assets/${encodeURIComponent(mrid)}`);
}

export type GiopMapSearchKind = 'asset' | 'place' | 'work_order' | 'crew';

export interface GiopMapSearchResult {
  kind: GiopMapSearchKind;
  id: string;
  title: string;
  subtitle?: string | null;
  longitude?: number | null;
  latitude?: number | null;
  bbox?: {
    west: number;
    south: number;
    east: number;
    north: number;
  } | null;
}

export async function searchMap(options: {
  q: string;
  limit?: number;
  kind?: GiopMapSearchKind | GiopMapSearchKind[];
}): Promise<GiopMapSearchResult[]> {
  const query = new URLSearchParams();
  query.set('q', options.q.trim());
  if (options.limit != null) query.set('limit', String(options.limit));
  if (options.kind) {
    const kinds = Array.isArray(options.kind) ? options.kind : [options.kind];
    query.set('kind', kinds.join(','));
  }
  const data = await fetchJson<{ results: GiopMapSearchResult[] }>(
    `${SYNC_BASE}/map/search?${query}`,
  );
  return data.results ?? [];
}

/** One-time district/region index for client-side map spotlight search. */
export async function getMapPlacesIndex(): Promise<GiopMapSearchResult[]> {
  const data = await fetchJson<{ places: GiopMapSearchResult[] }>(`${SYNC_BASE}/map/places-index`);
  return data.places ?? [];
}

/** OSM geocoding for towns/suburbs on the basemap (e.g. Gbawe) not in ECG districts. */
export async function getMapGeocode(options: {
  q: string;
  limit?: number;
}): Promise<GiopMapSearchResult[]> {
  const query = new URLSearchParams();
  query.set('q', options.q.trim());
  if (options.limit != null) query.set('limit', String(options.limit));
  const data = await fetchJson<{ results: GiopMapSearchResult[] }>(
    `${SYNC_BASE}/map/geocode?${query}`,
  );
  return data.results ?? [];
}

export async function getStagingAssets(options?: {
  includeRejected?: boolean;
  submittedBy?: string;
  /** Operations inbox: STAGED + IN_CONFLICT. DQ inbox: PENDING_FIELD + IN_CONFLICT. */
  queue?: 'all' | 'operations' | 'dq';
}): Promise<GiopStagingAsset[]> {
  const query = new URLSearchParams();
  if (options?.includeRejected) query.set('include_rejected', 'true');
  if (options?.submittedBy) query.set('submitted_by', options.submittedBy);
  if (options?.queue && options.queue !== 'all') query.set('queue', options.queue);
  const suffix = query.toString() ? `?${query}` : '';
  const data = await fetchJson<GiopStagingResponse>(`${SYNC_BASE}/assets/staging${suffix}`);
  return data.assets ?? [];
}

export async function approveAsset(mrid: string, operatorId?: string): Promise<void> {
  await fetchJson(`${SYNC_BASE}/assets/${mrid}/validation`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      validation: 'APPROVED',
      ...(operatorId ? { operator_id: operatorId } : {}),
    }),
  });
}

export async function rejectAsset(
  mrid: string,
  reason?: string,
  operatorId?: string,
): Promise<void> {
  await fetchJson(`${SYNC_BASE}/assets/${mrid}/validation`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      validation: 'REJECTED',
      ...(reason ? { reason } : {}),
      ...(operatorId ? { operator_id: operatorId } : {}),
    }),
  });
}

export interface GiopFieldTechnician {
  technician_id: string;
  display_name?: string | null;
  longitude: number;
  latitude: number;
  accuracy_m?: number | null;
  heading_deg?: number | null;
  speed_mps?: number | null;
  work_order_id?: string | null;
  session_started_at?: string | null;
  reported_at?: string | null;
  pending_submissions: number;
  total_submissions: number;
}

export async function getFieldTechnicians(
  staleMinutes = 30,
): Promise<GiopFieldTechnician[]> {
  const data = await fetchJson<{ technicians: GiopFieldTechnician[] }>(
    `${SYNC_BASE}/field/technicians?stale_minutes=${staleMinutes}`,
  );
  return data.technicians ?? [];
}

export async function getTechnicianSubmissions(
  technicianId: string,
): Promise<GiopStagingAsset[]> {
  const data = await fetchJson<{ submissions: GiopStagingAsset[] }>(
    `${SYNC_BASE}/field/technicians/${encodeURIComponent(technicianId)}/submissions`,
  );
  return data.submissions ?? [];
}

export async function patchAssetName(mrid: string, name: string): Promise<void> {
  await fetchJson(`${SYNC_BASE}/assets/${mrid}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
}

export async function patchAssetVoltage(
  mrid: string,
  nominalVoltage: string,
): Promise<void> {
  await fetchJson(`${SYNC_BASE}/assets/${mrid}/equipment`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nominal_voltage: nominalVoltage }),
  });
}

export interface GiopTopologyRepairResult {
  status: string;
  dry_run: boolean;
  result: {
    target_mrid: string;
    tier: string;
    dry_run: boolean;
    target_kind?: string;
    proposed?: Array<Record<string, unknown>>;
    applied?: Array<Record<string, unknown>>;
    skipped?: Array<Record<string, unknown>>;
    repairs?: Array<Record<string, unknown>>;
    radius_meters?: number;
  };
}

export async function repairTopology(
  targetMrid: string,
  options?: { radiusMeters?: number; dryRun?: boolean },
): Promise<GiopTopologyRepairResult> {
  return fetchJson(`${SYNC_BASE}/topology/repair`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      target_mrid: targetMrid,
      radius_meters: options?.radiusMeters ?? 50,
      dry_run: options?.dryRun ?? false,
    }),
  });
}

export async function submitMeterOcr(file: File): Promise<GiopOcrResult> {
  const form = new FormData();
  form.append('file', file);
  const res = await fetch(`${OCR_BASE}/meter/ocr`, { method: 'POST', body: form });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as { detail?: string }).detail || `OCR HTTP ${res.status}`);
  }
  return res.json() as Promise<GiopOcrResult>;
}

export async function submitTelemetry(meterMrid: string, activeEnergyKwh: number): Promise<unknown> {
  return fetchJson(`${SYNC_BASE}/telemetry/submit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ meter_mrid: meterMrid, active_energy_kwh: activeEnergyKwh }),
  });
}

export interface GiopInspection {
  id: string;
  asset_mrid: string;
  ai_validation_status: string;
  evidence_photo_url?: string | null;
  inspected_at?: string | null;
}

export async function listInspections(assetMrid?: string): Promise<GiopInspection[]> {
  const query = assetMrid ? `?asset_mrid=${encodeURIComponent(assetMrid)}` : '';
  const data = await fetchJson<{ inspections: GiopInspection[] }>(`${SYNC_BASE}/inspections${query}`);
  return data.inspections ?? [];
}

export async function createInspection(params: {
  assetMrid: string;
  evidencePhotoUrl?: string;
  inspectorNotes?: string;
}): Promise<GiopInspection> {
  return fetchJson<GiopInspection>(`${SYNC_BASE}/inspections`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      asset_mrid: params.assetMrid,
      evidence_photo_url: params.evidencePhotoUrl,
      inspector_notes: params.inspectorNotes,
    }),
  });
}

export const DEFAULT_START_MRID =
  import.meta.env.VITE_START_MRID || 'a0000000-0000-0000-0000-000000000001';

export interface GiopLineageEvent {
  id: number;
  target_mrid: string;
  source_type: string;
  action_type: string;
  operator_id?: string | null;
  provenance_ref?: string | null;
  before_state?: Record<string, unknown> | null;
  after_state?: Record<string, unknown> | null;
  created_at?: string | null;
}

export interface GiopConflictProposal {
  id: string;
  asset_mrid: string;
  asset_name?: string | null;
  offline_session_started_at?: string | null;
  server_updated_at?: string | null;
  proposed_payload?: Record<string, unknown>;
  status: string;
  created_at?: string | null;
}

export interface GiopDlqItem {
  id: string;
  source: string;
  payload: Record<string, unknown>;
  error_message: string;
  status: string;
  retry_count: number;
  created_at?: string | null;
}

export interface GiopHealthMetrics {
  status: 'green' | 'amber' | 'red';
  request_count: number;
  error_count: number;
  error_rate_pct: number;
  latency_p50_ms: number;
  latency_p95_ms: number;
  last_kafka_ingest_at?: number | null;
}

export interface GiopEnergyBalanceResult {
  id?: string | null;
  zone_key: string;
  period_start: string;
  period_end: string;
  energy_in_kwh: number;
  energy_out_kwh: number;
  variance_pct: number;
  anomaly_flag: boolean;
  meter_count?: number;
}

export async function getLineage(assetMrid: string, limit = 50): Promise<GiopLineageEvent[]> {
  const query = new URLSearchParams({ asset_mrid: assetMrid, limit: String(limit) });
  const data = await fetchJson<{ events: GiopLineageEvent[] }>(`${SYNC_BASE}/lineage?${query}`);
  return data.events ?? [];
}

export async function searchLineage(options: {
  assetMrid?: string;
  sourceType?: string;
  actionType?: string;
  limit?: number;
  offset?: number;
}): Promise<GiopLineageEvent[]> {
  const query = new URLSearchParams();
  if (options.assetMrid) query.set('asset_mrid', options.assetMrid);
  if (options.sourceType) query.set('source_type', options.sourceType);
  if (options.actionType) query.set('action_type', options.actionType);
  query.set('limit', String(options.limit ?? 50));
  query.set('offset', String(options.offset ?? 0));
  const data = await fetchJson<{ events: GiopLineageEvent[] }>(
    `${SYNC_BASE}/lineage/search?${query}`,
  );
  return data.events ?? [];
}

export async function listConflicts(): Promise<GiopConflictProposal[]> {
  const data = await fetchJson<{ conflicts: GiopConflictProposal[] }>(`${SYNC_BASE}/conflicts`);
  return data.conflicts ?? [];
}

export async function resolveConflict(
  conflictId: string,
  resolution: 'master' | 'field' | 'discard',
): Promise<unknown> {
  return fetchJson(`${SYNC_BASE}/conflicts/${conflictId}/resolve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ resolution }),
  });
}

export async function generateSchematic(mrid: string): Promise<string> {
  const res = await fetch(`${SYNC_BASE}/schematic/generate?mrid=${encodeURIComponent(mrid)}`);
  if (!res.ok) throw new Error(`Schematic HTTP ${res.status}`);
  return res.text();
}

export async function runEnergyBalance(params: {
  zoneKey: string;
  periodStart: string;
  periodEnd: string;
  nominalInjectionKwh?: number;
}): Promise<GiopEnergyBalanceResult> {
  return fetchJson<GiopEnergyBalanceResult>(`${SYNC_BASE}/analytics/energy-accounting/balance`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      zone_key: params.zoneKey,
      period_start: params.periodStart,
      period_end: params.periodEnd,
      nominal_injection_kwh: params.nominalInjectionKwh,
    }),
  });
}

export interface GiopDqRule {
  rule_code: string;
  domain: string;
  severity: string;
  description: string;
  enabled: boolean;
  blocks_promotion: boolean;
}

export interface GiopDqException {
  id: string;
  record_type: string;
  record_mrid: string;
  rule_code: string;
  domain: string;
  severity: string;
  status: string;
  error_message: string;
  details?: Record<string, unknown> | null;
  owner?: string | null;
  resolution_note?: string | null;
  resolved_by?: string | null;
  created_at?: string | null;
  resolved_at?: string | null;
  asset_name?: string | null;
  longitude?: number | null;
  latitude?: number | null;
  location_key?: string | null;
  colocated_staging_count?: number | null;
  colocated_staging_peers?: Array<{
    mrid: string;
    name?: string | null;
    validation?: string | null;
  }> | null;
  staging_validation?: string | null;
  can_release_to_operations?: boolean;
  rule_description?: string | null;
  blocks_promotion?: boolean;
  record_context?: {
    tier?: string | null;
    submitted_by?: string | null;
    work_order_id?: string | null;
    photo_url?: string | null;
    record_updated_at?: string | null;
    lifecycle_state?: string | null;
    asset_kind?: string | null;
    operating_utility?: string | null;
    substation_name?: string | null;
    boundary_feeder_id?: string | null;
  } | null;
}

export interface GiopDqSummary {
  open_total: number;
  open_by_severity: Record<string, number>;
  open_by_domain: Record<string, number>;
}

export interface GiopTopologyDqSummary {
  live: {
    approved_nodes: number;
    orphan_nodes: number;
    orphan_ratio: number;
    dangling_lines: number;
    lines_with_unapproved_endpoints: number;
  };
  exception_queue: Record<string, number>;
  export_blocked: {
    blocked: boolean;
    reasons: string[];
    caps: { open_topology_exceptions: number; orphan_ratio: number };
  };
  /** 'snapshot' = served from the last scan (fast); 'live' = freshly computed. */
  source?: 'snapshot' | 'live';
  /** ISO timestamp of the scan the snapshot came from (snapshot mode only). */
  scanned_at?: string | null;
  run_id?: string;
  /** master | staging — which network tier these counts describe. */
  tier?: 'master' | 'staging';
}

export interface GiopTopologyDqScanResult {
  run_id: string;
  status: string;
  orphans_found: number;
  orphans_inserted: number;
  dangling_found: number;
  dangling_inserted: number;
  unapproved_endpoints_found: number;
  unapproved_endpoints_inserted: number;
  auto_cleared: number;
  live: GiopTopologyDqSummary['live'];
  exception_queue: Record<string, number>;
  export_gate: GiopTopologyDqSummary['export_blocked'];
}

export async function getTopologyDqSummary(options?: {
  clip?: { west: number; south: number; east: number; north: number };
  /** 'snapshot' (default, fast) reads the last scan; 'live' forces recompute. */
  mode?: 'snapshot' | 'live';
  tier?: 'master' | 'staging';
}): Promise<GiopTopologyDqSummary> {
  const q = new URLSearchParams();
  const clip = options?.clip ?? GHANA_EXPORT_CLIP;
  q.set('west', String(clip.west));
  q.set('south', String(clip.south));
  q.set('east', String(clip.east));
  q.set('north', String(clip.north));
  q.set('mode', options?.mode ?? 'snapshot');
  q.set('tier', options?.tier ?? 'master');
  return fetchJson(`${SYNC_BASE}/dq/topology/summary?${q}`);
}

export async function runTopologyDqScan(options?: {
  clip?: { west: number; south: number; east: number; north: number };
  operatorId?: string;
}): Promise<{ run_id: string; status: string; message?: string }> {
  return fetchJson(`${SYNC_BASE}/dq/topology/scan`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      clip: options?.clip ?? GHANA_EXPORT_CLIP,
      operator_id: options?.operatorId,
    }),
  });
}

export interface GiopTopologyDqRun {
  id: string;
  scan_type: string;
  status: string;
  orphans_found: number;
  orphans_inserted: number;
  dangling_found: number;
  dangling_inserted: number;
  auto_cleared: number;
  started_at?: string | null;
  completed_at?: string | null;
  error_message?: string | null;
}

export async function listTopologyDqRuns(limit = 10): Promise<GiopTopologyDqRun[]> {
  const data = await fetchJson<{ runs: GiopTopologyDqRun[] }>(
    `${SYNC_BASE}/dq/topology/runs?limit=${limit}`,
  );
  return data.runs ?? [];
}

export interface GiopDqExceptionPage {
  exceptions: GiopDqException[];
  count: number;
  total: number;
  offset: number;
  limit: number;
}

export interface GiopDqQueueItem {
  mrid: string;
  name?: string | null;
  validation: string;
  submitted_by?: string | null;
  work_order_id?: string | null;
  photo_url?: string | null;
  updated_at?: string | null;
  lifecycle_state?: string | null;
  longitude?: number | null;
  latitude?: number | null;
  boundary_feeder_id?: string | null;
  asset_kind?: string | null;
  operating_utility?: string | null;
  substation_name?: string | null;
  open_exception_count: number;
  blocking_open_count: number;
  can_release_to_operations?: boolean;
  location_key?: string | null;
  colocated_staging_count?: number | null;
  colocated_staging_peers?: Array<{
    mrid: string;
    name?: string | null;
    validation?: string | null;
  }> | null;
  exceptions: GiopDqException[];
  record_context?: GiopDqException['record_context'];
  tier?: 'staging';
}

export interface GiopDqQueuePage {
  items: GiopDqQueueItem[];
  count: number;
  total: number;
  offset: number;
  limit: number;
}

export async function listDqQueue(options?: {
  /** ALL = every capture in DQ inbox; OPEN = has open issues; CLEAR = no open issues */
  status?: string;
  duplicatesOnly?: boolean;
  severity?: string;
  domain?: string;
  validation?: 'PENDING_FIELD' | 'IN_CONFLICT';
  limit?: number;
  offset?: number;
}): Promise<GiopDqQueuePage> {
  const query = new URLSearchParams();
  query.set('status', options?.status ?? 'ALL');
  if (options?.duplicatesOnly) query.set('duplicates_only', 'true');
  if (options?.severity) query.set('severity', options.severity);
  if (options?.domain) query.set('domain', options.domain);
  if (options?.validation) query.set('validation', options.validation);
  query.set('limit', String(options?.limit ?? 50));
  query.set('offset', String(options?.offset ?? 0));
  return fetchJson(`${SYNC_BASE}/dq/queue?${query}`);
}

export async function listDqExceptions(options?: {
  status?: string;
  severity?: string;
  domain?: string;
  recordMrid?: string;
  limit?: number;
  offset?: number;
  /** Default dq: exceptions for assets still in the DQ queue. */
  queue?: 'dq' | 'operations' | 'all';
}): Promise<GiopDqExceptionPage> {
  const query = new URLSearchParams();
  query.set('status', options?.status ?? 'OPEN');
  if (options?.severity) query.set('severity', options.severity);
  if (options?.domain) query.set('domain', options.domain);
  if (options?.recordMrid) query.set('record_mrid', options.recordMrid);
  if (options?.queue) query.set('queue', options.queue);
  query.set('limit', String(options?.limit ?? 50));
  query.set('offset', String(options?.offset ?? 0));
  return fetchJson(`${SYNC_BASE}/dq/exceptions?${query}`);
}

export async function releaseDqAssetToOperations(
  mrid: string,
  options?: { operatorId?: string; runChecks?: boolean },
): Promise<{ mrid: string; validation: string; previous_validation?: string }> {
  return fetchJson(`${SYNC_BASE}/dq/assets/${mrid}/release-to-operations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...(options?.operatorId ? { operator_id: options.operatorId } : {}),
      run_checks: options?.runChecks ?? true,
    }),
  });
}

export async function getDqSummary(options?: {
  tier?: 'master' | 'staging' | 'all';
}): Promise<GiopDqSummary> {
  const q = new URLSearchParams();
  if (options?.tier) q.set('tier', options.tier);
  const suffix = q.toString() ? `?${q}` : '';
  return fetchJson<GiopDqSummary>(`${SYNC_BASE}/dq/summary${suffix}`);
}

export async function listDqRules(): Promise<GiopDqRule[]> {
  const data = await fetchJson<{ rules: GiopDqRule[] }>(`${SYNC_BASE}/dq/rules`);
  return data.rules ?? [];
}

export async function resolveDqException(
  exceptionId: string,
  status: 'RESOLVED' | 'DEFERRED' | 'QUARANTINED' | 'REJECTED',
  note?: string,
): Promise<unknown> {
  return fetchJson(`${SYNC_BASE}/dq/exceptions/${exceptionId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status, note }),
  });
}

export async function runDqChecks(mrid: string, tier: 'staging' | 'master' = 'staging'): Promise<unknown> {
  const query = new URLSearchParams({ mrid, tier });
  return fetchJson(`${SYNC_BASE}/dq/run?${query}`, { method: 'POST' });
}

export interface GiopValidationRun {
  id: string;
  run_type: string;
  status: string;
  mode: string;
  requested_by?: string | null;
  started_at?: string | null;
  completed_at?: string | null;
}

export interface GiopKpiSnapshot {
  topology_validity_pct?: number;
  completeness_pct?: number;
  critical_exception_count?: number;
  open_exception_count?: number;
  auto_fix_success_rate?: number | null;
  pending_approval_count?: number;
  export_blocked?: boolean;
  escalation?: Array<{ code: string; message: string; action: string }>;
}

export interface GiopValidationProgress {
  run_id: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  mode?: string;
  run_type?: string;
  started_at?: string | null;
  completed_at?: string | null;
  error_message?: string | null;
  current_phase?: string | null;
  phase_detail?: string | null;
  completed_phases?: string[];
  steps?: Array<{
    agent_name?: string;
    tool_name?: string | null;
    policy_decision?: string | null;
    output_summary?: Record<string, unknown> | null;
    created_at?: string | null;
  }>;
  kpi?: GiopKpiSnapshot;
  agent_summary?: {
    content?: string;
    findings?: string[];
    actions?: string[];
    agent?: Record<string, unknown>;
  };
}

export interface GiopAgentsStatus {
  engine: string;
  llm_configured: boolean;
  llm_model?: string | null;
  llm_base_url?: string | null;
  llm_tools?: string[];
  llm_tool_count?: number;
  llm_reachable?: boolean;
  llm_error?: string | null;
  agents: string[];
}

export interface GiopApprovalRequest {
  id: string;
  cleanup_id?: string | null;
  exception_id?: string | null;
  rationale?: string | null;
  created_at?: string | null;
  cleanup_mode?: string | null;
  plan?: Record<string, unknown>;
  target_mrid?: string | null;
  rollback_sql?: string | null;
  qgis_steps?: string | null;
  rule_code?: string | null;
  severity?: string | null;
  error_message?: string | null;
  proposal_id?: string | null;
  change_summary?: Record<string, unknown> | null;
  dry_run_result?: Record<string, unknown> | null;
  proposed_by?: string | null;
  proposal_status?: string | null;
}

export interface GiopTopologyProposal {
  id: string;
  exception_id?: string | null;
  cleanup_id?: string | null;
  approval_id?: string | null;
  target_mrid?: string | null;
  rule_code?: string | null;
  proposed_by?: string | null;
  ai_rationale?: string | null;
  dry_run_result?: Record<string, unknown> | null;
  change_summary?: Record<string, unknown> | null;
  status?: string | null;
  published_by?: string | null;
  published_at?: string | null;
  error_message?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  severity?: string | null;
  exception_message?: string | null;
}

export async function runValidationCycle(options?: {
  runType?: 'full_cycle' | 'asset_checks' | 'topology_master' | 'revalidation';
  mode?: 'deterministic' | 'agent';
  operatorId?: string;
  async?: boolean;
}): Promise<{ run_id: string; status: string; async?: boolean; kpi?: GiopKpiSnapshot }> {
  const useAsync = options?.async !== false;
  const url = useAsync ? `${SYNC_BASE}/validation/run?async=true` : `${SYNC_BASE}/validation/run?async=false`;
  return fetchJson(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      run_type: options?.runType ?? 'full_cycle',
      mode: options?.mode ?? 'deterministic',
      operator_id: options?.operatorId,
    }),
  });
}

export async function getValidationRunProgress(runId: string): Promise<GiopValidationProgress> {
  return fetchJson(`${SYNC_BASE}/validation/runs/${runId}/progress`);
}

export async function getAgentsStatus(): Promise<GiopAgentsStatus> {
  return fetchJson(`${SYNC_BASE}/agents/status`);
}

export async function getLatestKpis(): Promise<GiopKpiSnapshot> {
  return fetchJson(`${SYNC_BASE}/kpis/latest`);
}

export async function listPendingApprovals(): Promise<GiopApprovalRequest[]> {
  const data = await fetchJson<{ approvals: GiopApprovalRequest[] }>(`${SYNC_BASE}/approvals/pending`);
  return data.approvals ?? [];
}

export async function approveCleanupRequest(
  approvalId: string,
  note?: string,
): Promise<unknown> {
  return fetchJson(`${SYNC_BASE}/approvals/${approvalId}/approve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ note, execute: false }),
  });
}

export async function rejectCleanupRequest(
  approvalId: string,
  note?: string,
): Promise<unknown> {
  return fetchJson(`${SYNC_BASE}/approvals/${approvalId}/reject`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ note }),
  });
}

export async function listApprovedProposals(): Promise<GiopTopologyProposal[]> {
  const data = await fetchJson<{ proposals: GiopTopologyProposal[] }>(
    `${SYNC_BASE}/proposals/approved`,
  );
  return data.proposals ?? [];
}

export async function publishTopologyProposal(
  proposalId: string,
  operatorId?: string,
): Promise<unknown> {
  return fetchJson(`${SYNC_BASE}/proposals/${proposalId}/publish`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ operator_id: operatorId }),
  });
}

export async function generateTopologyProposal(exceptionId: string): Promise<unknown> {
  return fetchJson(`${SYNC_BASE}/proposals/generate/${exceptionId}`, { method: 'POST' });
}

export async function generateCleanupPlan(exceptionId: string): Promise<unknown> {
  return fetchJson(`${SYNC_BASE}/cleanup/generate/${exceptionId}`, { method: 'POST' });
}

export async function portalAiChat(options: {
  message: string;
  exceptionId?: string;
  mrid?: string;
  context?: Record<string, unknown>;
}): Promise<{
  content: string;
  findings: string[];
  actions: string[];
  ui_actions?: Array<Record<string, unknown>>;
  agent?: Record<string, unknown>;
}> {
  return fetchJson(`${SYNC_BASE}/portal/ai/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: options.message,
      exception_id: options.exceptionId,
      mrid: options.mrid,
      context: options.context,
    }),
  });
}

export interface GiopVoiceStatus {
  stt: {
    mode?: string;
    provider?: string;
    available?: boolean;
    model?: string;
    beam_size?: number;
    initial_prompt_preview?: string;
    hint?: string | null;
    browser?: boolean;
    note?: string;
  };
  tts: { enabled: boolean; available: boolean; url?: string; voice?: string; lang?: string };
}

export async function getVoiceCopilotStatus(): Promise<GiopVoiceStatus> {
  return fetchJson(`${SYNC_BASE}/portal/ai/voice/status`);
}

export async function portalAiTranscribe(blob: Blob): Promise<{
  text: string;
  raw?: string;
  fixes?: string[];
}> {
  const form = new FormData();
  const name = blob.type.includes('ogg') ? 'recording.ogg' : 'recording.webm';
  form.append('audio', blob, name);
  const res = await fetch(`${SYNC_BASE}/portal/ai/transcribe`, {
    method: 'POST',
    body: form,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    const detail = (err as { detail?: string }).detail || res.statusText;
    throw new Error(detail || `HTTP ${res.status}`);
  }
  return res.json() as Promise<{ text: string; raw?: string; fixes?: string[] }>;
}

export interface GiopRealtimeSessionToken {
  value: string;
  expires_at?: number;
  model: string;
}

/** Mint an ephemeral OpenAI Realtime client secret (live-voice PoC). */
export async function createRealtimeSession(options?: {
  operatorId?: string;
}): Promise<GiopRealtimeSessionToken> {
  return fetchJson(`${SYNC_BASE}/portal/ai/realtime/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ operator_id: options?.operatorId }),
  });
}

export async function portalAiVoiceAudioTurn(options: {
  audio: Blob;
  sessionId?: string;
  exceptionId?: string;
  mrid?: string;
  operatorId?: string;
  context?: Record<string, unknown>;
}): Promise<{
  content: string;
  findings: string[];
  actions: string[];
  ui_actions?: Array<Record<string, unknown>>;
  agent?: Record<string, unknown> & {
    speak?: string;
    session_id?: string;
    transcript?: string;
    fast_path?: boolean;
    voice?: boolean;
    tts?: GiopVoiceStatus['tts'];
  };
}> {
  const form = new FormData();
  const name = options.audio.type.includes('ogg') ? 'recording.ogg' : 'recording.webm';
  form.append('audio', options.audio, name);
  if (options.sessionId) form.append('session_id', options.sessionId);
  if (options.exceptionId) form.append('exception_id', options.exceptionId);
  if (options.mrid) form.append('mrid', options.mrid);
  if (options.operatorId) form.append('operator_id', options.operatorId);
  if (options.context && Object.keys(options.context).length > 0) {
    form.append('context', JSON.stringify(options.context));
  }
  const res = await fetch(`${SYNC_BASE}/portal/ai/voice-audio-turn`, {
    method: 'POST',
    body: form,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    const detail = (err as { detail?: string }).detail || res.statusText;
    throw new Error(detail || `HTTP ${res.status}`);
  }
  return res.json() as Promise<{
    content: string;
    findings: string[];
    actions: string[];
    ui_actions?: Array<Record<string, unknown>>;
    agent?: Record<string, unknown> & {
      speak?: string;
      session_id?: string;
      transcript?: string;
      fast_path?: boolean;
      voice?: boolean;
      tts?: GiopVoiceStatus['tts'];
    };
  }>;
}

export async function portalAiVoiceTurn(options: {
  text: string;
  sessionId?: string;
  exceptionId?: string;
  mrid?: string;
  context?: Record<string, unknown>;
}): Promise<{
  content: string;
  findings: string[];
  actions: string[];
  ui_actions?: Array<Record<string, unknown>>;
  agent?: Record<string, unknown> & {
    speak?: string;
    session_id?: string;
    fast_path?: boolean;
    voice?: boolean;
    tts?: GiopVoiceStatus['tts'];
  };
}> {
  return fetchJson(`${SYNC_BASE}/portal/ai/voice-turn`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text: options.text,
      session_id: options.sessionId,
      exception_id: options.exceptionId,
      mrid: options.mrid,
      context: options.context,
    }),
  });
}

export interface GiopStagingSummary {
  pending_total: number;
  by_validation: Record<string, number>;
  in_conflict: number;
  active_field_workers: number;
}

export interface GiopStagingTerritoryCount {
  territory: string;
  group_by: string;
  asset_count: number;
  pending_field: number;
  staged: number;
  in_conflict: number;
}

export async function getStagingSummary(): Promise<GiopStagingSummary> {
  return fetchJson(`${SYNC_BASE}/staging/summary`);
}

export async function getStagingTerritoryCounts(options?: {
  groupBy?: 'region' | 'district';
  region?: string;
  limit?: number;
}): Promise<{ group_by: string; counts: GiopStagingTerritoryCount[] }> {
  const params = new URLSearchParams();
  if (options?.groupBy) params.set('group_by', options.groupBy);
  if (options?.region) params.set('region', options.region);
  if (options?.limit) params.set('limit', String(options.limit));
  const suffix = params.toString() ? `?${params.toString()}` : '';
  return fetchJson(`${SYNC_BASE}/staging/territory-counts${suffix}`);
}

export interface GiopSpatialTerritory {
  district?: string | null;
  region?: string | null;
  polygon_count?: number;
  center?: { lon: number; lat: number };
  bbox?: { west: number; south: number; east: number; north: number };
}

export interface GiopSpatialInventory {
  tier: string;
  asset_kind_filter?: string | null;
  total: number;
  by_kind: Record<string, number>;
  pole_total?: number;
  district?: string | null;
  region?: string | null;
  bbox?: Record<string, number> | null;
  note?: string;
}

export async function getSpatialTerritory(options?: {
  district?: string;
  region?: string;
}): Promise<GiopSpatialTerritory> {
  const params = new URLSearchParams();
  if (options?.district) params.set('district', options.district);
  if (options?.region) params.set('region', options.region);
  const suffix = params.toString() ? `?${params.toString()}` : '';
  return fetchJson(`${SYNC_BASE}/spatial/territory${suffix}`);
}

export async function getSpatialTerritoryGeojson(options?: {
  district?: string;
  region?: string;
}): Promise<TerritoryGeoJson> {
  const params = new URLSearchParams();
  if (options?.district) params.set('district', options.district);
  if (options?.region) params.set('region', options.region);
  const suffix = params.toString() ? `?${params.toString()}` : '';
  return fetchJson(`${SYNC_BASE}/spatial/territory/geojson${suffix}`);
}

export async function getSpatialInventory(options?: {
  tier?: 'master' | 'staging';
  assetKind?: string;
  district?: string;
  region?: string;
  bbox?: { west: number; south: number; east: number; north: number };
}): Promise<GiopSpatialInventory> {
  const params = new URLSearchParams();
  if (options?.tier) params.set('tier', options.tier);
  if (options?.assetKind) params.set('asset_kind', options.assetKind);
  if (options?.district) params.set('district', options.district);
  if (options?.region) params.set('region', options.region);
  if (options?.bbox) {
    params.set('west', String(options.bbox.west));
    params.set('south', String(options.bbox.south));
    params.set('east', String(options.bbox.east));
    params.set('north', String(options.bbox.north));
  }
  const suffix = params.toString() ? `?${params.toString()}` : '';
  return fetchJson(`${SYNC_BASE}/spatial/inventory${suffix}`);
}

export interface GiopExportJob {
  id: string;
  format?: string;
  status: string;
  feature_count?: number | null;
  created_at?: string | null;
  completed_at?: string | null;
}

/** Ghana operating bbox — default CIM export window (matches sync-service). */
export const GHANA_EXPORT_CLIP = {
  west: -3.5,
  south: 4.5,
  east: 1.5,
  north: 8.5,
} as const;

export async function createCimExport(options?: {
  layers?: string[];
  clip?: { west: number; south: number; east: number; north: number };
  operatorId?: string;
}): Promise<{ job: GiopExportJob }> {
  return fetchJson(`${SYNC_BASE}/exports/cim`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      layers: options?.layers,
      clip: options?.clip ?? GHANA_EXPORT_CLIP,
      operator_id: options?.operatorId,
    }),
  });
}

export async function listCimExports(limit = 50): Promise<GiopExportJob[]> {
  const data = await fetchJson<{ jobs: GiopExportJob[] }>(`${SYNC_BASE}/exports?limit=${limit}`);
  return data.jobs ?? [];
}

export function downloadExportUrl(jobId: string): string {
  return `${SYNC_BASE}/exports/${encodeURIComponent(jobId)}/download`;
}

/** @deprecated use downloadExportUrl */
export function downloadCimExportUrl(jobId: string): string {
  return downloadExportUrl(jobId);
}

export async function createDxfExport(options?: {
  clip?: { west: number; south: number; east: number; north: number };
  includeNodes?: boolean;
  includeLines?: boolean;
  operatorId?: string;
}): Promise<{ job: GiopExportJob }> {
  return fetchJson(`${SYNC_BASE}/exports/dxf`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      clip: options?.clip ?? GHANA_EXPORT_CLIP,
      include_nodes: options?.includeNodes ?? true,
      include_lines: options?.includeLines ?? true,
      operator_id: options?.operatorId,
    }),
  });
}

export async function previewDxfExport(options?: {
  limit?: number;
  clip?: { west: number; south: number; east: number; north: number };
}): Promise<{ counts: Record<string, number> }> {
  const clip = options?.clip ?? GHANA_EXPORT_CLIP;
  const limit = options?.limit ?? 50;
  const q = new URLSearchParams({
    limit: String(limit),
    west: String(clip.west),
    south: String(clip.south),
    east: String(clip.east),
    north: String(clip.north),
  });
  return fetchJson(`${SYNC_BASE}/exports/dxf/preview?${q}`);
}

export type GiopExportFormat =
  | 'geopackage'
  | 'kml'
  | 'shapefile'
  | 'csv'
  | 'cim-xml'
  | 'cim-rdf'
  | 'mdms-csv'
  | 'sap-csv';

export const EXPORT_FORMAT_LABELS: Record<string, string> = {
  'cim-json': 'CIM JSON',
  dxf: 'AutoCAD DXF',
  geopackage: 'GeoPackage',
  kml: 'KML',
  shapefile: 'Shapefile (zip)',
  csv: 'CSV bundle (zip)',
  'cim-xml': 'CIM RDF/XML (legacy name)',
  'cim-rdf': 'CIM RDF/XML (IEC 61968/61970)',
  'mdms-csv': 'MDMS batch CSV',
  'sap-csv': 'SAP batch CSV',
};

export async function listExportFormats(): Promise<string[]> {
  const data = await fetchJson<{ formats: string[] }>(`${SYNC_BASE}/exports/formats`);
  return data.formats ?? [];
}

export async function createFormatExport(
  format: GiopExportFormat,
  options?: {
    layers?: string[];
    clip?: { west: number; south: number; east: number; north: number };
    includeMeters?: boolean;
    operatorId?: string;
  },
): Promise<{ job: GiopExportJob }> {
  return fetchJson(`${SYNC_BASE}/exports/${encodeURIComponent(format)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      layers: options?.layers,
      clip: format === 'mdms-csv' ? undefined : (options?.clip ?? GHANA_EXPORT_CLIP),
      include_meters: options?.includeMeters ?? true,
      operator_id: options?.operatorId,
    }),
  });
}

// --- GIS reference layers & boundary import ---------------------------------

export interface GiopReferenceLayer {
  slug: string;
  display_name: string;
  description?: string | null;
  kind: 'boundary' | 'network' | 'overlay' | string;
  target_schema: string;
  target_table: string;
  martin_source_id?: string | null;
  gpkg_layer_name?: string | null;
  geometry_type?: string | null;
  min_zoom?: number | null;
  max_zoom?: number | null;
  sort_order: number;
  active: boolean;
  requires_post_import_refresh: boolean;
  feature_count?: number | null;
  last_imported_at?: string | null;
  render_mode?: 'martin' | 'geojson_static' | 'geojson_bbox' | 'none' | string;
  built_in_map_style?: boolean;
  bbox?: { west: number; south: number; east: number; north: number } | null;
  vertex_count?: number | null;
  table_bytes?: number | null;
  render_stats?: Record<string, unknown>;
  parent_slug?: string | null;
  dissolve_column?: string | null;
  label_field?: string | null;
  detail_min_zoom?: number | null;
  is_overview_derived?: boolean;
}

export interface GiopInspectLayer {
  name: string;
  feature_count: number;
  geometry_type?: string | null;
  fields: { name: string; type?: string }[];
  error?: string;
}

export interface GiopInspectResult {
  inspect_id: string;
  filename: string;
  layer_count: number;
  layers: GiopInspectLayer[];
}

export interface GiopBoundaryFieldSuggest {
  dissolve_column: string | null;
  label_field: string | null;
}

export interface GiopReferenceMapLayerConfig {
  slug: string;
  display_name: string;
  kind: string;
  render_mode: 'martin' | 'geojson_static' | 'geojson_bbox' | 'none';
  built_in_map_style: boolean;
  geometry_type?: string | null;
  min_zoom?: number | null;
  max_zoom?: number | null;
  feature_count?: number;
  bbox?: { west: number; south: number; east: number; north: number } | null;
  parent_slug?: string | null;
  is_overview_derived?: boolean;
  detail_min_zoom?: number | null;
  label_field?: string | null;
  martin?: { source_id: string; tiles: string[] };
  geojson?: { url_template: string; bbox_fetch: boolean };
}

export interface GiopGisImportJob {
  id: string;
  format?: string;
  status: string;
  layers?: string[] | null;
  feature_count?: number | null;
  error_message?: string | null;
  created_at?: string | null;
  completed_at?: string | null;
}

export async function listReferenceLayers(): Promise<GiopReferenceLayer[]> {
  const data = await fetchJson<{ layers: GiopReferenceLayer[] }>(`${SYNC_BASE}/reference-layers`);
  return data.layers ?? [];
}

/** True when an active catalog network layer has been imported and is renderable. */
export function referenceNetworkReady(layers: GiopReferenceLayer[]): boolean {
  return layers.some(
    (layer) =>
      layer.kind === 'network' &&
      layer.active &&
      layer.render_mode !== 'none' &&
      (layer.feature_count ?? 0) > 0,
  );
}

export async function getReferenceMapConfig(): Promise<GiopReferenceMapLayerConfig[]> {
  const data = await fetchJson<{ layers: GiopReferenceMapLayerConfig[] }>(
    `${SYNC_BASE}/reference-layers/map-config`,
  );
  return data.layers ?? [];
}

export async function getReferenceLayerGeojson(
  slug: string,
  bbox?: { west: number; south: number; east: number; north: number },
): Promise<GeoJSON.FeatureCollection> {
  const params = new URLSearchParams();
  if (bbox) {
    params.set('west', String(bbox.west));
    params.set('south', String(bbox.south));
    params.set('east', String(bbox.east));
    params.set('north', String(bbox.north));
  }
  const suffix = params.toString() ? `?${params.toString()}` : '';
  return fetchJson<GeoJSON.FeatureCollection>(
    `${SYNC_BASE}/reference-layers/${encodeURIComponent(slug)}/geojson${suffix}`,
  );
}

export async function listGisImports(limit = 50): Promise<GiopGisImportJob[]> {
  const data = await fetchJson<{ jobs: GiopGisImportJob[] }>(`${SYNC_BASE}/imports?limit=${limit}`);
  return data.jobs ?? [];
}

export async function importBoundaryGeopackage(
  file: File,
  layerSlug = 'ecg-admin-boundaries',
): Promise<{ job: GiopGisImportJob }> {
  const form = new FormData();
  form.append('file', file);
  const params = new URLSearchParams({ layer_slug: layerSlug });
  const res = await fetch(`${SYNC_BASE}/imports/boundaries?${params.toString()}`, {
    method: 'POST',
    body: form,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    const detail = (err as { detail?: string }).detail || `Import HTTP ${res.status}`;
    if (res.status === 404) {
      throw new Error(
        `${detail} — restart sync-service (./scripts/start_giop_stack.sh) to load GIS import routes`,
      );
    }
    throw new Error(detail);
  }
  return res.json() as Promise<{ job: GiopGisImportJob }>;
}

export async function importBundledBoundaries(
  filePath = '../supabase/Power System.gpkg',
): Promise<{ job: GiopGisImportJob }> {
  return fetchJson(`${SYNC_BASE}/imports/boundaries/bundled`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ file_path: filePath, layer_slugs: ['ecg-admin-boundaries'] }),
  });
}

export async function inspectGisUpload(file: File): Promise<GiopInspectResult> {
  const form = new FormData();
  form.append('file', file);
  const res = await fetch(`${SYNC_BASE}/imports/inspect`, { method: 'POST', body: form });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as { detail?: string }).detail || `Inspect HTTP ${res.status}`);
  }
  return res.json() as Promise<GiopInspectResult>;
}

export async function getInspectPreview(
  inspectId: string,
  layer: string,
): Promise<GeoJSON.FeatureCollection> {
  const params = new URLSearchParams({ layer });
  return fetchJson<GeoJSON.FeatureCollection>(
    `${SYNC_BASE}/imports/inspect/${encodeURIComponent(inspectId)}/preview?${params.toString()}`,
  );
}

export async function suggestInspectFields(
  inspectId: string,
  layer: string,
): Promise<GiopBoundaryFieldSuggest> {
  const params = new URLSearchParams({ layer });
  return fetchJson<GiopBoundaryFieldSuggest>(
    `${SYNC_BASE}/imports/inspect/${encodeURIComponent(inspectId)}/suggest?${params.toString()}`,
  );
}

export interface ReferenceImportConfig {
  inspect_id: string;
  display_name: string;
  source_layer: string;
  dissolve_column?: string | null;
  label_field?: string | null;
  detail_min_zoom?: number;
  catalog_slug?: string | null;
}

export async function commitReferenceImport(
  config: ReferenceImportConfig,
): Promise<{ job: GiopGisImportJob }> {
  return fetchJson(`${SYNC_BASE}/imports/reference`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(config),
  });
}

// --- FR-017 migration adapter (GeoPackage / DXF) ---------------------------
export interface GiopMigrationRun {
  id: string;
  source_format: string;
  source_name: string | null;
  status: string;
  feature_count: number;
  committed_count: number;
  failed_count: number;
  requested_by: string | null;
  started_at: string | null;
  finished_at: string | null;
}

export interface GiopMigrationFailed {
  id: string;
  source_ref: string | null;
  primitive: string | null;
  error_message: string;
  dlq_id: string | null;
  created_at: string | null;
}

export interface GiopMigrationResult {
  run_id: string;
  source_format: string;
  source_name: string;
  feature_count: number;
  committed: number;
  failed: number;
  status: string;
}

export interface GiopAffineParams {
  anchor_lon: number;
  anchor_lat: number;
  scale?: number;
  rotation_deg?: number;
  origin_x?: number;
  origin_y?: number;
}

export async function migrateDxf(body: {
  dxf_text?: string;
  file_path?: string;
  source_name?: string;
  apply_affine: boolean;
  affine?: GiopAffineParams;
  default_feeder?: string | null;
  default_utility?: string;
  requested_by?: string | null;
}): Promise<GiopMigrationResult> {
  return fetchJson(`${SYNC_BASE}/migration/dxf`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export async function migrateGeopackage(body: {
  file_path: string;
  table?: string | null;
  source_name?: string;
  apply_affine: boolean;
  affine?: GiopAffineParams;
  default_feeder?: string | null;
  default_utility?: string;
  requested_by?: string | null;
}): Promise<GiopMigrationResult> {
  return fetchJson(`${SYNC_BASE}/migration/geopackage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export async function listMigrationRuns(limit = 50): Promise<GiopMigrationRun[]> {
  const data = await fetchJson<{ runs: GiopMigrationRun[] }>(`${SYNC_BASE}/migration/runs?limit=${limit}`);
  return data.runs ?? [];
}

export async function listMigrationFailed(runId: string): Promise<GiopMigrationFailed[]> {
  const data = await fetchJson<{ failed: GiopMigrationFailed[] }>(
    `${SYNC_BASE}/migration/runs/${encodeURIComponent(runId)}/failed`,
  );
  return data.failed ?? [];
}

export async function listDlq(status = 'OPEN'): Promise<GiopDlqItem[]> {
  const data = await fetchJson<{ items: GiopDlqItem[] }>(`${SYNC_BASE}/dlq?status=${encodeURIComponent(status)}`);
  return data.items ?? [];
}

export async function retryDlq(dlqId: string): Promise<unknown> {
  return fetchJson(`${SYNC_BASE}/dlq/${dlqId}/retry`, { method: 'POST' });
}

export async function discardDlq(dlqId: string): Promise<unknown> {
  return fetchJson(`${SYNC_BASE}/dlq/${dlqId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'DISCARDED' }),
  });
}

export interface GiopSapIntegrationStatus {
  enabled: boolean;
  mode: string;
  mock_mode: boolean;
  base_url_configured: boolean;
  customer_entity_path: string;
  customer_accounts_total: number;
  customer_accounts_sap_linked: number;
  open_sap_dlq_count: number;
  last_run?: {
    id: string;
    mode: string;
    status: string;
    fetched: number;
    upserted: number;
    failed: number;
    error_summary?: string | null;
    started_at?: string | null;
    finished_at?: string | null;
  } | null;
}

export interface GiopSapSyncResult {
  run_id: string;
  mode: string;
  status: string;
  fetched: number;
  upserted: number;
  failed: number;
  errors: string[];
}

export async function getSapIntegrationStatus(): Promise<GiopSapIntegrationStatus> {
  return fetchJson(`${SYNC_BASE}/integrations/sap/status`);
}

export async function syncSapCustomers(): Promise<GiopSapSyncResult> {
  return fetchJson(`${SYNC_BASE}/integrations/sap/sync/customers`, { method: 'POST' });
}

export async function getHealthMetrics(): Promise<GiopHealthMetrics> {
  return fetchJson<GiopHealthMetrics>(`${SYNC_BASE}/health/metrics`);
}

/** Aggregated left-nav badge counts, keyed by portal tab id. */
export type GiopNavBadgeCounts = Record<string, number>;

export async function getNavBadges(): Promise<GiopNavBadgeCounts> {
  const data = await fetchJson<{ badges: GiopNavBadgeCounts }>(`${SYNC_BASE}/ops/badges`);
  return data.badges ?? {};
}

// --- Operational modules (Phase 2) ---

export interface GiopContactCase {
  id: string;
  reference: string;
  channel: string;
  account_mrid?: string | null;
  meter_mrid?: string | null;
  asset_mrid?: string | null;
  classification: string;
  priority: number;
  status: string;
  assigned_to?: string | null;
  summary: string;
  notes?: string | null;
  created_at?: string | null;
  links?: Array<Record<string, string>>;
}

export interface GiopTroubleTicket {
  id: string;
  reference: string;
  source: string;
  account_mrid?: string | null;
  meter_mrid?: string | null;
  asset_mrid?: string | null;
  ticket_type: string;
  severity: string;
  priority: number;
  status: string;
  assigned_to?: string | null;
  summary: string;
  resolution_code?: string | null;
  created_at?: string | null;
  links?: Array<Record<string, string>>;
}

export interface GiopWorkOrder {
  id: string;
  reference: string;
  work_type: string;
  priority: number;
  status: string;
  assigned_crew?: string | null;
  assigned_user?: string | null;
  asset_mrid?: string | null;
  summary: string;
  notes?: string | null;
  longitude?: number | null;
  latitude?: number | null;
  created_at?: string | null;
  links?: Array<Record<string, string>>;
}

export interface GiopOutage {
  id: string;
  reference: string;
  outage_type: string;
  status: string;
  started_at?: string | null;
  estimated_restoration_at?: string | null;
  restored_at?: string | null;
  affected_area?: string | null;
  feeder_id?: string | null;
  customers_affected: number;
  is_published: boolean;
  summary: string;
  links?: Array<Record<string, string>>;
}

export interface GiopRegulatoryMetrics {
  period_start: string;
  period_end: string;
  customer_base: number;
  outage_count: number;
  customer_minutes_interrupted: number;
  customers_affected_total: number;
  saidi_minutes: number;
  saifi_interruptions_per_customer: number;
  caidi_minutes: number;
  methodology_note?: string;
}

export async function listCases(status?: string): Promise<GiopContactCase[]> {
  const q = status ? `?status=${encodeURIComponent(status)}` : '';
  const data = await fetchJson<{ cases: GiopContactCase[] }>(`${SYNC_BASE}/cases${q}`);
  return data.cases ?? [];
}

export async function createCase(params: {
  channel: string;
  summary: string;
  classification?: string;
  priority?: number;
  account_mrid?: string;
  notes?: string;
}): Promise<GiopContactCase> {
  return fetchJson(`${SYNC_BASE}/cases`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
}

export async function convertCaseToTicket(caseId: string): Promise<GiopTroubleTicket> {
  return fetchJson(`${SYNC_BASE}/cases/${caseId}/convert-ticket`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
}

export async function convertCaseToWorkOrder(caseId: string): Promise<GiopWorkOrder> {
  return fetchJson(`${SYNC_BASE}/cases/${caseId}/convert-work-order`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ assigned_user: 'tech.demo' }),
  });
}

export async function listTickets(status?: string): Promise<GiopTroubleTicket[]> {
  const q = status ? `?status=${encodeURIComponent(status)}` : '';
  const data = await fetchJson<{ tickets: GiopTroubleTicket[] }>(`${SYNC_BASE}/tickets${q}`);
  return data.tickets ?? [];
}

export async function patchTicket(
  ticketId: string,
  body: { status?: string; assigned_to?: string },
): Promise<GiopTroubleTicket> {
  return fetchJson(`${SYNC_BASE}/tickets/${ticketId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export async function listWorkOrders(status?: string): Promise<GiopWorkOrder[]> {
  const q = status ? `?status=${encodeURIComponent(status)}` : '';
  const data = await fetchJson<{ work_orders: GiopWorkOrder[] }>(`${SYNC_BASE}/work-orders${q}`);
  return data.work_orders ?? [];
}

export async function createWorkOrder(params: {
  summary: string;
  work_type?: string;
  assigned_user?: string;
  assigned_crew?: string;
}): Promise<GiopWorkOrder> {
  return fetchJson(`${SYNC_BASE}/work-orders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
}

export async function patchWorkOrder(
  workOrderId: string,
  body: { status?: string; assigned_user?: string },
): Promise<GiopWorkOrder> {
  return fetchJson(`${SYNC_BASE}/work-orders/${workOrderId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export async function listOutages(publishedOnly = false): Promise<GiopOutage[]> {
  const q = publishedOnly ? '?published_only=true' : '';
  const data = await fetchJson<{ outages: GiopOutage[] }>(`${SYNC_BASE}/outages${q}`);
  return data.outages ?? [];
}

export async function createOutage(params: {
  summary: string;
  outage_type?: string;
  affected_area?: string;
  feeder_id?: string;
  customers_affected?: number;
  is_published?: boolean;
  create_ticket?: boolean;
}): Promise<GiopOutage> {
  return fetchJson(`${SYNC_BASE}/outages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
}

export async function restoreOutage(outageId: string): Promise<GiopOutage> {
  return fetchJson(`${SYNC_BASE}/outages/${outageId}/restore`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
}

export async function patchOutage(
  outageId: string,
  body: { is_published?: boolean; status?: string },
): Promise<GiopOutage> {
  return fetchJson(`${SYNC_BASE}/outages/${outageId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export async function getRegulatoryMetrics(
  periodStart: string,
  periodEnd: string,
  customerBase = 10000,
): Promise<GiopRegulatoryMetrics> {
  const q = new URLSearchParams({
    period_start: periodStart,
    period_end: periodEnd,
    customer_base: String(customerBase),
  });
  return fetchJson<GiopRegulatoryMetrics>(`${SYNC_BASE}/regulatory/metrics?${q}`);
}

export async function generateRegulatoryReport(params: {
  periodStart: string;
  periodEnd: string;
  customerBase?: number;
}): Promise<{ id: string; metrics: GiopRegulatoryMetrics }> {
  return fetchJson(`${SYNC_BASE}/regulatory/reports/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      period_start: params.periodStart,
      period_end: params.periodEnd,
      customer_base: params.customerBase ?? 10000,
    }),
  });
}

function resolvePublicBaseUrl(raw: string | undefined, fallbackPath: string): string {
  const value = (raw || fallbackPath).replace(/\/$/, '');
  if (/^https?:\/\//i.test(value)) {
    return value;
  }
  const path = value.startsWith('/') ? value : `/${value}`;
  if (typeof window !== 'undefined') {
    return `${window.location.origin}${path}`;
  }
  return `http://127.0.0.1:3001`;
}

/** Absolute base URL for Martin vector tiles (MapLibre workers reject relative paths). */
export const MARTIN_URL = resolvePublicBaseUrl(
  import.meta.env.VITE_MARTIN_URL,
  'http://127.0.0.1:3001',
);

/** Whether legacy GIS network overview layers (conductors, transformers) are loaded. */
export async function probeGisOverviewAvailable(
  _martinUrl: string = MARTIN_URL,
  signal?: AbortSignal,
): Promise<boolean> {
  try {
    const res = await fetch(`${SYNC_BASE}/reference-layers`, { signal });
    if (!res.ok) return false;
    const data = (await res.json()) as { layers?: GiopReferenceLayer[] };
    return referenceNetworkReady(data.layers ?? []);
  } catch {
    return false;
  }
}

export const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL || 'http://127.0.0.1:54321';
export const SUPABASE_ANON_KEY =
  import.meta.env.VITE_SUPABASE_ANON_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0';
