"""Memgraph read path for interactive trace and downstream impact."""

from __future__ import annotations

import os
from typing import Any

from graph_sync import memgraph_totals

TRACE_MAX_HOPS = int(os.getenv("TRACE_MAX_HOPS", "10"))
TRACE_MAX_NODES = int(os.getenv("TRACE_MAX_NODES", "5000"))
TRACE_MAX_EDGES = int(os.getenv("TRACE_MAX_EDGES", "15000"))
TRACE_FULL_HOPS = int(os.getenv("TRACE_FULL_HOPS", "12"))
MEMGRAPH_TRACE_MIN_EDGES = int(os.getenv("MEMGRAPH_TRACE_MIN_EDGES", "100"))

_trace_driver = None


def get_trace_driver():
    """Shared read-only driver for trace/impact (sync-service graph_driver preferred)."""
    global _trace_driver
    if _trace_driver is None:
        from neo4j import GraphDatabase

        from graph_sync import GRAPH_URI

        _trace_driver = GraphDatabase.driver(GRAPH_URI, auth=None)
    return _trace_driver


def memgraph_trace_ready(driver) -> bool:
    """True when Memgraph has enough edges to serve trace/impact reads."""
    try:
        _, edges = memgraph_totals(driver)
        return edges >= MEMGRAPH_TRACE_MIN_EDGES
    except Exception:
        return False


def _clamp_hops(max_hops: int | None, *, full: bool = False) -> int:
    default = TRACE_FULL_HOPS if full else TRACE_MAX_HOPS
    return max(1, min(max_hops or default, 20))


def _clamp_nodes(max_nodes: int | None) -> int:
    return max(100, min(max_nodes or TRACE_MAX_NODES, 20000))


def _clamp_edges(max_edges: int | None) -> int:
    return max(100, min(max_edges or TRACE_MAX_EDGES, 50000))


def collect_downstream_mrids(
    driver,
    start_mrid: str,
    *,
    max_hops: int,
    max_nodes: int,
) -> tuple[set[str], bool]:
    hops = _clamp_hops(max_hops)
    cap = _clamp_nodes(max_nodes)
    mrids: set[str] = {start_mrid}
    truncated = False
    query = f"""
        MATCH (start:ConnectivityNode {{mrid: $start_mrid}})
        MATCH (start)-[:AC_LINE_SEGMENT*1..{hops}]->(n:ConnectivityNode)
        RETURN DISTINCT n.mrid AS mrid
        LIMIT $limit
    """
    with driver.session() as session:
        rows = list(session.run(query, start_mrid=start_mrid, limit=cap))
    for row in rows:
        mrid = row.get("mrid")
        if mrid:
            mrids.add(str(mrid))
    if len(rows) >= cap or len(mrids) >= cap:
        truncated = True
    return mrids, truncated


def collect_neighborhood_mrids(
    driver,
    start_mrid: str,
    *,
    max_hops: int,
    max_nodes: int,
) -> tuple[set[str], bool]:
    """Downstream + limited upstream hops from seed (full-network neighborhood)."""
    hops = _clamp_hops(max_hops, full=True)
    cap = _clamp_nodes(max_nodes)
    mrids: set[str] = {start_mrid}
    truncated = False
    down_query = f"""
        MATCH (start:ConnectivityNode {{mrid: $start_mrid}})
        MATCH (start)-[:AC_LINE_SEGMENT*1..{hops}]->(n:ConnectivityNode)
        RETURN DISTINCT n.mrid AS mrid
        LIMIT $limit
    """
    up_query = """
        MATCH (start:ConnectivityNode {mrid: $start_mrid})
        MATCH (n:ConnectivityNode)-[:AC_LINE_SEGMENT*1..3]->(start)
        RETURN DISTINCT n.mrid AS mrid
        LIMIT $limit
    """
    with driver.session() as session:
        down_rows = list(session.run(down_query, start_mrid=start_mrid, limit=cap))
        remaining = max(0, cap - len(down_rows))
        up_rows = (
            list(session.run(up_query, start_mrid=start_mrid, limit=remaining))
            if remaining
            else []
        )
    for row in down_rows + up_rows:
        mrid = row.get("mrid")
        if mrid:
            mrids.add(str(mrid))
    if len(down_rows) >= cap or len(mrids) >= cap:
        truncated = True
    return mrids, truncated


def fetch_subgraph(
    driver,
    node_mrids: set[str],
    *,
    max_edges: int,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], set[str]]:
    if not node_mrids:
        return [], [], set()
    edge_cap = _clamp_edges(max_edges)
    mrid_list = list(node_mrids)
    query = """
        MATCH (a:ConnectivityNode)-[r:AC_LINE_SEGMENT]->(b:ConnectivityNode)
        WHERE a.mrid IN $mrids AND b.mrid IN $mrids
        RETURN
          r.mrid AS mrid,
          a.mrid AS source,
          b.mrid AS target,
          coalesce(r.phases, 'ABC') AS phases,
          coalesce(r.voltage, 'MV_11KV') AS voltage
        LIMIT $limit
    """
    with driver.session() as session:
        edge_rows = list(session.run(query, mrids=mrid_list, limit=edge_cap + 1))
    edges_truncated = len(edge_rows) > edge_cap
    if edges_truncated:
        edge_rows = edge_rows[:edge_cap]

    connected: set[str] = set()
    edges: list[dict[str, Any]] = []
    for row in edge_rows:
        src = str(row["source"])
        tgt = str(row["target"])
        connected.add(src)
        connected.add(tgt)
        edges.append(
            {
                "mrid": str(row["mrid"]) if row.get("mrid") else f"{src}->{tgt}",
                "source": src,
                "target": tgt,
                "phases": row.get("phases") or "ABC",
                "voltage": row.get("voltage") or "MV_11KV",
            }
        )

    node_query = """
        MATCH (n:ConnectivityNode)
        WHERE n.mrid IN $mrids
        RETURN n.mrid AS mrid, coalesce(n.name, n.mrid) AS name
    """
    with driver.session() as session:
        node_rows = list(session.run(node_query, mrids=mrid_list))

    nodes: list[dict[str, Any]] = []
    for row in node_rows:
        mrid = str(row["mrid"])
        nodes.append(
            {
                "mrid": mrid,
                "name": row.get("name") or mrid,
                "connected": mrid in connected,
            }
        )
    return nodes, edges, connected


def enrich_nodes_from_postgres(conn, nodes: list[dict[str, Any]], traced_mrids: set[str]) -> list[dict[str, Any]]:
    if not nodes:
        return []
    mrids = [n["mrid"] for n in nodes]
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT
              cn.mrid::text,
              io.name,
              io.validation::text,
              ST_Y(cn.geom) AS lat,
              ST_X(cn.geom) AS lon
            FROM public.connectivity_nodes cn
            JOIN public.identified_objects io ON io.mrid = cn.mrid
            WHERE cn.mrid = ANY(%s::uuid[])
            """,
            (mrids,),
        )
        rows = {row[0]: row for row in cur.fetchall()}

    enriched: list[dict[str, Any]] = []
    for node in nodes:
        mrid = node["mrid"]
        row = rows.get(mrid)
        name = node.get("name") or mrid
        validation = None
        lat = None
        lon = None
        if row:
            name = row[1] or name
            validation = row[2]
            lat = float(row[3]) if row[3] is not None else None
            lon = float(row[4]) if row[4] is not None else None
        enriched.append(
            {
                "mrid": mrid,
                "name": name,
                "type": ["ConnectivityNode"],
                "connected": bool(node.get("connected")),
                "traced": mrid in traced_mrids,
                "validation": validation,
                **({"latitude": lat, "longitude": lon} if lat is not None and lon is not None else {}),
            }
        )
    return enriched


def build_trace_payload_memgraph(
    driver,
    conn,
    start_mrid: str,
    scope: str,
    *,
    graph_totals: dict[str, int],
    max_hops: int | None = None,
    max_nodes: int | None = None,
) -> dict[str, Any]:
    node_cap = _clamp_nodes(max_nodes)
    edge_cap = _clamp_edges(TRACE_MAX_EDGES)
    hop_cap = _clamp_hops(max_hops, full=(scope == "full"))

    if scope == "full":
        included, trace_truncated = collect_neighborhood_mrids(
            driver, start_mrid, max_hops=hop_cap, max_nodes=node_cap
        )
    else:
        included, trace_truncated = collect_downstream_mrids(
            driver, start_mrid, max_hops=hop_cap, max_nodes=node_cap
        )

    traced_mrids, _ = collect_downstream_mrids(
        driver, start_mrid, max_hops=hop_cap, max_nodes=node_cap
    )

    raw_nodes, edges, _connected = fetch_subgraph(driver, included, max_edges=edge_cap)
    edges_truncated = len(edges) >= edge_cap
    if edges_truncated:
        trace_truncated = True

    endpoint_mrids = set(included)
    for edge in edges:
        endpoint_mrids.add(edge["source"])
        endpoint_mrids.add(edge["target"])

    raw_by_mrid = {n["mrid"]: n for n in raw_nodes}
    nodes_for_enrich = [
        raw_by_mrid.get(mrid, {"mrid": mrid, "name": mrid, "connected": False})
        for mrid in endpoint_mrids
    ]
    nodes = enrich_nodes_from_postgres(conn, nodes_for_enrich, traced_mrids)

    bounds = {
        "max_hops": hop_cap,
        "max_nodes": node_cap,
        "max_edges": edge_cap,
        "truncated": trace_truncated,
        "mode": "memgraph_full" if scope == "full" else "memgraph_traced",
    }
    if edges_truncated:
        bounds["edges_truncated"] = True

    return {
        "nodes": nodes,
        "edges": edges,
        "start_mrid": start_mrid,
        "scope": scope,
        "graph_totals": graph_totals,
        "bounds": bounds,
        "backend": "memgraph",
    }


def count_meter_customer_impact(
    conn,
    downstream_mrids: set[str],
) -> dict[str, int | None]:
    """Count meters and distinct customer accounts on downstream graph nodes."""
    if not downstream_mrids:
        return {"customers_affected": 0, "meters_downstream": 0}
    mrids = list(downstream_mrids)
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT COUNT(*)
                FROM public.meters m
                WHERE m.mrid = ANY(%s::uuid[])
                """,
                (mrids,),
            )
            meters = int(cur.fetchone()[0])
            cur.execute(
                """
                SELECT COUNT(DISTINCT up.account_mrid)
                FROM public.usage_points up
                WHERE up.mrid = ANY(%s::uuid[])
                """,
                (mrids,),
            )
            customers = int(cur.fetchone()[0])
    except Exception:
        return {"customers_affected": None, "meters_downstream": None}
    return {"customers_affected": customers, "meters_downstream": meters}


def sample_connected_node_pg(
    conn,
    *,
    west: float | None = None,
    south: float | None = None,
    east: float | None = None,
    north: float | None = None,
) -> dict[str, Any] | None:
    """One connectivity node on at least one line — smoke-test helper."""
    envelope_clause = ""
    params: list[Any] = []
    if None not in (west, south, east, north):
        envelope_clause = "AND cn.geom && ST_MakeEnvelope(%s, %s, %s, %s, 4326)"
        params.extend([west, south, east, north])

    with conn.cursor() as cur:
        cur.execute(
            f"""
            SELECT cn.mrid::text, io.name, ST_X(cn.geom) AS lon, ST_Y(cn.geom) AS lat
            FROM connectivity_nodes cn
            JOIN identified_objects io ON io.mrid = cn.mrid
            WHERE EXISTS (
              SELECT 1 FROM ac_line_segments als
              WHERE als.source_node_id = cn.mrid OR als.target_node_id = cn.mrid
            )
            {envelope_clause}
            ORDER BY cn.mrid
            LIMIT 1
            """,
            tuple(params),
        )
        row = cur.fetchone()
    if not row:
        return None
    mrid, name, lon, lat = row
    return {
        "mrid": mrid,
        "name": name or mrid,
        "lon": float(lon) if lon is not None else None,
        "lat": float(lat) if lat is not None else None,
    }


def downstream_impact_memgraph(
    driver,
    conn,
    start_mrid: str,
    *,
    graph_totals: dict[str, int] | None = None,
    max_nodes: int | None = None,
) -> dict[str, Any]:
    cap = _clamp_nodes(max_nodes)
    hop_cap = _clamp_hops(TRACE_FULL_HOPS, full=True)
    traced_mrids, truncated = collect_downstream_mrids(
        driver, start_mrid, max_hops=hop_cap, max_nodes=cap
    )
    raw_nodes, edges, _ = fetch_subgraph(driver, traced_mrids, max_edges=cap * 2)
    nodes = enrich_nodes_from_postgres(conn, raw_nodes, traced_mrids)
    node_ids = {n["mrid"] for n in nodes}
    filtered_edges = [
        e for e in edges if e["source"] in node_ids and e["target"] in node_ids
    ]
    downstream_count = max(0, len(nodes) - (1 if start_mrid in node_ids else 0))
    impact_counts = count_meter_customer_impact(conn, traced_mrids)
    return {
        "start_mrid": start_mrid,
        "nodes": nodes,
        "edges": filtered_edges,
        "metrics": {
            "total_nodes": len(nodes),
            "downstream_nodes": downstream_count,
            "edge_count": len(filtered_edges),
            "truncated": truncated or len(nodes) >= cap,
            "max_nodes": cap,
            **impact_counts,
        },
        "graph_totals": graph_totals,
        "backend": "memgraph",
    }
