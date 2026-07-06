"""NetworkX graph analysis tools for GraphAgent."""

from __future__ import annotations

import re
import os
from typing import Any

TOPOLOGY_GRAPH_MAX_NODES = int(os.getenv("TOPOLOGY_GRAPH_MAX_NODES", "75000"))
TRACE_FEEDER_MAX_NODES = int(os.getenv("TRACE_FEEDER_MAX_NODES", "2000"))
TRACE_FEEDER_MAP_SAMPLE = int(os.getenv("TRACE_FEEDER_MAP_SAMPLE", "500"))


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


def _feeder_id_for_mrid(conn, mrid: str) -> str | None:
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT boundary_feeder_id
            FROM public.connectivity_nodes
            WHERE mrid = %s::uuid
            LIMIT 1
            """,
            (mrid,),
        )
        row = cur.fetchone()
    if not row or not row[0]:
        return None
    return str(row[0]).strip() or None


def _feeder_seeds(conn, feeder_id: str) -> list[str]:
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
        return [r[0] for r in cur.fetchall()]


def resolve_feeder_query(conn, query: str) -> dict[str, Any]:
    """Resolve a spoken feeder label (e.g. 'Mallam') to boundary_feeder_id."""
    raw = (query or "").strip()
    token = re.sub(r"^(?:the|feeder|boundary feeder)\s+", "", raw, flags=re.I).strip()
    token = re.sub(r"\s+(?:feeder|boundary feeder)$", "", token, flags=re.I).strip()
    if not token:
        return {"query": raw, "feeder_id": None, "error": "Feeder name is required"}

    pattern = f"%{token.replace(' ', '%')}%"
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT cn.boundary_feeder_id, COUNT(*)::int AS node_count,
                   MAX(io.name) AS sample_name
            FROM public.connectivity_nodes cn
            JOIN public.identified_objects io ON io.mrid = cn.mrid
            LEFT JOIN public.ghana_grid_assets gga ON gga.mrid = cn.mrid
            WHERE cn.boundary_feeder_id IS NOT NULL
              AND (
                cn.boundary_feeder_id ILIKE %s
                OR io.name ILIKE %s
                OR gga.substation_name ILIKE %s
              )
            GROUP BY cn.boundary_feeder_id
            ORDER BY
              CASE WHEN lower(cn.boundary_feeder_id) = lower(%s) THEN 0
                   WHEN cn.boundary_feeder_id ILIKE %s THEN 1
                   ELSE 2 END,
              node_count DESC
            LIMIT 6
            """,
            (pattern, pattern, pattern, token, pattern),
        )
        rows = cur.fetchall()

    if not rows:
        return {
            "query": raw,
            "feeder_id": None,
            "error": f"No feeder found matching {token!r}",
        }

    candidates = [
        {
            "feeder_id": row[0],
            "node_count": int(row[1]),
            "sample_name": row[2],
        }
        for row in rows
    ]
    best = candidates[0]
    if len(candidates) == 1:
        return {
            "query": raw,
            "feeder_id": best["feeder_id"],
            "matched_as": best["feeder_id"],
            "sample_name": best.get("sample_name"),
            "node_count": best["node_count"],
            "source": "exact" if best["feeder_id"].lower() == token.lower() else "fuzzy",
        }

    # Multiple matches — prefer id containing token as whole word segment.
    token_low = token.lower()
    strong = [
        c
        for c in candidates
        if token_low in str(c["feeder_id"]).lower()
        or (c.get("sample_name") and token_low in str(c["sample_name"]).lower())
    ]
    if len(strong) == 1:
        pick = strong[0]
        return {
            "query": raw,
            "feeder_id": pick["feeder_id"],
            "matched_as": pick["feeder_id"],
            "sample_name": pick.get("sample_name"),
            "node_count": pick["node_count"],
            "source": "fuzzy",
            "candidates": candidates[1:4],
        }

    return {
        "query": raw,
        "feeder_id": None,
        "source": "ambiguous",
        "candidates": candidates[:5],
        "error": f"Multiple feeders match {token!r}",
    }


def _bfs_reachable(seeds: list[str], max_hops: int) -> set[str]:
    from topology_graph import load_master_digraph

    graph = load_master_digraph()
    visited: set[str] = set()
    frontier = list(seeds)
    hops = 0
    while frontier and hops < max_hops and len(visited) < TRACE_FEEDER_MAX_NODES:
        nxt: list[str] = []
        for node in frontier:
            if node in visited:
                continue
            visited.add(node)
            if len(visited) >= TRACE_FEEDER_MAX_NODES:
                break
            for neighbor in graph.neighbors(node):
                if neighbor not in visited:
                    nxt.append(neighbor)
            for neighbor in graph.predecessors(node):
                if neighbor not in visited:
                    nxt.append(neighbor)
        frontier = nxt
        hops += 1
    return visited


def _node_geojson(conn, mrids: list[str], *, limit: int) -> dict[str, Any]:
    if not mrids:
        return {"type": "FeatureCollection", "features": []}
    sample = mrids[:limit]
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT cn.mrid::text,
                   cn.boundary_feeder_id,
                   ST_X(cn.geom) AS lon,
                   ST_Y(cn.geom) AS lat,
                   io.name,
                   io.validation::text
            FROM public.connectivity_nodes cn
            JOIN public.identified_objects io ON io.mrid = cn.mrid
            WHERE cn.mrid = ANY(%s::uuid[])
              AND cn.geom IS NOT NULL
            ORDER BY cn.mrid
            LIMIT %s
            """,
            (sample, limit),
        )
        rows = cur.fetchall()

    features: list[dict[str, Any]] = []
    for mrid, feeder, lon, lat, name, validation in rows:
        if lon is None or lat is None:
            continue
        features.append(
            {
                "type": "Feature",
                "properties": {
                    "mrid": mrid,
                    "boundary_feeder_id": feeder,
                    "name": name,
                    "validation": validation or "",
                },
                "geometry": {
                    "type": "Point",
                    "coordinates": [float(lon), float(lat)],
                },
            }
        )
    return {"type": "FeatureCollection", "features": features}


def _edge_geojson(conn, mrids: set[str], *, limit: int = 800) -> dict[str, Any]:
    if not mrids:
        return {"type": "FeatureCollection", "features": []}
    mrid_list = list(mrids)[:TRACE_FEEDER_MAX_NODES]
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT ls.mrid::text,
                   ls.boundary_feeder_id,
                   ST_AsGeoJSON(ls.geom)::json AS geom
            FROM public.ac_line_segments ls
            WHERE ls.source_node_id = ANY(%s::uuid[])
              AND ls.target_node_id = ANY(%s::uuid[])
              AND ls.geom IS NOT NULL
            LIMIT %s
            """,
            (mrid_list, mrid_list, limit),
        )
        rows = cur.fetchall()

    features: list[dict[str, Any]] = []
    for mrid, feeder, geom in rows:
        if not geom:
            continue
        features.append(
            {
                "type": "Feature",
                "properties": {
                    "mrid": mrid,
                    "boundary_feeder_id": feeder,
                },
                "geometry": geom,
            }
        )
    return {"type": "FeatureCollection", "features": features}


def _bbox_from_geojson(geojson: dict[str, Any]) -> dict[str, float] | None:
    lons: list[float] = []
    lats: list[float] = []
    for feat in geojson.get("features") or []:
        geom = feat.get("geometry") or {}
        gtype = geom.get("type")
        coords = geom.get("coordinates")
        if gtype == "Point" and isinstance(coords, list) and len(coords) >= 2:
            lons.append(float(coords[0]))
            lats.append(float(coords[1]))
        elif gtype == "LineString" and isinstance(coords, list):
            for pt in coords:
                if isinstance(pt, list) and len(pt) >= 2:
                    lons.append(float(pt[0]))
                    lats.append(float(pt[1]))
    if not lons:
        return None
    pad = 0.002
    return {
        "west": min(lons) - pad,
        "south": min(lats) - pad,
        "east": max(lons) + pad,
        "north": max(lats) + pad,
    }


def trace_feeder(
    feeder_id: str | None = None,
    *,
    conn: Any = None,
    focus_mrid: str | None = None,
    max_hops: int = 500,
    show_on_map: bool = False,
    include_geojson: bool = True,
) -> dict[str, Any]:
    """Bounded BFS from nodes matching boundary_feeder_id; optional map GeoJSON."""
    own_conn = conn is None
    try:
        if own_conn:
            import psycopg2

            uri = os.getenv("SUPABASE_DB_URI")
            if not uri:
                return {"error": "SUPABASE_DB_URI not configured"}
            conn = psycopg2.connect(uri)

        resolved_feeder = (feeder_id or "").strip() or None
        if not resolved_feeder and focus_mrid:
            resolved_feeder = _feeder_id_for_mrid(conn, focus_mrid.strip())
        if not resolved_feeder:
            return {
                "error": "feeder_id is required (or provide focus_mrid with a boundary feeder)",
                "feeder_id": feeder_id,
            }

        seeds = _feeder_seeds(conn, resolved_feeder)
        if not seeds:
            return {
                "feeder_id": resolved_feeder,
                "nodes": [],
                "count": 0,
                "reachable_nodes": 0,
                "error": f"No nodes found for feeder {resolved_feeder}",
            }

        visited = _bfs_reachable(seeds, max_hops)
        visited_list = sorted(visited)
        truncated = len(visited) >= TRACE_FEEDER_MAX_NODES

        result: dict[str, Any] = {
            "feeder_id": resolved_feeder,
            "seed_count": len(seeds),
            "reachable_nodes": len(visited),
            "truncated": truncated,
            "sample_nodes": visited_list[:30],
        }

        if include_geojson or show_on_map:
            nodes_geojson = _node_geojson(
                conn,
                visited_list,
                limit=TRACE_FEEDER_MAP_SAMPLE if show_on_map else 120,
            )
            edges_geojson = _edge_geojson(conn, visited)
            bbox = _bbox_from_geojson(nodes_geojson) or _bbox_from_geojson(edges_geojson)
            result["geojson"] = {
                "nodes": nodes_geojson,
                "edges": edges_geojson,
            }
            result["map_node_count"] = len(nodes_geojson.get("features") or [])
            result["map_edge_count"] = len(edges_geojson.get("features") or [])
            if bbox:
                result["bbox"] = bbox

        if show_on_map:
            nodes_fc = result.get("geojson", {}).get("nodes") or {
                "type": "FeatureCollection",
                "features": [],
            }
            edges_fc = result.get("geojson", {}).get("edges") or {
                "type": "FeatureCollection",
                "features": [],
            }
            bbox = result.get("bbox")
            ui: dict[str, Any] = {
                "type": "highlight_feeder",
                "tab": "map",
                "feeder_id": resolved_feeder,
                "label": f"Feeder {resolved_feeder}",
                "geojson": {"nodes": nodes_fc, "edges": edges_fc},
            }
            if bbox:
                ui["bbox"] = bbox
            result["ui_action"] = ui

        return result
    except Exception as exc:
        return {"feeder_id": feeder_id, "error": str(exc)}
    finally:
        if own_conn and conn is not None:
            conn.close()


def trace_connection_path(
    conn,
    *,
    mrid: str | None = None,
    context: dict[str, Any] | None = None,
    show_on_map: bool = True,
) -> dict[str, Any]:
    """Highlight line segments and neighbors directly connected to one node."""
    from agents.portal_context import resolve_node_mrid
    from node_connections import fetch_node_connections

    ctx = dict(context or {})
    if not mrid and ctx.get("last_mrid"):
        mrid = str(ctx["last_mrid"])

    resolved = resolve_node_mrid(conn, ctx, explicit_mrid=(mrid or "").strip() or None)
    if not resolved.get("mrid"):
        return {
            "error": resolved.get("error")
            or "Select a node on the map first, or ask about a node in view.",
            "mrid": None,
        }

    node_mrid = str(resolved["mrid"])
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT io.name, ST_X(cn.geom), ST_Y(cn.geom)
            FROM public.connectivity_nodes cn
            JOIN public.identified_objects io ON io.mrid = cn.mrid
            WHERE cn.mrid::text = %s
            LIMIT 1
            """,
            (node_mrid,),
        )
        center_row = cur.fetchone()

    if not center_row:
        return {"error": f"No connectivity node found for {node_mrid}", "mrid": node_mrid}

    node_name, center_lon, center_lat = center_row
    if center_lon is None or center_lat is None:
        return {"error": f"Node {node_name or node_mrid} has no map location.", "mrid": node_mrid}

    topo = fetch_node_connections(conn, node_mrid, limit=25)
    links = (topo.get("downstream") or []) + (topo.get("upstream") or [])
    if not links:
        return {
            "mrid": node_mrid,
            "name": node_name,
            "degree": 0,
            "error": f"{node_name or 'This node'} has no line connections in the master network.",
        }

    node_features: list[dict[str, Any]] = [
        {
            "type": "Feature",
            "properties": {
                "mrid": node_mrid,
                "name": node_name,
                "focus": True,
            },
            "geometry": {
                "type": "Point",
                "coordinates": [float(center_lon), float(center_lat)],
            },
        }
    ]
    edge_features: list[dict[str, Any]] = []
    neighbor_names: list[str] = []
    seen_neighbors: set[str] = set()

    for link in links:
        neighbor_mrid = str(link.get("neighbor_mrid") or "")
        neighbor_name = str(link.get("neighbor_name") or neighbor_mrid or "neighbor")
        if neighbor_mrid and neighbor_mrid not in seen_neighbors:
            seen_neighbors.add(neighbor_mrid)
            neighbor_names.append(neighbor_name)
            n_lon = link.get("neighbor_lon")
            n_lat = link.get("neighbor_lat")
            if n_lon is not None and n_lat is not None:
                node_features.append(
                    {
                        "type": "Feature",
                        "properties": {
                            "mrid": neighbor_mrid,
                            "name": neighbor_name,
                        },
                        "geometry": {
                            "type": "Point",
                            "coordinates": [float(n_lon), float(n_lat)],
                        },
                    }
                )
        geom = link.get("geom")
        if isinstance(geom, dict) and geom.get("type"):
            edge_features.append(
                {
                    "type": "Feature",
                    "properties": {
                        "mrid": link.get("line_mrid"),
                        "direction": link.get("direction"),
                        "voltage": link.get("voltage"),
                    },
                    "geometry": geom,
                }
            )

    nodes_geojson = {"type": "FeatureCollection", "features": node_features}
    edges_geojson = {"type": "FeatureCollection", "features": edge_features}
    bbox = _bbox_from_geojson(nodes_geojson) or _bbox_from_geojson(edges_geojson)

    result: dict[str, Any] = {
        "mrid": node_mrid,
        "name": node_name,
        "degree": int(topo.get("degree") or len(links)),
        "neighbor_names": neighbor_names,
        "connection_count": len(edge_features),
        "geojson": {"nodes": nodes_geojson, "edges": edges_geojson},
    }
    if bbox:
        result["bbox"] = bbox

    if show_on_map:
        label = node_name or node_mrid
        ui: dict[str, Any] = {
            "type": "highlight_feeder",
            "tab": "map",
            "feeder_id": f"connections:{node_mrid[:8]}",
            "label": f"Connections at {label}",
            "geojson": {"nodes": nodes_geojson, "edges": edges_geojson},
        }
        if bbox:
            ui["bbox"] = bbox
        result["ui_action"] = ui

    return result


def _impact_payload_to_geojson(payload: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any], dict[str, float] | None]:
    """Build map GeoJSON + bbox from topology/impact-style payload (nodes with lat/lon)."""
    node_list = payload.get("nodes") or []
    edge_list = payload.get("edges") or []
    start_mrid = str(payload.get("start_mrid") or "")

    node_features: list[dict[str, Any]] = []
    coord_by_mrid: dict[str, tuple[float, float]] = {}
    for node in node_list:
        if not isinstance(node, dict):
            continue
        mrid = str(node.get("mrid") or "")
        lat = node.get("latitude")
        lon = node.get("longitude")
        if lat is None or lon is None or not mrid:
            continue
        lon_f, lat_f = float(lon), float(lat)
        coord_by_mrid[mrid] = (lon_f, lat_f)
        node_features.append(
            {
                "type": "Feature",
                "properties": {
                    "mrid": mrid,
                    "name": node.get("name") or mrid,
                    "validation": node.get("validation") or "",
                    "focus": mrid == start_mrid,
                    "traced": bool(node.get("traced")),
                },
                "geometry": {"type": "Point", "coordinates": [lon_f, lat_f]},
            }
        )

    edge_features: list[dict[str, Any]] = []
    for edge in edge_list:
        if not isinstance(edge, dict):
            continue
        source = str(edge.get("source") or "")
        target = str(edge.get("target") or "")
        src = coord_by_mrid.get(source)
        tgt = coord_by_mrid.get(target)
        if not src or not tgt:
            continue
        edge_features.append(
            {
                "type": "Feature",
                "properties": {
                    "mrid": edge.get("mrid"),
                    "voltage": edge.get("voltage") or "",
                    "phases": edge.get("phases") or "",
                },
                "geometry": {"type": "LineString", "coordinates": [list(src), list(tgt)]},
            }
        )

    nodes_geojson = {"type": "FeatureCollection", "features": node_features}
    edges_geojson = {"type": "FeatureCollection", "features": edge_features}
    bbox = _bbox_from_geojson(nodes_geojson) or _bbox_from_geojson(edges_geojson)
    return nodes_geojson, edges_geojson, bbox


def trace_downstream_path(
    conn,
    *,
    mrid: str | None = None,
    context: dict[str, Any] | None = None,
    max_nodes: int = 5000,
    show_on_map: bool = True,
) -> dict[str, Any]:
    """Directed downstream walk from a seed node (same logic as GET /topology/impact)."""
    from agents.portal_context import resolve_node_mrid
    from topology_analysis import downstream_impact_payload

    ctx = dict(context or {})
    if not mrid and ctx.get("last_mrid"):
        mrid = str(ctx["last_mrid"])

    resolved = resolve_node_mrid(conn, ctx, explicit_mrid=(mrid or "").strip() or None)
    if not resolved.get("mrid"):
        return {
            "error": resolved.get("error")
            or "Select a node on the map first, or name the asset to trace downstream from.",
            "mrid": None,
        }

    node_mrid = str(resolved["mrid"])
    try:
        cap = max(1, min(int(max_nodes or 5000), 20000))
        payload = downstream_impact_payload(node_mrid, max_nodes=cap)
    except Exception as exc:
        return {"error": str(exc), "mrid": node_mrid}

    nodes = payload.get("nodes") or []
    if not nodes:
        return {
            "error": f"No downstream network found from {node_mrid}",
            "mrid": node_mrid,
            "start_mrid": node_mrid,
        }

    seed_name = next(
        (str(n.get("name") or node_mrid) for n in nodes if isinstance(n, dict) and str(n.get("mrid")) == node_mrid),
        node_mrid,
    )
    metrics = payload.get("metrics") if isinstance(payload.get("metrics"), dict) else {}
    downstream_count = int(metrics.get("downstream_nodes") or max(0, len(nodes) - 1))
    edge_count = int(metrics.get("edge_count") or len(payload.get("edges") or []))
    customers = metrics.get("customers_affected")
    meters = metrics.get("meters_downstream")

    _, _, bbox = _impact_payload_to_geojson(payload)

    result: dict[str, Any] = {
        "start_mrid": node_mrid,
        "name": seed_name,
        "mrid": node_mrid,
        "metrics": metrics,
        "downstream_nodes": downstream_count,
        "edge_count": edge_count,
        "impact": payload,
    }
    if customers is not None:
        result["customers_affected"] = customers
    if meters is not None:
        result["meters_downstream"] = meters
    if bbox:
        result["bbox"] = bbox

    if show_on_map:
        label = seed_name or node_mrid
        ui: dict[str, Any] = {
            "type": "show_downstream_impact",
            "tab": "map",
            "start_mrid": node_mrid,
            "label": f"Downstream from {label}",
            "impact": payload,
        }
        if bbox:
            ui["bbox"] = bbox
        result["ui_action"] = ui

    return result
