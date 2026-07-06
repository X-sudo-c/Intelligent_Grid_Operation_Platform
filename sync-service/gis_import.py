"""GIS import helpers — unpromoted conductor segment queue for stewards."""

from __future__ import annotations

import json
import os
from typing import Any

TOPO_ENDPOINT_TOLERANCE_M = float(os.getenv("TOPO_ENDPOINT_TOLERANCE_M", "1.0"))
GIS_IMPORT_SUMMARY_CACHE_TTL_SEC = int(os.getenv("GIS_IMPORT_SUMMARY_CACHE_TTL_SEC", "300"))

UNPROMOTED_REASONS = (
    "missing_endpoints",
    "customer_equipment_originating",
    "customer_equipment_end",
    "unresolved_originating",
    "unresolved_end",
    "same_endpoint",
    "invalid_geom",
    "eligible_unpromoted",
)

CUSTOMER_EQUIPMENT_REASONS = (
    "customer_equipment_originating",
    "customer_equipment_end",
)


def snap_conductor_endpoints(conn, *, tolerance_m: float | None = None) -> dict[str, Any]:
    """Run conservative endpoint snap on gis.conductor_segments."""
    tol = tolerance_m if tolerance_m is not None else TOPO_ENDPOINT_TOLERANCE_M
    with conn.cursor() as cur:
        cur.execute(
            "SELECT gis.snap_eligible_conductor_endpoints(%s)",
            (tol,),
        )
        row = cur.fetchone()
        cur.execute("SELECT gis.refresh_conductor_import_status()")
        refresh = cur.fetchone()
    conn.commit()
    result = row[0] if row else {}
    if refresh and refresh[0]:
        result["import_status"] = refresh[0]
    return result


def refresh_import_status(conn) -> dict[str, Any]:
    with conn.cursor() as cur:
        cur.execute("SELECT gis.refresh_conductor_import_status()")
        row = cur.fetchone()
    conn.commit()
    return row[0] if row else {}


def unpromoted_segments_summary(
    conn,
    *,
    district: str | None = None,
    clip: dict[str, float] | None = None,
) -> dict[str, Any]:
    """Counts of unpromoted gis.conductor_segments grouped by reason."""
    if district is None and clip is None:
        cached = _cached_pipeline_summary(conn)
        if cached is not None:
            return cached

    filters, params = _status_filters(district=district, clip=clip)
    sql = f"""
        SELECT reason, COUNT(*)::bigint AS count
        FROM gis.conductor_import_status s
        WHERE reason <> 'already_promoted'
          {filters}
        GROUP BY 1
        ORDER BY 2 DESC, 1
    """
    with conn.cursor() as cur:
        cur.execute(sql, params)
        rows = cur.fetchall()

    by_reason = {reason: int(count) for reason, count in rows}
    total = sum(by_reason.values())
    customer_equipment = sum(by_reason.get(reason, 0) for reason in CUSTOMER_EQUIPMENT_REASONS)
    return {
        "total_unpromoted": total,
        "actionable_unpromoted": max(0, total - customer_equipment),
        "customer_equipment_unpromoted": customer_equipment,
        "by_reason": by_reason,
        "district": district,
        "clip": clip,
    }


def _cached_pipeline_summary(conn) -> dict[str, Any] | None:
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT refreshed_at, conductor_segments, master_lines, total_unpromoted, by_reason
            FROM gis.import_pipeline_stats
            WHERE id = 1
            """
        )
        row = cur.fetchone()
    if not row:
        return None
    refreshed_at, conductor_segments, master_lines, total_unpromoted, by_reason = row
    if isinstance(by_reason, str):
        by_reason = json.loads(by_reason)
    customer_equipment = sum(
        int(by_reason.get(reason, 0)) for reason in CUSTOMER_EQUIPMENT_REASONS
    )
    total = int(total_unpromoted)
    return {
        "total_unpromoted": total,
        "actionable_unpromoted": max(0, total - customer_equipment),
        "customer_equipment_unpromoted": customer_equipment,
        "by_reason": by_reason or {},
        "district": None,
        "clip": None,
        "refreshed_at": refreshed_at.isoformat() if refreshed_at else None,
        "conductor_segments": int(conductor_segments),
        "master_lines": int(master_lines),
        "pct_promoted": round(100.0 * int(master_lines) / max(int(conductor_segments), 1), 1),
        "source": "cached",
    }


def _cached_unpromoted_total(
    conn,
    *,
    district: str | None = None,
    reason: str | None = None,
    clip: dict[str, float] | None = None,
) -> int | None:
    """Use gis.import_pipeline_stats when filters match the cached rollup."""
    if clip is not None or district is not None:
        return None
    cached = _cached_pipeline_summary(conn)
    if cached is None:
        return None
    if reason is None:
        return int(cached["total_unpromoted"])
    by_reason = cached.get("by_reason") or {}
    return int(by_reason.get(reason, 0))


def list_unpromoted_segments(
    conn,
    *,
    district: str | None = None,
    reason: str | None = None,
    clip: dict[str, float] | None = None,
    limit: int = 50,
    offset: int = 0,
) -> dict[str, Any]:
    """Paginated unpromoted conductor segments with classification reason."""
    if reason is not None and reason not in UNPROMOTED_REASONS:
        raise ValueError(f"reason must be one of {UNPROMOTED_REASONS}")

    filters, params = _status_filters(district=district, clip=clip, table_alias="s")
    reason_filter = ""
    if reason:
        reason_filter = "AND s.reason = %s"
        params.append(reason)

    count_sql = f"""
        SELECT COUNT(*)::bigint
        FROM gis.conductor_import_status s
        WHERE s.reason <> 'already_promoted'
          {filters}
          {reason_filter}
    """

    list_sql = f"""
        SELECT
          s.id,
          s.source_layer,
          s.source_fid,
          s.voltage_class,
          s.circuit_id,
          s.district,
          s.region,
          s.originating_node_id,
          s.end_node_id,
          s.length_m,
          s.longitude,
          s.latitude,
          s.line_mrid,
          s.reason
        FROM gis.conductor_import_status s
        WHERE s.reason <> 'already_promoted'
          {filters}
          {reason_filter}
        ORDER BY s.district NULLS LAST, s.source_layer, s.source_fid
        LIMIT %s OFFSET %s
    """

    cached_total = _cached_unpromoted_total(
        conn, district=district, reason=reason, clip=clip
    )

    with conn.cursor() as cur:
        if cached_total is not None:
            total = cached_total
        else:
            cur.execute(count_sql, params)
            total = int(cur.fetchone()[0])
        cur.execute(list_sql, [*params, limit, offset])
        rows = cur.fetchall()

    segments = [
        {
            "id": row[0],
            "source_layer": row[1],
            "source_fid": row[2],
            "voltage_class": row[3],
            "circuit_id": row[4],
            "district": row[5],
            "region": row[6],
            "originating_node_id": row[7],
            "end_node_id": row[8],
            "length_m": row[9],
            "longitude": row[10],
            "latitude": row[11],
            "line_mrid": row[12],
            "reason": row[13],
        }
        for row in rows
    ]
    return {
        "segments": segments,
        "count": len(segments),
        "total": total,
        "offset": offset,
        "limit": limit,
        "district": district,
        "reason": reason,
        "clip": clip,
    }


def unpromoted_segment_geojson(conn, segment_id: int) -> dict[str, Any]:
    """Line + endpoint markers for map highlight (GIS import queue Show)."""
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT
              cs.id,
              cs.source_layer,
              cs.district,
              cs.originating_node_id,
              cs.end_node_id,
              s.reason,
              ST_AsGeoJSON(ST_Force2D(cs.geom))::json AS line_geom,
              ST_X(COALESCE(src.geom, ST_StartPoint(ST_Force2D(cs.geom)))) AS start_lon,
              ST_Y(COALESCE(src.geom, ST_StartPoint(ST_Force2D(cs.geom)))) AS start_lat,
              ST_X(COALESCE(tgt.geom, ST_EndPoint(ST_Force2D(cs.geom)))) AS end_lon,
              ST_Y(COALESCE(tgt.geom, ST_EndPoint(ST_Force2D(cs.geom)))) AS end_lat,
              (src.mrid IS NOT NULL) AS start_resolved,
              (tgt.mrid IS NOT NULL) AS end_resolved,
              ST_XMin(ST_Envelope(cs.geom)) AS west,
              ST_YMin(ST_Envelope(cs.geom)) AS south,
              ST_XMax(ST_Envelope(cs.geom)) AS east,
              ST_YMax(ST_Envelope(cs.geom)) AS north
            FROM gis.conductor_segments cs
            JOIN gis.conductor_import_status s ON s.id = cs.id
            LEFT JOIN LATERAL gis.resolve_endpoint(cs.district, cs.originating_node_id) src ON true
            LEFT JOIN LATERAL gis.resolve_endpoint(cs.district, cs.end_node_id) tgt ON true
            WHERE cs.id = %s
              AND s.reason <> 'already_promoted'
            """,
            (segment_id,),
        )
        row = cur.fetchone()

    if not row:
        raise ValueError("segment_not_found")

    (
        seg_id,
        source_layer,
        district,
        orig_id,
        end_id,
        reason,
        line_geom,
        start_lon,
        start_lat,
        end_lon,
        end_lat,
        start_resolved,
        end_resolved,
        west,
        south,
        east,
        north,
    ) = row

    line_features: list[dict[str, Any]] = []
    if line_geom and isinstance(line_geom, dict):
        line_features.append(
            {
                "type": "Feature",
                "properties": {
                    "segment_id": seg_id,
                    "source_layer": source_layer,
                    "reason": reason,
                },
                "geometry": line_geom,
            }
        )

    endpoint_features: list[dict[str, Any]] = []
    if start_lon is not None and start_lat is not None:
        endpoint_features.append(
            {
                "type": "Feature",
                "properties": {
                    "role": "start",
                    "node_id": orig_id or "start",
                    "resolved": bool(start_resolved),
                },
                "geometry": {"type": "Point", "coordinates": [start_lon, start_lat]},
            }
        )
    if end_lon is not None and end_lat is not None:
        endpoint_features.append(
            {
                "type": "Feature",
                "properties": {
                    "role": "end",
                    "node_id": end_id or "end",
                    "resolved": bool(end_resolved),
                },
                "geometry": {"type": "Point", "coordinates": [end_lon, end_lat]},
            }
        )

    bbox = None
    if None not in (west, south, east, north):
        bbox = {
            "west": float(west),
            "south": float(south),
            "east": float(east),
            "north": float(north),
        }

    label_parts = [district or source_layer, reason.replace("_", " ")]
    if orig_id or end_id:
        label_parts.append(f"{orig_id or '?'} → {end_id or '?'}")

    return {
        "segment_id": int(seg_id),
        "label": " · ".join(p for p in label_parts if p),
        "geojson": {
            "line": {"type": "FeatureCollection", "features": line_features},
            "endpoints": {"type": "FeatureCollection", "features": endpoint_features},
        },
        "bbox": bbox,
    }


def _status_filters(
    *,
    district: str | None,
    clip: dict[str, float] | None,
    table_alias: str = "s",
) -> tuple[str, list[Any]]:
    clauses: list[str] = []
    params: list[Any] = []
    if district:
        clauses.append(f"AND btrim(lower({table_alias}.district)) = btrim(lower(%s))")
        params.append(district)
    if clip:
        clauses.append(
            f"""
            AND EXISTS (
              SELECT 1
              FROM gis.conductor_segments cs
              WHERE cs.id = {table_alias}.id
                AND cs.geom && ST_MakeEnvelope(%s, %s, %s, %s, 4326)
            )
            """
        )
        params.extend([clip["west"], clip["south"], clip["east"], clip["north"]])
    return "\n".join(clauses), params


def endpoint_diagnostics_summary(
    conn,
    *,
    district: str | None = None,
) -> dict[str, Any]:
    """Endpoint ID class breakdown for unpromoted conductor segments."""
    with conn.cursor() as cur:
        cur.execute(
            "SELECT gis.endpoint_diagnostics_summary(%s)",
            (district,),
        )
        row = cur.fetchone()
    payload = row[0] if row else {}
    if isinstance(payload, str):
        payload = json.loads(payload)
    return payload if isinstance(payload, dict) else {}

