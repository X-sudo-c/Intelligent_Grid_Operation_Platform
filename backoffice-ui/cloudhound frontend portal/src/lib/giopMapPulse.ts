import type { Map as MaplibreMap } from 'maplibre-gl';
import {
  focusIdentifyRipplePinRadius,
  noticeRippleFrame,
  stagingRipplePinRadius,
  WORK_ORDER_RIPPLE_SPREAD_SCALE,
  workOrderPinRadiusAtZoom,
} from './giopMapLayers';

/** Seconds for one ripple to expand and fade. */
const RIPPLE_CYCLE_S = 2.4;

type RippleLayerSpec = {
  layerId: string;
  pinRadius: (zoom: number) => number;
  phaseOffset: number;
  spreadScale?: number;
};

const RIPPLE_LAYERS: RippleLayerSpec[] = [
  { layerId: 'staging-points-pulse', pinRadius: stagingRipplePinRadius, phaseOffset: 0 },
  { layerId: 'staging-points-pulse-2', pinRadius: stagingRipplePinRadius, phaseOffset: 0.5 },
  {
    layerId: 'work-order-pins-pulse',
    pinRadius: workOrderPinRadiusAtZoom,
    phaseOffset: 0,
    spreadScale: WORK_ORDER_RIPPLE_SPREAD_SCALE,
  },
  {
    layerId: 'work-order-pins-pulse-2',
    pinRadius: workOrderPinRadiusAtZoom,
    phaseOffset: 0.5,
    spreadScale: WORK_ORDER_RIPPLE_SPREAD_SCALE,
  },
  { layerId: 'impact-nodes-pulse', pinRadius: stagingRipplePinRadius, phaseOffset: 0 },
  { layerId: 'impact-nodes-pulse-2', pinRadius: stagingRipplePinRadius, phaseOffset: 0.5 },
  { layerId: 'focus-identify-pulse', pinRadius: focusIdentifyRipplePinRadius, phaseOffset: 0 },
  { layerId: 'focus-identify-pulse-2', pinRadius: focusIdentifyRipplePinRadius, phaseOffset: 0.5 },
];

function applyRippleFrame(
  map: MaplibreMap,
  layerId: string,
  zoom: number,
  phase: number,
  pinRadius: number,
  spreadScale = 1,
): void {
  const frame = noticeRippleFrame(zoom, phase, pinRadius, spreadScale);
  map.setPaintProperty(layerId, 'circle-radius', frame.radius);
  map.setPaintProperty(layerId, 'circle-opacity', 0);
  map.setPaintProperty(layerId, 'circle-stroke-opacity', frame.strokeOpacity);
  map.setPaintProperty(layerId, 'circle-stroke-width', frame.strokeWidth);
}

/** Single rAF loop driving thin expanding ripple rings on notice layers. */
export function attachGiopMapPulseLoop(map: MaplibreMap): () => void {
  let frameId = 0;
  let cancelled = false;
  const start = performance.now();

  const animate = () => {
    if (cancelled) return;
    const elapsed = (performance.now() - start) / 1000;
    const zoom = map.getZoom();

    for (const spec of RIPPLE_LAYERS) {
      if (!map.getLayer(spec.layerId)) continue;
      const phase = (elapsed / RIPPLE_CYCLE_S + spec.phaseOffset) % 1;
      try {
        applyRippleFrame(
          map,
          spec.layerId,
          zoom,
          phase,
          spec.pinRadius(zoom),
          spec.spreadScale ?? 1,
        );
      } catch {
        /* layer may be rebuilding after style refresh */
      }
    }

    frameId = requestAnimationFrame(animate);
  };

  frameId = requestAnimationFrame(animate);
  return () => {
    cancelled = true;
    cancelAnimationFrame(frameId);
  };
}
