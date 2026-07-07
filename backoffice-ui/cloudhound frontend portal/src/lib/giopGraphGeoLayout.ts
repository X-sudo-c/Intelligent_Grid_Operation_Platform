import { normalizeMapCoordinates } from './giopMapCoordinates';

export interface GeoLayoutNode {
  id: string;
  x?: number;
  y?: number;
  vx?: number;
  vy?: number;
  fx?: number | null;
  fy?: number | null;
  properties?: Record<string, unknown>;
}

export interface GeoLayoutLink {
  source: string;
  target: string;
  properties?: Record<string, unknown>;
}

function linkEndpointId(endpoint: string | { id: string }): string {
  return typeof endpoint === 'object' ? endpoint.id : endpoint;
}

/** Collect lon/lat for nodes from properties and edge endpoint fields. */
function buildCoordinateMap(
  nodes: GeoLayoutNode[],
  links: GeoLayoutLink[],
): Map<string, [number, number]> {
  const coords = new Map<string, [number, number]>();

  for (const node of nodes) {
    const props = node.properties ?? {};
    const fromNode = normalizeMapCoordinates([props.lon, props.lat]);
    if (fromNode) coords.set(node.id, fromNode);
  }

  for (const link of links) {
    const props = link.properties ?? {};
    const sourceId = linkEndpointId(link.source as string | { id: string });
    const targetId = linkEndpointId(link.target as string | { id: string });

    if (!coords.has(sourceId)) {
      const c = normalizeMapCoordinates([props.source_lon, props.source_lat]);
      if (c) coords.set(sourceId, c);
    }
    if (!coords.has(targetId)) {
      const c = normalizeMapCoordinates([props.target_lon, props.target_lat]);
      if (c) coords.set(targetId, c);
    }
  }

  return coords;
}

/** Fill gaps by averaging coordinates of graph neighbors. */
function propagateCoordinates(
  nodes: GeoLayoutNode[],
  links: GeoLayoutLink[],
  coords: Map<string, [number, number]>,
): void {
  const neighbors = new Map<string, string[]>();
  for (const link of links) {
    const sourceId = linkEndpointId(link.source as string | { id: string });
    const targetId = linkEndpointId(link.target as string | { id: string });
    neighbors.set(sourceId, [...(neighbors.get(sourceId) ?? []), targetId]);
    neighbors.set(targetId, [...(neighbors.get(targetId) ?? []), sourceId]);
  }

  for (let pass = 0; pass < 16; pass += 1) {
    let added = 0;
    for (const node of nodes) {
      if (coords.has(node.id)) continue;
      const nbIds = neighbors.get(node.id) ?? [];
      const positioned = nbIds
        .map((id) => coords.get(id))
        .filter((c): c is [number, number] => Boolean(c));
      if (positioned.length === 0) continue;
      const lon = positioned.reduce((sum, c) => sum + c[0], 0) / positioned.length;
      const lat = positioned.reduce((sum, c) => sum + c[1], 0) / positioned.length;
      coords.set(node.id, [lon, lat]);
      added += 1;
    }
    if (added === 0) break;
  }
}

/**
 * Place nodes using map coordinates so the graph mirrors geographic layout
 * (rectangular spread like the map panel) instead of a force-directed ball.
 */
export function seedGeoGraphLayout(
  nodes: GeoLayoutNode[],
  links: GeoLayoutLink[],
  targetSpan = 3600,
): boolean {
  if (nodes.length < 2) return false;

  const coords = buildCoordinateMap(nodes, links);
  propagateCoordinates(nodes, links, coords);

  const minRequired = Math.max(12, Math.floor(nodes.length * 0.12));
  if (coords.size < minRequired) return false;

  let minLon = Infinity;
  let maxLon = -Infinity;
  let minLat = Infinity;
  let maxLat = -Infinity;
  for (const [, [lon, lat]] of coords) {
    minLon = Math.min(minLon, lon);
    maxLon = Math.max(maxLon, lon);
    minLat = Math.min(minLat, lat);
    maxLat = Math.max(maxLat, lat);
  }

  const spanLon = Math.max(1e-6, maxLon - minLon);
  const spanLat = Math.max(1e-6, maxLat - minLat);
  const centerLon = (minLon + maxLon) / 2;
  const centerLat = (minLat + maxLat) / 2;
  const aspect = spanLon / spanLat;

  let worldW: number;
  let worldH: number;
  if (aspect >= 1) {
    worldW = targetSpan;
    worldH = targetSpan / aspect;
  } else {
    worldH = targetSpan;
    worldW = targetSpan * aspect;
  }

  const positioned = new Set<string>();
  for (const node of nodes) {
    const c = coords.get(node.id);
    if (!c) continue;
    const [lon, lat] = c;
    node.x = ((lon - centerLon) / spanLon) * worldW;
    node.y = -((lat - centerLat) / spanLat) * worldH;
    node.vx = 0;
    node.vy = 0;
    positioned.add(node.id);
  }

  // Residual nodes without coordinates: ring around the geo bounding box.
  let ring = 0;
  for (const node of nodes) {
    if (positioned.has(node.id)) continue;
    const angle = (ring % 48) * ((Math.PI * 2) / 48);
    const radius = worldW * 0.55 + Math.floor(ring / 48) * 42;
    node.x = Math.cos(angle) * radius;
    node.y = Math.sin(angle) * radius * 0.72;
    node.vx = 0;
    node.vy = 0;
    ring += 1;
  }

  return positioned.size >= minRequired;
}

/** Pin geo-positioned nodes so the layout stays map-shaped (released on drag). */
export function pinGeoLayoutNodes(nodes: GeoLayoutNode[]): void {
  for (const node of nodes) {
    if (node.x == null || node.y == null) continue;
    node.fx = node.x;
    node.fy = node.y;
    node.vx = 0;
    node.vy = 0;
  }
}
