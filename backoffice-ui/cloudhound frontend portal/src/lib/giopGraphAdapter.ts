import type { GiopStagingAsset, GiopTraceResponse, GiopGraphChunkResponse, GiopTopologyPayload } from '../api/giop-api';
import type { GiopGraphQueryKey } from './giopGraphTypes';
import type { PortalGraphResponse } from './giopGraphTypes';
import { voltageEdgeColor } from './giopSldTheme';

export const MAX_GRAPH_NODES = 2000;

type RiskBand = 'critical' | 'high' | 'medium' | 'low';

function inferAssetClass(name: string): string {
  const lower = name.toLowerCase();
  if (lower.includes('bsp') || lower.includes('bulk supply')) return 'substation';
  if (lower.includes('substation')) return 'substation';
  if (lower.includes('transformer') || lower.includes('tx')) return 'transformer';
  if (lower.includes('feeder')) return 'feeder';
  if (lower.includes('meter')) return 'meter';
  return 'connectivity_node';
}

function isCriticalAsset(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.includes('bsp') || lower.includes('bulk supply') || lower.includes('substation');
}

function validationToRisk(validation?: string, connected = true): { band: RiskBand; level: number } {
  if (validation === 'IN_CONFLICT') return { band: 'critical', level: 92 };
  if (validation === 'REJECTED') return { band: 'low', level: 10 };
  if (!connected) return { band: 'high', level: 75 };
  if (validation === 'PENDING_FIELD' || validation === 'STAGED') return { band: 'medium', level: 55 };
  return { band: 'low', level: 15 };
}

function stagingValidationMap(assets: GiopStagingAsset[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const asset of assets) {
    if (asset.validation) map.set(asset.mrid, asset.validation);
  }
  return map;
}

export function traceToPortalGraph(
  trace: GiopTraceResponse,
  stagingAssets: GiopStagingAsset[] = [],
  queryKey: GiopGraphQueryKey = 'network_topology',
): PortalGraphResponse {
  const validationByMrid = stagingValidationMap(stagingAssets);

  const nodes = trace.nodes.map((node) => {
    const validation = validationByMrid.get(node.mrid) ?? node.validation;
    const assetClass = inferAssetClass(node.name || '');
    const { band, level } = validationToRisk(validation, node.connected);
    return {
      id: node.mrid,
      label: node.name || node.mrid,
      name: node.name || node.mrid,
      type: assetClass,
      risk_level: level,
      risk_band: band,
      properties: {
        connected: node.connected,
        traced: node.traced,
        validation: validation ?? 'APPROVED',
        is_hvt: isCriticalAsset(node.name || ''),
        disconnected: !node.connected,
        is_conflict: validation === 'IN_CONFLICT',
      },
    };
  });

  const edges = trace.edges.map((edge) => ({
    id: edge.mrid || `${edge.source}-${edge.target}`,
    source: edge.source,
    target: edge.target,
    relationship_type: edge.voltage || 'AC_LINE_SEGMENT',
    properties: {
      phases: edge.phases,
      voltage: edge.voltage,
      edge_color: voltageEdgeColor(edge.voltage),
      is_privilege_escalation: false,
      is_topology_gap: false,
    },
  }));

  const disconnectedCount = trace.nodes.filter((n) => !n.connected).length;
  const conflictCount = trace.nodes.filter((n) => {
    const v = validationByMrid.get(n.mrid) ?? n.validation;
    return v === 'IN_CONFLICT';
  }).length;
  const criticalCount = trace.nodes.filter((n) => isCriticalAsset(n.name || '')).length;

  const noteParts: string[] = [];
  if (trace.graph_totals && trace.graph_totals.nodes > nodes.length) {
    const backend =
      (trace as GiopTraceResponse & { backend?: string }).backend === 'memgraph'
        ? 'Memgraph'
        : 'network';
    noteParts.push(
      `Loaded ${nodes.length.toLocaleString()} nodes · ${edges.length.toLocaleString()} edges of ${trace.graph_totals.nodes.toLocaleString()} ${backend} nodes (${trace.scope ?? 'traced'} scope).`,
    );
  } else if (edges.length > 0) {
    noteParts.push(
      `${nodes.length.toLocaleString()} nodes · ${edges.length.toLocaleString()} edges (${trace.scope ?? 'traced'} scope).`,
    );
  }
  if (trace.bounds?.truncated) {
    noteParts.push(
      `Result capped at ${trace.bounds.max_nodes.toLocaleString()} nodes / ${trace.bounds.max_hops} hops`,
    );
  }
  if (trace.bounds?.mode === 'viewport_fallback') {
    noteParts.push('Large network — showing viewport around seed');
  }

  const fullGraph: PortalGraphResponse = {
    configured: true,
    query_key: queryKey,
    title: 'Grid Network Topology',
    nodes,
    edges,
    metrics: {
      total_nodes: nodes.length,
      total_edges: edges.length,
      high_risk_entities: conflictCount + disconnectedCount,
      hvt_count: criticalCount,
      privilege_escalation_paths: disconnectedCount,
      external_trust_roles: 0,
      query_title: 'Grid topology',
      query_mode: queryKey,
      note: noteParts.length > 0 ? noteParts.join(' · ') : undefined,
    },
  };

  return capGraphForCanvas(filterGraphByQuery(fullGraph, queryKey));
}

export function topologyPayloadToPortalGraph(
  payload: GiopTopologyPayload,
  stagingAssets: GiopStagingAsset[] = [],
  queryKey: GiopGraphQueryKey = 'topology_gaps',
  title = 'Topology analysis',
): PortalGraphResponse {
  const traceLike: GiopTraceResponse = {
    nodes: payload.nodes,
    edges: payload.edges,
    start_mrid: payload.start_mrid ?? '',
    scope: 'full',
  };
  const graph = traceToPortalGraph(traceLike, stagingAssets, queryKey);
  const noteParts: string[] = [];
  if (payload.metrics?.orphan_count != null) {
    noteParts.push(`${payload.metrics.orphan_count} orphan nodes in master`);
  }
  if (payload.metrics?.downstream_nodes != null) {
    noteParts.push(`${payload.metrics.downstream_nodes} downstream nodes`);
  }
  if (payload.metrics?.truncated) {
    noteParts.push('result truncated — narrow seed or raise max_nodes');
  }
  if (noteParts.length > 0) {
    graph.metrics = { ...graph.metrics, note: noteParts.join(' · ') };
  }
  graph.title = title;
  return graph;
}

export function filterGraphByQuery(
  graph: PortalGraphResponse,
  queryKey: GiopGraphQueryKey,
): PortalGraphResponse {
  if (queryKey === 'network_topology' || queryKey === 'viewport_subgraph') {
    return { ...graph, query_key: queryKey };
  }

  let nodeFilter: (props: Record<string, unknown>) => boolean;
  switch (queryKey) {
    case 'traced_subgraph':
      nodeFilter = (p) => p.traced === true;
      break;
    case 'topology_gaps':
      nodeFilter = (p) => p.connected === false || p.disconnected === true;
      break;
    case 'conflicts':
      nodeFilter = (p) => p.is_conflict === true || p.validation === 'IN_CONFLICT';
      break;
    case 'critical_assets':
      nodeFilter = (p) => p.is_hvt === true;
      break;
    default:
      return graph;
  }

  const keptNodeIds = new Set(
    graph.nodes.filter((n) => nodeFilter((n.properties || {}) as Record<string, unknown>)).map((n) => n.id),
  );

  if (queryKey === 'traced_subgraph') {
    for (const edge of graph.edges) {
      if (keptNodeIds.has(edge.source) || keptNodeIds.has(edge.target)) {
        keptNodeIds.add(edge.source);
        keptNodeIds.add(edge.target);
      }
    }
  }

  const filteredNodes = graph.nodes.filter((n) => keptNodeIds.has(n.id));
  const filteredEdges = graph.edges.filter(
    (e) => keptNodeIds.has(e.source) && keptNodeIds.has(e.target),
  );

  return {
    ...graph,
    query_key: queryKey,
    nodes: filteredNodes,
    edges: filteredEdges,
    metrics: {
      ...graph.metrics,
      total_nodes: filteredNodes.length,
      total_edges: filteredEdges.length,
      query_mode: queryKey,
    },
  };
}

function capGraphForCanvas(graph: PortalGraphResponse): PortalGraphResponse {
  const maxNodes = MAX_GRAPH_NODES;
  if (graph.nodes.length <= maxNodes && graph.edges.length <= maxNodes) {
    return graph;
  }

  const nodePriority = (node: PortalGraphResponse['nodes'][number]) => {
    const props = (node.properties || {}) as Record<string, unknown>;
    if (props.traced === true) return 0;
    if (props.is_conflict === true) return 1;
    if (props.is_hvt === true) return 2;
    if (props.connected !== false && props.disconnected !== true) return 3;
    if (props.disconnected === true || props.connected === false) return 5;
    return 4;
  };

  // Keep wired structure first — avoids E=0 when the API returned edges.
  const keptIds = new Set<string>();
  const keptEdges: PortalGraphResponse['edges'] = [];
  for (const edge of graph.edges) {
    if (keptEdges.length >= maxNodes) break;
    keptIds.add(edge.source);
    keptIds.add(edge.target);
    keptEdges.push(edge);
  }

  const sortedNodes = [...graph.nodes].sort((a, b) => nodePriority(a) - nodePriority(b));
  for (const node of sortedNodes) {
    if (keptIds.size >= maxNodes) break;
    keptIds.add(node.id);
  }

  const keptNodes = graph.nodes.filter((n) => keptIds.has(n.id));
  const finalEdges = keptEdges.filter(
    (e) => keptIds.has(e.source) && keptIds.has(e.target),
  );

  const omitted = graph.nodes.length - keptNodes.length;
  return {
    ...graph,
    nodes: keptNodes,
    edges: finalEdges,
    metrics: {
      ...graph.metrics,
      total_nodes: keptNodes.length,
      total_edges: finalEdges.length,
      note:
        omitted > 0
          ? `Showing ${keptNodes.length.toLocaleString()} nodes · ${finalEdges.length.toLocaleString()} edges (${omitted.toLocaleString()} nodes omitted). Pan the map or use Traced for a feeder walk.`
          : `Showing ${keptNodes.length.toLocaleString()} nodes · ${finalEdges.length.toLocaleString()} edges.`,
    },
    detail:
      graph.detail ??
      (omitted > 0
        ? `Graph capped: ${omitted.toLocaleString()} nodes omitted for performance.`
        : undefined),
  };
}

export function chunkToPortalGraph(
  chunk: GiopGraphChunkResponse,
  stagingAssets: GiopStagingAsset[] = [],
): PortalGraphResponse {
  const validationByMrid = stagingValidationMap(stagingAssets);
  const pseudoTrace: GiopTraceResponse = {
    nodes: chunk.nodes.map((node) => ({
      mrid: node.mrid,
      name: node.name,
      connected: node.connected,
      traced: node.traced,
      validation: validationByMrid.get(node.mrid) ?? node.validation,
    })),
    edges: chunk.edges,
    start_mrid: '',
    scope: 'traced',
  };

  const graph = traceToPortalGraph(pseudoTrace, stagingAssets, 'viewport_subgraph');
  const backendLabel =
    chunk.backend === 'memgraph' ? ' · Memgraph' : chunk.backend === 'postgres' ? ' · Postgres' : '';
  return {
    ...graph,
    metrics: {
      ...graph.metrics,
      query_title: 'Map viewport',
      note: chunk.truncated
        ? `Viewport: ${chunk.nodes.length} nodes (cap ${chunk.limit}), ${chunk.edges.length} lines in bounds${backendLabel}.`
        : `Viewport: ${chunk.nodes.length} nodes, ${chunk.edges.length} lines in map bounds${backendLabel}.`,
    },
  };
}

export function countValidationStats(assets: GiopStagingAsset[]) {
  const stats = { approved: 0, pending: 0, staged: 0, conflict: 0, rejected: 0, other: 0 };
  for (const asset of assets) {
    const v = asset.validation;
    if (v === 'APPROVED') stats.approved += 1;
    else if (v === 'PENDING_FIELD') stats.pending += 1;
    else if (v === 'STAGED') stats.staged += 1;
    else if (v === 'IN_CONFLICT') stats.conflict += 1;
    else if (v === 'REJECTED') stats.rejected += 1;
    else stats.other += 1;
  }
  return stats;
}

export function traceSummary(trace: GiopTraceResponse) {
  return {
    totalNodes: trace.nodes.length,
    totalEdges: trace.edges.length,
    tracedNodes: trace.nodes.filter((n) => n.traced).length,
    disconnectedNodes: trace.nodes.filter((n) => !n.connected).length,
  };
}
