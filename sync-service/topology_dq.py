"""Master topology DQ at scale — set-based orphan & dangling line scans."""

from __future__ import annotations

import json
from typing import Any

from lineage import log_lineage

# Open topology exceptions above this count in an export clip block the export job.
EXPORT_TOPOLOGY_EXCEPTION_CAP = 500
# Orphan ratio in clip above this fraction triggers export block (when orphans > cap).
EXPORT_ORPHAN_RATIO_CAP = 0.15


def _bbox_clause(alias: str, clip: dict[str, float] | None) -> tuple[str, list[Any]]:
    if not clip:
        return "", []
    return (
        f" AND {alias}.geom && ST_MakeEnvelope(%s, %s, %s, %s, 4326)",
        [clip["west"], clip["south"], clip["east"], clip["north"]],
    )


def live_topology_counts(conn, *, clip: dict[str, float] | None = None) -> dict[str, int]:
    """Live counts from master tables (not exception queue)."""
    node_bbox, node_params = _bbox_clause("cn", clip)
    line_bbox, line_params = _bbox_clause("als", clip)

    with conn.cursor() as cur:
        cur.execute(
            f"""
            SELECT COUNT(*)
            FROM public.connectivity_nodes cn
            JOIN public.identified_objects io ON io.mrid = cn.mrid
            WHERE io.validation = 'APPROVED'
            {node_bbox}
            """,
            node_params,
        )
        approved_nodes = int(cur.fetchone()[0])

        cur.execute(
            f"""
            SELECT COUNT(*)
            FROM public.connectivity_nodes cn
            JOIN public.identified_objects io ON io.mrid = cn.mrid
            WHERE io.validation = 'APPROVED'
            {node_bbox}
              AND NOT EXISTS (
                SELECT 1 FROM public.ac_line_segments als
                WHERE als.source_node_id = cn.mrid OR als.target_node_id = cn.mrid
              )
            """,
            node_params,
        )
        orphan_nodes = int(cur.fetchone()[0])

        cur.execute(
            f"""
            SELECT COUNT(*)
            FROM public.ac_line_segments als
            JOIN public.identified_objects io ON io.mrid = als.mrid
            WHERE io.validation = 'APPROVED'
            {line_bbox}
              AND (
                NOT EXISTS (
                  SELECT 1 FROM public.connectivity_nodes cn
                  WHERE cn.mrid = als.source_node_id
                )
                OR NOT EXISTS (
                  SELECT 1 FROM public.connectivity_nodes cn
                  WHERE cn.mrid = als.target_node_id
                )
              )
            """,
            line_params,
        )
        dangling_lines = int(cur.fetchone()[0])

        cur.execute(
            f"""
            SELECT COUNT(*)
            FROM public.ac_line_segments als
            JOIN public.identified_objects io ON io.mrid = als.mrid
            WHERE io.validation = 'APPROVED'
            {line_bbox}
              AND (
                NOT EXISTS (
                  SELECT 1 FROM public.connectivity_nodes cn
                  JOIN public.identified_objects nio ON nio.mrid = cn.mrid
                  WHERE cn.mrid = als.source_node_id AND nio.validation = 'APPROVED'
                )
                OR NOT EXISTS (
                  SELECT 1 FROM public.connectivity_nodes cn
                  JOIN public.identified_objects nio ON nio.mrid = cn.mrid
                  WHERE cn.mrid = als.target_node_id AND nio.validation = 'APPROVED'
                )
              )
            """,
            line_params,
        )
        bad_endpoints = int(cur.fetchone()[0])

    orphan_ratio = round(orphan_nodes / approved_nodes, 6) if approved_nodes else 0.0
    return {
        "approved_nodes": approved_nodes,
        "orphan_nodes": orphan_nodes,
        "orphan_ratio": orphan_ratio,
        "dangling_lines": dangling_lines,
        "lines_with_unapproved_endpoints": bad_endpoints,
    }


def _open_topology_exception_counts(conn, *, clip: dict[str, float] | None = None) -> dict[str, int]:
    node_bbox, node_params = _bbox_clause("cn", clip)
    line_bbox, line_params = _bbox_clause("als", clip)

    with conn.cursor() as cur:
        cur.execute(
            f"""
            SELECT e.rule_code, COUNT(*)
            FROM public.data_quality_exceptions e
            JOIN public.data_quality_rules r ON r.rule_code = e.rule_code
            JOIN public.connectivity_nodes cn ON cn.mrid = e.record_mrid
            WHERE e.status = 'OPEN' AND r.domain = 'topology'
              AND e.record_type = 'connectivity_node'
            {node_bbox}
            GROUP BY e.rule_code
            """,
            node_params,
        )
        node_counts = {r[0]: int(r[1]) for r in cur.fetchall()}

        cur.execute(
            f"""
            SELECT e.rule_code, COUNT(*)
            FROM public.data_quality_exceptions e
            JOIN public.data_quality_rules r ON r.rule_code = e.rule_code
            JOIN public.ac_line_segments als ON als.mrid = e.record_mrid
            WHERE e.status = 'OPEN' AND r.domain = 'topology'
              AND e.record_type = 'ac_line_segments'
            {line_bbox}
            GROUP BY e.rule_code
            """,
            line_params,
        )
        line_counts = {r[0]: int(r[1]) for r in cur.fetchall()}

    merged: dict[str, int] = {}
    for d in (node_counts, line_counts):
        for k, v in d.items():
            merged[k] = merged.get(k, 0) + v
    merged["open_topology_total"] = sum(merged.values())
    return merged


def topology_dq_summary(conn, *, clip: dict[str, float] | None = None) -> dict[str, Any]:
    """Compute the LIVE topology summary (expensive at national scale).

    The expensive live/queue counts are computed once and reused for the export
    gate (previously this scanned the master tables twice). For interactive
    reads prefer ``latest_topology_snapshot()``, which serves the last scan.
    """
    live = live_topology_counts(conn, clip=clip)
    queue = _open_topology_exception_counts(conn, clip=clip)
    summary = {
        "live": live,
        "exception_queue": queue,
        "export_blocked": export_topology_blocked(conn, clip=clip, live=live, queue=queue),
    }
    summary["source"] = "live"
    return summary


def latest_topology_snapshot(conn) -> dict[str, Any] | None:
    """Cheap indexed read of the most recent completed scan's summary snapshot.

    Returns the stored ``{live, exception_queue, export_blocked}`` payload
    annotated with ``source='snapshot'``, ``scanned_at`` and ``run_id`` so the
    UI can show "as of <time>". Returns None when no completed scan exists yet.
    """
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT id::text, completed_at, summary_snapshot
            FROM public.data_quality_batch_runs
            WHERE status = 'completed'
              AND scan_type = 'topology_master'
              AND summary_snapshot IS NOT NULL
            ORDER BY completed_at DESC
            LIMIT 1
            """
        )
        row = cur.fetchone()

    if not row:
        return None

    run_id, completed_at, snapshot = row
    if not isinstance(snapshot, dict):
        return None

    result = dict(snapshot)
    result["source"] = "snapshot"
    result["scanned_at"] = completed_at.isoformat() if completed_at else None
    result["run_id"] = run_id
    return result


def export_topology_blocked(
    conn,
    *,
    clip: dict[str, float] | None,
    live: dict[str, int] | None = None,
    queue: dict[str, int] | None = None,
) -> dict[str, Any]:
    """Whether an export in this clip should be blocked by topology DQ.

    Pass precomputed ``live``/``queue`` counts to avoid re-scanning the master
    tables when the caller already has them.
    """
    if live is None:
        live = live_topology_counts(conn, clip=clip)
    if queue is None:
        queue = _open_topology_exception_counts(conn, clip=clip)
    reasons: list[str] = []

    if live["dangling_lines"] > 0:
        reasons.append(
            f"{live['dangling_lines']} dangling line(s) in scope (missing endpoint node)"
        )
    open_total = queue.get("open_topology_total", 0)
    if open_total > EXPORT_TOPOLOGY_EXCEPTION_CAP:
        reasons.append(
            f"{open_total} open topology exceptions in scope (cap {EXPORT_TOPOLOGY_EXCEPTION_CAP})"
        )
    if live["approved_nodes"] > 0 and live["orphan_ratio"] > EXPORT_ORPHAN_RATIO_CAP:
        reasons.append(
            f"orphan ratio {live['orphan_ratio']:.1%} exceeds {EXPORT_ORPHAN_RATIO_CAP:.0%} cap"
        )

    return {
        "blocked": bool(reasons),
        "reasons": reasons,
        "caps": {
            "open_topology_exceptions": EXPORT_TOPOLOGY_EXCEPTION_CAP,
            "orphan_ratio": EXPORT_ORPHAN_RATIO_CAP,
        },
    }


def validate_export_topology(conn, clip: dict[str, float] | None) -> None:
    gate = export_topology_blocked(conn, clip=clip)
    if gate["blocked"]:
        raise ValueError(
            "Export blocked by master topology DQ: " + "; ".join(gate["reasons"])
        )


def _auto_clear_orphans(conn, *, clip: dict[str, float] | None) -> int:
    node_bbox, node_params = _bbox_clause("cn", clip)
    with conn.cursor() as cur:
        cur.execute(
            f"""
            UPDATE public.data_quality_exceptions e
            SET status = 'RESOLVED',
                resolved_at = NOW(),
                resolved_by = 'topology_scan',
                resolution_note = 'Auto-cleared: node now has connected line segment'
            FROM public.connectivity_nodes cn
            WHERE e.rule_code = 'ASSET_ORPHAN_NODE'
              AND e.status = 'OPEN'
              AND e.record_mrid = cn.mrid
              {node_bbox}
              AND EXISTS (
                SELECT 1 FROM public.ac_line_segments als
                WHERE als.source_node_id = cn.mrid OR als.target_node_id = cn.mrid
              )
            """,
            node_params,
        )
        cleared = cur.rowcount
    return cleared


def _auto_clear_dangling(conn, *, clip: dict[str, float] | None) -> int:
    line_bbox, line_params = _bbox_clause("als", clip)
    with conn.cursor() as cur:
        cur.execute(
            f"""
            UPDATE public.data_quality_exceptions e
            SET status = 'RESOLVED',
                resolved_at = NOW(),
                resolved_by = 'topology_scan',
                resolution_note = 'Auto-cleared: line endpoints now valid'
            FROM public.ac_line_segments als
            WHERE e.rule_code IN (
                    'TOPO_DANGLING_LINE_ENDPOINT',
                    'TOPO_LINE_ENDPOINT_NOT_APPROVED'
                  )
              AND e.status = 'OPEN'
              AND e.record_mrid = als.mrid
              {line_bbox}
              AND EXISTS (
                SELECT 1 FROM public.connectivity_nodes s
                WHERE s.mrid = als.source_node_id
              )
              AND EXISTS (
                SELECT 1 FROM public.connectivity_nodes t
                WHERE t.mrid = als.target_node_id
              )
              AND EXISTS (
                SELECT 1 FROM public.identified_objects sio
                WHERE sio.mrid = als.source_node_id AND sio.validation = 'APPROVED'
              )
              AND EXISTS (
                SELECT 1 FROM public.identified_objects tio
                WHERE tio.mrid = als.target_node_id AND tio.validation = 'APPROVED'
              )
            """,
            line_params,
        )
        return cur.rowcount


def _bulk_upsert_orphans(conn, *, clip: dict[str, float] | None) -> tuple[int, int]:
    node_bbox, node_params = _bbox_clause("cn", clip)
    with conn.cursor() as cur:
        cur.execute(
            f"""
            SELECT COUNT(*)
            FROM public.connectivity_nodes cn
            JOIN public.identified_objects io ON io.mrid = cn.mrid
            WHERE io.validation = 'APPROVED'
            {node_bbox}
              AND NOT EXISTS (
                SELECT 1 FROM public.ac_line_segments als
                WHERE als.source_node_id = cn.mrid OR als.target_node_id = cn.mrid
              )
            """,
            node_params,
        )
        found = int(cur.fetchone()[0])

        cur.execute(
            f"""
            INSERT INTO public.data_quality_exceptions (
              record_type, record_mrid, rule_code, severity, error_message, details
            )
            SELECT
              'connectivity_node',
              cn.mrid,
              'ASSET_ORPHAN_NODE',
              r.severity,
              'Master node has no connected line segment.',
              jsonb_build_object('line_count', 0)
            FROM public.connectivity_nodes cn
            JOIN public.identified_objects io ON io.mrid = cn.mrid
            JOIN public.data_quality_rules r ON r.rule_code = 'ASSET_ORPHAN_NODE'
            WHERE io.validation = 'APPROVED'
              AND r.enabled = TRUE
            {node_bbox}
              AND NOT EXISTS (
                SELECT 1 FROM public.ac_line_segments als
                WHERE als.source_node_id = cn.mrid OR als.target_node_id = cn.mrid
              )
            ON CONFLICT (record_mrid, rule_code) WHERE status = 'OPEN'
            DO NOTHING
            """,
            node_params,
        )
        inserted = cur.rowcount
    return found, inserted


def _bulk_upsert_dangling(conn, *, clip: dict[str, float] | None) -> tuple[int, int]:
    line_bbox, line_params = _bbox_clause("als", clip)
    with conn.cursor() as cur:
        cur.execute(
            f"""
            SELECT COUNT(*)
            FROM public.ac_line_segments als
            JOIN public.identified_objects io ON io.mrid = als.mrid
            WHERE io.validation = 'APPROVED'
            {line_bbox}
              AND (
                NOT EXISTS (
                  SELECT 1 FROM public.connectivity_nodes cn WHERE cn.mrid = als.source_node_id
                )
                OR NOT EXISTS (
                  SELECT 1 FROM public.connectivity_nodes cn WHERE cn.mrid = als.target_node_id
                )
              )
            """,
            line_params,
        )
        found = int(cur.fetchone()[0])

        cur.execute(
            f"""
            INSERT INTO public.data_quality_exceptions (
              record_type, record_mrid, rule_code, severity, error_message, details
            )
            SELECT
              'ac_line_segments',
              als.mrid,
              'TOPO_DANGLING_LINE_ENDPOINT',
              r.severity,
              'Line segment references a missing connectivity node endpoint.',
              jsonb_build_object(
                'source_node_mrid', als.source_node_id::text,
                'target_node_mrid', als.target_node_id::text,
                'missing_source', NOT EXISTS (
                  SELECT 1 FROM public.connectivity_nodes cn WHERE cn.mrid = als.source_node_id
                ),
                'missing_target', NOT EXISTS (
                  SELECT 1 FROM public.connectivity_nodes cn WHERE cn.mrid = als.target_node_id
                )
              )
            FROM public.ac_line_segments als
            JOIN public.identified_objects io ON io.mrid = als.mrid
            JOIN public.data_quality_rules r ON r.rule_code = 'TOPO_DANGLING_LINE_ENDPOINT'
            WHERE io.validation = 'APPROVED'
              AND r.enabled = TRUE
            {line_bbox}
              AND (
                NOT EXISTS (
                  SELECT 1 FROM public.connectivity_nodes cn WHERE cn.mrid = als.source_node_id
                )
                OR NOT EXISTS (
                  SELECT 1 FROM public.connectivity_nodes cn WHERE cn.mrid = als.target_node_id
                )
              )
            ON CONFLICT (record_mrid, rule_code) WHERE status = 'OPEN'
            DO NOTHING
            """,
            line_params,
        )
        inserted = cur.rowcount
    return found, inserted


def _bulk_upsert_unapproved_endpoints(conn, *, clip: dict[str, float] | None) -> tuple[int, int]:
    line_bbox, line_params = _bbox_clause("als", clip)
    with conn.cursor() as cur:
        cur.execute(
            f"""
            SELECT COUNT(*)
            FROM public.ac_line_segments als
            JOIN public.identified_objects io ON io.mrid = als.mrid
            WHERE io.validation = 'APPROVED'
            {line_bbox}
              AND EXISTS (
                SELECT 1 FROM public.connectivity_nodes cn WHERE cn.mrid = als.source_node_id
              )
              AND EXISTS (
                SELECT 1 FROM public.connectivity_nodes cn WHERE cn.mrid = als.target_node_id
              )
              AND (
                NOT EXISTS (
                  SELECT 1 FROM public.identified_objects nio
                  WHERE nio.mrid = als.source_node_id AND nio.validation = 'APPROVED'
                )
                OR NOT EXISTS (
                  SELECT 1 FROM public.identified_objects nio
                  WHERE nio.mrid = als.target_node_id AND nio.validation = 'APPROVED'
                )
              )
            """,
            line_params,
        )
        found = int(cur.fetchone()[0])

        cur.execute(
            f"""
            INSERT INTO public.data_quality_exceptions (
              record_type, record_mrid, rule_code, severity, error_message, details
            )
            SELECT
              'ac_line_segments',
              als.mrid,
              'TOPO_LINE_ENDPOINT_NOT_APPROVED',
              r.severity,
              'Line segment has an endpoint node that is not APPROVED master.',
              jsonb_build_object(
                'source_node_mrid', als.source_node_id::text,
                'target_node_mrid', als.target_node_id::text,
                'source_approved', EXISTS (
                  SELECT 1 FROM public.identified_objects nio
                  WHERE nio.mrid = als.source_node_id AND nio.validation = 'APPROVED'
                ),
                'target_approved', EXISTS (
                  SELECT 1 FROM public.identified_objects nio
                  WHERE nio.mrid = als.target_node_id AND nio.validation = 'APPROVED'
                )
              )
            FROM public.ac_line_segments als
            JOIN public.identified_objects io ON io.mrid = als.mrid
            JOIN public.data_quality_rules r ON r.rule_code = 'TOPO_LINE_ENDPOINT_NOT_APPROVED'
            WHERE io.validation = 'APPROVED'
              AND r.enabled = TRUE
            {line_bbox}
              AND EXISTS (
                SELECT 1 FROM public.connectivity_nodes cn WHERE cn.mrid = als.source_node_id
              )
              AND EXISTS (
                SELECT 1 FROM public.connectivity_nodes cn WHERE cn.mrid = als.target_node_id
              )
              AND (
                NOT EXISTS (
                  SELECT 1 FROM public.identified_objects nio
                  WHERE nio.mrid = als.source_node_id AND nio.validation = 'APPROVED'
                )
                OR NOT EXISTS (
                  SELECT 1 FROM public.identified_objects nio
                  WHERE nio.mrid = als.target_node_id AND nio.validation = 'APPROVED'
                )
              )
            ON CONFLICT (record_mrid, rule_code) WHERE status = 'OPEN'
            DO NOTHING
            """,
            line_params,
        )
        inserted = cur.rowcount
    return found, inserted


def create_topology_batch_run(
    conn,
    *,
    clip: dict[str, float] | None = None,
    requested_by: str | None = None,
) -> str:
    with conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO public.data_quality_batch_runs (
              scan_type, status, clip_west, clip_south, clip_east, clip_north, requested_by
            )
            VALUES (
              'topology_master', 'running',
              %s, %s, %s, %s,
              %s
            )
            RETURNING id::text
            """,
            (
                clip["west"] if clip else None,
                clip["south"] if clip else None,
                clip["east"] if clip else None,
                clip["north"] if clip else None,
                requested_by,
            ),
        )
        return cur.fetchone()[0]


def execute_topology_batch_scan(
    conn,
    run_id: str,
    *,
    clip: dict[str, float] | None = None,
    requested_by: str | None = None,
) -> dict[str, Any]:
    """Set-based master topology scan → steward exception queue."""
    try:
        cleared_orphans = _auto_clear_orphans(conn, clip=clip)
        cleared_dangling = _auto_clear_dangling(conn, clip=clip)
        auto_cleared = cleared_orphans + cleared_dangling

        orphans_found, orphans_inserted = _bulk_upsert_orphans(conn, clip=clip)
        dangling_found, dangling_inserted = _bulk_upsert_dangling(conn, clip=clip)
        unapproved_found, unapproved_inserted = _bulk_upsert_unapproved_endpoints(conn, clip=clip)

        live = live_topology_counts(conn, clip=clip)
        queue = _open_topology_exception_counts(conn, clip=clip)
        gate = export_topology_blocked(conn, clip=clip, live=live, queue=queue)

        # Canonical summary persisted as a snapshot so interactive reads never
        # re-run this national scan.
        summary_snapshot = {
            "live": live,
            "exception_queue": queue,
            "export_blocked": gate,
            "clip": clip,
        }

        with conn.cursor() as cur:
            cur.execute(
                """
                UPDATE public.data_quality_batch_runs
                SET status = 'completed',
                    orphans_found = %s,
                    orphans_inserted = %s,
                    dangling_found = %s,
                    dangling_inserted = %s,
                    auto_cleared = %s,
                    summary_snapshot = %s::jsonb,
                    completed_at = NOW()
                WHERE id = %s::uuid
                """,
                (
                    orphans_found,
                    orphans_inserted,
                    dangling_found + unapproved_found,
                    dangling_inserted + unapproved_inserted,
                    auto_cleared,
                    json.dumps(summary_snapshot, default=str),
                    run_id,
                ),
            )

        log_lineage(
            conn,
            target_mrid=run_id or "topology-scan",
            source_type="SYSTEM",
            action_type="TOPOLOGY_DQ_SCAN",
            operator_id=requested_by,
            provenance_ref=f"data_quality_batch_runs:{run_id}",
            after_state={
                "orphans_found": orphans_found,
                "orphans_inserted": orphans_inserted,
                "dangling_found": dangling_found,
                "unapproved_endpoints_found": unapproved_found,
                "auto_cleared": auto_cleared,
                "clip": clip,
            },
        )

        return {
            "run_id": run_id,
            "status": "completed",
            "orphans_found": orphans_found,
            "orphans_inserted": orphans_inserted,
            "dangling_found": dangling_found,
            "dangling_inserted": dangling_inserted,
            "unapproved_endpoints_found": unapproved_found,
            "unapproved_endpoints_inserted": unapproved_inserted,
            "auto_cleared": auto_cleared,
            "live": live,
            "exception_queue": queue,
            "export_gate": gate,
        }
    except Exception as exc:
        with conn.cursor() as cur:
            cur.execute(
                """
                UPDATE public.data_quality_batch_runs
                SET status = 'failed', error_message = %s, completed_at = NOW()
                WHERE id = %s::uuid
                """,
                (str(exc)[:2000], run_id),
            )
        raise


def run_topology_batch_scan(
    conn,
    *,
    clip: dict[str, float] | None = None,
    requested_by: str | None = None,
) -> dict[str, Any]:
    run_id = create_topology_batch_run(conn, clip=clip, requested_by=requested_by)
    return execute_topology_batch_scan(conn, run_id, clip=clip, requested_by=requested_by)


def list_batch_runs(conn, *, limit: int = 20) -> list[dict[str, Any]]:
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT id::text, scan_type, status,
                   orphans_found, orphans_inserted,
                   dangling_found, dangling_inserted,
                   auto_cleared, requested_by,
                   started_at, completed_at, error_message
            FROM public.data_quality_batch_runs
            ORDER BY started_at DESC
            LIMIT %s
            """,
            (limit,),
        )
        rows = cur.fetchall()
    return [
        {
            "id": r[0],
            "scan_type": r[1],
            "status": r[2],
            "orphans_found": r[3],
            "orphans_inserted": r[4],
            "dangling_found": r[5],
            "dangling_inserted": r[6],
            "auto_cleared": r[7],
            "requested_by": r[8],
            "started_at": r[9].isoformat() if r[9] else None,
            "completed_at": r[10].isoformat() if r[10] else None,
            "error_message": r[11],
        }
        for r in rows
    ]
