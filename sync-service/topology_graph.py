"""Build CIM-aligned NetworkX graphs from Postgres master topology."""

from __future__ import annotations

import os
import threading
import time
from typing import Any

from graph_sync import fetch_topology_from_postgres

# Rebuilding the national graph pulls every node + edge out of Postgres; a
# short TTL keeps repeated agent tool calls (cycles, islands, feeder trace in
# one chat turn) from re-fetching identical data.
_GRAPH_CACHE_TTL_SEC = float(os.getenv("TOPOLOGY_GRAPH_CACHE_TTL_SEC", "60"))

_cache_lock = threading.Lock()
_cached_graph: Any = None
_cached_at: float = 0.0


def load_master_digraph(*, force_refresh: bool = False):
    import networkx as nx

    global _cached_graph, _cached_at
    with _cache_lock:
        fresh = _cached_graph is not None and (time.monotonic() - _cached_at) < _GRAPH_CACHE_TTL_SEC
        if fresh and not force_refresh:
            return _cached_graph

    nodes, edges = fetch_topology_from_postgres()
    graph = nx.DiGraph()
    for mrid, name in nodes:
        graph.add_node(mrid, name=name)
    for line_mrid, src, tgt, phases, voltage, direction_downstream in edges:
        attrs = {
            "mrid": line_mrid,
            "phases": phases,
            "voltage": voltage,
        }
        if direction_downstream:
            graph.add_edge(src, tgt, **attrs)
        else:
            graph.add_edge(tgt, src, **attrs)

    with _cache_lock:
        _cached_graph = graph
        _cached_at = time.monotonic()
    return graph


def graph_totals() -> tuple[int, int]:
    graph = load_master_digraph()
    return graph.number_of_nodes(), graph.number_of_edges()
