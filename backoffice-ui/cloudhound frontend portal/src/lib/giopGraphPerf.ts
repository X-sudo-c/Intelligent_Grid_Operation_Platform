/** Render-quality tiers for the canvas force graph (CPU/GPU budget vs fidelity). */
export type GraphRenderQuality = 'ultra' | 'balanced' | 'safe';

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
  },
  balanced: {
    edgeCap: 6000,
    labelZoom: 1.95,
    shadows: false,
    drift: true,
    pulseRipples: true,
    simTicks: 2,
    viewportCull: true,
  },
  safe: {
    edgeCap: 3200,
    labelZoom: 2.1,
    shadows: false,
    drift: false,
    pulseRipples: false,
    simTicks: 1,
    viewportCull: true,
  },
};

/** Pick a quality tier from node count; compact ops panel downgrades sooner. */
export function computeGraphQuality(nodeCount: number, compact = false): GraphRenderQuality {
  if (nodeCount > 6500) return 'safe';
  if (nodeCount > 3000) return 'balanced';
  if (compact) {
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
