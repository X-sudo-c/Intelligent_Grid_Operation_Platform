import type { GiopCopilotPortalContext, MapBboxContext, MapViewportContext } from './giopCopilotTypes';

/** Matches GiopMapView initial camera — used before the map reports live bounds. */
export const DEFAULT_MAP_CENTER = { lon: -0.2941, lat: 5.6812 };
export const DEFAULT_MAP_ZOOM = 13;

/** Approximate visible bbox from center + zoom (MapLibre-style mercator). */
export function bboxFromCenterZoom(
  lon: number,
  lat: number,
  zoom: number,
  viewportWidthPx = 900,
  viewportHeightPx = 700,
): MapBboxContext {
  const latRad = (lat * Math.PI) / 180;
  const lonPerPx = 360 / (256 * 2 ** zoom);
  const latPerPx = lonPerPx / Math.max(Math.cos(latRad), 0.01);
  const halfW = (viewportWidthPx / 2) * lonPerPx;
  const halfH = (viewportHeightPx / 2) * latPerPx;
  return {
    west: lon - halfW,
    south: lat - halfH,
    east: lon + halfW,
    north: lat + halfH,
  };
}

export function defaultMapViewport(): MapViewportContext {
  return {
    center: { ...DEFAULT_MAP_CENTER },
    zoom: DEFAULT_MAP_ZOOM,
    bbox: bboxFromCenterZoom(DEFAULT_MAP_CENTER.lon, DEFAULT_MAP_CENTER.lat, DEFAULT_MAP_ZOOM),
  };
}

/** Prefer live map bounds, then last reported viewport, then map default. */
export function resolveMapViewport(
  reported: MapViewportContext | null | undefined,
  live?: MapViewportContext | null,
): MapViewportContext {
  const candidate = live ?? reported;
  if (candidate?.bbox) {
    return candidate;
  }
  if (candidate?.center && candidate.zoom != null) {
    return {
      ...candidate,
      bbox: bboxFromCenterZoom(
        candidate.center.lon,
        candidate.center.lat,
        candidate.zoom,
      ),
    };
  }
  return defaultMapViewport();
}

export function buildCopilotContext(
  base: GiopCopilotPortalContext,
  getLive?: () => MapViewportContext | null,
): GiopCopilotPortalContext {
  return {
    ...base,
    viewport: resolveMapViewport(base.viewport, getLive?.() ?? undefined),
  };
}
