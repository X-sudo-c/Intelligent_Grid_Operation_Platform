/** Render-quality tiers for the canvas force graph (CPU/GPU budget vs fidelity). */
export type GraphRenderQuality = 'ultra' | 'balanced' | 'safe' | 'minimal';

export const GRAPH_QUALITY: Record<
  GraphRenderQuality,
  {
    edgeCap: number;
    labelZoom: number;
    shadows: boolean;
    drift: boolean;
    pulseRipples: boolean;
    simTicks: number;
    viewportCull: boolean;
    /** Zoom level below which edge rendering is skipped entirely to save draw calls.
     *  0 = never skip edges.  Higher = more aggressive savings. */
    edgeZoomMin: number;
  }
> = {
  ultra: {
    edgeCap: 12000,
    labelZoom: 1.8,
    shadows: true,
    drift: true,
    pulseRipples: true,
    simTicks: 3,
    viewportCull: false,
    edgeZoomMin: 0,
  },
  balanced: {
    edgeCap: 6000,
    labelZoom: 1.95,
    shadows: false,
    drift: false,
    pulseRipples: true,
    simTicks: 1,
    viewportCull: true,
    edgeZoomMin: 0.28,
  },
  safe: {
    edgeCap: 3200,
    labelZoom: 2.1,
    shadows: false,
    drift: false,
    pulseRipples: false,
    simTicks: 1,
    viewportCull: true,
    edgeZoomMin: 0.32,
  },
  minimal: {
    edgeCap: 1600,
    labelZoom: 3.0,
    shadows: false,
    drift: false,
    pulseRipples: false,
    simTicks: 1,
    viewportCull: true,
    edgeZoomMin: 0.45,
  },
};

/** Pick a quality tier from node count; compact ops panel downgrades sooner. */
export function computeGraphQuality(nodeCount: number, compact = false): GraphRenderQuality {
  if (nodeCount > 9000) return 'minimal';
  if (nodeCount > 6500) return 'safe';
  if (nodeCount > 3000) return 'balanced';
  if (compact) {
    if (nodeCount > 1600) return 'minimal';
    if (nodeCount > 1200) return 'safe';
    if (nodeCount > 500) return 'balanced';
  }
  return 'ultra';
}

export function isOnScreen(
  x: number,
  y: number,
  width: number,
  height: number,
  margin = 56,
): boolean {
  return x >= -margin && x <= width + margin && y >= -margin && y <= height + margin;
}
