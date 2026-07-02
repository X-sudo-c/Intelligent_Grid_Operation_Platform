import type { FeatureCollection, Point } from 'geojson';
import type { GeoJSONSource, Map as MaplibreMap } from 'maplibre-gl';
import {
  ACTIVE_WORK_ORDER_STATUSES,
  focusIdentifyRipplePinRadius,
  mapNodeRadiusAtZoom,
  noticeRippleFrame,
  stagingRipplePinRadius,
  WORK_ORDER_RIPPLE_SPREAD_SCALE,
  workOrderPinRadiusAtZoom,
} from './giopMapLayers';

/** Seconds for one ripple to expand and fade. */
const RIPPLE_CYCLE_S = 2.4;

const RIPPLE_PIN_LAYERS = [
  'staging-points',
  'work-order-pins',
  'impact-nodes-layer',
  'focus-identify-point',
] as const;

const LAYER_SOURCE_IDS: Record<(typeof RIPPLE_PIN_LAYERS)[number], string> = {
  'staging-points': 'staging-overlay',
  'work-order-pins': 'work-orders-overlay',
  'impact-nodes-layer': 'impact-nodes',
  'focus-identify-point': 'focus-identify',
};

const STAGING_PULSE_VALIDATIONS = new Set(['PENDING_FIELD', 'STAGED']);

type PinLayerId = (typeof RIPPLE_PIN_LAYERS)[number];

type PulsePoint = {
  layerId: PinLayerId;
  lng: number;
  lat: number;
  props: Record<string, unknown>;
};

function pinRadiusForLayer(layerId: PinLayerId, zoom: number): number {
  if (layerId === 'work-order-pins') return workOrderPinRadiusAtZoom(zoom);
  if (layerId === 'focus-identify-point') return focusIdentifyRipplePinRadius(zoom);
  return stagingRipplePinRadius(zoom);
}

function spreadScaleForLayer(layerId: PinLayerId): number {
  return layerId === 'work-order-pins' ? WORK_ORDER_RIPPLE_SPREAD_SCALE : 1;
}

function strokeColorForFeature(layerId: PinLayerId, props: Record<string, unknown>): string {
  if (layerId === 'staging-points') {
    return props.validation === 'STAGED' ? '#3b82f6' : '#f59e0b';
  }
  if (layerId === 'work-order-pins') return '#a855f7';
  if (layerId === 'impact-nodes-layer') return '#ef4444';
  return '#06b6d4';
}

function shouldPulseFeature(layerId: PinLayerId, props: Record<string, unknown>): boolean {
  if (layerId === 'staging-points') {
    const v = String(props.validation ?? '');
    return STAGING_PULSE_VALIDATIONS.has(v);
  }
  if (layerId === 'work-order-pins') {
    return (ACTIVE_WORK_ORDER_STATUSES as readonly string[]).includes(String(props.status ?? ''));
  }
  return true;
}

function layerVisible(map: MaplibreMap, layerId: string): boolean {
  try {
    if (!map.getLayer(layerId)) return false;
    return map.getLayoutProperty(layerId, 'visibility') !== 'none';
  } catch {
    return false;
  }
}

function geoJsonFromSource(map: MaplibreMap, sourceId: string): FeatureCollection | null {
  const src = map.getSource(sourceId) as GeoJSONSource | undefined;
  if (!src || src.type !== 'geojson') return null;
  try {
    const data = src.serialize().data;
    if (!data || typeof data === 'string') return null;
    return data as FeatureCollection;
  } catch {
    return null;
  }
}

function collectPulsePoints(map: MaplibreMap, activeLayers: PinLayerId[]): PulsePoint[] {
  const points: PulsePoint[] = [];

  for (const layerId of activeLayers) {
    const sourceId = LAYER_SOURCE_IDS[layerId];
    const fc = geoJsonFromSource(map, sourceId);
    if (!fc) continue;

    for (const feature of fc.features) {
      if (feature.geometry?.type !== 'Point') continue;
      const props = (feature.properties ?? {}) as Record<string, unknown>;
      if (!shouldPulseFeature(layerId, props)) continue;
      const [lng, lat] = (feature.geometry as Point).coordinates;
      if (!Number.isFinite(lng) || !Number.isFinite(lat)) continue;
      points.push({ layerId, lng, lat, props });
    }
  }

  return points;
}

function resizeCanvasToDisplay(canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D): void {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (w <= 0 || h <= 0) return;
  const pw = Math.round(w * dpr);
  const ph = Math.round(h * dpr);
  if (canvas.width !== pw || canvas.height !== ph) {
    canvas.width = pw;
    canvas.height = ph;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function drawRippleRing(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  radius: number,
  strokeWidth: number,
  strokeOpacity: number,
  color: string,
): void {
  if (strokeOpacity <= 0.01 || radius <= 0) return;
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.strokeStyle = color;
  ctx.globalAlpha = strokeOpacity;
  ctx.lineWidth = strokeWidth;
  ctx.stroke();
}

/**
 * HTML canvas ripple overlay — animates outside MapLibre paint properties so
 * pan/zoom never freezes halos. Canvas is mounted inside the map canvas container
 * for correct z-order and coordinate alignment.
 */
export function attachGiopMapPulseCanvasOverlay(map: MaplibreMap): () => void {
  const container = map.getCanvasContainer();
  const canvas = document.createElement('canvas');
  canvas.className = 'giop-map-pulse-canvas';
  canvas.setAttribute('aria-hidden', 'true');
  container.appendChild(canvas);

  const ctx = canvas.getContext('2d');
  if (!ctx) {
    canvas.remove();
    return () => {};
  }

  let frameId = 0;
  let cancelled = false;
  const start = performance.now();

  const animate = () => {
    if (cancelled) return;
    frameId = requestAnimationFrame(animate);

    resizeCanvasToDisplay(canvas, ctx);
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (w <= 0 || h <= 0) return;

    ctx.clearRect(0, 0, w, h);

    const activeLayers = RIPPLE_PIN_LAYERS.filter((id) => layerVisible(map, id));
    if (activeLayers.length === 0) return;

    const points = collectPulsePoints(map, activeLayers);
    if (points.length === 0) return;

    const zoom = map.getZoom();
    const elapsed = (performance.now() - start) / 1000;

    for (const point of points) {
      const projected = map.project([point.lng, point.lat]);
      if (projected.x < -80 || projected.y < -80 || projected.x > w + 80 || projected.y > h + 80) {
        continue;
      }

      const pinRadius = pinRadiusForLayer(point.layerId, zoom);
      const spreadScale = spreadScaleForLayer(point.layerId);
      const color = strokeColorForFeature(point.layerId, point.props);

      for (const phaseOffset of [0, 0.5]) {
        const phase = (elapsed / RIPPLE_CYCLE_S + phaseOffset) % 1;
        const frame = noticeRippleFrame(zoom, phase, pinRadius, spreadScale);
        drawRippleRing(
          ctx,
          projected.x,
          projected.y,
          frame.radius,
          frame.strokeWidth,
          frame.strokeOpacity,
          color,
        );
      }
    }

    ctx.globalAlpha = 1;
  };

  frameId = requestAnimationFrame(animate);

  const onResize = () => {
    resizeCanvasToDisplay(canvas, ctx);
  };
  map.on('resize', onResize);

  return () => {
    cancelled = true;
    cancelAnimationFrame(frameId);
    map.off('resize', onResize);
    canvas.remove();
  };
}
