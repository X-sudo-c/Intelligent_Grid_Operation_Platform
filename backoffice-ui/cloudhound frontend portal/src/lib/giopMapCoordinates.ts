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
