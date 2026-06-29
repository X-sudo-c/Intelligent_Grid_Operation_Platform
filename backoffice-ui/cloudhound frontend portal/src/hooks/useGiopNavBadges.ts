import { useCallback, useEffect, useRef, useState } from 'react';
import { getNavBadges } from '../api/giop-api';
import type { GiopPortalTab } from '../lib/giopPortalRouting';
import { readSwCache, writeSwCache } from '../lib/giopSwCache';

export type GiopNavBadgeMap = Partial<Record<GiopPortalTab, number>>;

const BADGES_CACHE_KEY = 'ops-nav-badges';

function badgesFromCounts(counts: Record<string, number>): GiopNavBadgeMap {
  const next: GiopNavBadgeMap = {};
  for (const [tab, count] of Object.entries(counts)) {
    if (typeof count === 'number' && count > 0) {
      next[tab as GiopPortalTab] = count;
    }
  }
  return next;
}

/**
 * Left-nav badge counts with stale-while-revalidate.
 *
 * Shows the last-known counts instantly from session cache, then refreshes in
 * the background. Backed by `/ops/badges` (Redis-cached server-side).
 */
export function useGiopNavBadges(refreshToken = 0): GiopNavBadgeMap {
  const [badges, setBadges] = useState<GiopNavBadgeMap>(
    () => readSwCache<GiopNavBadgeMap>(BADGES_CACHE_KEY) ?? {},
  );
  const hasCacheRef = useRef(Boolean(readSwCache(BADGES_CACHE_KEY)));

  const revalidate = useCallback(async () => {
    try {
      const counts = await getNavBadges();
      const next = badgesFromCounts(counts);
      writeSwCache(BADGES_CACHE_KEY, next);
      hasCacheRef.current = true;
      setBadges(next);
    } catch {
      if (!hasCacheRef.current) setBadges({});
    }
  }, []);

  useEffect(() => {
    void revalidate();
    const id = window.setInterval(() => void revalidate(), 30_000);
    return () => window.clearInterval(id);
  }, [refreshToken, revalidate]);

  return badges;
}
