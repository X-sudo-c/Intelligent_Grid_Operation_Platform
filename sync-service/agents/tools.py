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
        cur.execute(
            """
            SELECT e.id::text, e.record_type, e.record_mrid::text, e.rule_code,
                   r.domain, e.severity::text, e.status::text, e.error_message,
                   e.details, e.queue_name,
                   COALESCE(sio.name, pio.name) AS asset_name
            FROM public.data_quality_exceptions e
            JOIN public.data_quality_rules r ON r.rule_code = e.rule_code
            LEFT JOIN staging.identified_objects sio ON sio.mrid = e.record_mrid
            LEFT JOIN public.identified_objects pio ON pio.mrid = e.record_mrid
            WHERE e.id = %s::uuid
            """,
            (exception_id,),
        )
        row = cur.fetchone()
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
