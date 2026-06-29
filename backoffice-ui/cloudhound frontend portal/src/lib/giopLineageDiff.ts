const SKIP_DIFF_KEYS = new Set(['updated_at', 'created_at']);

export interface LineageFieldChange {
  field: string;
  before: unknown;
  after: unknown;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function flattenState(
  value: unknown,
  prefix = '',
  out: Record<string, unknown> = {},
): Record<string, unknown> {
  if (!isPlainObject(value)) {
    if (prefix) out[prefix] = value;
    return out;
  }
  for (const [key, nested] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (isPlainObject(nested)) {
      flattenState(nested, path, out);
    } else {
      out[path] = nested;
    }
  }
  return out;
}

export function diffLineageStates(
  before?: Record<string, unknown> | null,
  after?: Record<string, unknown> | null,
): LineageFieldChange[] {
  const left = flattenState(before ?? {});
  const right = flattenState(after ?? {});
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  const changes: LineageFieldChange[] = [];

  for (const field of [...keys].sort()) {
    if (SKIP_DIFF_KEYS.has(field.split('.').pop() ?? field)) continue;
    const prev = left[field];
    const next = right[field];
    if (JSON.stringify(prev) === JSON.stringify(next)) continue;
    changes.push({ field, before: prev, after: next });
  }
  return changes;
}

export function formatLineageValue(value: unknown): string {
  if (value === undefined || value === null) return '—';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

export const LINEAGE_SOURCE_LABELS: Record<string, string> = {
  FIELD_SYNC: 'Field sync',
  REPAIR: 'Topology repair',
  PROMOTE: 'Promote to master',
  MANUAL_EDIT: 'Manual edit',
  DLQ_RETRY: 'DLQ retry',
  SYSTEM: 'System',
};
