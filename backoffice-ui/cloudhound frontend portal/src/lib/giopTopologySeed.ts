import { DEFAULT_START_MRID } from '../api/giop-api';

/** Demo island from 00002_seed.sql — not connected to the national GIS graph. */
export const DEMO_ISLAND_MRIDS = new Set([
  'a0000000-0000-0000-0000-000000000001',
  'a0000000-0000-0000-0000-000000000002',
  'a0000000-0000-0000-0000-000000000003',
]);

const SEED_CACHE_KEY = 'giop.topologySeed.v1';
const SEED_CENTER_CACHE_KEY = 'giop.topologySeedCenter.v1';

export interface TopologySeedCenter {
  lon: number;
  lat: number;
}

export function isDemoIslandSeed(mrid: string | null | undefined): boolean {
  if (!mrid) return false;
  return DEMO_ISLAND_MRIDS.has(mrid);
}

export function readCachedTopologySeed(): string | null {
  try {
    const raw = sessionStorage.getItem(SEED_CACHE_KEY);
    if (raw && !isDemoIslandSeed(raw)) return raw;
  } catch {
    /* ignore */
  }
  return null;
}

export function readCachedTopologySeedCenter(): TopologySeedCenter | null {
  try {
    const raw = sessionStorage.getItem(SEED_CENTER_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as TopologySeedCenter;
    if (typeof parsed.lon === 'number' && typeof parsed.lat === 'number') return parsed;
  } catch {
    /* ignore */
  }
  return null;
}

export function writeCachedTopologySeed(mrid: string, center?: TopologySeedCenter | null): void {
  try {
    sessionStorage.setItem(SEED_CACHE_KEY, mrid);
    if (center) {
      sessionStorage.setItem(SEED_CENTER_CACHE_KEY, JSON.stringify(center));
    }
  } catch {
    /* ignore */
  }
}

/** Effective trace root: explicit national seed from route/env, else cached replacement for demo island. */
export function pickTopologySeed(routeStartMrid: string | undefined): string {
  const requested = routeStartMrid || DEFAULT_START_MRID;
  if (!isDemoIslandSeed(requested)) return requested;
  const cached = readCachedTopologySeed();
  if (cached) return cached;
  return DEFAULT_START_MRID;
}

export function shouldAutoResolveTopologySeed(routeStartMrid: string | undefined): boolean {
  return isDemoIslandSeed(routeStartMrid || DEFAULT_START_MRID) && !readCachedTopologySeed();
}
