/**
 * Instant relative zoom (zoom in / zoom out on current view) — no backend hop.
 * Mirrors sync-service/agents/voice_router.py _parse_zoom_relative_intent.
 */

import type { GiopCopilotUiAction, MapViewportContext } from './giopCopilotTypes';
import { MIN_MAP_ZOOM } from './giopMapLayers';

const MAX_MAP_ZOOM = 20;
/** Snappy camera for repeated zoom in/out (ms). */
export const RELATIVE_ZOOM_DURATION_MS = 280;

function normalizeZoomCommandText(raw: string): string {
  let text = raw.trim().toLowerCase();
  text = text.replace(
    /^(?:please\s+|(?:(?:can|could|would)\s+you\s+(?:please\s+)?)+)+/i,
    '',
  ).trim();
  text = text.replace(/\s+please[.?!]*$/i, '').trim();
  return text;
}

function zoomStepFromPhrase(intensity: string | undefined): number {
  const text = (intensity ?? '').trim().toLowerCase();
  if (!text) return 1.5;
  if (text.includes('way')) return 3.0;
  if (/a\s+(?:bit|little)\s+more/.test(text) || text.includes('further')) return 2.4;
  if (text.includes('a bit') || text.includes('little') || text.includes('slight')) return 0.8;
  if (text.includes('more')) return 2.4;
  return 1.5;
}

/**
 * Parse "zoom in", "zoom out a bit", etc. Returns signed delta or null if not relative zoom.
 */
export function parseRelativeZoomDelta(command: string): number | null {
  const text = normalizeZoomCommandText(command);
  if (/\bzoom\s+(?:in|out)\s+to\s+\S/i.test(text)) {
    return null;
  }

  const suffix = '(?:\\s+(?:on|at)\\s+(?:the\\s+)?map)?[.?!]*';
  const intensity = '(?:\\s+(?<intensity>a\\s+bit(?:\\s+more)?|a\\s+little(?:\\s+more)?|little|slightly|more|further|way))?';

  const full = new RegExp(
    `^zoom\\s+(?:(?:the|this)\\s+map\\s+)?(?<dir>in|out)${intensity}${suffix}$`,
    'i',
  );
  let match = text.match(full);
  if (!match) {
    const embedded = new RegExp(
      `\\bzoom\\s+(?:(?:the|this)\\s+map\\s+)?(?<dir>in|out)\\b${intensity}${suffix}`,
      'i',
    );
    match = text.match(embedded);
  }
  if (!match?.groups?.dir) return null;

  const dir = match.groups.dir.toLowerCase();
  const step = zoomStepFromPhrase(match.groups.intensity as string | undefined);
  return dir === 'in' ? step : -step;
}

export function relativeZoomSpeak(delta: number): string {
  const direction = delta >= 0 ? 'in' : 'out';
  const strength = Math.abs(delta);
  if (strength < 1.0) return `Zooming ${direction} a bit.`;
  if (strength > 2.0) return `Zooming ${direction} more.`;
  return `Zooming ${direction}.`;
}

export function buildRelativeZoomAction(
  viewport: MapViewportContext | null | undefined,
  delta: number,
): GiopCopilotUiAction | null {
  const center = viewport?.center;
  const zoom = viewport?.zoom;
  if (!center || zoom == null || !Number.isFinite(zoom)) return null;

  const nextZoom = Math.max(MIN_MAP_ZOOM, Math.min(MAX_MAP_ZOOM, zoom + delta));
  if (Math.abs(nextZoom - zoom) < 0.01) {
    return null;
  }

  return {
    type: 'fly_to',
    tab: 'map',
    center: { lon: center.lon, lat: center.lat },
    zoom: Math.round(nextZoom * 10) / 10,
    duration: RELATIVE_ZOOM_DURATION_MS,
  };
}

export function tryInstantRelativeZoom(
  command: string,
  viewport: MapViewportContext | null | undefined,
): { action: GiopCopilotUiAction; speak: string } | null {
  const delta = parseRelativeZoomDelta(command);
  if (delta == null) return null;
  const action = buildRelativeZoomAction(viewport, delta);
  if (!action) return null;
  return { action, speak: relativeZoomSpeak(delta) };
}
