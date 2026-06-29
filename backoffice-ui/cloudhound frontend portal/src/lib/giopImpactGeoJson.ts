import type { GiopTopologyPayload } from '../api/giop-api';

function edgeLineCoordinates(
  edge: GiopTopologyPayload['edges'][number],
): [number, number][] | null {
  if (edge.coordinates && edge.coordinates.length >= 2) {
    return edge.coordinates;
  }
  const source =
    edge.source_lon != null && edge.source_lat != null
      ? ([edge.source_lon, edge.source_lat] as [number, number])
      : undefined;
  const target =
    edge.target_lon != null && edge.target_lat != null
      ? ([edge.target_lon, edge.target_lat] as [number, number])
      : undefined;
  if (!source || !target) return null;
  return [source, target];
}

export function topologyImpactToGeoJson(payload: GiopTopologyPayload | null) {
  if (!payload) {
    return {
      nodes: { type: 'FeatureCollection' as const, features: [] },
      edges: { type: 'FeatureCollection' as const, features: [] },
    };
  }

  const nodeList = Array.isArray(payload.nodes) ? payload.nodes : [];
  const edgeList = Array.isArray(payload.edges) ? payload.edges : [];

  const nodes = {
    type: 'FeatureCollection' as const,
    features: nodeList
      .map((node) => {
        const lon =
          (node as { longitude?: number }).longitude ??
          (node as { lon?: number }).lon;
        const lat =
          (node as { latitude?: number }).latitude ??
          (node as { lat?: number }).lat;
        if (lon == null || lat == null) return null;
        return {
          type: 'Feature' as const,
          properties: {
            mrid: node.mrid,
            name: node.name,
            validation: node.validation ?? '',
          },
          geometry: {
            type: 'Point' as const,
            coordinates: [lon, lat] as [number, number],
          },
        };
      })
      .filter((f): f is NonNullable<typeof f> => f !== null),
  };

  const edges = {
    type: 'FeatureCollection' as const,
    features: edgeList
      .map((edge) => {
        const coordinates = edgeLineCoordinates(edge);
        if (!coordinates) return null;
        return {
          type: 'Feature' as const,
          properties: { mrid: edge.mrid, voltage: edge.voltage ?? '' },
          geometry: {
            type: 'LineString' as const,
            coordinates,
          },
        };
      })
      .filter((f): f is NonNullable<typeof f> => f !== null),
  };

  return { nodes, edges };
}
