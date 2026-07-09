"""Master & staging topology DQ — set-based orphan & dangling line scans."""

from __future__ import annotations

import json
import os
from typing import Any, Literal

from db_pool import set_local_statement_timeout
from lineage import log_lineage

TopologyTier = Literal["master", "staging"]

# Open topology exceptions above this count in an export clip block the export job.
EXPORT_TOPOLOGY_EXCEPTION_CAP = 500
# Orphan ratio in clip above this fraction triggers export block (when orphans > cap).
EXPORT_ORPHAN_RATIO_CAP = 0.15

TOPOLOGY_MASTER_LIVE_TIMEOUT_MS = int(
    os.getenv("TOPOLOGY_MASTER_LIVE_TIMEOUT_MS", "120000")
)
TOPOLOGY_STAGING_LIVE_TIMEOUT_MS = int(
    os.getenv("TOPOLOGY_STAGING_LIVE_TIMEOUT_MS", "30000")
)

TOPOLOGY_SCAN_PHASES: tuple[tuple[str, str, float], ...] = (
    ("auto_clear", "Clearing resolved exceptions", 0.08),
    ("orphans", "Scanning orphan nodes", 0.22),
    ("dangling", "Scanning dangling lines", 0.22),
    ("endpoints", "Checking line endpoints", 0.18),
    ("geometric", "Geometric topology rules", 0.22),
    ("snapshot", "Saving snapshot", 0.08),
)

TOPOLOGY_SCAN_DEFAULT_ESTIMATE_SEC = int(
    # After 00105 + national geom skip, national scans should finish in minutes.
    os.getenv("TOPOLOGY_SCAN_DEFAULT_ESTIMATE_SEC", "180")
)
# Fail a run that has not published progress for this long (geometric SQL can
# legitimately take a while — keep above typical phase duration, below lock TTL).
TOPOLOGY_SCAN_STALE_SEC = int(os.getenv("TOPOLOGY_SCAN_STALE_SEC", "1800"))
# Cap historical ETA so a previous multi-hour run does not advertise "~7m".
TOPOLOGY_SCAN_ESTIMATE_MAX_SEC = int(os.getenv("TOPOLOGY_SCAN_ESTIMATE_MAX_SEC", "3600"))
# National / large-clip orphan INSERT cap. Full found count is still reported;
# only queue inserts are limited so Scan → queue cannot flood ~500k+ rows.
# District-scale clips (span ≤ TOPO_CROSSING_MAX_SPAN_DEG) are uncapped.
# Set to 0 to disable the cap entirely.
TOPOLOGY_ORPHAN_INSERT_CAP = int(os.getenv("TOPOLOGY_ORPHAN_INSERT_CAP", "10000"))


class TopologyScanInProgressError(Exception):
    """Raised when a master topology batch scan is already running."""

    def __init__(self, run_id: str) -> None:
        self.run_id = run_id
        super().__init__(f"Topology scan already running ({run_id})")


class TopologyScanCancelledError(Exception):
    """Raised when an operator cancels an in-flight master topology scan."""

    def __init__(self, run_id: str) -> None:
        self.run_id = run_id
        super().__init__(f"Topology scan cancelled ({run_id})")

_STAGING_ACTIVE_SQL = "io.validation NOT IN ('REJECTED', 'APPROVED')"


def _bbox_clause(alias: str, clip: dict[str, float] | None) -> tuple[str, list[Any]]:
    if not clip:
        return "", []
    return (
        f" AND {alias}.geom && ST_MakeEnvelope(%s, %s, %s, %s, 4326)",
        [clip["west"], clip["south"], clip["east"], clip["north"]],
    )


_CONNECTED_NODE_MRIDS_TABLE = "public.connected_node_mrids"


# Skip connected-node MV rebuild when fresher than this (seconds). Full rebuild
# on ~1M lines can take minutes; orphan detection only needs a recent cache.
CONNECTED_NODE_MRIDS_MAX_AGE_SEC = int(
    os.getenv("CONNECTED_NODE_MRIDS_MAX_AGE_SEC", "21600")
)


def refresh_connected_node_mrids(
    conn,
    *,
    max_age_seconds: int | None = None,
) -> dict[str, Any]:
    """Refresh cached line-endpoint node set (call before orphan scan / after promote).

    Pass ``max_age_seconds=0`` to force a rebuild. Topology scans use the env
    default (6h) so repeated Scan → queue does not re-scan every line endpoint.
    """
    age = CONNECTED_NODE_MRIDS_MAX_AGE_SEC if max_age_seconds is None else max_age_seconds
    with conn.cursor() as cur:
        try:
            cur.execute(
                "SELECT public.refresh_connected_node_mrids(%s)",
                (int(age),),
            )
        except Exception:
            # Pre-00105 databases only expose the zero-arg overload.
            # UndefinedFunction aborts the transaction — must clear before retry.
            try:
                conn.rollback()
            except Exception:
                pass
            cur.execute("SELECT public.refresh_connected_node_mrids()")
        row = cur.fetchone()
    payload = row[0] if row else {}
    return payload if isinstance(payload, dict) else {}


def live_topology_counts(
    conn,
    *,
    clip: dict[str, float] | None = None,
    tier: TopologyTier = "master",
) -> dict[str, int]:
    """Live topology counts for master or staging tables."""
    if tier == "staging":
        return live_staging_topology_counts(conn, clip=clip)
    return live_master_topology_counts(conn, clip=clip)


def live_master_topology_counts(conn, *, clip: dict[str, float] | None = None) -> dict[str, int]:
    """Live counts from master tables (not exception queue)."""
    set_local_statement_timeout(conn, TOPOLOGY_MASTER_LIVE_TIMEOUT_MS)
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
            LEFT JOIN {_CONNECTED_NODE_MRIDS_TABLE} c ON c.mrid = cn.mrid
            WHERE io.validation = 'APPROVED'
              AND c.mrid IS NULL
            {node_bbox}
            """,
            node_params,
        )
        orphan_nodes = int(cur.fetchone()[0])

        # Hash anti-joins beat per-row EXISTS on ~1M lines (see EXPLAIN costs).
        cur.execute(
            f"""
            SELECT COUNT(*)
            FROM public.ac_line_segments als
            JOIN public.identified_objects io ON io.mrid = als.mrid
            LEFT JOIN public.connectivity_nodes src ON src.mrid = als.source_node_id
            LEFT JOIN public.connectivity_nodes tgt ON tgt.mrid = als.target_node_id
            WHERE io.validation = 'APPROVED'
            {line_bbox}
              AND (src.mrid IS NULL OR tgt.mrid IS NULL)
            """,
            line_params,
        )
        dangling_lines = int(cur.fetchone()[0])

        cur.execute(
            f"""
            SELECT COUNT(*)
            FROM public.ac_line_segments als
            JOIN public.identified_objects io ON io.mrid = als.mrid
            JOIN public.connectivity_nodes src ON src.mrid = als.source_node_id
            JOIN public.connectivity_nodes tgt ON tgt.mrid = als.target_node_id
            LEFT JOIN public.identified_objects sio ON sio.mrid = als.source_node_id
            LEFT JOIN public.identified_objects tio ON tio.mrid = als.target_node_id
            WHERE io.validation = 'APPROVED'
            {line_bbox}
              AND (
                sio.validation IS DISTINCT FROM 'APPROVED'
                OR tio.validation IS DISTINCT FROM 'APPROVED'
              )
            """,
            line_params,
        )
        bad_endpoints = int(cur.fetchone()[0])

    orphan_ratio = round(orphan_nodes / approved_nodes, 6) if approved_nodes else 0.0
    from geometric_topology import geometric_topology_live_counts

    geom = geometric_topology_live_counts(conn, clip=clip, tier="master")
    return {
        "approved_nodes": approved_nodes,
        "orphan_nodes": orphan_nodes,
        "orphan_ratio": orphan_ratio,
        "dangling_lines": dangling_lines,
        "lines_with_unapproved_endpoints": bad_endpoints,
        **geom,
    }


def live_staging_topology_counts(conn, *, clip: dict[str, float] | None = None) -> dict[str, int]:
    """Live topology counts from staging field-capture tables."""
    set_local_statement_timeout(conn, TOPOLOGY_STAGING_LIVE_TIMEOUT_MS)
    node_bbox, node_params = _bbox_clause("cn", clip)
    line_bbox, line_params = _bbox_clause("als", clip)

    with conn.cursor() as cur:
        cur.execute(
            f"""
            SELECT COUNT(*)
            FROM staging.connectivity_nodes cn
            JOIN staging.identified_objects io ON io.mrid = cn.mrid
            WHERE {_STAGING_ACTIVE_SQL}
            {node_bbox}
            """,
            node_params,
        )
        staging_nodes = int(cur.fetchone()[0])

        cur.execute(
            f"""
            SELECT COUNT(*)
            FROM staging.connectivity_nodes cn
            JOIN staging.identified_objects io ON io.mrid = cn.mrid
            WHERE {_STAGING_ACTIVE_SQL}
            {node_bbox}
              AND NOT EXISTS (
                SELECT 1 FROM staging.ac_line_segments als
                WHERE als.source_node_id = cn.mrid OR als.target_node_id = cn.mrid
              )
            """,
            node_params,
        )
        orphan_nodes = int(cur.fetchone()[0])

        cur.execute(
            f"""
            SELECT COUNT(*)
            FROM staging.ac_line_segments als
            JOIN staging.identified_objects io ON io.mrid = als.mrid
            WHERE {_STAGING_ACTIVE_SQL}
            {line_bbox}
              AND (
                NOT EXISTS (
                  SELECT 1 FROM staging.connectivity_nodes cn
                  WHERE cn.mrid = als.source_node_id
                )
                OR NOT EXISTS (
                  SELECT 1 FROM staging.connectivity_nodes cn
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
            FROM staging.ac_line_segments als
            JOIN staging.identified_objects io ON io.mrid = als.mrid
            WHERE {_STAGING_ACTIVE_SQL}
            {line_bbox}
              AND (
                NOT EXISTS (
                  SELECT 1 FROM staging.connectivity_nodes cn
                  JOIN staging.identified_objects nio ON nio.mrid = cn.mrid
                  WHERE cn.mrid = als.source_node_id AND {_STAGING_ACTIVE_SQL.replace('io.', 'nio.')}
                )
                OR NOT EXISTS (
                  SELECT 1 FROM staging.connectivity_nodes cn
                  JOIN staging.identified_objects nio ON nio.mrid = cn.mrid
                  WHERE cn.mrid = als.target_node_id AND {_STAGING_ACTIVE_SQL.replace('io.', 'nio.')}
                )
              )
            """,
            line_params,
        )
        bad_endpoints = int(cur.fetchone()[0])

    orphan_ratio = round(orphan_nodes / staging_nodes, 6) if staging_nodes else 0.0
    from geometric_topology import geometric_topology_live_counts

    geom = geometric_topology_live_counts(conn, clip=clip, tier="staging")
    return {
        "approved_nodes": staging_nodes,
        "orphan_nodes": orphan_nodes,
        "orphan_ratio": orphan_ratio,
        "dangling_lines": dangling_lines,
        "lines_with_unapproved_endpoints": bad_endpoints,
        **geom,
    }


def _open_topology_exception_counts(
    conn,
    *,
    clip: dict[str, float] | None = None,
    tier: TopologyTier = "master",
) -> dict[str, int]:
    if tier == "staging":
        return _open_staging_topology_exception_counts(conn, clip=clip)
    return _open_master_topology_exception_counts(conn, clip=clip)


def _open_master_topology_exception_counts(
    conn, *, clip: dict[str, float] | None = None
) -> dict[str, int]:
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


def _open_staging_topology_exception_counts(
    conn, *, clip: dict[str, float] | None = None
) -> dict[str, int]:
    node_bbox, node_params = _bbox_clause("cn", clip)
    line_bbox, line_params = _bbox_clause("als", clip)

    with conn.cursor() as cur:
        cur.execute(
            f"""
            SELECT e.rule_code, COUNT(*)
            FROM staging.data_quality_exceptions e
            JOIN public.data_quality_rules r ON r.rule_code = e.rule_code
            JOIN staging.connectivity_nodes cn ON cn.mrid = e.record_mrid
            JOIN staging.identified_objects sio ON sio.mrid = e.record_mrid
            WHERE e.status = 'OPEN' AND r.domain = 'topology'
              AND e.record_type = 'connectivity_node'
              AND {_STAGING_ACTIVE_SQL.replace('io.', 'sio.')}
            {node_bbox}
            GROUP BY e.rule_code
            """,
            node_params,
        )
        node_counts = {r[0]: int(r[1]) for r in cur.fetchall()}

        cur.execute(
            f"""
            SELECT e.rule_code, COUNT(*)
            FROM staging.data_quality_exceptions e
            JOIN public.data_quality_rules r ON r.rule_code = e.rule_code
            JOIN staging.ac_line_segments als ON als.mrid = e.record_mrid
            JOIN staging.identified_objects sio ON sio.mrid = e.record_mrid
            WHERE e.status = 'OPEN' AND r.domain = 'topology'
              AND e.record_type = 'ac_line_segments'
              AND {_STAGING_ACTIVE_SQL.replace('io.', 'sio.')}
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


def topology_dq_summary(
    conn,
    *,
    clip: dict[str, float] | None = None,
    tier: TopologyTier = "master",
) -> dict[str, Any]:
    """Compute the LIVE topology summary (expensive at national scale for master).

    Staging is always computed live from the smaller staging tables.
    """
    live = live_topology_counts(conn, clip=clip, tier=tier)
    queue = _open_topology_exception_counts(conn, clip=clip, tier=tier)
    summary = {
        "live": live,
        "exception_queue": queue,
        "export_blocked": export_topology_blocked(conn, clip=clip, live=live, queue=queue, tier=tier),
        "tier": tier,
    }
    summary["source"] = "live"
    return summary


def topology_snapshot_pending(*, tier: TopologyTier = "master") -> dict[str, Any]:
    """Fast placeholder when no completed master scan exists yet.

    Avoids running ``topology_dq_summary()`` on page load — that live path scans
    the full national graph and can take 10+ minutes.
    """
    return {
        "live": {
            "approved_nodes": 0,
            "orphan_nodes": 0,
            "orphan_ratio": 0.0,
            "dangling_lines": 0,
            "lines_with_unapproved_endpoints": 0,
        },
        "exception_queue": {"open_topology_total": 0},
        "export_blocked": {
            "blocked": True,
            "reasons": ["No completed topology scan — use Scan → queue"],
            "caps": {
                "open_topology_exceptions": EXPORT_TOPOLOGY_EXCEPTION_CAP,
                "orphan_ratio": EXPORT_ORPHAN_RATIO_CAP,
            },
        },
        "source": "pending",
        "tier": tier,
        "scanned_at": None,
        "run_id": None,
    }


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
    result["tier"] = "master"
    result["scanned_at"] = completed_at.isoformat() if completed_at else None
    result["run_id"] = run_id
    return result


def latest_staging_topology_live(conn, *, clip: dict[str, float] | None = None) -> dict[str, Any]:
    """Always-live staging topology summary (no batch snapshot yet)."""
    result = topology_dq_summary(conn, clip=clip, tier="staging")
    result["scanned_at"] = None
    return result


def export_topology_blocked(
    conn,
    *,
    clip: dict[str, float] | None,
    live: dict[str, int] | None = None,
    queue: dict[str, int] | None = None,
    tier: TopologyTier = "master",
) -> dict[str, Any]:
    """Whether an export / release in this clip should be blocked by topology DQ."""
    if live is None:
        live = live_topology_counts(conn, clip=clip, tier=tier)
    if queue is None:
        queue = _open_topology_exception_counts(conn, clip=clip, tier=tier)
    reasons: list[str] = []

    if live["dangling_lines"] > 0:
        label = "staging" if tier == "staging" else "master"
        reasons.append(
            f"{live['dangling_lines']} dangling line(s) in {label} scope (missing endpoint node)"
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
    """Resolve orphan exceptions that are now connected.

    Exception-table driven (no geom bbox join) — national clips must stay fast.
    ``clip`` is accepted for API compatibility but intentionally unused here.
    """
    _ = clip
    with conn.cursor() as cur:
        cur.execute(
            f"""
            UPDATE public.data_quality_exceptions e
            SET status = 'RESOLVED',
                resolved_at = NOW(),
                resolved_by = 'topology_scan',
                resolution_note = 'Auto-cleared: node now has connected line segment'
            WHERE e.rule_code = 'ASSET_ORPHAN_NODE'
              AND e.status = 'OPEN'
              AND EXISTS (
                SELECT 1 FROM {_CONNECTED_NODE_MRIDS_TABLE} c
                WHERE c.mrid = e.record_mrid
              )
            """
        )
        return int(cur.rowcount or 0)


def _auto_clear_dangling(conn, *, clip: dict[str, float] | None) -> int:
    """Resolve dangling/unapproved-endpoint exceptions that are now healthy.

    Driven from OPEN exceptions only — never scans every approved line.
    ``clip`` is accepted for API compatibility but intentionally unused here.
    """
    _ = clip
    with conn.cursor() as cur:
        cur.execute(
            """
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
            """
        )
        return int(cur.rowcount or 0)


def _orphan_insert_limit(clip: dict[str, float] | None) -> int | None:
    """Return INSERT row cap for orphan upsert, or None for unlimited.

    National / multi-district clips can find hundreds of thousands of orphans;
    inserting all of them locks ``data_quality_exceptions`` for a long time and
    floods the steward queue. District clips stay uncapped so local cleanup
    can still queue every orphan in the clip.
    """
    if TOPOLOGY_ORPHAN_INSERT_CAP <= 0:
        return None
    from geometric_topology import _should_run_line_crossings

    if clip is not None and _should_run_line_crossings(clip):
        return None
    return TOPOLOGY_ORPHAN_INSERT_CAP


def _bulk_upsert_orphans(
    conn, *, clip: dict[str, float] | None
) -> tuple[int, int, bool]:
    """Insert OPEN orphan exceptions for approved nodes with no incident line.

    Returns ``(found, inserted, capped)``. ``found`` is always the full orphan
    count; ``inserted`` may be limited on national/large clips.
    """
    node_bbox, node_params = _bbox_clause("cn", clip)
    insert_limit = _orphan_insert_limit(clip)
    capped = insert_limit is not None
    # Stable order so repeated capped scans refill the same steward batch first.
    limit_sql = "ORDER BY o.mrid LIMIT %s" if capped else ""
    params: list[Any] = list(node_params)
    if capped:
        params.append(int(insert_limit))

    with conn.cursor() as cur:
        cur.execute(
            f"""
            WITH orphans AS (
              SELECT cn.mrid
              FROM public.connectivity_nodes cn
              JOIN public.identified_objects io ON io.mrid = cn.mrid
              LEFT JOIN {_CONNECTED_NODE_MRIDS_TABLE} c ON c.mrid = cn.mrid
              WHERE io.validation = 'APPROVED'
                AND c.mrid IS NULL
              {node_bbox}
            ),
            to_insert AS (
              SELECT o.mrid
              FROM orphans o
              {limit_sql}
            ),
            inserted AS (
              INSERT INTO public.data_quality_exceptions (
                record_type, record_mrid, rule_code, severity, error_message, details
              )
              SELECT
                'connectivity_node',
                t.mrid,
                'ASSET_ORPHAN_NODE',
                r.severity,
                'Master node has no connected line segment.',
                jsonb_build_object('line_count', 0)
              FROM to_insert t
              JOIN public.data_quality_rules r ON r.rule_code = 'ASSET_ORPHAN_NODE'
                AND r.enabled = TRUE
              ON CONFLICT (record_mrid, rule_code) WHERE status = 'OPEN'
              DO NOTHING
              RETURNING 1
            )
            SELECT
              (SELECT COUNT(*) FROM orphans)::bigint AS found,
              (SELECT COUNT(*) FROM inserted)::bigint AS inserted
            """,
            params,
        )
        row = cur.fetchone()
    found = int(row[0] or 0) if row else 0
    inserted = int(row[1] or 0) if row else 0
    # Cap only "bites" when more orphans exist than we queued.
    return found, inserted, bool(capped and found > inserted)


def _bulk_upsert_dangling(conn, *, clip: dict[str, float] | None) -> tuple[int, int]:
    """Insert OPEN dangling-endpoint exceptions (hash anti-join, single pass)."""
    line_bbox, line_params = _bbox_clause("als", clip)
    with conn.cursor() as cur:
        cur.execute(
            f"""
            WITH dangling AS (
              SELECT
                als.mrid,
                als.source_node_id,
                als.target_node_id,
                (src.mrid IS NULL) AS missing_source,
                (tgt.mrid IS NULL) AS missing_target
              FROM public.ac_line_segments als
              JOIN public.identified_objects io ON io.mrid = als.mrid
              LEFT JOIN public.connectivity_nodes src ON src.mrid = als.source_node_id
              LEFT JOIN public.connectivity_nodes tgt ON tgt.mrid = als.target_node_id
              WHERE io.validation = 'APPROVED'
              {line_bbox}
                AND (src.mrid IS NULL OR tgt.mrid IS NULL)
            ),
            inserted AS (
              INSERT INTO public.data_quality_exceptions (
                record_type, record_mrid, rule_code, severity, error_message, details
              )
              SELECT
                'ac_line_segments',
                d.mrid,
                'TOPO_DANGLING_LINE_ENDPOINT',
                r.severity,
                'Line segment references a missing connectivity node endpoint.',
                jsonb_build_object(
                  'source_node_mrid', d.source_node_id::text,
                  'target_node_mrid', d.target_node_id::text,
                  'missing_source', d.missing_source,
                  'missing_target', d.missing_target
                )
              FROM dangling d
              JOIN public.data_quality_rules r ON r.rule_code = 'TOPO_DANGLING_LINE_ENDPOINT'
                AND r.enabled = TRUE
              ON CONFLICT (record_mrid, rule_code) WHERE status = 'OPEN'
              DO NOTHING
              RETURNING 1
            )
            SELECT
              (SELECT COUNT(*) FROM dangling)::bigint AS found,
              (SELECT COUNT(*) FROM inserted)::bigint AS inserted
            """,
            line_params,
        )
        row = cur.fetchone()
    found = int(row[0] or 0) if row else 0
    inserted = int(row[1] or 0) if row else 0
    return found, inserted


def _bulk_upsert_unapproved_endpoints(conn, *, clip: dict[str, float] | None) -> tuple[int, int]:
    """Insert OPEN unapproved-endpoint exceptions (hash joins, single pass)."""
    line_bbox, line_params = _bbox_clause("als", clip)
    with conn.cursor() as cur:
        cur.execute(
            f"""
            WITH bad AS (
              SELECT
                als.mrid,
                als.source_node_id,
                als.target_node_id,
                (sio.validation = 'APPROVED') AS source_approved,
                (tio.validation = 'APPROVED') AS target_approved
              FROM public.ac_line_segments als
              JOIN public.identified_objects io ON io.mrid = als.mrid
              JOIN public.connectivity_nodes src ON src.mrid = als.source_node_id
              JOIN public.connectivity_nodes tgt ON tgt.mrid = als.target_node_id
              LEFT JOIN public.identified_objects sio ON sio.mrid = als.source_node_id
              LEFT JOIN public.identified_objects tio ON tio.mrid = als.target_node_id
              WHERE io.validation = 'APPROVED'
              {line_bbox}
                AND (
                  sio.validation IS DISTINCT FROM 'APPROVED'
                  OR tio.validation IS DISTINCT FROM 'APPROVED'
                )
            ),
            inserted AS (
              INSERT INTO public.data_quality_exceptions (
                record_type, record_mrid, rule_code, severity, error_message, details
              )
              SELECT
                'ac_line_segments',
                b.mrid,
                'TOPO_LINE_ENDPOINT_NOT_APPROVED',
                r.severity,
                'Line segment has an endpoint node that is not APPROVED master.',
                jsonb_build_object(
                  'source_node_mrid', b.source_node_id::text,
                  'target_node_mrid', b.target_node_id::text,
                  'source_approved', COALESCE(b.source_approved, FALSE),
                  'target_approved', COALESCE(b.target_approved, FALSE)
                )
              FROM bad b
              JOIN public.data_quality_rules r ON r.rule_code = 'TOPO_LINE_ENDPOINT_NOT_APPROVED'
                AND r.enabled = TRUE
              ON CONFLICT (record_mrid, rule_code) WHERE status = 'OPEN'
              DO NOTHING
              RETURNING 1
            )
            SELECT
              (SELECT COUNT(*) FROM bad)::bigint AS found,
              (SELECT COUNT(*) FROM inserted)::bigint AS inserted
            """,
            line_params,
        )
        row = cur.fetchone()
    found = int(row[0] or 0) if row else 0
    inserted = int(row[1] or 0) if row else 0
    return found, inserted


def create_topology_batch_run(
    conn,
    *,
    clip: dict[str, float] | None = None,
    requested_by: str | None = None,
) -> str:
    active = find_active_topology_batch_run(conn)
    if active is not None:
        raise TopologyScanInProgressError(active["run_id"])

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
        run_id = cur.fetchone()[0]

    _publish_scan_progress(
        run_id,
        status="running",
        current_phase="auto_clear",
        completed_phases=[],
        started_at=_run_started_at(conn, run_id),
    )
    return run_id


def request_topology_scan_cancel(run_id: str) -> None:
    """Signal the worker to stop; survives until the run finishes or TTL expires."""
    from redis_cache import (
        TOPOLOGY_SCAN_CANCEL_TTL_SEC,
        set_json,
        topology_scan_cancel_key,
    )

    set_json(
        topology_scan_cancel_key(run_id),
        {"cancelled": True},
        TOPOLOGY_SCAN_CANCEL_TTL_SEC,
    )


def topology_scan_cancel_requested(run_id: str) -> bool:
    from redis_cache import get_json, topology_scan_cancel_key

    raw = get_json(topology_scan_cancel_key(run_id))
    return isinstance(raw, dict) and bool(raw.get("cancelled"))


def clear_topology_scan_cancel(run_id: str) -> None:
    from redis_cache import delete_key, topology_scan_cancel_key

    delete_key(topology_scan_cancel_key(run_id))


def fail_stale_topology_batch_run(
    conn,
    run_id: str,
    *,
    error_message: str,
) -> None:
    """Mark a zombie scan failed and release Redis coordination keys."""
    from redis_cache import (
        TOPOLOGY_SCAN_LOCK_NAME,
        delete_key,
        force_release_lock,
        topology_scan_active_key,
    )

    request_topology_scan_cancel(run_id)
    started_at = _run_started_at(conn, run_id)
    with conn.cursor() as cur:
        cur.execute(
            """
            UPDATE public.data_quality_batch_runs
            SET status = 'failed', error_message = %s, completed_at = NOW()
            WHERE id = %s::uuid AND status = 'running'
            """,
            (error_message[:2000], run_id),
        )
    conn.commit()
    force_release_lock(TOPOLOGY_SCAN_LOCK_NAME)
    delete_key(topology_scan_active_key())
    # Bypass cancel guard so the failed status is visible to the UI.
    _publish_scan_progress(
        run_id,
        status="failed",
        current_phase="auto_clear",
        completed_phases=[],
        started_at=started_at,
        error_message=error_message[:2000],
        force=True,
    )


def find_active_topology_batch_run(conn) -> dict[str, Any] | None:
    """Return the newest in-flight master topology scan, if any."""
    from redis_cache import TOPOLOGY_SCAN_LOCK_NAME, lock_held

    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT id::text, status, started_at, completed_at, error_message,
                   orphans_found, dangling_found, auto_cleared
            FROM public.data_quality_batch_runs
            WHERE scan_type = 'topology_master'
              AND status = 'running'
            ORDER BY started_at DESC
            LIMIT 1
            """
        )
        row = cur.fetchone()
    if not row:
        return None
    run_id = row[0]
    started_at = row[2].isoformat() if row[2] else None
    cached = _read_scan_progress(run_id)
    if row[1] == "running":
        if cached:
            cached = _maybe_fail_stale_progress(
                conn, run_id, cached, started_at=started_at
            )
            if cached is None or cached.get("status") != "running":
                return None
        elif not lock_held(TOPOLOGY_SCAN_LOCK_NAME):
            fail_stale_topology_batch_run(
                conn,
                run_id,
                error_message="Topology scan worker stopped (lock expired). Re-run the scan.",
            )
            return None
    if cached:
        cached.setdefault("run_id", run_id)
        cached.setdefault("started_at", started_at)
        cached.setdefault("status", row[1])
        estimate = cached.get("estimate_seconds")
        if estimate is None:
            estimate = estimate_topology_scan_seconds(conn)
            cached["estimate_seconds"] = estimate
        cached["eta_seconds"] = _eta_seconds_remaining(
            estimate_seconds=int(estimate) if estimate is not None else None,
            started_at=cached.get("started_at") or started_at,
            status=str(cached.get("status") or row[1]),
        )
        return cached
    estimate_seconds = estimate_topology_scan_seconds(conn)
    return {
        "run_id": run_id,
        "status": row[1],
        "current_phase": "auto_clear",
        "completed_phases": [],
        "started_at": started_at,
        "estimate_seconds": estimate_seconds,
        "eta_seconds": _eta_seconds_remaining(
            estimate_seconds=estimate_seconds,
            started_at=started_at,
            status=row[1],
        ),
    }


def estimate_topology_scan_seconds(conn, *, default: int | None = None) -> int:
    """Rolling average duration of recent completed master scans."""
    fallback = default if default is not None else TOPOLOGY_SCAN_DEFAULT_ESTIMATE_SEC
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT EXTRACT(EPOCH FROM (completed_at - started_at))
            FROM public.data_quality_batch_runs
            WHERE scan_type = 'topology_master'
              AND status = 'completed'
              AND completed_at IS NOT NULL
              AND started_at IS NOT NULL
            ORDER BY completed_at DESC
            LIMIT 5
            """
        )
        rows = cur.fetchall()
    durations = [float(r[0]) for r in rows if r and r[0] and float(r[0]) >= 30]
    if not durations:
        return fallback
    avg = sum(durations) / len(durations)
    return int(max(60, min(TOPOLOGY_SCAN_ESTIMATE_MAX_SEC, round(avg))))


def _elapsed_seconds_since(started_at: str | None) -> float | None:
    if not started_at:
        return None
    try:
        return max(0.0, (datetime_now_iso_ms() - iso_to_ms(started_at)) / 1000.0)
    except Exception:
        return None


def _eta_seconds_remaining(
    *,
    estimate_seconds: int | None,
    started_at: str | None,
    status: str,
) -> int | None:
    """Remaining ETA from wall clock — never reuse a frozen Redis eta_seconds."""
    if status != "running" or estimate_seconds is None:
        return None
    elapsed = _elapsed_seconds_since(started_at)
    if elapsed is None:
        return int(estimate_seconds)
    remaining = int(estimate_seconds - elapsed)
    # Once past the estimate, stop advertising a fake countdown.
    return remaining if remaining > 0 else 0


def _maybe_fail_stale_progress(
    conn,
    run_id: str,
    cached: dict[str, Any],
    *,
    started_at: str | None,
) -> dict[str, Any] | None:
    """Mark zombie scans failed when Redis progress stops updating."""
    from redis_cache import TOPOLOGY_SCAN_LOCK_NAME, lock_held

    if cached.get("status") != "running":
        return cached
    if not lock_held(TOPOLOGY_SCAN_LOCK_NAME):
        fail_stale_topology_batch_run(
            conn,
            run_id,
            error_message="Topology scan worker stopped (lock expired). Re-run the scan.",
        )
        return _read_scan_progress(run_id)

    updated_at = cached.get("updated_at") or started_at
    if not updated_at:
        return cached
    try:
        from datetime import datetime, timezone

        last_touch = datetime.fromisoformat(str(updated_at).replace("Z", "+00:00"))
        stale_for = (datetime.now(timezone.utc) - last_touch).total_seconds()
    except Exception:
        return cached

    if stale_for <= TOPOLOGY_SCAN_STALE_SEC:
        return cached

    fail_stale_topology_batch_run(
        conn,
        run_id,
        error_message=(
            "Topology scan stopped responding "
            f"(no progress for {int(stale_for // 60)} min). Re-run the scan."
        ),
    )
    return _read_scan_progress(run_id)


def topology_scan_progress_pct(completed_phases: list[str]) -> int:
    done_weight = sum(
        weight for phase_id, _, weight in TOPOLOGY_SCAN_PHASES if phase_id in completed_phases
    )
    return min(99, int(round(done_weight * 100)))


def get_topology_batch_progress(conn, run_id: str) -> dict[str, Any] | None:
    cached = _read_scan_progress(run_id)
    if cached:
        started_at = cached.get("started_at") or _run_started_at(conn, run_id)
        if cached.get("status") == "running":
            refreshed = _maybe_fail_stale_progress(
                conn, run_id, cached, started_at=started_at
            )
            if refreshed is None:
                return None
            cached = refreshed
        estimate = cached.get("estimate_seconds")
        if estimate is None:
            estimate = estimate_topology_scan_seconds(conn)
            cached["estimate_seconds"] = estimate
        cached["eta_seconds"] = _eta_seconds_remaining(
            estimate_seconds=int(estimate) if estimate is not None else None,
            started_at=cached.get("started_at") or started_at,
            status=str(cached.get("status") or "running"),
        )
        return cached

    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT id::text, status, started_at, completed_at, error_message,
                   orphans_found, dangling_found, dangling_inserted, auto_cleared
            FROM public.data_quality_batch_runs
            WHERE id = %s::uuid
            """,
            (run_id,),
        )
        row = cur.fetchone()
    if not row:
        return None

    started_at = row[2].isoformat() if row[2] else None
    completed_at = row[3].isoformat() if row[3] else None
    status = row[1]
    completed_phases = [p[0] for p in TOPOLOGY_SCAN_PHASES] if status == "completed" else []
    progress_pct = 100 if status == "completed" else 0
    estimate_seconds = estimate_topology_scan_seconds(conn)
    payload: dict[str, Any] = {
        "run_id": row[0],
        "status": status,
        "current_phase": "snapshot" if status == "completed" else "auto_clear",
        "completed_phases": completed_phases,
        "phases": [{"id": p[0], "label": p[1]} for p in TOPOLOGY_SCAN_PHASES],
        "started_at": started_at,
        "completed_at": completed_at,
        "error_message": row[4],
        "estimate_seconds": estimate_seconds,
        "progress_pct": progress_pct,
        "orphans_found": int(row[5] or 0),
        "dangling_found": int(row[6] or 0),
        "auto_cleared": int(row[8] or 0),
    }
    if status == "running":
        payload["eta_seconds"] = _eta_seconds_remaining(
            estimate_seconds=estimate_seconds,
            started_at=started_at,
            status=status,
        )
    return payload


def _run_started_at(conn, run_id: str) -> str | None:
    with conn.cursor() as cur:
        cur.execute(
            "SELECT started_at FROM public.data_quality_batch_runs WHERE id = %s::uuid",
            (run_id,),
        )
        row = cur.fetchone()
    return row[0].isoformat() if row and row[0] else None


def _read_scan_progress(run_id: str) -> dict[str, Any] | None:
    from redis_cache import get_json, topology_scan_progress_key

    raw = get_json(topology_scan_progress_key(run_id))
    if not isinstance(raw, dict):
        return None
    return raw


def _publish_scan_progress(
    run_id: str,
    *,
    status: str,
    current_phase: str,
    completed_phases: list[str],
    started_at: str | None = None,
    completed_at: str | None = None,
    error_message: str | None = None,
    estimate_seconds: int | None = None,
    orphans_found: int | None = None,
    dangling_found: int | None = None,
    auto_cleared: int | None = None,
    geometric_step: str | None = None,
    force: bool = False,
) -> None:
    from redis_cache import (
        TOPOLOGY_SCAN_LOCK_TTL_SEC,
        delete_key,
        set_json,
        topology_scan_active_key,
        topology_scan_progress_key,
    )

    # After cancel, ignore further "running" heartbeats from the worker.
    if (
        not force
        and status == "running"
        and topology_scan_cancel_requested(run_id)
    ):
        raise TopologyScanCancelledError(run_id)

    progress_pct = 100 if status == "completed" else topology_scan_progress_pct(completed_phases)
    from datetime import datetime, timezone

    payload: dict[str, Any] = {
        "run_id": run_id,
        "status": status,
        "current_phase": current_phase,
        "completed_phases": completed_phases,
        "phases": [{"id": p[0], "label": p[1]} for p in TOPOLOGY_SCAN_PHASES],
        "progress_pct": progress_pct,
        "updated_at": datetime.now(timezone.utc).isoformat(),
    }
    if started_at:
        payload["started_at"] = started_at
    if completed_at:
        payload["completed_at"] = completed_at
    if error_message:
        payload["error_message"] = error_message
    if estimate_seconds is not None:
        payload["estimate_seconds"] = estimate_seconds
        eta = _eta_seconds_remaining(
            estimate_seconds=estimate_seconds,
            started_at=started_at,
            status=status,
        )
        if eta is not None:
            payload["eta_seconds"] = eta
    if orphans_found is not None:
        payload["orphans_found"] = orphans_found
    if dangling_found is not None:
        payload["dangling_found"] = dangling_found
    if auto_cleared is not None:
        payload["auto_cleared"] = auto_cleared
    if geometric_step:
        payload["geometric_step"] = geometric_step

    set_json(topology_scan_progress_key(run_id), payload, TOPOLOGY_SCAN_LOCK_TTL_SEC)
    if status == "running":
        set_json(topology_scan_active_key(), {"run_id": run_id}, TOPOLOGY_SCAN_LOCK_TTL_SEC)
    else:
        delete_key(topology_scan_active_key())
        # Keep the cancel flag after failure so a late worker heartbeat cannot
        # resurrect the run as "running". Cleared only on successful completion.
        if status == "completed":
            clear_topology_scan_cancel(run_id)


def datetime_now_iso_ms() -> float:
    from datetime import datetime, timezone

    return datetime.now(timezone.utc).timestamp() * 1000


def iso_to_ms(value: str) -> float:
    from datetime import datetime

    normalized = value.replace("Z", "+00:00")
    return datetime.fromisoformat(normalized).timestamp() * 1000


def _count_approved_master_nodes(conn, *, clip: dict[str, float] | None) -> int:
    node_bbox, node_params = _bbox_clause("cn", clip)
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
        return int(cur.fetchone()[0])


def _live_summary_from_scan_results(
    *,
    approved_nodes: int,
    orphans_found: int,
    dangling_found: int,
    unapproved_found: int,
    geom_results: dict[str, Any] | None,
) -> dict[str, int]:
    """Build snapshot live counts from scan phases (avoids duplicate national queries)."""
    orphan_ratio = round(orphans_found / approved_nodes, 6) if approved_nodes else 0.0
    live: dict[str, int] = {
        "approved_nodes": approved_nodes,
        "orphan_nodes": orphans_found,
        "orphan_ratio": orphan_ratio,
        "dangling_lines": dangling_found,
        "lines_with_unapproved_endpoints": unapproved_found,
    }
    if geom_results:
        for key in (
            "geom_endpoint_mismatch",
            "geom_dangling_endpoints",
            "line_crossings_without_node",
        ):
            if key in geom_results:
                live[key] = int(geom_results[key])
    return live


def execute_topology_batch_scan(
    conn,
    run_id: str,
    *,
    clip: dict[str, float] | None = None,
    requested_by: str | None = None,
) -> dict[str, Any]:
    """Set-based master topology scan → steward exception queue."""
    from redis_cache import lock, TOPOLOGY_SCAN_LOCK_NAME, TOPOLOGY_SCAN_LOCK_TTL_SEC

    started_at = _run_started_at(conn, run_id)
    estimate_seconds = estimate_topology_scan_seconds(conn)
    completed: list[str] = []

    def _phase(phase_id: str, *, orphans: int | None = None, dangling: int | None = None, cleared: int | None = None) -> None:
        if topology_scan_cancel_requested(run_id):
            raise TopologyScanCancelledError(run_id)
        _publish_scan_progress(
            run_id,
            status="running",
            current_phase=phase_id,
            completed_phases=list(completed),
            started_at=started_at,
            estimate_seconds=estimate_seconds,
            orphans_found=orphans,
            dangling_found=dangling,
            auto_cleared=cleared,
        )

    with lock(TOPOLOGY_SCAN_LOCK_NAME, ttl_sec=TOPOLOGY_SCAN_LOCK_TTL_SEC) as token:
        if token is None:
            active = find_active_topology_batch_run(conn)
            if active and active.get("run_id") != run_id:
                raise TopologyScanInProgressError(active["run_id"])

        try:
            if topology_scan_cancel_requested(run_id):
                raise TopologyScanCancelledError(run_id)

            # Refresh connected-node cache first so auto-clear + orphan upsert
            # share one fresh MV (age-aware; skips rebuild within 6h by default).
            from geometric_topology import bulk_upsert_geometric_topology

            _phase("auto_clear")
            refresh_connected_node_mrids(conn)
            if topology_scan_cancel_requested(run_id):
                raise TopologyScanCancelledError(run_id)
            # Stage 1 must finish in seconds: exception-table clears only.
            # Never run geometric auto-clear or geom-bbox joins here.
            cleared_orphans = _auto_clear_orphans(conn, clip=clip)
            _phase("auto_clear", cleared=cleared_orphans)
            cleared_dangling = _auto_clear_dangling(conn, clip=clip)
            auto_cleared = cleared_orphans + cleared_dangling
            completed.append("auto_clear")
            _phase("auto_clear", cleared=auto_cleared)

            _phase("orphans", cleared=auto_cleared)
            if topology_scan_cancel_requested(run_id):
                raise TopologyScanCancelledError(run_id)
            orphans_found, orphans_inserted, orphans_capped = _bulk_upsert_orphans(
                conn, clip=clip
            )
            completed.append("orphans")
            _phase("orphans", orphans=orphans_found, cleared=auto_cleared)

            _phase("dangling", orphans=orphans_found, cleared=auto_cleared)
            dangling_found, dangling_inserted = _bulk_upsert_dangling(conn, clip=clip)
            completed.append("dangling")
            _phase("dangling", orphans=orphans_found, dangling=dangling_found, cleared=auto_cleared)

            _phase("endpoints", orphans=orphans_found, dangling=dangling_found, cleared=auto_cleared)
            unapproved_found, unapproved_inserted = _bulk_upsert_unapproved_endpoints(conn, clip=clip)
            completed.append("endpoints")

            _phase("geometric", orphans=orphans_found, dangling=dangling_found, cleared=auto_cleared)

            def _geom_heartbeat(step: str) -> None:
                # Refresh Redis progress so the UI ETA / stale detector stay alive
                # while long geometric SQL statements run.
                _publish_scan_progress(
                    run_id,
                    status="running",
                    current_phase="geometric",
                    completed_phases=list(completed),
                    started_at=started_at,
                    estimate_seconds=estimate_seconds,
                    orphans_found=orphans_found,
                    dangling_found=dangling_found,
                    auto_cleared=auto_cleared,
                    geometric_step=step,
                )

            geom_results = bulk_upsert_geometric_topology(
                conn,
                clip=clip,
                tier="master",
                heartbeat=_geom_heartbeat,
                include_live_counts=False,
            )
            completed.append("geometric")

            _phase("snapshot", orphans=orphans_found, dangling=dangling_found, cleared=auto_cleared)
            approved_nodes = _count_approved_master_nodes(conn, clip=clip)
            live = _live_summary_from_scan_results(
                approved_nodes=approved_nodes,
                orphans_found=orphans_found,
                dangling_found=dangling_found,
                unapproved_found=unapproved_found,
                geom_results=geom_results,
            )
            queue = _open_topology_exception_counts(conn, clip=clip)
            gate = export_topology_blocked(conn, clip=clip, live=live, queue=queue)

            summary_snapshot = {
                "live": live,
                "exception_queue": queue,
                "export_blocked": gate,
                "clip": clip,
                "geom_topology": geom_results,
                "orphans_capped": orphans_capped,
                "orphan_insert_cap": (
                    TOPOLOGY_ORPHAN_INSERT_CAP if orphans_capped else None
                ),
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
                      AND status = 'running'
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
                if cur.rowcount == 0:
                    raise TopologyScanCancelledError(run_id)

            completed.append("snapshot")
            from datetime import datetime, timezone

            completed_at = datetime.now(timezone.utc).isoformat()
            _publish_scan_progress(
                run_id,
                status="completed",
                current_phase="snapshot",
                completed_phases=completed,
                started_at=started_at,
                completed_at=completed_at,
                estimate_seconds=estimate_seconds,
                orphans_found=orphans_found,
                dangling_found=dangling_found,
                auto_cleared=auto_cleared,
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
                    "orphans_capped": orphans_capped,
                    "dangling_found": dangling_found,
                    "unapproved_endpoints_found": unapproved_found,
                    "geom_topology": geom_results,
                    "auto_cleared": auto_cleared,
                    "clip": clip,
                },
            )

            return {
                "run_id": run_id,
                "status": "completed",
                "orphans_found": orphans_found,
                "orphans_inserted": orphans_inserted,
                "orphans_capped": orphans_capped,
                "dangling_found": dangling_found,
                "dangling_inserted": dangling_inserted,
                "unapproved_endpoints_found": unapproved_found,
                "unapproved_endpoints_inserted": unapproved_inserted,
                "geom_topology": geom_results,
                "auto_cleared": auto_cleared,
                "live": live,
                "exception_queue": queue,
                "export_gate": gate,
            }
        except TopologyScanCancelledError:
            conn.rollback()
            fail_stale_topology_batch_run(
                conn,
                run_id,
                error_message="Topology scan cancelled by operator. Re-run the scan.",
            )
            return {
                "run_id": run_id,
                "status": "failed",
                "error_message": "Topology scan cancelled by operator. Re-run the scan.",
            }
        except Exception as exc:
            conn.rollback()
            from datetime import datetime, timezone

            completed_at = datetime.now(timezone.utc).isoformat()
            _publish_scan_progress(
                run_id,
                status="failed",
                current_phase=completed[-1] if completed else "auto_clear",
                completed_phases=completed,
                started_at=started_at,
                completed_at=completed_at,
                error_message=str(exc)[:2000],
                estimate_seconds=estimate_seconds,
                force=True,
            )
            with conn.cursor() as cur:
                cur.execute(
                    """
                    UPDATE public.data_quality_batch_runs
                    SET status = 'failed', error_message = %s, completed_at = NOW()
                    WHERE id = %s::uuid AND status = 'running'
                    """,
                    (str(exc)[:2000], run_id),
                )
            conn.commit()
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
