"""Fast node adjacency lookup for mobile field map (indexed ac_line_segments)."""

from __future__ import annotations

import json
from collections import defaultdict
from typing import Any


def _parse_geom(geom_json: Any) -> Any:
    if geom_json is None:
        return None
    if isinstance(geom_json, str):
        try:
            return json.loads(geom_json)
        except json.JSONDecodeError:
            return None
    return geom_json


def _connection_dict(
    *,
    line_mrid: str,
    neighbor_mrid: str,
    neighbor_name: str | None,
    voltage: str | None,
    geom_json: Any,
    neighbor_lat: float | None,
    neighbor_lon: float | None,
    direction: str,
) -> dict[str, Any]:
    return {
        "line_mrid": line_mrid,
        "neighbor_mrid": neighbor_mrid,
        "neighbor_name": neighbor_name,
        "voltage": voltage,
        "direction": direction,
        "geom": _parse_geom(geom_json),
        "neighbor_lat": float(neighbor_lat) if neighbor_lat is not None else None,
        "neighbor_lon": float(neighbor_lon) if neighbor_lon is not None else None,
    }


def _empty_topology(mrid: str) -> dict[str, Any]:
    return {"mrid": mrid, "downstream": [], "upstream": [], "degree": 0}


def _row_to_connection(row: tuple[Any, ...], direction: str) -> dict[str, Any]:
    (
        line_mrid,
        neighbor_mrid,
        neighbor_name,
        voltage,
        geom_json,
        neighbor_lat,
        neighbor_lon,
    ) = row
    return _connection_dict(
        line_mrid=line_mrid,
        neighbor_mrid=neighbor_mrid,
        neighbor_name=neighbor_name,
        voltage=voltage,
        geom_json=geom_json,
        neighbor_lat=neighbor_lat,
        neighbor_lon=neighbor_lon,
        direction=direction,
    )


def fetch_node_connections(conn, mrid: str, *, limit: int = 25) -> dict[str, Any]:
    """Indexed single-node lookup — two LIMIT queries, no bulk scan."""
    lim = max(1, min(limit, 100))

    downstream_sql = """
        SELECT
          als.mrid::text,
          als.target_node_id::text,
          io.name,
          ce.nominal_voltage::text,
          ST_AsGeoJSON(als.geom)::text,
          ST_Y(tgt.geom),
          ST_X(tgt.geom)
        FROM public.ac_line_segments als
        JOIN public.connectivity_nodes tgt ON tgt.mrid = als.target_node_id
        JOIN public.identified_objects io ON io.mrid = tgt.mrid
        LEFT JOIN public.conducting_equipment ce ON ce.mrid = als.mrid
        WHERE als.source_node_id = %s::uuid
        LIMIT %s
    """
    upstream_sql = """
        SELECT
          als.mrid::text,
          als.source_node_id::text,
          io.name,
          ce.nominal_voltage::text,
          ST_AsGeoJSON(als.geom)::text,
          ST_Y(src.geom),
          ST_X(src.geom)
        FROM public.ac_line_segments als
        JOIN public.connectivity_nodes src ON src.mrid = als.source_node_id
        JOIN public.identified_objects io ON io.mrid = src.mrid
        LEFT JOIN public.conducting_equipment ce ON ce.mrid = als.mrid
        WHERE als.target_node_id = %s::uuid
        LIMIT %s
    """
    degree_sql = """
        SELECT COUNT(*)::int
        FROM public.ac_line_segments
        WHERE source_node_id = %s::uuid OR target_node_id = %s::uuid
    """

    with conn.cursor() as cur:
        cur.execute(downstream_sql, (mrid, lim))
        downstream = [_row_to_connection(row, "downstream") for row in cur.fetchall()]
        cur.execute(upstream_sql, (mrid, lim))
        upstream = [_row_to_connection(row, "upstream") for row in cur.fetchall()]
        cur.execute(degree_sql, (mrid, mrid))
        degree_row = cur.fetchone()
        degree = int(degree_row[0]) if degree_row else 0

    return {
        "mrid": mrid,
        "downstream": downstream,
        "upstream": upstream,
        "degree": degree,
    }


def fetch_bulk_node_connections(
    conn,
    mrids: list[str],
    *,
    limit_per_node: int = 25,
) -> dict[str, Any]:
    if not mrids:
        return {"connections": {}, "node_count": 0, "edge_count": 0, "truncated": False}

    lim = max(1, min(limit_per_node, 100))
    unique = list(dict.fromkeys(m for m in mrids if m))
    truncated = len(unique) > 1500
    unique = unique[:1500]

    degree_sql = """
        SELECT nid::text, COUNT(*)::int
        FROM (
          SELECT source_node_id AS nid
          FROM public.ac_line_segments
          WHERE source_node_id = ANY(%s::uuid[])
          UNION ALL
          SELECT target_node_id AS nid
          FROM public.ac_line_segments
          WHERE target_node_id = ANY(%s::uuid[])
        ) counts
        GROUP BY nid
    """
    downstream_sql = """
        SELECT
          line_mrid,
          source_mrid,
          target_mrid,
          voltage,
          geom,
          target_name,
          target_lat,
          target_lon
        FROM (
          SELECT
            als.mrid::text AS line_mrid,
            als.source_node_id::text AS source_mrid,
            als.target_node_id::text AS target_mrid,
            ce.nominal_voltage::text AS voltage,
            ST_AsGeoJSON(als.geom)::text AS geom,
            io_tgt.name AS target_name,
            ST_Y(tgt.geom) AS target_lat,
            ST_X(tgt.geom) AS target_lon,
            ROW_NUMBER() OVER (
              PARTITION BY als.source_node_id
              ORDER BY als.mrid
            ) AS rn
          FROM public.ac_line_segments als
          JOIN public.connectivity_nodes tgt ON tgt.mrid = als.target_node_id
          JOIN public.identified_objects io_tgt ON io_tgt.mrid = tgt.mrid
          LEFT JOIN public.conducting_equipment ce ON ce.mrid = als.mrid
          WHERE als.source_node_id = ANY(%s::uuid[])
        ) ranked
        WHERE rn <= %s
    """
    upstream_sql = """
        SELECT
          line_mrid,
          source_mrid,
          target_mrid,
          voltage,
          geom,
          source_name,
          source_lat,
          source_lon
        FROM (
          SELECT
            als.mrid::text AS line_mrid,
            als.source_node_id::text AS source_mrid,
            als.target_node_id::text AS target_mrid,
            ce.nominal_voltage::text AS voltage,
            ST_AsGeoJSON(als.geom)::text AS geom,
            io_src.name AS source_name,
            ST_Y(src.geom) AS source_lat,
            ST_X(src.geom) AS source_lon,
            ROW_NUMBER() OVER (
              PARTITION BY als.target_node_id
              ORDER BY als.mrid
            ) AS rn
          FROM public.ac_line_segments als
          JOIN public.connectivity_nodes src ON src.mrid = als.source_node_id
          JOIN public.identified_objects io_src ON io_src.mrid = src.mrid
          LEFT JOIN public.conducting_equipment ce ON ce.mrid = als.mrid
          WHERE als.target_node_id = ANY(%s::uuid[])
        ) ranked
        WHERE rn <= %s
    """

    downstream: dict[str, list[dict[str, Any]]] = defaultdict(list)
    upstream: dict[str, list[dict[str, Any]]] = defaultdict(list)
    degrees: dict[str, int] = {m: 0 for m in unique}
    edge_count = 0

    with conn.cursor() as cur:
        cur.execute(degree_sql, (unique, unique))
        for node_mrid, count in cur.fetchall():
            if node_mrid in degrees:
                degrees[node_mrid] = int(count)

        cur.execute(downstream_sql, (unique, lim))
        for row in cur.fetchall():
            (
                line_mrid,
                source_mrid,
                target_mrid,
                voltage,
                geom_json,
                target_name,
                target_lat,
                target_lon,
            ) = row
            edge_count += 1
            downstream[source_mrid].append(
                _connection_dict(
                    line_mrid=line_mrid,
                    neighbor_mrid=target_mrid,
                    neighbor_name=target_name,
                    voltage=voltage,
                    geom_json=geom_json,
                    neighbor_lat=target_lat,
                    neighbor_lon=target_lon,
                    direction="downstream",
                )
            )

        cur.execute(upstream_sql, (unique, lim))
        for row in cur.fetchall():
            (
                line_mrid,
                source_mrid,
                target_mrid,
                voltage,
                geom_json,
                source_name,
                source_lat,
                source_lon,
            ) = row
            edge_count += 1
            upstream[target_mrid].append(
                _connection_dict(
                    line_mrid=line_mrid,
                    neighbor_mrid=source_mrid,
                    neighbor_name=source_name,
                    voltage=voltage,
                    geom_json=geom_json,
                    neighbor_lat=source_lat,
                    neighbor_lon=source_lon,
                    direction="upstream",
                )
            )

    connections: dict[str, dict[str, Any]] = {}
    for mrid in unique:
        connections[mrid] = {
            "mrid": mrid,
            "downstream": downstream.get(mrid, []),
            "upstream": upstream.get(mrid, []),
            "degree": degrees.get(mrid, 0),
        }

    return {
        "connections": connections,
        "node_count": len(unique),
        "edge_count": edge_count,
        "truncated": truncated,
    }
