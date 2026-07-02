import type { GiopDqQueueItem } from '../api/giop-api';

export interface DuplicateDiffField {
  key: string;
  label: string;
  activeValue: string;
  otherValues: string[];
  differs: boolean;
}

const DIFF_SPECS: Array<{
  key: string;
  label: string;
  read: (item: GiopDqQueueItem) => string | null;
}> = [
  { key: 'submitted_by', label: 'Submitted by', read: (i) => i.submitted_by ?? i.record_context?.submitted_by ?? null },
  { key: 'work_order_id', label: 'Work order', read: (i) => i.work_order_id ?? i.record_context?.work_order_id ?? null },
  {
    key: 'asset_kind',
    label: 'Asset kind',
    read: (i) => (i.asset_kind ?? i.record_context?.asset_kind ?? null)?.replaceAll('_', ' ') ?? null,
  },
  {
    key: 'operating_utility',
    label: 'Operating utility',
    read: (i) => i.operating_utility ?? i.record_context?.operating_utility ?? null,
  },
  {
    key: 'substation_name',
    label: 'Substation',
    read: (i) => i.substation_name ?? i.record_context?.substation_name ?? null,
  },
  {
    key: 'boundary_feeder_id',
    label: 'Boundary feeder',
    read: (i) => i.boundary_feeder_id ?? i.record_context?.boundary_feeder_id ?? null,
  },
  { key: 'validation', label: 'Validation', read: (i) => i.validation ?? null },
  {
    key: 'open_exception_count',
    label: 'Open issues',
    read: (i) => String(i.open_exception_count ?? 0),
  },
  {
    key: 'updated_at',
    label: 'Captured',
    read: (i) => {
      if (!i.updated_at) return null;
      const ts = new Date(i.updated_at);
      return Number.isNaN(ts.getTime()) ? i.updated_at : ts.toLocaleString();
    },
  },
];

function normalizeValue(value: string | null | undefined): string {
  if (value == null || value === '') return '—';
  return value;
}

export function buildDuplicateDiffFields(
  peers: GiopDqQueueItem[],
  activeMrid: string,
): DuplicateDiffField[] {
  const active = peers.find((p) => p.mrid === activeMrid);
  if (!active || peers.length < 2) return [];

  const fields: DuplicateDiffField[] = [];
  for (const spec of DIFF_SPECS) {
    const values = peers.map((peer) => normalizeValue(spec.read(peer)));
    const unique = new Set(values);
    const differs = unique.size > 1;
    const activeValue = normalizeValue(spec.read(active));
    const otherValues = peers
      .filter((p) => p.mrid !== activeMrid)
      .map((p) => normalizeValue(spec.read(p)));
    if (!differs && activeValue === '—' && otherValues.every((v) => v === '—')) continue;
    fields.push({
      key: spec.key,
      label: spec.label,
      activeValue,
      otherValues,
      differs,
    });
  }
  return fields;
}

export function activeDiffersFromPeers(fields: DuplicateDiffField[]): string[] {
  return fields.filter((f) => f.differs).map((f) => f.label);
}

export interface DuplicateTimelineEntry {
  mrid: string;
  name: string | null;
  updatedAt: string | null;
  validation: string | null;
  isActive: boolean;
  hasOpenIssues: boolean;
}

export function buildDuplicateTimeline(
  peers: GiopDqQueueItem[],
  activeMrid: string,
): DuplicateTimelineEntry[] {
  return [...peers]
    .sort((a, b) => {
      const ta = a.updated_at ? Date.parse(a.updated_at) : 0;
      const tb = b.updated_at ? Date.parse(b.updated_at) : 0;
      return ta - tb;
    })
    .map((item) => ({
      mrid: item.mrid,
      name: item.name ?? null,
      updatedAt: item.updated_at ?? null,
      validation: item.validation ?? null,
      isActive: item.mrid === activeMrid,
      hasOpenIssues: (item.open_exception_count ?? 0) > 0,
    }));
}

export interface DuplicatePhotoEntry {
  mrid: string;
  name: string | null;
  photoUrl: string;
  isActive: boolean;
}

export function collectDuplicatePhotos(
  peers: GiopDqQueueItem[],
  activeMrid: string,
): DuplicatePhotoEntry[] {
  const entries: DuplicatePhotoEntry[] = [];
  for (const item of peers) {
    const photoUrl = item.photo_url ?? item.record_context?.photo_url;
    if (!photoUrl) continue;
    entries.push({
      mrid: item.mrid,
      name: item.name ?? null,
      photoUrl,
      isActive: item.mrid === activeMrid,
    });
  }
  return entries;
}
