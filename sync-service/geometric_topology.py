"""Geometric topology DQ — ArcGIS-style endpoint snap and dangle checks."""

from __future__ import annotations

import logging
import os
from typing import Any, Callable, Literal

TopologyTier = Literal["master", "staging"]

logger = logging.getLogger(__name__)

# Matches staging topology repair snap threshold (00057).
TOPO_ENDPOINT_TOLERANCE_M = float(os.getenv("TOPO_ENDPOINT_TOLERANCE_M", "1.0"))
# ~1m in degrees at equator — used for GiST prefilter before geography distance.
_TOPO_TOLERANCE_DEG = TOPO_ENDPOINT_TOLERANCE_M / 111_320.0
# National / multi-district clips: skip O(n²) line-crossing self-join.
TOPO_CROSSING_MAX_SPAN_DEG = float(os.getenv("TOPO_CROSSING_MAX_SPAN_DEG", "1.5"))
TOPOLOGY_GEOMETRIC_TIMEOUT_MS = int(
    os.getenv("TOPOLOGY_GEOMETRIC_TIMEOUT_MS", "1800000")
)  # 30 min hard cap per geometric statement
TOPOLOGY_MASTER_LIVE_TIMEOUT_MS = int(
    os.getenv("TOPOLOGY_MASTER_LIVE_TIMEOUT_MS", "120000")
)
TOPOLOGY_STAGING_LIVE_TIMEOUT_MS = int(
    os.getenv("TOPOLOGY_STAGING_LIVE_TIMEOUT_MS", "30000")
)

HeartbeatFn = Callable[[str], None]


def _clip_span_deg(clip: dict[str, float] | None) -> float | None:
    if not clip:
        return None
    return max(
        float(clip["east"]) - float(clip["west"]),
        float(clip["north"]) - float(clip["south"]),
    )


def _should_run_line_crossings(clip: dict[str, float] | None) -> bool:
    """Line-crossing is O(n²); only run on district-scale clips."""
    if not clip:
        return False
    span = _clip_span_deg(clip)
    return span is not None and span <= TOPO_CROSSING_MAX_SPAN_DEG


def _tier_scope(tier: TopologyTier) -> dict[str, str]:
    if tier == "staging":
        return {
            "als": "staging.ac_line_segments",
            "cn": "staging.connectivity_nodes",
            "io": "staging.identified_objects",
            "nio": "staging.identified_objects",
            "exc": "staging.data_quality_exceptions",
            "line_active": "io.validation NOT IN ('REJECTED', 'APPROVED')",
            "node_active": "nio.validation NOT IN ('REJECTED', 'APPROVED')",
            "record_type": "ac_line_segments",
        }
    return {
        "als": "public.ac_line_segments",
        "cn": "public.connectivity_nodes",
        "io": "public.identified_objects",
        "nio": "public.identified_objects",
        "exc": "public.data_quality_exceptions",
        "line_active": "io.validation = 'APPROVED'",
        "node_active": "nio.validation = 'APPROVED'",
        "record_type": "ac_line_segments",
    }


def _clip_sql(alias: str, clip: dict[str, float] | None) -> tuple[str, list[Any]]:
    if not clip:
        return "", []
    return (
        f" AND {alias}.geom && ST_MakeEnvelope(%s, %s, %s, %s, 4326)",
        [clip["west"], clip["south"], clip["east"], clip["north"]],
    )


def _endpoint_near_node_sql(
    *,
    endpoint_expr: str,
    scope: dict[str, str],
) -> str:
    """EXISTS near-node check with GiST bbox prefilter + geography tolerance."""
    return f"""
                    EXISTS (
                      SELECT 1 FROM {scope["cn"]} cn
                      JOIN {scope["nio"]} nio ON nio.mrid = cn.mrid
                      WHERE {scope["node_active"]}
                        AND cn.geom && ST_Expand(({endpoint_expr})::geometry, {_TOPO_TOLERANCE_DEG})
                        AND ST_DWithin(
                          ({endpoint_expr})::geography,
                          cn.geom::geography,
                          %s
                        )
                    )
    """


def geometric_topology_live_counts(
    conn,
    *,
    clip: dict[str, float] | None = None,
    tier: TopologyTier = "master",
    tolerance_m: float | None = None,
) -> dict[str, int]:
    """Count lines failing geometric endpoint / dangle rules (live SQL)."""
    from db_pool import set_local_statement_timeout

    timeout_ms = (
        TOPOLOGY_STAGING_LIVE_TIMEOUT_MS
        if tier == "staging"
        else TOPOLOGY_MASTER_LIVE_TIMEOUT_MS
    )
    set_local_statement_timeout(conn, timeout_ms)
    tol = tolerance_m if tolerance_m is not None else TOPO_ENDPOINT_TOLERANCE_M
    scope = _tier_scope(tier)
    line_bbox, line_params = _clip_sql("als", clip)
    start_near = _endpoint_near_node_sql(
        endpoint_expr="ST_StartPoint(als.geom)", scope=scope
    )
    end_near = _endpoint_near_node_sql(
        endpoint_expr="ST_EndPoint(als.geom)", scope=scope
    )

    # National live counts must not run geography over ~1M lines (minutes+).
    if not _should_run_line_crossings(clip):
        return {
            "geom_endpoint_mismatch": 0,
            "geom_dangling_endpoints": 0,
            "line_crossings_without_node": 0,
        }

    assert clip is not None
    with conn.cursor() as cur:
        cur.execute(
            f"""
            SELECT COUNT(*)
            FROM {scope["als"]} als
            JOIN {scope["io"]} io ON io.mrid = als.mrid
            JOIN {scope["cn"]} src ON src.mrid = als.source_node_id
            JOIN {scope["cn"]} tgt ON tgt.mrid = als.target_node_id
            WHERE {scope["line_active"]}
            {line_bbox}
              AND (
                ST_Distance(ST_StartPoint(als.geom)::geography, src.geom::geography) > %s
                OR ST_Distance(ST_EndPoint(als.geom)::geography, tgt.geom::geography) > %s
              )
            """,
            [*line_params, tol, tol],
        )
        geom_mismatch = int(cur.fetchone()[0])

        cur.execute(
            f"""
            SELECT COUNT(*)
            FROM {scope["als"]} als
            JOIN {scope["io"]} io ON io.mrid = als.mrid
            WHERE {scope["line_active"]}
            {line_bbox}
              AND (
                NOT {start_near}
                OR NOT {end_near}
              )
            """,
            [*line_params, tol, tol],
        )
        geom_dangling = int(cur.fetchone()[0])

        cur.execute(
            f"""
            SELECT COUNT(DISTINCT a.mrid)
            FROM {scope["als"]} a
            JOIN {scope["io"]} aio ON aio.mrid = a.mrid
            JOIN {scope["als"]} b ON a.mrid < b.mrid
            JOIN {scope["io"]} bio ON bio.mrid = b.mrid
            WHERE {scope["line_active"].replace("io.", "aio.")}
              AND {scope["line_active"].replace("io.", "bio.")}
              AND a.geom && b.geom
              AND ST_Crosses(a.geom, b.geom)
              AND a.geom && ST_MakeEnvelope(%s, %s, %s, %s, 4326)
              AND NOT EXISTS (
                SELECT 1 FROM {scope["cn"]} cn
                JOIN {scope["nio"]} nio ON nio.mrid = cn.mrid
                WHERE {scope["node_active"]}
                  AND cn.geom && ST_Expand(ST_Intersection(a.geom, b.geom)::geometry, {_TOPO_TOLERANCE_DEG})
                  AND ST_DWithin(
                    ST_Intersection(a.geom, b.geom)::geography,
                    cn.geom::geography,
                    %s
                  )
              )
            """,
            [clip["west"], clip["south"], clip["east"], clip["north"], tol],
        )
        crossing = int(cur.fetchone()[0])

    return {
        "geom_endpoint_mismatch": geom_mismatch,
        "geom_dangling_endpoints": geom_dangling,
        "line_crossings_without_node": crossing,
    }


def auto_clear_geometric_topology(conn, *, clip: dict[str, float] | None, tier: TopologyTier) -> int:
    tol = TOPO_ENDPOINT_TOLERANCE_M
    scope = _tier_scope(tier)
    line_bbox, line_params = _clip_sql("als", clip)
    cleared = 0
    start_near = _endpoint_near_node_sql(
        endpoint_expr="ST_StartPoint(als.geom)", scope=scope
    )
    end_near = _endpoint_near_node_sql(
        endpoint_expr="ST_EndPoint(als.geom)", scope=scope
    )

    with conn.cursor() as cur:
        cur.execute(
            f"""
            UPDATE {scope["exc"]} e
            SET status = 'RESOLVED',
                resolved_at = NOW(),
                resolved_by = 'topology_scan',
                resolution_note = 'Auto-cleared: line endpoints now snap to assigned nodes'
            FROM {scope["als"]} als
            JOIN {scope["cn"]} src ON src.mrid = als.source_node_id
            JOIN {scope["cn"]} tgt ON tgt.mrid = als.target_node_id
            WHERE e.rule_code = 'TOPO_LINE_ENDPOINT_GEOM_MISMATCH'
              AND e.status = 'OPEN'
              AND e.record_mrid = als.mrid
              {line_bbox}
              AND ST_Distance(ST_StartPoint(als.geom)::geography, src.geom::geography) <= %s
              AND ST_Distance(ST_EndPoint(als.geom)::geography, tgt.geom::geography) <= %s
            """,
            [*line_params, tol, tol],
        )
        cleared += cur.rowcount

        cur.execute(
            f"""
            UPDATE {scope["exc"]} e
            SET status = 'RESOLVED',
                resolved_at = NOW(),
                resolved_by = 'topology_scan',
                resolution_note = 'Auto-cleared: both line endpoints near connectivity nodes'
            FROM {scope["als"]} als
            WHERE e.rule_code = 'TOPO_GEOM_DANGLING_ENDPOINT'
              AND e.status = 'OPEN'
              AND e.record_mrid = als.mrid
              {line_bbox}
              AND {start_near}
              AND {end_near}
            """,
            [*line_params, tol, tol],
        )
        cleared += cur.rowcount

    return cleared


def bulk_upsert_geometric_topology(
    conn,
    *,
    clip: dict[str, float] | None,
    tier: TopologyTier,
    heartbeat: HeartbeatFn | None = None,
    include_live_counts: bool = True,
) -> dict[str, Any]:
    from db_pool import set_local_statement_timeout

    set_local_statement_timeout(conn, TOPOLOGY_GEOMETRIC_TIMEOUT_MS)
    tol = TOPO_ENDPOINT_TOLERANCE_M
    scope = _tier_scope(tier)
    line_bbox, line_params = _clip_sql("als", clip)
    results: dict[str, Any] = {}
    start_near = _endpoint_near_node_sql(
        endpoint_expr="ST_StartPoint(als.geom)", scope=scope
    )
    end_near = _endpoint_near_node_sql(
        endpoint_expr="ST_EndPoint(als.geom)", scope=scope
    )

    def _beat(step: str) -> None:
        if heartbeat:
            try:
                heartbeat(step)
            except Exception:
                logger.debug("geometric topology heartbeat failed", exc_info=True)

    # National / multi-district clips: skip all geography-heavy geometric rules.
    # ST_Distance / ST_DWithin over ~1M lines dominates scan time; topological
    # dangling/orphan/endpoint phases already cover national queue needs.
    # District clips (span ≤ TOPO_CROSSING_MAX_SPAN_DEG) keep full coverage.
    run_geom = _should_run_line_crossings(clip)
    results["geom_mismatch_inserted"] = 0
    results["geom_dangling_inserted"] = 0
    results["crossing_inserted"] = 0
    results["geom_mismatch_skipped"] = not run_geom
    results["geom_dangling_skipped"] = not run_geom
    results["crossing_skipped"] = not run_geom

    with conn.cursor() as cur:
        if not run_geom:
            logger.info(
                "Skipping geometric topology upserts for large/national clip "
                "(span=%.2f°)",
                _clip_span_deg(clip) if clip else -1,
            )
        else:
            assert clip is not None
            _beat("geom_mismatch")
            cur.execute(
                f"""
                INSERT INTO {scope["exc"]} (
                  record_type, record_mrid, rule_code, severity, error_message, details
                )
                SELECT
                  '{scope["record_type"]}',
                  als.mrid,
                  'TOPO_LINE_ENDPOINT_GEOM_MISMATCH',
                  r.severity,
                  'Line geometry endpoint is not coincident with its assigned connectivity node.',
                  jsonb_build_object(
                    'tolerance_m', %s,
                    'start_distance_m',
                      ST_Distance(ST_StartPoint(als.geom)::geography, src.geom::geography),
                    'end_distance_m',
                      ST_Distance(ST_EndPoint(als.geom)::geography, tgt.geom::geography),
                    'source_node_id', als.source_node_id::text,
                    'target_node_id', als.target_node_id::text
                  )
                FROM {scope["als"]} als
                JOIN {scope["io"]} io ON io.mrid = als.mrid
                JOIN {scope["cn"]} src ON src.mrid = als.source_node_id
                JOIN {scope["cn"]} tgt ON tgt.mrid = als.target_node_id
                JOIN public.data_quality_rules r ON r.rule_code = 'TOPO_LINE_ENDPOINT_GEOM_MISMATCH'
                WHERE r.enabled = TRUE
                  AND {scope["line_active"]}
                {line_bbox}
                  AND (
                    ST_Distance(ST_StartPoint(als.geom)::geography, src.geom::geography) > %s
                    OR ST_Distance(ST_EndPoint(als.geom)::geography, tgt.geom::geography) > %s
                  )
                ON CONFLICT (record_mrid, rule_code) WHERE status = 'OPEN'
                DO NOTHING
                """,
                [tol, *line_params, tol, tol],
            )
            results["geom_mismatch_inserted"] = cur.rowcount

            _beat("geom_dangling")
            cur.execute(
                f"""
                INSERT INTO {scope["exc"]} (
                  record_type, record_mrid, rule_code, severity, error_message, details
                )
                SELECT
                  '{scope["record_type"]}',
                  als.mrid,
                  'TOPO_GEOM_DANGLING_ENDPOINT',
                  r.severity,
                  'Line geometry endpoint is not within tolerance of any connectivity node.',
                  jsonb_build_object(
                    'tolerance_m', %s,
                    'start_dangling', NOT {start_near},
                    'end_dangling', NOT {end_near}
                  )
                FROM {scope["als"]} als
                JOIN {scope["io"]} io ON io.mrid = als.mrid
                JOIN public.data_quality_rules r ON r.rule_code = 'TOPO_GEOM_DANGLING_ENDPOINT'
                WHERE r.enabled = TRUE
                  AND {scope["line_active"]}
                {line_bbox}
                  AND (
                    NOT {start_near}
                    OR NOT {end_near}
                  )
                ON CONFLICT (record_mrid, rule_code) WHERE status = 'OPEN'
                DO NOTHING
                """,
                [tol, tol, tol, *line_params, tol, tol],
            )
            results["geom_dangling_inserted"] = cur.rowcount

            _beat("geom_crossings")
            cur.execute(
                f"""
                INSERT INTO {scope["exc"]} (
                  record_type, record_mrid, rule_code, severity, error_message, details
                )
                SELECT DISTINCT ON (a.mrid)
                  '{scope["record_type"]}',
                  a.mrid,
                  'TOPO_LINE_CROSSING_WITHOUT_NODE',
                  r.severity,
                  'Line crosses another segment with no connectivity node at the intersection.',
                  jsonb_build_object(
                    'tolerance_m', %s,
                    'crosses_mrid', b.mrid::text,
                    'intersection',
                      ST_AsGeoJSON(ST_Intersection(a.geom, b.geom))::jsonb
                  )
                FROM {scope["als"]} a
                JOIN {scope["io"]} aio ON aio.mrid = a.mrid
                JOIN {scope["als"]} b ON a.mrid < b.mrid
                JOIN {scope["io"]} bio ON bio.mrid = b.mrid
                JOIN public.data_quality_rules r ON r.rule_code = 'TOPO_LINE_CROSSING_WITHOUT_NODE'
                WHERE r.enabled = TRUE
                  AND {scope["line_active"].replace("io.", "aio.")}
                  AND {scope["line_active"].replace("io.", "bio.")}
                  AND a.geom && b.geom
                  AND ST_Crosses(a.geom, b.geom)
                  AND a.geom && ST_MakeEnvelope(%s, %s, %s, %s, 4326)
                  AND NOT EXISTS (
                    SELECT 1 FROM {scope["cn"]} cn
                    JOIN {scope["nio"]} nio ON nio.mrid = cn.mrid
                    WHERE {scope["node_active"]}
                      AND cn.geom && ST_Expand(ST_Intersection(a.geom, b.geom)::geometry, {_TOPO_TOLERANCE_DEG})
                      AND ST_DWithin(
                        ST_Intersection(a.geom, b.geom)::geography,
                        cn.geom::geography,
                        %s
                      )
                  )
                ORDER BY a.mrid, b.mrid
                ON CONFLICT (record_mrid, rule_code) WHERE status = 'OPEN'
                DO NOTHING
                """,
                [
                    tol,
                    clip["west"],
                    clip["south"],
                    clip["east"],
                    clip["north"],
                    tol,
                ],
            )
            results["crossing_inserted"] = cur.rowcount

    if include_live_counts:
        _beat("geom_live_counts")
        live = geometric_topology_live_counts(conn, clip=clip, tier=tier)
        results["live"] = live
    else:
        # Inserted counts are enough for the batch snapshot; avoid a second
        # national geography pass that can take as long as the upserts.
        results["live"] = {
            "geom_endpoint_mismatch": int(results.get("geom_mismatch_inserted") or 0),
            "geom_dangling_endpoints": int(results.get("geom_dangling_inserted") or 0),
            "line_crossings_without_node": int(results.get("crossing_inserted") or 0),
        }
    return results
