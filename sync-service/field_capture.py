"""Field capture helpers: placement snap, duplicate check, lookups, spans."""

from __future__ import annotations

import os
import secrets
import uuid
from pathlib import Path
from typing import Any, Optional

FIELD_UPLOAD_DIR = Path(os.environ.get("FIELD_UPLOAD_DIR", "uploads/field"))


def ensure_upload_dir() -> Path:
    FIELD_UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    return FIELD_UPLOAD_DIR


def save_field_photo(content: bytes, *, suffix: str = ".jpg") -> str:
    ensure_upload_dir()
    name = f"{uuid.uuid4().hex}{suffix}"
    path = FIELD_UPLOAD_DIR / name
    path.write_bytes(content)
    return f"/api/v1/field/photos/{name}"


def snap_placement_point(
    conn,
    *,
    longitude: float,
    latitude: float,
    snap_m: float = 15.0,
) -> dict[str, Any]:
    with conn.cursor() as cur:
        cur.execute(
            """
            WITH origin AS (
              SELECT ST_SetSRID(ST_MakePoint(%s, %s), 4326) AS geom
            )
            SELECT
              cn.mrid::text,
              io.name,
              'node' AS snap_type,
              ST_Distance(cn.geom::geography, o.geom::geography) AS dist_m,
              ST_X(cn.geom) AS longitude,
              ST_Y(cn.geom) AS latitude
            FROM public.connectivity_nodes cn
            JOIN public.identified_objects io ON io.mrid = cn.mrid
            CROSS JOIN origin o
            WHERE ST_DWithin(cn.geom::geography, o.geom::geography, %s)
            ORDER BY dist_m
            LIMIT 1
            """,
            (longitude, latitude, snap_m),
        )
        row = cur.fetchone()
        if row:
            return {
                "snapped": True,
                "snap_type": row[2],
                "snapped_to_mrid": row[0],
                "snapped_to_name": row[1],
                "distance_m": float(row[3]),
                "longitude": float(row[4]),
                "latitude": float(row[5]),
            }

        cur.execute(
            """
            WITH origin AS (
              SELECT ST_SetSRID(ST_MakePoint(%s, %s), 4326) AS geom
            ),
            hit AS (
              SELECT
                als.mrid::text AS line_mrid,
                ST_Distance(als.geom::geography, o.geom::geography) AS dist_m,
                ST_ClosestPoint(als.geom, o.geom) AS geom
              FROM public.ac_line_segments als
              CROSS JOIN origin o
              WHERE ST_DWithin(als.geom::geography, o.geom::geography, %s)
              ORDER BY dist_m
              LIMIT 1
            )
            SELECT line_mrid, dist_m, ST_X(geom), ST_Y(geom) FROM hit
            """,
            (longitude, latitude, snap_m),
        )
        row = cur.fetchone()
    if not row:
        return {
            "snapped": False,
            "longitude": longitude,
            "latitude": latitude,
        }
    return {
        "snapped": True,
        "snap_type": "line",
        "snapped_to_mrid": row[0],
        "snapped_to_name": f"Line {row[0][:8]}",
        "distance_m": float(row[1]),
        "longitude": float(row[2]),
        "latitude": float(row[3]),
    }


def nearby_assets(
    conn,
    *,
    longitude: float,
    latitude: float,
    radius_m: float = 5.0,
    limit: int = 10,
) -> list[dict[str, Any]]:
    with conn.cursor() as cur:
        cur.execute(
            """
            WITH origin AS (
              SELECT ST_SetSRID(ST_MakePoint(%s, %s), 4326) AS geom
            ),
            hits AS (
              SELECT
                cn.mrid::text,
                io.name,
                'master' AS tier,
                COALESCE(public.asset_kind_for_mrid(cn.mrid), 'connectivity_node') AS asset_kind,
                ST_Distance(cn.geom::geography, o.geom::geography) AS dist_m
              FROM public.connectivity_nodes cn
              JOIN public.identified_objects io ON io.mrid = cn.mrid
              CROSS JOIN origin o
              WHERE ST_DWithin(cn.geom::geography, o.geom::geography, %s)
              UNION ALL
              SELECT
                cn.mrid::text,
                io.name,
                'staging' AS tier,
                COALESCE(ga.asset_kind, 'connectivity_node'),
                ST_Distance(cn.geom::geography, o.geom::geography)
              FROM staging.connectivity_nodes cn
              JOIN staging.identified_objects io ON io.mrid = cn.mrid
              LEFT JOIN staging.ghana_grid_assets ga ON ga.mrid = cn.mrid
              CROSS JOIN origin o
              WHERE ST_DWithin(cn.geom::geography, o.geom::geography, %s)
            )
            SELECT mrid, name, tier, asset_kind, dist_m
            FROM hits
            ORDER BY dist_m
            LIMIT %s
            """,
            (longitude, latitude, radius_m, radius_m, limit),
        )
        rows = cur.fetchall()
    return [
        {
            "mrid": r[0],
            "name": r[1],
            "tier": r[2],
            "asset_kind": r[3],
            "distance_m": float(r[4]),
        }
        for r in rows
    ]


def distinct_feeders(conn, *, q: str | None = None, limit: int = 50) -> list[str]:
    pattern = f"%{q.strip()}%" if q and q.strip() else None
    with conn.cursor() as cur:
        if pattern:
            cur.execute(
                """
                SELECT DISTINCT boundary_feeder_id
                FROM (
                  SELECT boundary_feeder_id FROM public.connectivity_nodes
                  UNION ALL
                  SELECT boundary_feeder_id FROM staging.connectivity_nodes
                ) f
                WHERE boundary_feeder_id IS NOT NULL
                  AND boundary_feeder_id ILIKE %s
                ORDER BY 1
                LIMIT %s
                """,
                (pattern, limit),
            )
        else:
            cur.execute(
                """
                SELECT DISTINCT boundary_feeder_id
                FROM (
                  SELECT boundary_feeder_id FROM public.connectivity_nodes
                  UNION ALL
                  SELECT boundary_feeder_id FROM staging.connectivity_nodes
                ) f
                WHERE boundary_feeder_id IS NOT NULL
                ORDER BY 1
                LIMIT %s
                """,
                (limit,),
            )
        rows = cur.fetchall()
    return [r[0] for r in rows if r[0]]


def distinct_substations(conn, *, q: str | None = None, limit: int = 50) -> list[str]:
    pattern = f"%{q.strip()}%" if q and q.strip() else None
    with conn.cursor() as cur:
        if pattern:
            cur.execute(
                """
                SELECT DISTINCT substation_name
                FROM (
                  SELECT substation_name FROM public.ghana_grid_assets
                  UNION ALL
                  SELECT substation_name FROM staging.ghana_grid_assets
                ) s
                WHERE substation_name IS NOT NULL
                  AND substation_name ILIKE %s
                ORDER BY 1
                LIMIT %s
                """,
                (pattern, limit),
            )
        else:
            cur.execute(
                """
                SELECT DISTINCT substation_name
                FROM (
                  SELECT substation_name FROM public.ghana_grid_assets
                  UNION ALL
                  SELECT substation_name FROM staging.ghana_grid_assets
                ) s
                WHERE substation_name IS NOT NULL
                ORDER BY 1
                LIMIT %s
                """,
                (limit,),
            )
        rows = cur.fetchall()
    return [r[0] for r in rows if r[0]]


def technician_hex_allowed(
    conn,
    *,
    technician_id: str,
    h3_index: str,
) -> bool:
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT 1
            FROM public.h3_cell_assignments
            WHERE assigned_to = %s
              AND h3_index = %s
              AND status IN ('ASSIGNED', 'IN_PROGRESS')
            LIMIT 1
            """,
            (technician_id, h3_index),
        )
        return cur.fetchone() is not None


def list_staging_spans(conn, *, submitted_by: str | None = None) -> list[dict[str, Any]]:
    filters = []
    params: list[Any] = []
    if submitted_by:
        filters.append("io.submitted_by = %s")
        params.append(submitted_by)
    where = f"WHERE {' AND '.join(filters)}" if filters else ""
    with conn.cursor() as cur:
        cur.execute(
            f"""
            SELECT
              ls.mrid::text,
              io.name,
              io.validation::text,
              ls.source_node_id::text,
              ls.target_node_id::text,
              ls.boundary_feeder_id,
              ST_AsGeoJSON(ls.geom)::json,
              io.submitted_by
            FROM staging.ac_line_segments ls
            JOIN staging.identified_objects io ON io.mrid = ls.mrid
            {where}
            ORDER BY io.updated_at DESC
            """,
            params,
        )
        rows = cur.fetchall()
    return [
        {
            "mrid": r[0],
            "name": r[1],
            "validation": r[2],
            "source_node_id": r[3],
            "target_node_id": r[4],
            "boundary_feeder_id": r[5],
            "geom": r[6],
            "submitted_by": r[7],
            "tier": "staging",
        }
        for r in rows
    ]


def submit_field_span(
    conn,
    *,
    source_node_id: str,
    target_node_id: str,
    operator_id: str | None,
    boundary_feeder_id: str | None = None,
    work_order_id: str | None = None,
    name: str | None = None,
) -> dict[str, Any]:
    if source_node_id == target_node_id:
        raise ValueError("Source and target must differ")

    suffix = secrets.token_hex(4)
    mrid = f"c0000000-0000-0000-0000-{suffix}"
    span_name = name or f"Span {source_node_id[:8]}→{target_node_id[:8]}"

    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT cn.mrid, cn.geom, cn.boundary_feeder_id
            FROM staging.connectivity_nodes cn
            WHERE cn.mrid IN (%s::uuid, %s::uuid)
            """,
            (source_node_id, target_node_id),
        )
        nodes = {str(r[0]): (r[1], r[2]) for r in cur.fetchall()}
        if len(nodes) < 2:
            cur.execute(
                """
                SELECT cn.mrid, cn.geom, cn.boundary_feeder_id
                FROM public.connectivity_nodes cn
                WHERE cn.mrid IN (%s::uuid, %s::uuid)
                """,
                (source_node_id, target_node_id),
            )
            for r in cur.fetchall():
                nodes[str(r[0])] = (r[1], r[2])
        if source_node_id not in nodes or target_node_id not in nodes:
            raise ValueError("Both nodes must exist in staging or master")

        src_geom = nodes[source_node_id][0]
        tgt_geom = nodes[target_node_id][0]
        feeder = boundary_feeder_id or nodes[source_node_id][1] or nodes[target_node_id][1]

        cur.execute(
            """
            INSERT INTO staging.identified_objects (
              mrid, name, lifecycle_state, validation, submitted_by, work_order_id
            )
            VALUES (%s::uuid, %s, 'IN_SERVICE', 'PENDING_FIELD', %s, %s)
            """,
            (mrid, span_name, operator_id, work_order_id),
        )
        cur.execute(
            """
            INSERT INTO staging.ac_line_segments (
              mrid, source_node_id, target_node_id, boundary_feeder_id, geom
            )
            VALUES (
              %s::uuid, %s::uuid, %s::uuid, %s,
              ST_MakeLine(%s, %s)
            )
            """,
            (mrid, source_node_id, target_node_id, feeder, src_geom, tgt_geom),
        )
    return {
        "mrid": mrid,
        "name": span_name,
        "source_node_id": source_node_id,
        "target_node_id": target_node_id,
        "boundary_feeder_id": feeder,
        "validation": "PENDING_FIELD",
        "tier": "staging",
    }
