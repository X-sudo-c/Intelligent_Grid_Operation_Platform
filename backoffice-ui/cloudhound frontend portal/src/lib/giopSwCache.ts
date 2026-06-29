const PREFIX = 'giop.swr.v1:';

export interface GiopSwCacheEntry<T> {
  data: T;
  fetchedAt: number;
}

/** Read cached payload (any age). Returns null on miss or parse error. */
export function readSwCache<T>(key: string): T | null {
  try {
    const raw = sessionStorage.getItem(PREFIX + key);
    if (!raw) return null;
    const entry = JSON.parse(raw) as GiopSwCacheEntry<T>;
    return entry?.data ?? null;
  } catch {
    return null;
  }
}

export function readSwCacheEntry<T>(key: string): GiopSwCacheEntry<T> | null {
  try {
    const raw = sessionStorage.getItem(PREFIX + key);
    if (!raw) return null;
    return JSON.parse(raw) as GiopSwCacheEntry<T>;
  } catch {
    return null;
  }
}

/** Persist payload for stale-while-revalidate on the next navigation. */
export function writeSwCache<T>(key: string, data: T): void {
  try {
    const entry: GiopSwCacheEntry<T> = { data, fetchedAt: Date.now() };
    sessionStorage.setItem(PREFIX + key, JSON.stringify(entry));
  } catch {
    // Quota exceeded or private mode — skip silently.
  }
}

export function clearSwCache(key: string): void {
  try {
    sessionStorage.removeItem(PREFIX + key);
  } catch {
    /* ignore */
  }
}
