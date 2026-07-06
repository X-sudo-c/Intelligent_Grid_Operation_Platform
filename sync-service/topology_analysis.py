"""Topology health, gaps, and downstream impact (CIM mrid keys)."""

from __future__ import annotations

import os
from typing import Any

import psycopg2

TOPOLOGY_GRAPH_MAX_NODES = int(os.getenv("TOPOLOGY_GRAPH_MAX_NODES", "75000"))
TOPOLOGY_GAPS_DEFAULT_LIMIT = int(os.getenv("TOPOLOGY_GAPS_LIMIT", "2000"))
TOPOLOGY_IMPACT_DEFAULT_MAX = int(os.getenv("TOPOLOGY_IMPACT_MAX_NODES", "5000"))


def _pg_connect():
    uri = os.getenv("SUPABASE_DB_URI")
    if not uri:
        raise RuntimeError("SUPABASE_DB_URI not configured")
    return psycopg2.connect(uri)


def _count_master_topology(conn) -> tuple[int, int]:
    with conn.cursor() as cur:
        cur.execute("SELECT COUNT(*) FROM public.connectivity_nodes")
        node_count = int(cur.fetchone()[0])
        cur.execute("SELECT COUNT(*) FROM public.ac_line_segments")
        edge_count = int(cur.fetchone()[0])
    return node_count, edge_count


def _fetch_orphans(
    conn,
    *,
    limit: int,
    west: float | None = None,
    south: float | None = None,
    east: float | None = None,
    north: float | None = None,
) -> list[dict[str, Any]]:
    bbox_clause = ""
    params: list[Any] = [limit]
    if None not in (west, south, east, north):
        bbox_clause = """
          AND cn.geom && ST_MakeEnvelope(%s, %s, %s, %s, 4326)
        """
        params = [west, south, east, north, limit]

    with conn.cursor() as cur:
        cur.execute(
            f"""
            SELECT
              cn.mrid::text,
              io.name,
              io.validation::text,
              ST_Y(cn.geom) AS lat,
              ST_X(cn.geom) AS lon
            FROM public.connectivity_nodes cn
            JOIN public.identified_objects io ON io.mrid = cn.mrid
            WHERE NOT EXISTS (
              SELECT 1
              FROM public.ac_line_segments als
              WHERE als.source_node_id = cn.mrid OR als.target_node_id = cn.mrid
            )
            {bbox_clause}
            ORDER BY io.name
            LIMIT %s
            """,
            params,
        )
        rows = cur.fetchall()

    return [
        {
            "mrid": row[0],
            "name": row[1] or row[0],
            "validation": row[2],
            "latitude": float(row[3]) if row[3] is not None else None,
            "longitude": float(row[4]) if row[4] is not None else None,
            "connected": False,
            "traced": False,
            "type": ["ConnectivityNode"],
        }
        for row in rows
    ]


def _count_orphans(conn) -> int:
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT COUNT(*)
            FROM public.connectivity_nodes cn
            WHERE NOT EXISTS (
              SELECT 1
              FROM public.ac_line_segments als
              WHERE als.source_node_id = cn.mrid OR als.target_node_id = cn.mrid
            )
            """
        )
        return int(cur.fetchone()[0])


def _component_metrics(node_count: int) -> dict[str, Any]:
    if node_count == 0 or node_count > TOPOLOGY_GRAPH_MAX_NODES:
        return {"component_count": None, "largest_component_nodes": None, "graph_analysis": "skipped"}
    try:
        import networkx as nx

        from topology_graph import load_master_digraph

        graph = load_master_digraph()
        undirected = graph.to_undirected()
        components = list(nx.connected_components(undirected))
        sizes = sorted((len(c) for c in components), reverse=True)
        return {
            "component_count": len(components),
            "largest_component_nodes": sizes[0] if sizes else 0,
            "isolated_component_count": sum(1 for size in sizes if size == 1),
            "graph_analysis": "networkx",
        }
    except Exception as exc:
        return {"component_count": None, "largest_component_nodes": None, "graph_analysis": f"error:{exc}"}


def topology_health_report() -> dict[str, Any]:
    conn = _pg_connect()
    try:
        node_count, edge_count = _count_master_topology(conn)
        orphan_count = _count_orphans(conn)
        edge_ratio = round(edge_count / node_count, 6) if node_count else 0.0
        components = _component_metrics(node_count)
        status = "ok"
        if node_count == 0:
            status = "empty"
        elif orphan_count > 0:
            status = "warn"
        return {
            "status": status,
            "metrics": {
                "node_count": node_count,
                "edge_count": edge_count,
                "edge_ratio": edge_ratio,
                "orphan_count": orphan_count,
                **components,
            },
        }
    finally:
        conn.close()


def topology_gaps_payload(
    *,
    limit: int | None = None,
    west: float | None = None,
    south: float | None = None,
    east: float | None = None,
    north: float | None = None,
) -> dict[str, Any]:
    lim = max(1, min(limit or TOPOLOGY_GAPS_DEFAULT_LIMIT, 10000))
    conn = _pg_connect()
    try:
        nodes = _fetch_orphans(conn, limit=lim, west=west, south=south, east=east, north=north)
        total_orphans = _count_orphans(conn)
    finally:
        conn.close()

    return {
        "nodes": nodes,
        "edges": [],
        "metrics": {
            "orphan_count": total_orphans,
            "returned": len(nodes),
            "truncated": total_orphans > len(nodes),
        },
    }


def downstream_impact_payload(
    start_mrid: str,
    *,
    max_nodes: int | None = None,
    graph_driver=None,
) -> dict[str, Any]:
    cap = max(1, min(max_nodes or TOPOLOGY_IMPACT_DEFAULT_MAX, 20000))
    driver = graph_driver
    memgraph_ready = False
    downstream_impact_memgraph = None
    try:
        from memgraph_topology import (
            downstream_impact_memgraph as _impact_mg,
            get_trace_driver,
            memgraph_trace_ready,
        )

        downstream_impact_memgraph = _impact_mg
        if driver is None:
            driver = get_trace_driver()
        memgraph_ready = bool(driver and memgraph_trace_ready(driver))
    except Exception:
        memgraph_ready = False

    conn = _pg_connect()
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT COUNT(*) FROM public.connectivity_nodes")
            pg_nodes = int(cur.fetchone()[0])
            cur.execute("SELECT COUNT(*) FROM public.ac_line_segments")
            pg_edges = int(cur.fetchone()[0])
        graph_totals = {"nodes": pg_nodes, "edges": pg_edges}

        if memgraph_ready and driver is not None and downstream_impact_memgraph is not None:
            try:
                return downstream_impact_memgraph(
                    driver,
                    conn,
                    start_mrid,
                    graph_totals=graph_totals,
                    max_nodes=cap,
                )
            except Exception as exc:
                import logging

                logging.getLogger(__name__).warning(
                    "Memgraph impact failed, falling back to Postgres: %s", exc
                )

        with conn.cursor() as cur:
            cur.execute(
                """
                WITH RECURSIVE walk AS (
                  SELECT %s::uuid AS mrid, 0 AS depth
                  UNION ALL
                  SELECT als.target_node_id, w.depth + 1
                  FROM walk w
                  JOIN public.ac_line_segments als ON als.source_node_id = w.mrid
                  WHERE w.depth < 64
                ),
                reached AS (
                  SELECT DISTINCT mrid FROM walk
                )
                SELECT
                  cn.mrid::text,
                  io.name,
                  io.validation::text,
                  ST_Y(cn.geom) AS lat,
                  ST_X(cn.geom) AS lon
                FROM reached r
                JOIN public.connectivity_nodes cn ON cn.mrid = r.mrid
                JOIN public.identified_objects io ON io.mrid = cn.mrid
                LIMIT %s
                """,
                (start_mrid, cap),
            )
            node_rows = cur.fetchall()

            cur.execute(
                """
                WITH RECURSIVE walk AS (
                  SELECT %s::uuid AS mrid, 0 AS depth
                  UNION ALL
                  SELECT als.target_node_id, w.depth + 1
                  FROM walk w
                  JOIN public.ac_line_segments als ON als.source_node_id = w.mrid
                  WHERE w.depth < 64
                ),
                reached AS (
                  SELECT DISTINCT mrid FROM walk
                )
                SELECT
                  als.mrid::text,
                  als.source_node_id::text,
                  als.target_node_id::text,
                  coalesce(ce.phases, 'ABC'),
                  coalesce(ce.nominal_voltage::text, 'MV_11KV')
                FROM public.ac_line_segments als
                JOIN public.conducting_equipment ce ON ce.mrid = als.mrid
                WHERE als.source_node_id IN (SELECT mrid FROM reached)
                  AND als.target_node_id IN (SELECT mrid FROM reached)
                LIMIT %s
                """,
                (start_mrid, cap * 2),
            )
            edge_rows = cur.fetchall()

        node_ids = {row[0] for row in node_rows}
        nodes = [
            {
                "mrid": row[0],
                "name": row[1] or row[0],
                "validation": row[2],
                "latitude": float(row[3]) if row[3] is not None else None,
                "longitude": float(row[4]) if row[4] is not None else None,
                "connected": True,
                "traced": row[0] != start_mrid,
                "type": ["ConnectivityNode"],
            }
            for row in node_rows
        ]
        edges = [
            {
                "mrid": row[0],
                "source": row[1],
                "target": row[2],
                "phases": row[3],
                "voltage": row[4],
            }
            for row in edge_rows
            if row[1] in node_ids and row[2] in node_ids
        ]

        downstream_count = max(0, len(nodes) - (1 if start_mrid in node_ids else 0))
        downstream_mrids = {n["mrid"] for n in nodes}
        from memgraph_topology import count_meter_customer_impact

        impact_counts = count_meter_customer_impact(conn, downstream_mrids)
        return {
            "start_mrid": start_mrid,
            "nodes": nodes,
            "edges": edges,
            "metrics": {
                "total_nodes": len(nodes),
                "downstream_nodes": downstream_count,
                "edge_count": len(edges),
                "truncated": len(nodes) >= cap,
                "max_nodes": cap,
                **impact_counts,
            },
            "graph_totals": graph_totals,
            "backend": "postgres",
        }
    finally:
        conn.close()
