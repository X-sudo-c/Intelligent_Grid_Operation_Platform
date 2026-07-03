"""Deterministic tool wrappers for agent execution."""

from __future__ import annotations

from typing import Any

from data_quality import (
    list_exceptions,
    list_rules,
    resolve_exception,
    run_asset_checks,
    run_batch_validation,
    summary,
)
from topology_analysis import topology_health_report
from topology_dq import (
    create_topology_batch_run,
    execute_topology_batch_scan,
    topology_dq_summary,
)
from agents import staging_review


def tool_run_asset_checks(conn, mrid: str, tier: str = "master") -> dict[str, Any]:
    return run_asset_checks(conn, mrid, tier)


def tool_inspect_node(
    conn,
    mrid: str | None = None,
    *,
    context: dict[str, Any] | None = None,
    tier: str = "master",
    show_on_map: bool = False,
) -> dict[str, Any]:
    """Describe a single connectivity node: name, state, location, feeder, and connections.

    When mrid is omitted, resolves from portal context: selected asset first, then the
    node nearest the map center in the current viewport.
    """
    from agents.portal_context import resolve_node_mrid

    resolved = resolve_node_mrid(
        conn,
        context or {},
        explicit_mrid=(mrid or "").strip() or None,
        tier=tier,
    )
    if not resolved.get("mrid"):
        return resolved

    mrid = str(resolved["mrid"])
    schema = "staging" if (tier or "master").strip().lower() == "staging" else "public"

    def _fetch_node_row(target_mrid: str):
        with conn.cursor() as cur:
            cur.execute(
                f"""
                SELECT io.name,
                       io.lifecycle_state::text,
                       io.validation::text,
                       cn.boundary_feeder_id,
                       ST_X(cn.geom) AS lon,
                       ST_Y(cn.geom) AS lat
                FROM {schema}.connectivity_nodes cn
                JOIN {schema}.identified_objects io ON io.mrid = cn.mrid
                WHERE cn.mrid::text = %s
                LIMIT 1
                """,
                (target_mrid,),
            )
            return cur.fetchone()

    row = _fetch_node_row(mrid)

    if not row and resolved.get("source") in {"selection", "explicit"}:
        # If focused asset is not itself a connectivity node, fall back to node-in-view.
        fallback = resolve_node_mrid(conn, context or {}, explicit_mrid=None, tier=tier)
        fallback_mrid = str(fallback.get("mrid") or "").strip()
        if fallback_mrid:
            fallback_row = _fetch_node_row(fallback_mrid)
            if fallback_row:
                mrid = fallback_mrid
                resolved = fallback
                row = fallback_row

    if not row:
        return {
            "error": f"No connectivity node found for mrid {mrid} in {schema}",
            "mrid": mrid,
            "tier": schema,
        }

    name, lifecycle_state, validation, feeder_id, lon, lat = row

    result: dict[str, Any] = {
        "mrid": mrid,
        "tier": schema,
        "name": name,
        "lifecycle_state": lifecycle_state,
        "validation": validation,
        "boundary_feeder_id": feeder_id,
        "location": None,
        "resolved_from": resolved.get("source"),
    }
    if resolved.get("distance_m") is not None:
        result["distance_from_center_m"] = resolved["distance_m"]

    if lon is not None and lat is not None:
        result["location"] = {"lon": float(lon), "lat": float(lat)}

        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT district, region
                FROM gis.ecg_admin_boundaries
                WHERE ST_Contains(geom, ST_SetSRID(ST_MakePoint(%s, %s), 4326))
                LIMIT 1
                """,
                (float(lon), float(lat)),
            )
            terr = cur.fetchone()
        if terr:
            result["district"] = terr[0]
            result["region"] = terr[1]

    with conn.cursor() as cur:
        cur.execute(
            f"""
            SELECT ls.mrid::text AS segment_mrid,
                   CASE WHEN ls.source_node_id = %s::uuid
                        THEN ls.target_node_id::text
                        ELSE ls.source_node_id::text END AS neighbor_mrid,
                   nio.name AS neighbor_name,
                   ls.direction_downstream,
                   (ls.source_node_id = %s::uuid) AS outgoing
            FROM {schema}.ac_line_segments ls
            LEFT JOIN {schema}.identified_objects nio
              ON nio.mrid = CASE WHEN ls.source_node_id = %s::uuid
                                 THEN ls.target_node_id
                                 ELSE ls.source_node_id END
            WHERE ls.source_node_id = %s::uuid OR ls.target_node_id = %s::uuid
            ORDER BY ls.mrid
            LIMIT 50
            """,
            (mrid, mrid, mrid, mrid, mrid),
        )
        edge_rows = cur.fetchall()

    connections = [
        {
            "segment_mrid": seg,
            "neighbor_mrid": neighbor,
            "neighbor_name": neighbor_name,
            "direction": "downstream" if outgoing and downstream else "upstream",
        }
        for seg, neighbor, neighbor_name, downstream, outgoing in edge_rows
    ]

    result["degree"] = len(connections)
    result["connections"] = connections
    if not connections:
        result["note"] = "This node is isolated — no line segments connect to it."

    result["certain"] = bool(resolved.get("certain", True))
    result["confirmation_needed"] = bool(resolved.get("confirmation_needed", False))
    if resolved.get("alternates"):
        result["alternates"] = resolved["alternates"]

    loc = result.get("location")
    if loc:
        if result["confirmation_needed"]:
            result["ui_action"] = {
                "type": "highlight_node",
                "tab": "map",
                "mrid": mrid,
                "label": name,
                "center": loc,
                "zoom": 17,
                "tentative": True,
            }
        elif show_on_map:
            result["ui_action"] = {
                "type": "fly_to",
                "tab": "map",
                "center": loc,
                "zoom": 17,
            }

    return result


def tool_list_work_orders_in_view(
    conn,
    *,
    west: float,
    south: float,
    east: float,
    north: float,
    status: str | None = None,
    open_only: bool = True,
    limit: int = 50,
) -> dict[str, Any]:
    from work_orders import list_work_orders_in_bbox

    return list_work_orders_in_bbox(
        conn,
        west=west,
        south=south,
        east=east,
        north=north,
        status=status,
        open_only=open_only,
        limit=limit,
    )


def tool_list_exceptions(
    conn,
    *,
    status: str = "OPEN",
    severity: str | None = None,
    domain: str | None = None,
    limit: int = 100,
) -> list[dict[str, Any]]:
    return list_exceptions(conn, status=status, severity=severity, domain=domain, limit=limit)


def tool_list_rules(conn) -> list[dict[str, Any]]:
    return list_rules(conn)


def tool_dq_summary(conn) -> dict[str, Any]:
    return summary(conn)


def tool_topology_health() -> dict[str, Any]:
    return topology_health_report()


def tool_topology_dq_summary(conn, clip: dict[str, float] | None = None) -> dict[str, Any]:
    return topology_dq_summary(conn, clip=clip)


def tool_topology_batch_scan(
    conn,
    *,
    clip: dict[str, float] | None = None,
    requested_by: str | None = None,
) -> dict[str, Any]:
    run_id = create_topology_batch_run(conn, clip=clip, requested_by=requested_by)
    return execute_topology_batch_scan(conn, run_id, clip=clip, requested_by=requested_by)


def tool_resolve_exception(
    conn,
    exception_id: str,
    *,
    status: str,
    note: str | None = None,
    operator: str | None = None,
) -> dict[str, Any]:
    return resolve_exception(conn, exception_id, status=status, note=note, operator=operator)


def tool_repair_topology(
    conn,
    target_mrid: str,
    *,
    radius_meters: float = 50,
    dry_run: bool = True,
) -> dict[str, Any]:
    with conn.cursor() as cur:
        cur.execute(
            "SELECT public.repair_asset_topology_and_attributes(%s::uuid, %s, %s)",
            (target_mrid, radius_meters, dry_run),
        )
        result = cur.fetchone()[0]
    if isinstance(result, dict):
        return result
    return {"result": result}


def tool_run_batch_validation(conn) -> dict[str, Any]:
    return run_batch_validation(conn)


def tool_staging_summary(conn) -> dict[str, Any]:
    return staging_review.staging_summary(conn)


def tool_staging_territory_totals(
    conn,
    *,
    group_by: str = "district",
    region: str | None = None,
    limit: int = 50,
) -> list[dict[str, Any]]:
    return staging_review.staging_territory_totals(
        conn, group_by=group_by, region=region, limit=limit
    )


def tool_list_staging_queue(
    conn,
    *,
    validation: str | None = None,
    region: str | None = None,
    district: str | None = None,
    submitted_by: str | None = None,
    limit: int = 50,
) -> list[dict[str, Any]]:
    return staging_review.list_staging_queue(
        conn,
        validation=validation,
        region=region,
        district=district,
        submitted_by=submitted_by,
        limit=limit,
    )


def tool_review_staging_asset(conn, mrid: str) -> dict[str, Any]:
    return staging_review.review_staging_asset(conn, mrid)


def tool_get_exception(conn, exception_id: str) -> dict[str, Any] | None:
    items = list_exceptions(conn, status=None, limit=500)
    for item in items:
        if item["id"] == exception_id:
            return item
    with conn.cursor() as cur:
        row = None
        for table in ("staging.data_quality_exceptions", "public.data_quality_exceptions"):
            cur.execute(
                f"""
                SELECT e.id::text, e.record_type, e.record_mrid::text, e.rule_code,
                       r.domain, e.severity::text, e.status::text, e.error_message,
                       e.details, e.queue_name,
                       COALESCE(sio.name, pio.name) AS asset_name
                FROM {table} e
                JOIN public.data_quality_rules r ON r.rule_code = e.rule_code
                LEFT JOIN staging.identified_objects sio ON sio.mrid = e.record_mrid
                LEFT JOIN public.identified_objects pio ON pio.mrid = e.record_mrid
                WHERE e.id = %s::uuid
                """,
                (exception_id,),
            )
            row = cur.fetchone()
            if row:
                break
    if not row:
        return None
    return {
        "id": row[0],
        "record_type": row[1],
        "record_mrid": row[2],
        "rule_code": row[3],
        "domain": row[4],
        "severity": row[5],
        "status": row[6],
        "error_message": row[7],
        "details": row[8],
        "queue_name": row[9],
        "asset_name": row[10],
    }
