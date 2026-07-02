import type { GiopTopologyRepairResult } from '../api/giop-api';

type LineFeature = {
  type: 'Feature';
  properties: Record<string, unknown>;
  geometry: { type: 'LineString'; coordinates: [number, number][] };
};

type FeatureCollection = {
  type: 'FeatureCollection';
  features: LineFeature[];
};

export interface GiopRepairPreviewLayers {
  before: FeatureCollection;
  after: FeatureCollection;
}

const EMPTY: FeatureCollection = { type: 'FeatureCollection', features: [] };

function lineFromGeom(geom: unknown): [number, number][] | null {
  if (!geom || typeof geom !== 'object') return null;
  const g = geom as { type?: string; coordinates?: unknown };
  if (g.type !== 'LineString' || !Array.isArray(g.coordinates)) return null;
  const coords = g.coordinates.filter(
    (c): c is [number, number] =>
      Array.isArray(c) && c.length >= 2 && typeof c[0] === 'number' && typeof c[1] === 'number',
  );
  return coords.length >= 2 ? coords : null;
}

export function repairPreviewToGeoJson(
  result: GiopTopologyRepairResult['result'] | null | undefined,
): GiopRepairPreviewLayers {
  if (!result?.proposed?.length) {
    return { before: EMPTY, after: EMPTY };
  }

  const before: LineFeature[] = [];
  const after: LineFeature[] = [];

  for (const item of result.proposed) {
    const segmentMrid = item.segment_mrid as string | undefined;
    const segmentTier = (item.segment_tier as string | undefined) ?? 'staging';
    const props = {
      segment_mrid: segmentMrid,
      segment_tier: segmentTier,
      link_start_to: item.link_start_to,
      link_end_to: item.link_end_to,
      start_dist_m: item.start_dist_m,
      end_dist_m: item.end_dist_m,
      deferred_until_promote: item.deferred_until_promote ?? false,
    };

    const beforeCoords = lineFromGeom(item.geom_before);
    const afterCoords = lineFromGeom(item.geom_after);

    if (beforeCoords) {
      before.push({
        type: 'Feature',
        properties: { ...props, preview_role: 'before' },
        geometry: { type: 'LineString', coordinates: beforeCoords },
      });
    }
    if (afterCoords) {
      after.push({
        type: 'Feature',
        properties: { ...props, preview_role: 'after' },
        geometry: { type: 'LineString', coordinates: afterCoords },
      });
    }
  }

  return {
    before: { type: 'FeatureCollection', features: before },
    after: { type: 'FeatureCollection', features: after },
  };
}

export function formatRepairProposalSummary(item: Record<string, unknown>): string {
  const tier = (item.segment_tier as string) ?? 'staging';
  const seg = String(item.segment_mrid ?? '').slice(0, 8);
  const parts: string[] = [`${tier} span ${seg}…`];
  if (item.link_start_to) parts.push(`start → ${String(item.link_start_to).slice(0, 8)}…`);
  if (item.link_end_to) parts.push(`end → ${String(item.link_end_to).slice(0, 8)}…`);
  if (item.start_dist_m != null) parts.push(`${item.start_dist_m}m`);
  if (item.deferred_until_promote) parts.push('(on promote)');
  return parts.join(' · ');
}
