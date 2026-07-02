/** Validate a lng/lat pair for MapLibre flyTo and GeoJSON points. */
export function normalizeMapCoordinates(raw: unknown): [number, number] | null {
  if (!Array.isArray(raw) || raw.length < 2) return null;
  const lng = Number(raw[0]);
  const lat = Number(raw[1]);
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  return [lng, lat];
}

/** Stable string key for comparing coordinates across re-renders (avoids ref churn). */
export function coordsKey(coords: [number, number], precision = 6): string {
  return `${coords[0].toFixed(precision)},${coords[1].toFixed(precision)}`;
}

export function coordsNearlyEqual(
  a: [number, number] | null | undefined,
  b: [number, number] | null | undefined,
  precision = 5,
): boolean {
  if (!a || !b) return false;
  return coordsKey(a, precision) === coordsKey(b, precision);
}

type CoordGeom = { coordinates?: unknown } | null | undefined;

/** Parse staging asset geom (GeoJSON object, JSON string, or raw coordinate pair). */
export function extractStagingGeomCoordinates(geom: unknown): [number, number] | null {
  if (geom == null) return null;
  if (typeof geom === 'string') {
    try {
      return extractStagingGeomCoordinates(JSON.parse(geom));
    } catch {
      return null;
    }
  }
  if (Array.isArray(geom)) {
    return normalizeMapCoordinates(geom);
  }
  if (typeof geom === 'object') {
    const g = geom as { coordinates?: unknown };
    const fromCoords = normalizeMapCoordinates(g.coordinates);
    if (fromCoords) return fromCoords;
  }
  return null;
}

/** Resolve map focus coordinates from props, staging geom, or a loaded graph chunk. */
export function resolveStagingAssetCoordinates(
  mrid: string,
  sources: {
    coordinates?: [number, number] | null;
    geom?: CoordGeom;
    stagingAssets?: Array<{ mrid: string; geom?: CoordGeom }>;
    chunkNodes?: Array<{ mrid: string; lon: number; lat: number }>;
  },
): [number, number] | null {
  const direct = normalizeMapCoordinates(sources.coordinates);
  if (direct) return direct;
  const fromGeom = extractStagingGeomCoordinates(sources.geom);
  if (fromGeom) return fromGeom;
  const staged = sources.stagingAssets?.find((a) => a.mrid === mrid);
  const fromStaged = extractStagingGeomCoordinates(staged?.geom);
  if (fromStaged) return fromStaged;
  const node = sources.chunkNodes?.find((n) => n.mrid === mrid);
  if (node) return normalizeMapCoordinates([node.lon, node.lat]);
  return null;
}
