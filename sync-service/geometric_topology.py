"""Geometric topology DQ — ArcGIS-style endpoint snap and dangle checks."""

from __future__ import annotations

import os
from typing import Any, Literal

TopologyTier = Literal["master", "staging"]

# Matches staging topology repair snap threshold (00057).
TOPO_ENDPOINT_TOLERANCE_M = float(os.getenv("TOPO_ENDPOINT_TOLERANCE_M", "1.0"))
TOPOLOGY_MASTER_LIVE_TIMEOUT_MS = int(
    os.getenv("TOPOLOGY_MASTER_LIVE_TIMEOUT_MS", "120000")
)
TOPOLOGY_STAGING_LIVE_TIMEOUT_MS = int(
    os.getenv("TOPOLOGY_STAGING_LIVE_TIMEOUT_MS", "30000")
)


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
                NOT EXISTS (
                  SELECT 1 FROM {scope["cn"]} cn
                  JOIN {scope["nio"]} nio ON nio.mrid = cn.mrid
                  WHERE {scope["node_active"]}
                    AND ST_DWithin(
                      ST_StartPoint(als.geom)::geography,
                      cn.geom::geography,
                      %s
                    )
                )
                OR NOT EXISTS (
                  SELECT 1 FROM {scope["cn"]} cn
                  JOIN {scope["nio"]} nio ON nio.mrid = cn.mrid
                  WHERE {scope["node_active"]}
                    AND ST_DWithin(
                      ST_EndPoint(als.geom)::geography,
                      cn.geom::geography,
                      %s
                    )
                )
              )
            """,
            [*line_params, tol, tol],
        )
        geom_dangling = int(cur.fetchone()[0])

        crossing = 0
        if clip:
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
              AND EXISTS (
                SELECT 1 FROM {scope["cn"]} cn
                JOIN {scope["nio"]} nio ON nio.mrid = cn.mrid
                WHERE {scope["node_active"]}
                  AND ST_DWithin(ST_StartPoint(als.geom)::geography, cn.geom::geography, %s)
              )
              AND EXISTS (
                SELECT 1 FROM {scope["cn"]} cn
                JOIN {scope["nio"]} nio ON nio.mrid = cn.mrid
                WHERE {scope["node_active"]}
                  AND ST_DWithin(ST_EndPoint(als.geom)::geography, cn.geom::geography, %s)
              )
            """,
            [*line_params, tol, tol],
        )
        cleared += cur.rowcount

    return cleared


def bulk_upsert_geometric_topology(conn, *, clip: dict[str, float] | None, tier: TopologyTier) -> dict[str, Any]:
    tol = TOPO_ENDPOINT_TOLERANCE_M
    scope = _tier_scope(tier)
    line_bbox, line_params = _clip_sql("als", clip)
    results: dict[str, Any] = {}

    with conn.cursor() as cur:
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
                'start_dangling',
                  NOT EXISTS (
                    SELECT 1 FROM {scope["cn"]} cn
                    JOIN {scope["nio"]} nio ON nio.mrid = cn.mrid
                    WHERE {scope["node_active"]}
                      AND ST_DWithin(
                        ST_StartPoint(als.geom)::geography,
                        cn.geom::geography,
                        %s
                      )
                  ),
                'end_dangling',
                  NOT EXISTS (
                    SELECT 1 FROM {scope["cn"]} cn
                    JOIN {scope["nio"]} nio ON nio.mrid = cn.mrid
                    WHERE {scope["node_active"]}
                      AND ST_DWithin(
                        ST_EndPoint(als.geom)::geography,
                        cn.geom::geography,
                        %s
                      )
                  )
              )
            FROM {scope["als"]} als
            JOIN {scope["io"]} io ON io.mrid = als.mrid
            JOIN public.data_quality_rules r ON r.rule_code = 'TOPO_GEOM_DANGLING_ENDPOINT'
            WHERE r.enabled = TRUE
              AND {scope["line_active"]}
            {line_bbox}
              AND (
                NOT EXISTS (
                  SELECT 1 FROM {scope["cn"]} cn
                  JOIN {scope["nio"]} nio ON nio.mrid = cn.mrid
                  WHERE {scope["node_active"]}
                    AND ST_DWithin(
                      ST_StartPoint(als.geom)::geography,
                      cn.geom::geography,
                      %s
                    )
                )
                OR NOT EXISTS (
                  SELECT 1 FROM {scope["cn"]} cn
                  JOIN {scope["nio"]} nio ON nio.mrid = cn.mrid
                  WHERE {scope["node_active"]}
                    AND ST_DWithin(
                      ST_EndPoint(als.geom)::geography,
                      cn.geom::geography,
                      %s
                    )
                )
              )
            ON CONFLICT (record_mrid, rule_code) WHERE status = 'OPEN'
            DO NOTHING
            """,
            [tol, tol, tol, *line_params, tol, tol],
        )
        results["geom_dangling_inserted"] = cur.rowcount

        results["crossing_inserted"] = 0
        if clip:
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

    live = geometric_topology_live_counts(conn, clip=clip, tier=tier)
    results["live"] = live
    return results
