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

function rankMatch(title: string, query: string): number {
  const t = title.toLowerCase();
  const q = query.toLowerCase();
  if (t === q) return 0;
  if (t.startsWith(q)) return 1;
  if (t.includes(q)) return 2;
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
    const hay = `${item.title} ${item.subtitle ?? ''} ${item.id}`.toLowerCase();
    return hay.includes(q.toLowerCase());
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
}): GiopMapSearchResult[] {
  const { filter, placeCatalog, opsCatalog, query, limit = 12 } = options;
  const q = query.trim();
  if (q.length < 1) return [];

  if (filter === 'place') {
    return searchLocalMapCatalog(placeCatalog, q, 'place', limit);
  }

  if (filter !== 'all') {
    return searchLocalMapCatalog(opsCatalog, q, filter, limit);
  }

  const placeLimit = Math.max(4, Math.ceil(limit / 2));
  const placeHits = searchLocalMapCatalog(placeCatalog, q, 'place', placeLimit);
  const opsLimit = Math.max(limit - placeHits.length, 4);
  const opsHits = searchLocalMapCatalog(opsCatalog, q, 'all', opsLimit);
  const merged = [...placeHits, ...opsHits];
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
