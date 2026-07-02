import type { GiopDqException } from '../api/giop-api';
import { formatDqCoordinates } from './giopDqLocationClusters';

const DETAIL_LABELS: Record<string, string> = {
  longitude: 'Longitude',
  latitude: 'Latitude',
  lon: 'Longitude',
  lat: 'Latitude',
  bbox: 'Bounding box',
  distance_m: 'Distance (m)',
  duplicate_mrid: 'Near-duplicate MRID',
  mrid: 'MRID',
  name: 'Name',
  line_count: 'Connected lines',
  days_since_update: 'Days since update',
  source_node_mrid: 'Source node',
  target_node_mrid: 'Target node',
  missing_source: 'Missing source',
  missing_target: 'Missing target',
  source_approved: 'Source approved',
  target_approved: 'Target approved',
  connectivity_node_mrid: 'Connectivity node',
  endpoint_node_mrid: 'Endpoint node',
  node_mrid: 'Node MRID',
  in_ecg_region: 'Inside ECG region',
};

function humanizeKey(key: string): string {
  if (DETAIL_LABELS[key]) return DETAIL_LABELS[key];
  return key
    .replaceAll('_', ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function formatDetailValue(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'number') {
    if (Number.isInteger(value)) return value.toLocaleString();
    return value.toLocaleString(undefined, { maximumFractionDigits: 6 });
  }
  if (Array.isArray(value)) {
    if (value.every((v) => typeof v === 'number')) {
      return value.map((n) => Number(n).toFixed(5)).join(', ');
    }
    return value.map((v) => formatDetailValue(v)).join(', ');
  }
  if (typeof value === 'object') {
    return JSON.stringify(value);
  }
  return String(value);
}

export interface DqPresentField {
  label: string;
  value: string;
  mono?: boolean;
  href?: string;
}

export function buildDqExceptionFields(item: GiopDqException): DqPresentField[] {
  const ctx = item.record_context ?? {};
  const fields: DqPresentField[] = [];

  const push = (label: string, value: unknown, opts?: { mono?: boolean; href?: string }) => {
    if (value === null || value === undefined || value === '') return;
    fields.push({
      label,
      value: typeof value === 'string' ? value : formatDetailValue(value),
      mono: opts?.mono,
      href: opts?.href,
    });
  };

  push('Asset name', item.asset_name);
  push('MRID', item.record_mrid, { mono: true });
  push('Record tier', ctx.tier ?? (item.staging_validation ? 'staging' : undefined));
  push('Record type', item.record_type?.replaceAll('_', ' '));
  push('Validation', item.staging_validation);
  push('Lifecycle', ctx.lifecycle_state);
  push('Asset kind', ctx.asset_kind?.replaceAll('_', ' '));
  push('Submitted by', ctx.submitted_by, { mono: true });
  push('Work order', ctx.work_order_id, { mono: true });
  push('Operating utility', ctx.operating_utility);
  push('Substation', ctx.substation_name);
  push('Boundary feeder', ctx.boundary_feeder_id, { mono: true });

  const coords = formatDqCoordinates(item.longitude, item.latitude);
  if (coords) push('Coordinates', coords, { mono: true });

  if (ctx.record_updated_at) {
    const ts = new Date(ctx.record_updated_at);
    push(
      'Last updated',
      Number.isNaN(ts.getTime()) ? ctx.record_updated_at : ts.toLocaleString(),
    );
  }
  if (item.created_at) {
    const ts = new Date(item.created_at);
    push(
      'Exception opened',
      Number.isNaN(ts.getTime()) ? item.created_at : ts.toLocaleString(),
    );
  }

  if (ctx.photo_url) {
    push('Field photo', 'View capture', { href: ctx.photo_url });
  }

  if (item.details && typeof item.details === 'object') {
    for (const [key, value] of Object.entries(item.details)) {
      if (value === null || value === undefined) continue;
      // Skip fields already shown from record_context / top-level enrichment.
      if (
        key === 'asset_name' &&
        item.asset_name &&
        String(value) === item.asset_name
      ) {
        continue;
      }
      push(humanizeKey(key), formatDetailValue(value), {
        mono: key.includes('mrid') || key === 'bbox',
      });
    }
  }

  if (item.resolution_note) push('Resolution note', item.resolution_note);
  if (item.resolved_by) push('Resolved by', item.resolved_by, { mono: true });
  if (item.resolved_at) {
    const ts = new Date(item.resolved_at);
    push(
      'Resolved at',
      Number.isNaN(ts.getTime()) ? item.resolved_at : ts.toLocaleString(),
    );
  }

  return fields;
}

/** Rule-specific evidence only — omit record context already shown on the parent capture card. */
export function buildDqIssueDetailFields(item: GiopDqException): DqPresentField[] {
  const fields: DqPresentField[] = [];
  const push = (label: string, value: unknown, opts?: { mono?: boolean }) => {
    if (value === null || value === undefined || value === '') return;
    fields.push({
      label,
      value: typeof value === 'string' ? value : formatDetailValue(value),
      mono: opts?.mono,
    });
  };

  if (item.details && typeof item.details === 'object') {
    for (const [key, value] of Object.entries(item.details)) {
      if (value === null || value === undefined) continue;
      push(humanizeKey(key), formatDetailValue(value), {
        mono: key.includes('mrid') || key === 'bbox',
      });
    }
  }

  if (item.resolution_note) push('Resolution note', item.resolution_note);
  return fields;
}
