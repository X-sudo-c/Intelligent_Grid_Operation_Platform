import { DEFAULT_START_MRID, type GiopStagingAsset } from '../api/giop-api';
import type { GiopPortalTab } from './giopPortalRouting';

/** Pending field / staged assets are not in the master Memgraph trace. */
export function isStagingOnlySeed(
  mrid: string,
  stagingAssets: GiopStagingAsset[],
): boolean {
  const row = stagingAssets.find((a) => a.mrid === mrid);
  if (!row) return false;
  return row.validation !== 'APPROVED';
}

/**
 * Memgraph / PostGIS trace seeds must be master connectivity nodes.
 * Operations desk always uses the default master seed; staging table rows are not graph roots.
 */
export function resolveTopologyStartMrid(
  tab: GiopPortalTab,
  routeStartMrid: string | undefined,
  stagingAssets: GiopStagingAsset[],
): string {
  if (tab === 'operations') return DEFAULT_START_MRID;

  const requested = routeStartMrid || DEFAULT_START_MRID;
  if (isStagingOnlySeed(requested, stagingAssets)) return DEFAULT_START_MRID;
  return requested;
}
