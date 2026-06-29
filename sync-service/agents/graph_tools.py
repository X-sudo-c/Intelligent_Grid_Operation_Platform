"""NetworkX graph analysis tools for GraphAgent."""

from __future__ import annotations

import os
from typing import Any

TOPOLOGY_GRAPH_MAX_NODES = int(os.getenv("TOPOLOGY_GRAPH_MAX_NODES", "75000"))


def detect_cycles(max_nodes: int = TOPOLOGY_GRAPH_MAX_NODES) -> dict[str, Any]:
    try:
        import networkx as nx

        from topology_graph import load_master_digraph

        graph = load_master_digraph()
        if graph.number_of_nodes() > max_nodes:
            return {"cycles": [], "count": 0, "skipped": True, "reason": "graph_too_large"}
        undirected = graph.to_undirected()
        basis = nx.cycle_basis(undirected)
        return {
            "cycles": [list(c)[:20] for c in basis[:50]],
            "count": len(basis),
            "skipped": False,
        }
    except Exception as exc:
        return {"cycles": [], "count": 0, "error": str(exc)}


def detect_islands(
    min_component_size: int = 2,
    max_nodes: int = TOPOLOGY_GRAPH_MAX_NODES,
) -> dict[str, Any]:
    try:
        import networkx as nx

        from topology_graph import load_master_digraph

        graph = load_master_digraph()
        if graph.number_of_nodes() > max_nodes:
            return {"islands": [], "count": 0, "skipped": True}
        undirected = graph.to_undirected()
        components = list(nx.connected_components(undirected))
        small = [list(c)[:10] for c in components if 1 < len(c) < min_component_size]
        isolated = sum(1 for c in components if len(c) == 1)
        return {
            "islands": small[:50],
            "small_component_count": len(small),
            "isolated_node_count": isolated,
            "total_components": len(components),
        }
    except Exception as exc:
        return {"islands": [], "error": str(exc)}


def trace_feeder(feeder_id: str, max_hops: int = 500) -> dict[str, Any]:
    """Bounded BFS from nodes matching boundary_feeder_id."""
    try:
        import os

        import psycopg2

        uri = os.getenv("SUPABASE_DB_URI")
        if not uri:
            return {"error": "SUPABASE_DB_URI not configured"}
        conn = psycopg2.connect(uri)
        try:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    SELECT cn.mrid::text
                    FROM public.connectivity_nodes cn
                    WHERE cn.boundary_feeder_id = %s
                    LIMIT 20
                    """,
                    (feeder_id,),
                )
                seeds = [r[0] for r in cur.fetchall()]
            if not seeds:
                return {"feeder_id": feeder_id, "nodes": [], "count": 0}

            from topology_graph import load_master_digraph

            graph = load_master_digraph()
            visited: set[str] = set()
            frontier = list(seeds)
            hops = 0
            while frontier and hops < max_hops:
                nxt: list[str] = []
                for node in frontier:
                    if node in visited:
                        continue
                    visited.add(node)
                    for neighbor in graph.neighbors(node):
                        if neighbor not in visited:
                            nxt.append(neighbor)
                    for neighbor in graph.predecessors(node):
                        if neighbor not in visited:
                            nxt.append(neighbor)
                frontier = nxt
                hops += 1
            return {
                "feeder_id": feeder_id,
                "seed_count": len(seeds),
                "reachable_nodes": len(visited),
                "sample_nodes": list(visited)[:30],
            }
        finally:
            conn.close()
    except Exception as exc:
        return {"feeder_id": feeder_id, "error": str(exc)}
