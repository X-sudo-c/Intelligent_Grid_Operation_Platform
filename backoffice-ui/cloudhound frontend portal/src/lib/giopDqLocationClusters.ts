import type { GiopDqException } from '../api/giop-api';
import type { GiopDqQueueItem } from '../api/giop-api';

export interface DqColocatedPeer {
  mrid: string;
  name?: string | null;
  validation?: string | null;
}

export interface DqLocationCluster {
  locationKey: string;
  longitude: number | null;
  latitude: number | null;
  colocatedCount: number;
  peers: DqColocatedPeer[];
  exceptions: GiopDqException[];
}

export interface DqQueueLocationCluster {
  locationKey: string;
  longitude: number | null;
  latitude: number | null;
  colocatedCount: number;
  peers: DqColocatedPeer[];
  items: GiopDqQueueItem[];
}

export function queueItemDuplicateDetected(item: GiopDqQueueItem): boolean {
  if ((item.colocated_staging_count ?? 0) > 1) return true;
  return item.exceptions.some(
    (ex) => ex.status === 'OPEN' && ex.rule_code === 'ASSET_DUPLICATE_NEAR',
  );
}

export function partitionDqQueueItems(items: GiopDqQueueItem[]): {
  clusters: DqQueueLocationCluster[];
  singletons: GiopDqQueueItem[];
} {
  const byLocation = new Map<string, GiopDqQueueItem[]>();

  for (const item of items) {
    const count = item.colocated_staging_count ?? 0;
    const key = item.location_key;
    if (count > 1 && key) {
      const bucket = byLocation.get(key) ?? [];
      bucket.push(item);
      byLocation.set(key, bucket);
    }
  }

  const clusteredMrids = new Set<string>();
  const clusters: DqQueueLocationCluster[] = [];

  for (const [locationKey, clusterItems] of byLocation) {
    const sample = clusterItems[0];
    const peers = (sample.colocated_staging_peers ?? []) as DqColocatedPeer[];
    const colocatedCount = sample.colocated_staging_count ?? peers.length ?? clusterItems.length;
    for (const item of clusterItems) clusteredMrids.add(item.mrid);
    clusters.push({
      locationKey,
      longitude: sample.longitude ?? null,
      latitude: sample.latitude ?? null,
      colocatedCount,
      peers,
      items: clusterItems,
    });
  }

  clusters.sort((a, b) => b.colocatedCount - a.colocatedCount);

  const singletons = items.filter((item) => !clusteredMrids.has(item.mrid));
  return { clusters, singletons };
}

export function partitionDqExceptions(exceptions: GiopDqException[]): {
  clusters: DqLocationCluster[];
  singletons: GiopDqException[];
} {
  const byLocation = new Map<string, GiopDqException[]>();

  for (const item of exceptions) {
    const count = item.colocated_staging_count ?? 0;
    const key = item.location_key;
    if (count > 1 && key) {
      const bucket = byLocation.get(key) ?? [];
      bucket.push(item);
      byLocation.set(key, bucket);
    }
  }

  const clusteredIds = new Set<string>();
  const clusters: DqLocationCluster[] = [];

  for (const [locationKey, items] of byLocation) {
    const sample = items[0];
    const peers = (sample.colocated_staging_peers ?? []) as DqColocatedPeer[];
    const colocatedCount = sample.colocated_staging_count ?? peers.length ?? items.length;
    for (const item of items) clusteredIds.add(item.id);
    clusters.push({
      locationKey,
      longitude: sample.longitude ?? null,
      latitude: sample.latitude ?? null,
      colocatedCount,
      peers,
      exceptions: items,
    });
  }

  clusters.sort((a, b) => b.colocatedCount - a.colocatedCount);

  const singletons = exceptions.filter((item) => !clusteredIds.has(item.id));
  return { clusters, singletons };
}

export function formatDqCoordinates(lon: number | null, lat: number | null): string | null {
  if (lon == null || lat == null) return null;
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
  return `${lon.toFixed(5)}, ${lat.toFixed(5)}`;
}
