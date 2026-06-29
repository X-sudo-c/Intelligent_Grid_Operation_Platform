"""DB-backed H3 features: node streaming (k-ring), coverage, and cell assignments.

All hexagon math comes from `h3_index` (official bindings). These functions take
an open psycopg2 connection and return plain dicts ready for JSON responses.
"""

from __future__ import annotations

from typing import Any, Iterable

import h3_index as h3x


# --- node streaming -----------------------------------------------------------

def fetch_nodes_in_cells(
    conn,
    *,
    cells: Iterable[str],
    res: int,
    limit: int = 4000,
) -> list[dict[str, Any]]:
    """Return master nodes whose centroid falls in any of `cells`.

    Uses the PostGIS GIST index via a bounding box that covers the cells, then
    filters to exact cell membership in Python and tags each node with its cell.
    Output shape matches `nodes_near_location` so existing clients parse it.
    """
    cell_set = {c for c in cells if c}
    if not cell_set:
        return []

    bbox = h3x.cells_bbox(cell_set)
    if bbox is None:
        return []
    west, south, east, north = bbox

    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT cn.mrid::text,
                   cn.boundary_feeder_id,
                   ST_X(cn.geom) AS lng,
                   ST_Y(cn.geom) AS lat,
                   ST_AsGeoJSON(cn.geom)::json AS geom,
                   io.name,
                   io.validation::text,
                   gga.operating_utility,
                   gga.substation_name,
                   public.node_wire_degree(cn.mrid) AS wire_degree
            FROM public.connectivity_nodes cn
            JOIN public.identified_objects io ON io.mrid = cn.mrid
            LEFT JOIN public.ghana_grid_assets gga ON gga.mrid = cn.mrid
            WHERE cn.geom && ST_MakeEnvelope(%s, %s, %s, %s, 4326)
            ORDER BY cn.mrid
            LIMIT %s
            """,
            (west, south, east, north, max(1, min(limit, 20000))),
        )
        rows = cur.fetchall()

    nodes: list[dict[str, Any]] = []
    for r in rows:
        mrid, feeder, lng, lat, geom, name, validation, ou, ss, wire_degree = r
        if lat is None or lng is None:
            continue
        cell = h3x.latlng_to_cell(lat, lng, res)
        if cell not in cell_set:
            continue
        nodes.append(
            {
                "mrid": mrid,
                "boundary_feeder_id": feeder,
                "geom": geom,
                "wire_degree": int(wire_degree or 0),
                "h3": cell,
                "identified_objects": {
                    "name": name,
                    "validation": validation,
                    "ghana_grid_assets": {
                        "operating_utility": ou,
                        "substation_name": ss,
                    },
                },
            }
        )
    return nodes


def fetch_staging_in_cells(
    conn,
    *,
    cells: Iterable[str],
    res: int,
    limit: int = 2000,
    include_rejected: bool = False,
) -> list[dict[str, Any]]:
    """Staging nodes in the given H3 cells (excludes REJECTED by default)."""
    cell_set = {c for c in cells if c}
    if not cell_set:
        return []

    bbox = h3x.cells_bbox(cell_set)
    if bbox is None:
        return []
    west, south, east, north = bbox

    rejected_clause = "" if include_rejected else "AND io.validation <> 'REJECTED'"
    with conn.cursor() as cur:
        cur.execute(
            f"""
            SELECT cn.mrid::text,
                   io.name,
                   io.validation::text,
                   ST_AsGeoJSON(cn.geom)::json AS geom,
                   cn.boundary_feeder_id,
                   ga.operating_utility::text,
                   ga.substation_name,
                   io.submitted_by,
                   ST_X(cn.geom) AS lng,
                   ST_Y(cn.geom) AS lat
            FROM staging.connectivity_nodes cn
            JOIN staging.identified_objects io ON cn.mrid = io.mrid
            LEFT JOIN staging.ghana_grid_assets ga ON cn.mrid = ga.mrid
            WHERE cn.geom && ST_MakeEnvelope(%s, %s, %s, %s, 4326)
              {rejected_clause}
            ORDER BY io.updated_at DESC
            LIMIT %s
            """,
            (west, south, east, north, max(1, min(limit, 20000))),
        )
        rows = cur.fetchall()

    nodes: list[dict[str, Any]] = []
    for r in rows:
        mrid, name, validation, geom, feeder, ou, ss, submitted_by, lng, lat = r
        if lat is None or lng is None:
            continue
        cell = h3x.latlng_to_cell(lat, lng, res)
        if cell not in cell_set:
            continue
        nodes.append(
            {
                "mrid": mrid,
                "tier": "staging",
                "boundary_feeder_id": feeder,
                "geom": geom,
                "name": name,
                "validation": validation,
                "operating_utility": ou,
                "substation_name": ss,
                "submitted_by": submitted_by,
                "h3": cell,
            }
        )
    return nodes


def fetch_map_nodes_in_cells(
    conn,
    *,
    cells: Iterable[str],
    res: int,
    limit: int = 4000,
    include_staging: bool = True,
) -> list[dict[str, Any]]:
    """Master + optional staging nodes for H3 cell delta refresh."""
    master = fetch_nodes_in_cells(conn, cells=cells, res=res, limit=limit)
    if not include_staging:
        return master
    staging = fetch_staging_in_cells(
        conn, cells=cells, res=res, limit=max(500, limit // 2)
    )
    seen = {n["mrid"] for n in master}
    merged = list(master)
    for row in staging:
        if row["mrid"] in seen:
            continue
        merged.append(row)
    return merged


# --- coverage / rebuild progress ---------------------------------------------

def _aggregate_cells(conn, table: str, bbox, res: int, scan_limit: int) -> dict[str, int]:
    west, south, east, north = bbox
    counts: dict[str, int] = {}
    with conn.cursor() as cur:
        cur.execute(
            f"""
            SELECT ST_Y(geom) AS lat, ST_X(geom) AS lng
            FROM {table}
            WHERE geom && ST_MakeEnvelope(%s, %s, %s, %s, 4326)
            LIMIT %s
            """,
            (west, south, east, north, scan_limit),
        )
        for lat, lng in cur.fetchall():
            if lat is None or lng is None:
                continue
            cell = h3x.latlng_to_cell(lat, lng, res)
            counts[cell] = counts.get(cell, 0) + 1
    return counts


def fetch_coverage(
    conn,
    *,
    west: float,
    south: float,
    east: float,
    north: float,
    res: int,
    scan_limit: int = 50000,
    include_reference: bool = True,
) -> dict[str, Any]:
    """Per-hex rebuild coverage as a GeoJSON FeatureCollection.

    verified_count = promoted public nodes
    staged_count   = field captures awaiting validation
    reference_count = original (inaccurate) GIS import, as a target/yardstick
    """
    bbox = (west, south, east, north)

    verified = _aggregate_cells(conn, "public.connectivity_nodes", bbox, res, scan_limit)
    staged = _aggregate_cells(conn, "staging.connectivity_nodes", bbox, res, scan_limit)
    reference: dict[str, int] = {}
    if include_reference:
        try:
            reference = _aggregate_cells(conn, "gis.asset_id_map", bbox, res, scan_limit)
        except Exception:
            reference = {}

    assignments = _assignment_lookup(conn, res)

    all_cells = set(verified) | set(staged) | set(reference)
    features = []
    for cell in all_cells:
        assignment = assignments.get(cell, {})
        features.append(
            {
                "type": "Feature",
                "geometry": h3x.cell_geojson_polygon(cell),
                "properties": {
                    "h3": cell,
                    "resolution": res,
                    "verified_count": verified.get(cell, 0),
                    "staged_count": staged.get(cell, 0),
                    "reference_count": reference.get(cell, 0),
                    "assigned_to": assignment.get("assigned_to"),
                    "status": assignment.get("status"),
                },
            }
        )

    return {
        "type": "FeatureCollection",
        "resolution": res,
        "features": features,
        "cell_count": len(features),
    }


# --- cell assignments ---------------------------------------------------------

def _assignment_lookup(conn, res: int) -> dict[str, dict[str, Any]]:
    out: dict[str, dict[str, Any]] = {}
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT h3_index, assigned_to, status
                FROM public.h3_cell_assignments
                WHERE resolution = %s
                """,
                (res,),
            )
            for h3_index, assigned_to, status in cur.fetchall():
                out[h3_index] = {"assigned_to": assigned_to, "status": status}
    except Exception:
        # table may not exist yet (migration not applied)
        return {}
    return out


def list_assignments(
    conn,
    *,
    assigned_to: str | None = None,
    status: str | None = None,
) -> list[dict[str, Any]]:
    clauses = []
    params: list[Any] = []
    if assigned_to:
        clauses.append("assigned_to = %s")
        params.append(assigned_to)
    if status:
        clauses.append("status = %s")
        params.append(status)
    where = (" WHERE " + " AND ".join(clauses)) if clauses else ""
    with conn.cursor() as cur:
        cur.execute(
            f"""
            SELECT h3_index, resolution, assigned_to, status, note,
                   assigned_at, updated_at
            FROM public.h3_cell_assignments
            {where}
            ORDER BY updated_at DESC
            LIMIT 1000
            """,
            tuple(params),
        )
        rows = cur.fetchall()
    return [
        {
            "h3_index": r[0],
            "resolution": r[1],
            "assigned_to": r[2],
            "status": r[3],
            "note": r[4],
            "assigned_at": r[5].isoformat() if r[5] else None,
            "updated_at": r[6].isoformat() if r[6] else None,
        }
        for r in rows
    ]


def upsert_assignment(
    conn,
    *,
    h3_index: str,
    resolution: int,
    assigned_to: str | None,
    status: str = "ASSIGNED",
    note: str | None = None,
) -> dict[str, Any]:
    with conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO public.h3_cell_assignments
                (h3_index, resolution, assigned_to, status, note, updated_at)
            VALUES (%s, %s, %s, %s, %s, now())
            ON CONFLICT (h3_index) DO UPDATE SET
                resolution = EXCLUDED.resolution,
                assigned_to = EXCLUDED.assigned_to,
                status = EXCLUDED.status,
                note = COALESCE(EXCLUDED.note, public.h3_cell_assignments.note),
                updated_at = now()
            RETURNING h3_index, resolution, assigned_to, status, note,
                      assigned_at, updated_at
            """,
            (h3_index, resolution, assigned_to, status, note),
        )
        r = cur.fetchone()
    conn.commit()
    return {
        "h3_index": r[0],
        "resolution": r[1],
        "assigned_to": r[2],
        "status": r[3],
        "note": r[4],
        "assigned_at": r[5].isoformat() if r[5] else None,
        "updated_at": r[6].isoformat() if r[6] else None,
    }


def assignments_geojson(
    conn,
    *,
    assigned_to: str | None = None,
    statuses: Iterable[str] | None = None,
) -> dict[str, Any]:
    """Assignment hexagons as a GeoJSON FeatureCollection (one polygon per cell).

    Lets the field app draw a worker's territory without doing H3 math on-device.
    `statuses` filters to the given set (e.g. ASSIGNED + IN_PROGRESS); None = all.
    """
    status_list = [s.strip() for s in (statuses or []) if s and s.strip()]

    clauses: list[str] = []
    params: list[Any] = []
    if assigned_to:
        clauses.append("assigned_to = %s")
        params.append(assigned_to)
    if status_list:
        clauses.append("status = ANY(%s)")
        params.append(status_list)
    where = (" WHERE " + " AND ".join(clauses)) if clauses else ""

    with conn.cursor() as cur:
        cur.execute(
            f"""
            SELECT h3_index, resolution, assigned_to, status, note, updated_at
            FROM public.h3_cell_assignments
            {where}
            ORDER BY updated_at DESC
            LIMIT 2000
            """,
            tuple(params),
        )
        rows = cur.fetchall()

    features: list[dict[str, Any]] = []
    bbox = [None, None, None, None]  # west, south, east, north
    for h3_index, resolution, a_to, status, note, updated_at in rows:
        if not h3x.is_valid_cell(h3_index):
            continue
        geometry = h3x.cell_geojson_polygon(h3_index)
        for lng, lat in geometry.get("coordinates", [[]])[0]:
            bbox[0] = lng if bbox[0] is None else min(bbox[0], lng)
            bbox[1] = lat if bbox[1] is None else min(bbox[1], lat)
            bbox[2] = lng if bbox[2] is None else max(bbox[2], lng)
            bbox[3] = lat if bbox[3] is None else max(bbox[3], lat)
        features.append(
            {
                "type": "Feature",
                "geometry": geometry,
                "properties": {
                    "h3": h3_index,
                    "resolution": resolution,
                    "assigned_to": a_to,
                    "status": status,
                    "note": note,
                    "updated_at": updated_at.isoformat() if updated_at else None,
                },
            }
        )

    return {
        "type": "FeatureCollection",
        "features": features,
        "cell_count": len(features),
        "bbox": bbox if bbox[0] is not None else None,
    }


def cell_at_point(lat: float, lng: float, res: int) -> dict[str, Any]:
    """H3 cell index + GeoJSON polygon for a lat/lng point."""
    cell = h3x.latlng_to_cell(lat, lng, res)
    return {
        "h3": cell,
        "resolution": res,
        "geometry": h3x.cell_geojson_polygon(cell),
    }


def bbox_grid_geojson(
    west: float,
    south: float,
    east: float,
    north: float,
    res: int,
    *,
    max_cells: int = 800,
) -> dict[str, Any]:
    """Hex grid covering a bbox — for portal territory pickers."""
    cells = h3x.bbox_cells(west, south, east, north, res, max_cells=max_cells)
    features = [
        {
            "type": "Feature",
            "geometry": h3x.cell_geojson_polygon(cell),
            "properties": {"h3": cell, "resolution": res},
        }
        for cell in cells
        if h3x.is_valid_cell(cell)
    ]
    return {
        "type": "FeatureCollection",
        "resolution": res,
        "features": features,
        "cell_count": len(features),
        "truncated": len(cells) >= max_cells,
    }


def batch_upsert_assignments(
    conn,
    *,
    h3_indexes: Iterable[str],
    resolution: int,
    assigned_to: str | None,
    status: str = "ASSIGNED",
    note: str | None = None,
) -> list[dict[str, Any]]:
    """Assign many hex cells in one transaction."""
    results: list[dict[str, Any]] = []
    with conn.cursor() as cur:
        for h3_index in h3_indexes:
            if not h3x.is_valid_cell(h3_index):
                continue
            cur.execute(
                """
                INSERT INTO public.h3_cell_assignments
                    (h3_index, resolution, assigned_to, status, note, updated_at)
                VALUES (%s, %s, %s, %s, %s, now())
                ON CONFLICT (h3_index) DO UPDATE SET
                    resolution = EXCLUDED.resolution,
                    assigned_to = EXCLUDED.assigned_to,
                    status = EXCLUDED.status,
                    note = COALESCE(EXCLUDED.note, public.h3_cell_assignments.note),
                    updated_at = now()
                RETURNING h3_index, resolution, assigned_to, status, note,
                          assigned_at, updated_at
                """,
                (h3_index, resolution, assigned_to, status, note),
            )
            r = cur.fetchone()
            if r:
                results.append(
                    {
                        "h3_index": r[0],
                        "resolution": r[1],
                        "assigned_to": r[2],
                        "status": r[3],
                        "note": r[4],
                        "assigned_at": r[5].isoformat() if r[5] else None,
                        "updated_at": r[6].isoformat() if r[6] else None,
                    }
                )
    conn.commit()
    return results


def delete_assignments(conn, h3_indexes: Iterable[str]) -> int:
    """Remove territory assignments for the given cells."""
    cells = [c for c in h3_indexes if c]
    if not cells:
        return 0
    with conn.cursor() as cur:
        cur.execute(
            "DELETE FROM public.h3_cell_assignments WHERE h3_index = ANY(%s)",
            (cells,),
        )
        deleted = cur.rowcount
    conn.commit()
    return deleted
