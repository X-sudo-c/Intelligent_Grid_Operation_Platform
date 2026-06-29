import type { GiopDqException } from '../api/giop-api';

/** Prefer a point geometry MRID when the exception targets a line or indirect record. */
export function dqExceptionMapMrid(item: GiopDqException): string {
  const d = item.details;
  if (d && typeof d === 'object') {
    for (const key of [
      'connectivity_node_mrid',
      'source_node_mrid',
      'node_mrid',
      'endpoint_node_mrid',
    ]) {
      const v = d[key];
      if (typeof v === 'string' && v.length > 0) return v;
    }
  }
  return item.record_mrid;
}
