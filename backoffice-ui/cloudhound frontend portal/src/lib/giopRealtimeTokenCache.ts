import type { GiopRealtimeSessionToken } from '../api/giop-api';
import { createRealtimeSession } from '../api/giop-api';

const TOKEN_SKEW_MS = 90_000;

let cachedToken: GiopRealtimeSessionToken | null = null;
let prefetchPromise: Promise<GiopRealtimeSessionToken | null> | null = null;

function tokenExpiresAtMs(token: GiopRealtimeSessionToken): number {
  return (token.expires_at ?? 0) * 1000;
}

export function isRealtimeTokenFresh(token: GiopRealtimeSessionToken | null): boolean {
  if (!token?.value) return false;
  const expiresAt = tokenExpiresAtMs(token);
  if (expiresAt <= 0) return true;
  return expiresAt - Date.now() > TOKEN_SKEW_MS;
}

export function getCachedRealtimeToken(): GiopRealtimeSessionToken | null {
  return isRealtimeTokenFresh(cachedToken) ? cachedToken : null;
}

export function setCachedRealtimeToken(token: GiopRealtimeSessionToken | null): void {
  cachedToken = token;
}

/**
 * Mint a Realtime client secret before the user clicks Live voice (Phase 3 latency).
 * Safe to call multiple times — dedupes in-flight requests.
 */
export function prefetchRealtimeSessionToken(): Promise<GiopRealtimeSessionToken | null> {
  const fresh = getCachedRealtimeToken();
  if (fresh) return Promise.resolve(fresh);

  if (prefetchPromise) return prefetchPromise;

  prefetchPromise = createRealtimeSession()
    .then((token) => {
      setCachedRealtimeToken(token);
      return token;
    })
    .catch(() => null)
    .finally(() => {
      prefetchPromise = null;
    });

  return prefetchPromise;
}

export async function resolveRealtimeSessionToken(): Promise<GiopRealtimeSessionToken> {
  const fresh = getCachedRealtimeToken();
  if (fresh) return fresh;
  const token = await createRealtimeSession();
  setCachedRealtimeToken(token);
  return token;
}
