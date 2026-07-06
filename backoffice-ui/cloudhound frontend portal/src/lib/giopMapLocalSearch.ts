import type {
  GiopFieldTechnician,
  GiopMapSearchKind,
  GiopMapSearchResult,
  GiopStagingAsset,
  GiopWorkOrder,
} from '../api/giop-api';
import { extractStagingGeomCoordinates } from './giopMapCoordinates';
import type { Map as MaplibreMap } from 'maplibre-gl';

export type GiopMapSearchFilter = 'all' | GiopMapSearchKind;

function normalizeSearchText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const row = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    let prev = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? row[j - 1] : Math.min(row[j - 1], row[j], prev) + 1;
      row[j - 1] = prev;
      prev = cost;
    }
    row[b.length] = prev;
  }
  return row[b.length];
}

/** Substring, token-prefix, or small edit-distance match for map spotlight. */
export function fuzzyMatchesMapQuery(haystack: string, query: string): boolean {
  const q = normalizeSearchText(query);
  if (!q) return false;

  const h = normalizeSearchText(haystack);
  if (!h) return false;
  if (h.includes(q)) return true;

  const qTokens = q.split(/\s+/).filter(Boolean);
  const hTokens = h.split(/\s+/).filter(Boolean);

  for (const token of hTokens) {
    if (token.startsWith(q)) return true;
    if (q.length >= 3 && token.length >= 3) {
      const maxDist = q.length <= 4 ? 1 : q.length <= 6 ? 2 : 3;
      const window = token.slice(0, Math.max(token.length, q.length + 1));
      if (levenshtein(q, window) <= maxDist) return true;
    }
  }

  if (qTokens.length > 1) {
    return qTokens.every(
      (qt) => hTokens.some((ht) => ht.includes(qt) || ht.startsWith(qt) || levenshtein(qt, ht) <= 1),
    );
  }

  return false;
}

function dedupeSearchResults(items: GiopMapSearchResult[]): GiopMapSearchResult[] {
  const seen = new Set<string>();
  const out: GiopMapSearchResult[] = [];
  for (const item of items) {
    const key = `${item.kind}:${item.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function rankMatch(title: string, query: string): number {
  const t = title.toLowerCase();
  const q = query.toLowerCase();
  if (t === q) return 0;
  if (t.startsWith(q)) return 1;
  if (t.includes(q)) return 2;
  const tokens = t.split(/[\s,/\-–—]+/);
  if (tokens.some((token) => token.startsWith(q))) return 3;
  if (fuzzyMatchesMapQuery(title, query)) return 4;
  return 99;
}

function kindRank(kind: GiopMapSearchKind): number {
  switch (kind) {
    case 'place':
      return 0;
    case 'asset':
      return 1;
    case 'work_order':
      return 2;
    case 'crew':
      return 3;
    default:
      return 4;
  }
}

function compareSearchHits(a: GiopMapSearchResult, b: GiopMapSearchResult, q: string): number {
  const ra = rankMatch(a.title, q);
  const rb = rankMatch(b.title, q);
  if (ra !== rb) return ra - rb;
  const ka = kindRank(a.kind);
  const kb = kindRank(b.kind);
  if (ka !== kb) return ka - kb;
  return a.title.localeCompare(b.title);
}

export function searchLocalMapCatalog(
  catalog: GiopMapSearchResult[],
  query: string,
  filter: GiopMapSearchFilter,
  limit = 12,
): GiopMapSearchResult[] {
  const q = query.trim();
  if (q.length < 1) return [];

  const kinds =
    filter === 'all' ? null : new Set<GiopMapSearchKind>([filter]);

  const hits = catalog.filter((item) => {
    if (kinds && !kinds.has(item.kind)) return false;
    const hay = `${item.title} ${item.subtitle ?? ''} ${item.id}`;
    return fuzzyMatchesMapQuery(hay, q);
  });

  hits.sort((a, b) => compareSearchHits(a, b, q));

  return hits.slice(0, limit);
}

/** Search places + ops without scanning both catalogs as one giant list. */
export function searchMapCatalog(options: {
  filter: GiopMapSearchFilter;
  placeCatalog: GiopMapSearchResult[];
  opsCatalog: GiopMapSearchResult[];
  query: string;
  limit?: number;
  /** OSM / server geocode hits — always shown (already matched upstream). */
  geocodeHits?: GiopMapSearchResult[];
  /** Server-side DB search fallback hits. */
  remoteHits?: GiopMapSearchResult[];
}): GiopMapSearchResult[] {
  const { filter, placeCatalog, opsCatalog, query, limit = 12, geocodeHits = [], remoteHits = [] } = options;
  const q = query.trim();
  if (q.length < 1) return [];

  const passthrough = dedupeSearchResults([...geocodeHits, ...remoteHits]);

  if (filter === 'place') {
    const local = searchLocalMapCatalog(placeCatalog, q, 'place', limit);
    const merged = dedupeSearchResults([...passthrough.filter((item) => item.kind === 'place'), ...local]);
    merged.sort((a, b) => compareSearchHits(a, b, q));
    return merged.slice(0, limit);
  }

  if (filter !== 'all') {
    const local = searchLocalMapCatalog(opsCatalog, q, filter, limit);
    const merged = dedupeSearchResults([
      ...passthrough.filter((item) => item.kind === filter),
      ...local,
    ]);
    merged.sort((a, b) => compareSearchHits(a, b, q));
    return merged.slice(0, limit);
  }

  const placeLimit = Math.max(4, Math.ceil(limit / 2));
  const placeHits = searchLocalMapCatalog(placeCatalog, q, 'place', placeLimit);
  const opsLimit = Math.max(limit - placeHits.length, 4);
  const opsHits = searchLocalMapCatalog(opsCatalog, q, 'all', opsLimit);
  const merged = dedupeSearchResults([...passthrough, ...placeHits, ...opsHits]);
  merged.sort((a, b) => compareSearchHits(a, b, q));
  return merged.slice(0, limit);
}

/** Merge OSM geocode hits without duplicating ECG district/region names. */
export function mergeGeocodePlaces(
  places: GiopMapSearchResult[],
  geocode: GiopMapSearchResult[],
): GiopMapSearchResult[] {
  if (!geocode.length) return places;
  const seen = new Set(places.map((item) => item.title.trim().toLowerCase()));
  const extra = geocode.filter((item) => {
    const key = item.title.trim().toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return extra.length ? [...places, ...extra] : places;
}

export function buildOpsSearchCatalog(options: {
  workOrders?: GiopWorkOrder[];
  fieldTechnicians?: GiopFieldTechnician[];
  stagingAssets?: GiopStagingAsset[];
}): GiopMapSearchResult[] {
  const out: GiopMapSearchResult[] = [];

  for (const wo of options.workOrders ?? []) {
    out.push({
      kind: 'work_order',
      id: wo.id,
      title: wo.reference || wo.summary || wo.id,
      subtitle: wo.summary || wo.status,
      longitude: wo.longitude ?? null,
      latitude: wo.latitude ?? null,
    });
  }

  for (const tech of options.fieldTechnicians ?? []) {
    out.push({
      kind: 'crew',
      id: tech.technician_id,
      title: tech.display_name || tech.technician_id,
      subtitle: 'Field technician',
      longitude: tech.longitude,
      latitude: tech.latitude,
    });
  }

  for (const asset of options.stagingAssets ?? []) {
    const coords = extractStagingGeomCoordinates(asset.geom);
    out.push({
      kind: 'asset',
      id: asset.mrid,
      title: asset.name || asset.mrid,
      subtitle: asset.validation || asset.asset_kind || 'Staging asset',
      longitude: coords?.[0] ?? null,
      latitude: coords?.[1] ?? null,
    });
  }

  return out;
}

export function buildGraphNodeSearchCatalog(
  graph: { nodes: Array<{ id: string; label?: string; name?: string }> } | null,
): GiopMapSearchResult[] {
  if (!graph?.nodes.length) return [];
  return graph.nodes.map((node) => ({
    kind: 'asset' as const,
    id: node.id,
    title: node.label || node.name || node.id,
    subtitle: 'Network node',
    longitude: null,
    latitude: null,
  }));
}

export function mergeSearchCatalogs(
  primary: GiopMapSearchResult[],
  extra: GiopMapSearchResult[],
): GiopMapSearchResult[] {
  if (!extra.length) return primary;
  const seen = new Set(primary.map((item) => `${item.kind}:${item.id}`));
  const merged = [...primary];
  for (const item of extra) {
    const key = `${item.kind}:${item.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(item);
  }
  return merged;
}

/** @deprecated Prefer separate place + ops catalogs for search performance. */
export function buildLocalMapSearchCatalog(options: {
  places: GiopMapSearchResult[];
  workOrders?: GiopWorkOrder[];
  fieldTechnicians?: GiopFieldTechnician[];
  stagingAssets?: GiopStagingAsset[];
}): GiopMapSearchResult[] {
  return [...options.places, ...buildOpsSearchCatalog(options)];
}

export function pickMapSearchPool(
  filter: GiopMapSearchFilter,
  placeCatalog: GiopMapSearchResult[],
  opsCatalog: GiopMapSearchResult[],
): GiopMapSearchResult[] {
  if (filter === 'place') return placeCatalog;
  if (filter === 'all') {
    return placeCatalog.length || opsCatalog.length
      ? [...placeCatalog, ...opsCatalog]
      : [];
  }
  return opsCatalog;
}

/** Don't zoom closer than this — fitBounds picks the best level below the cap. */
const SEARCH_MAX_ZOOM = 16;

const SEARCH_FIT_PADDING = 56;

/** Smooth ease-out curve (Apple-like deceleration). */
export function mapSearchEase(t: number): number {
  return 1 - (1 - t) ** 3;
}

type LngLatBounds = [[number, number], [number, number]];

function isValidBbox(
  bbox: GiopMapSearchResult['bbox'],
): bbox is NonNullable<GiopMapSearchResult['bbox']> {
  if (!bbox) return false;
  const { west, south, east, north } = bbox;
  if ([west, south, east, north].some((v) => v == null || !Number.isFinite(v))) {
    return false;
  }
  return east > west && north > south;
}

/** Expand tiny bboxes so fitBounds doesn't over-zoom on point-like results. */
function expandBboxToMinExtent(
  west: number,
  south: number,
  east: number,
  north: number,
  minSpanDeg: number,
): LngLatBounds {
  const lonSpan = east - west;
  const latSpan = north - south;
  const cx = (west + east) / 2;
  const cy = (south + north) / 2;
  const halfLon = Math.max(lonSpan / 2, minSpanDeg / 2);
  const halfLat = Math.max(latSpan / 2, minSpanDeg / 2);
  return [
    [cx - halfLon, cy - halfLat],
    [cx + halfLon, cy + halfLat],
  ];
}

function fitBoundsForResult(result: GiopMapSearchResult): LngLatBounds | null {
  if (isValidBbox(result.bbox)) {
    const minSpan = result.kind === 'place' ? 0.008 : 0.004;
    return expandBboxToMinExtent(
      result.bbox.west,
      result.bbox.south,
      result.bbox.east,
      result.bbox.north,
      minSpan,
    );
  }

  if (result.longitude != null && result.latitude != null) {
    const lon = result.longitude;
    const lat = result.latitude;
    const minSpan = result.kind === 'place' ? 0.012 : 0.006;
    return expandBboxToMinExtent(
      lon,
      lat,
      lon,
      lat,
      minSpan,
    );
  }

  return null;
}

/** Single camera path for search preview and confirm — avoids competing flys. */
export function applySearchResultCamera(
  map: MaplibreMap,
  result: GiopMapSearchResult,
  opts?: { duration?: number },
): void {
  const duration = opts?.duration ?? 900;
  map.stop();

  const bounds = fitBoundsForResult(result);
  if (!bounds) return;

  map.fitBounds(bounds, {
    padding: SEARCH_FIT_PADDING,
    duration,
    maxZoom: SEARCH_MAX_ZOOM,
    easing: mapSearchEase,
    essential: true,
  });
}
