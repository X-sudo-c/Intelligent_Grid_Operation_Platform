import { type GiopStagingAsset } from '../api/giop-api';
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
 * Memgraph / PostGIS trace seeds must be master connectivity nodes on the national graph.
 * Staging-only MRIDs cannot be graph roots — fall back to the resolved national seed.
 */
export function resolveTopologyStartMrid(
  _tab: GiopPortalTab,
  routeStartMrid: string | undefined,
  nationalSeed: string,
  stagingAssets: GiopStagingAsset[],
): string {
  const requested = routeStartMrid || nationalSeed;
  if (isStagingOnlySeed(requested, stagingAssets)) return nationalSeed;
  return requested;
}
