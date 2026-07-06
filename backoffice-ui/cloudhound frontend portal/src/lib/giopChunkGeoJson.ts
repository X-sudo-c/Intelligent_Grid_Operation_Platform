import type { GiopGraphChunkResponse } from '../api/giop-api';
import { voltageEdgeColor } from './giopSldTheme';

function edgeLineCoordinates(
  edge: GiopGraphChunkResponse['edges'][number],
  coordByMrid?: Map<string, [number, number]>,
): [number, number][] | null {
  if (edge.coordinates && edge.coordinates.length >= 2) {
    return edge.coordinates;
  }
  const source =
    edge.source_lon != null && edge.source_lat != null
      ? ([edge.source_lon, edge.source_lat] as [number, number])
      : coordByMrid?.get(edge.source ?? '');
  const target =
    edge.target_lon != null && edge.target_lat != null
      ? ([edge.target_lon, edge.target_lat] as [number, number])
      : coordByMrid?.get(edge.target ?? '');
  if (!source || !target) return null;
  return [source, target];
}

export function chunkToEdgeGeoJson(
  chunk: GiopGraphChunkResponse | null,
  _options?: { geomOnly?: boolean },
) {
  if (!chunk) {
    return { type: 'FeatureCollection' as const, features: [] };
  }

  const coordByMrid = new Map(
    chunk.nodes.map((node) => [node.mrid, [node.lon, node.lat] as [number, number]]),
  );

  const features = chunk.edges
    .map((edge) => {
      const coordinates = edgeLineCoordinates(edge, coordByMrid);
      if (!coordinates) return null;
      return {
        type: 'Feature' as const,
        properties: {
          mrid: edge.mrid,
          source: edge.source,
          target: edge.target,
          voltage: edge.voltage,
          color: voltageEdgeColor(edge.voltage),
        },
        geometry: {
          type: 'LineString' as const,
          coordinates,
        },
      };
    })
    .filter((feature): feature is NonNullable<typeof feature> => feature !== null);

  return { type: 'FeatureCollection' as const, features };
}

/** All nodes in the viewport chunk — used when Martin tiles are unavailable. */
export function chunkToNodeGeoJson(chunk: GiopGraphChunkResponse | null) {
  if (!chunk) {
    return { type: 'FeatureCollection' as const, features: [] };
  }

  return {
    type: 'FeatureCollection' as const,
    features: chunk.nodes.map((node) => ({
      type: 'Feature' as const,
      properties: {
        mrid: node.mrid,
        name: node.name,
        connected: node.connected,
        traced: node.traced,
        validation: node.validation ?? '',
      },
      geometry: {
        type: 'Point' as const,
        coordinates: [node.lon, node.lat] as [number, number],
      },
    })),
  };
}
