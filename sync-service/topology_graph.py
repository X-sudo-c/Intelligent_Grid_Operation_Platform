"""Build CIM-aligned NetworkX graphs from Postgres master topology."""

from __future__ import annotations

from typing import Any

from graph_sync import fetch_topology_from_postgres


def load_master_digraph():
    import networkx as nx

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
    return graph


def graph_totals() -> tuple[int, int]:
    nodes, edges = fetch_topology_from_postgres()
    return len(nodes), len(edges)
