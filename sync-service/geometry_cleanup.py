"""Geometry-based GIS steward cleanup — scan, propose, and execute district repairs."""

from __future__ import annotations

import json
from typing import Any

from agents import repository
from agents.audit import log_agent_step
from gis_import import TOPO_ENDPOINT_TOLERANCE_M, unpromoted_segments_summary

DEFAULT_TIER_A_M = 5.0
DEFAULT_TIER_B_M = 15.0
GEOM_CLEANUP_PLAN_TYPE = "district_geom_clean"


def _endpoint_side(
    *,
    text_id: str | None,
    lookup_ok: bool,
    nearest_id: str | None,
    dist_m: float | None,
    tolerance_m: float,
    assisted_m: float,
) -> dict[str, Any]:
    raw = (text_id or "").strip()
    if lookup_ok:
        return {
            "text_id": raw or None,
            "lookup_ok": True,
            "nearest_pole_id": raw or None,
            "distance_m": round(dist_m, 3) if dist_m is not None else 0.0,
            "tier": "resolved",
            "suggested_id": raw or None,
        }

    tier = "manual"
    suggested = None
    if raw:
        # classify via SQL in preview path; here use distance heuristics only
        pass
    if nearest_id and dist_m is not None:
        if dist_m <= tolerance_m:
            tier = "tier_a"
            suggested = nearest_id
        elif dist_m <= assisted_m:
            tier = "tier_b"
            suggested = nearest_id
    return {
        "text_id": raw or None,
        "lookup_ok": False,
        "nearest_pole_id": nearest_id,
        "distance_m": round(dist_m, 3) if dist_m is not None else None,
        "tier": tier,
        "suggested_id": suggested,
    }


def preview_geom_snap_candidate(
    conn,
    segment_id: int,
    *,
    tolerance_m: float = DEFAULT_TIER_A_M,
    assisted_m: float = DEFAULT_TIER_B_M,
) -> dict[str, Any]:
    """Inspect one unpromoted segment: endpoint IDs, nearest poles, distances, tiers."""
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT
              cs.id,
              cs.source_layer,
              cs.source_fid,
              cs.district,
              cs.voltage_class,
              cs.originating_node_id,
              cs.end_node_id,
              s.reason,
              gis.as_linestring(cs.geom) AS line_geom,
              src_l.unique_id IS NOT NULL AS start_ok,
              tgt_l.unique_id IS NOT NULL AS end_ok,
              src_l.mrid::text AS start_mrid,
              tgt_l.mrid::text AS end_mrid
            FROM gis.conductor_segments cs
            LEFT JOIN gis.conductor_import_status s ON s.id = cs.id
            LEFT JOIN gis.unique_id_lookup src_l
              ON src_l.unique_id = btrim(cs.originating_node_id)
            LEFT JOIN gis.unique_id_lookup tgt_l
              ON tgt_l.unique_id = btrim(cs.end_node_id)
            WHERE cs.id = %s
            """,
            (segment_id,),
        )
        row = cur.fetchone()
    if not row:
        raise ValueError("segment_not_found")

    line_geom = row[8]
    if line_geom is None:
        raise ValueError("invalid_geom")

    with conn.cursor() as cur:
        cur.execute(
            "SELECT ST_StartPoint(%s::geometry), ST_EndPoint(%s::geometry)",
            (line_geom, line_geom),
        )
        start_pt, end_pt = cur.fetchone()
        cur.execute(
            """
            SELECT am.source_unique_id,
                   ST_Distance(%s::geography, am.geom::geography)
            FROM gis.asset_id_map am
            WHERE am.source_layer LIKE 'oh_support_structure%%' AND am.geom IS NOT NULL
            ORDER BY am.geom <-> %s::geometry
            LIMIT 1
            """,
            (start_pt, start_pt),
        )
        ns = cur.fetchone()
        cur.execute(
            """
            SELECT am.source_unique_id,
                   ST_Distance(%s::geography, am.geom::geography)
            FROM gis.asset_id_map am
            WHERE am.source_layer LIKE 'oh_support_structure%%' AND am.geom IS NOT NULL
            ORDER BY am.geom <-> %s::geometry
            LIMIT 1
            """,
            (end_pt, end_pt),
        )
        ne = cur.fetchone()

    start = _endpoint_side(
        text_id=row[5],
        lookup_ok=bool(row[9]),
        nearest_id=ns[0] if ns else None,
        dist_m=float(ns[1]) if ns else None,
        tolerance_m=tolerance_m,
        assisted_m=assisted_m,
    )
    end = _endpoint_side(
        text_id=row[6],
        lookup_ok=bool(row[10]),
        nearest_id=ne[0] if ne else None,
        dist_m=float(ne[1]) if ne else None,
        tolerance_m=tolerance_m,
        assisted_m=assisted_m,
    )

    promotable_after_tier_a = (
        (start["lookup_ok"] or start["tier"] == "tier_a")
        and (end["lookup_ok"] or end["tier"] == "tier_a")
        and (
            (start.get("suggested_id") or start.get("text_id"))
            != (end.get("suggested_id") or end.get("text_id"))
        )
    )

    return {
        "segment_id": row[0],
        "source_layer": row[1],
        "source_fid": row[2],
        "district": row[3],
        "voltage_class": row[4],
        "reason": row[7],
        "start": start,
        "end": end,
        "start_node_mrid": row[11],
        "end_node_mrid": row[12],
        "promotable_after_tier_a": promotable_after_tier_a,
        "tolerance_m": tolerance_m,
        "assisted_m": assisted_m,
    }


def scan_district_geom_cleanup(
    conn,
    district: str,
    *,
    tolerance_m: float = DEFAULT_TIER_A_M,
    assisted_m: float = DEFAULT_TIER_B_M,
    sample_limit: int = 5,
) -> dict[str, Any]:
    """Classify unpromoted segments in a district by geometry-distance cleanup tier."""
    district = (district or "").strip()
    if not district:
        raise ValueError("district is required")

    summary = unpromoted_segments_summary(conn, district=district)

    with conn.cursor() as cur:
        cur.execute(
            """
            WITH unpromoted AS (
              SELECT cs.id, cs.originating_node_id, cs.end_node_id,
                     gis.as_linestring(cs.geom) AS line_geom,
                     src_l.unique_id IS NOT NULL AS start_ok,
                     tgt_l.unique_id IS NOT NULL AS end_ok
              FROM gis.conductor_import_status s
              JOIN gis.conductor_segments cs ON cs.id = s.id
              LEFT JOIN gis.unique_id_lookup src_l
                ON src_l.unique_id = btrim(cs.originating_node_id)
              LEFT JOIN gis.unique_id_lookup tgt_l
                ON tgt_l.unique_id = btrim(cs.end_node_id)
              WHERE s.reason <> 'already_promoted'
                AND btrim(cs.district) = %s
                AND cs.geom IS NOT NULL
                AND gis.as_linestring(cs.geom) IS NOT NULL
            ),
            nearest AS (
              SELECT
                u.*,
                ns.pole_id AS start_nearest,
                ns.dist_m AS start_dist_m,
                ne.pole_id AS end_nearest,
                ne.dist_m AS end_dist_m
              FROM unpromoted u
              LEFT JOIN LATERAL (
                SELECT am.source_unique_id AS pole_id,
                       ST_Distance(ST_StartPoint(u.line_geom)::geography, am.geom::geography) AS dist_m
                FROM gis.asset_id_map am
                WHERE am.source_layer LIKE 'oh_support_structure%%'
                  AND am.geom IS NOT NULL
                ORDER BY am.geom <-> ST_StartPoint(u.line_geom)
                LIMIT 1
              ) ns ON NOT u.start_ok
              LEFT JOIN LATERAL (
                SELECT am.source_unique_id AS pole_id,
                       ST_Distance(ST_EndPoint(u.line_geom)::geography, am.geom::geography) AS dist_m
                FROM gis.asset_id_map am
                WHERE am.source_layer LIKE 'oh_support_structure%%'
                  AND am.geom IS NOT NULL
                ORDER BY am.geom <-> ST_EndPoint(u.line_geom)
                LIMIT 1
              ) ne ON NOT u.end_ok
            ),
            classified AS (
              SELECT
                n.id,
                CASE
                  WHEN (n.start_ok OR (n.start_dist_m IS NOT NULL AND n.start_dist_m <= %s))
                   AND (n.end_ok OR (n.end_dist_m IS NOT NULL AND n.end_dist_m <= %s))
                   AND COALESCE(n.start_nearest, btrim(n.originating_node_id))
                       IS DISTINCT FROM COALESCE(n.end_nearest, btrim(n.end_node_id))
                   AND NOT gis.is_customer_equipment_id(btrim(COALESCE(n.originating_node_id, '')))
                   AND NOT gis.is_customer_equipment_id(btrim(COALESCE(n.end_node_id, '')))
                  THEN 'tier_a'
                  WHEN (
                    (NOT n.start_ok AND n.start_dist_m IS NOT NULL AND n.start_dist_m <= %s)
                    OR (NOT n.end_ok AND n.end_dist_m IS NOT NULL AND n.end_dist_m <= %s)
                  )
                  AND NOT gis.is_customer_equipment_id(btrim(COALESCE(n.originating_node_id, '')))
                  AND NOT gis.is_customer_equipment_id(btrim(COALESCE(n.end_node_id, '')))
                  THEN 'tier_b'
                  ELSE 'tier_c'
                END AS tier
              FROM nearest n
            )
            SELECT tier, COUNT(*)::bigint FROM classified GROUP BY 1
            """,
            (district, tolerance_m, tolerance_m, assisted_m, assisted_m),
        )
        tiers = {tier: int(count) for tier, count in cur.fetchall()}

        cur.execute(
            """
            WITH unpromoted AS (
              SELECT cs.id, cs.source_layer, cs.source_fid, cs.originating_node_id, cs.end_node_id,
                     s.reason, gis.as_linestring(cs.geom) AS line_geom,
                     src_l.unique_id IS NOT NULL AS start_ok,
                     tgt_l.unique_id IS NOT NULL AS end_ok
              FROM gis.conductor_import_status s
              JOIN gis.conductor_segments cs ON cs.id = s.id
              LEFT JOIN gis.unique_id_lookup src_l
                ON src_l.unique_id = btrim(cs.originating_node_id)
              LEFT JOIN gis.unique_id_lookup tgt_l
                ON tgt_l.unique_id = btrim(cs.end_node_id)
              WHERE s.reason <> 'already_promoted'
                AND btrim(cs.district) = %s
                AND cs.geom IS NOT NULL
                AND gis.as_linestring(cs.geom) IS NOT NULL
            ),
            nearest AS (
              SELECT u.*,
                     ns.pole_id AS start_nearest, ns.dist_m AS start_dist_m,
                     ne.pole_id AS end_nearest, ne.dist_m AS end_dist_m
              FROM unpromoted u
              LEFT JOIN LATERAL (
                SELECT am.source_unique_id AS pole_id,
                       ST_Distance(ST_StartPoint(u.line_geom)::geography, am.geom::geography) AS dist_m
                FROM gis.asset_id_map am
                WHERE am.source_layer LIKE 'oh_support_structure%%' AND am.geom IS NOT NULL
                ORDER BY am.geom <-> ST_StartPoint(u.line_geom) LIMIT 1
              ) ns ON NOT u.start_ok
              LEFT JOIN LATERAL (
                SELECT am.source_unique_id AS pole_id,
                       ST_Distance(ST_EndPoint(u.line_geom)::geography, am.geom::geography) AS dist_m
                FROM gis.asset_id_map am
                WHERE am.source_layer LIKE 'oh_support_structure%%' AND am.geom IS NOT NULL
                ORDER BY am.geom <-> ST_EndPoint(u.line_geom) LIMIT 1
              ) ne ON NOT u.end_ok
            )
            SELECT id FROM nearest n
            WHERE (n.start_ok OR (n.start_dist_m IS NOT NULL AND n.start_dist_m <= %s))
              AND (n.end_ok OR (n.end_dist_m IS NOT NULL AND n.end_dist_m <= %s))
              AND COALESCE(n.start_nearest, btrim(n.originating_node_id))
                  IS DISTINCT FROM COALESCE(n.end_nearest, btrim(n.end_node_id))
            ORDER BY LEAST(COALESCE(n.start_dist_m, 0), COALESCE(n.end_dist_m, 0))
            LIMIT %s
            """,
            (district, tolerance_m, tolerance_m, sample_limit),
        )
        sample_ids = [int(r[0]) for r in cur.fetchall()]

    samples = []
    for seg_id in sample_ids:
        try:
            samples.append(preview_geom_snap_candidate(conn, seg_id, tolerance_m=tolerance_m, assisted_m=assisted_m))
        except ValueError:
            continue

    return {
        "district": district,
        "tolerance_m": tolerance_m,
        "assisted_m": assisted_m,
        "unpromoted_summary": summary,
        "tiers": {
            "tier_a_auto": tiers.get("tier_a", 0),
            "tier_b_assisted": tiers.get("tier_b", 0),
            "tier_c_manual": tiers.get("tier_c", 0),
        },
        "sample_candidates": samples,
    }


def propose_district_geom_cleanup(
    conn,
    district: str,
    *,
    tolerance_m: float = DEFAULT_TIER_A_M,
    assisted_m: float = DEFAULT_TIER_B_M,
    operator_id: str | None = None,
    run_id: str | None = None,
) -> dict[str, Any]:
    """Scan district and queue an approval-gated geometry cleanup plan (no writes)."""
    scan = scan_district_geom_cleanup(
        conn,
        district,
        tolerance_m=tolerance_m,
        assisted_m=assisted_m,
    )
    tier_a = scan["tiers"]["tier_a_auto"]
    if tier_a <= 0:
        raise ValueError("no_tier_a_candidates")

    plan = {
        "type": GEOM_CLEANUP_PLAN_TYPE,
        "district": district,
        "tolerance_m": tolerance_m,
        "assisted_m": assisted_m,
        "tiers": scan["tiers"],
        "unpromoted_summary": scan["unpromoted_summary"],
        "steps": [
            f"Infer endpoint IDs from nearest poles within {tolerance_m}m (Tier A)",
            "Snap conductor geometry to resolved poles",
            f"Promote eligible segments in {district} to master",
            "Refresh import pipeline statistics",
        ],
        "risk": "medium",
    }
    rationale = (
        f"Geometry cleanup for {district}: {tier_a:,} Tier A segments "
        f"(pole within {tolerance_m}m). Infer IDs → snap → district promote."
    )

    cleanup_id = repository.insert_cleanup_action(
        conn,
        exception_id=None,
        run_id=run_id,
        target_mrid=None,
        mode="ASSISTED",
        status="proposed",
        plan=plan,
        rollback_sql="-- Restore prior originating_node_id/end_node_id from steward export if needed",
        qgis_steps=f"Review Tier A samples in {district} on map before approve.",
    )
    approval_id = repository.create_approval_request(
        conn,
        cleanup_id=cleanup_id,
        exception_id=None,
        rationale=rationale,
    )
    conn.commit()

    log_agent_step(
        conn,
        run_id=run_id,
        agent_name="GeometryStewardAgent",
        tool_name="propose_district_geom_cleanup",
        policy_decision="proposed",
        output_summary={"district": district, "tier_a": tier_a, "cleanup_id": cleanup_id},
    )
    conn.commit()

    return {
        "cleanup_id": cleanup_id,
        "approval_id": approval_id,
        "plan": plan,
        "scan": scan,
        "operator_id": operator_id,
    }


def execute_geom_cleanup_proposal(
    conn,
    cleanup_id: str,
    *,
    operator_id: str | None = None,
    force: bool = False,
) -> dict[str, Any]:
    """Run approved district geometry cleanup: infer → snap → district promote."""
    action = repository.get_cleanup_action(conn, cleanup_id)
    if not action:
        raise ValueError("cleanup_not_found")
    if action["status"] not in ("approved", "proposed") and not force:
        raise ValueError(f"status_{action['status']}_blocks_execution")

    plan = action.get("plan") or {}
    if plan.get("type") != GEOM_CLEANUP_PLAN_TYPE:
        raise ValueError("not_a_geom_cleanup_plan")

    district = (plan.get("district") or "").strip()
    if not district:
        raise ValueError("district_missing_in_plan")

    tolerance_m = float(plan.get("tolerance_m") or DEFAULT_TIER_A_M)

    with conn.cursor() as cur:
        cur.execute(
            "SELECT gis.infer_conductor_endpoint_ids_tier_a(%s, %s)",
            (tolerance_m, district),
        )
        infer_result = cur.fetchone()[0]

        cur.execute("SELECT gis.snap_eligible_conductor_endpoints(%s)", (TOPO_ENDPOINT_TOLERANCE_M,))
        snap_result = cur.fetchone()[0]

        cur.execute("SELECT gis.promote_conductors_for_district(%s)", (district,))
        promote_result = cur.fetchone()[0]

        cur.execute("SELECT gis.refresh_conductor_import_status()")
        refresh_result = cur.fetchone()[0]

        cur.execute("SELECT public.refresh_connected_node_mrids()")
        connected_result = cur.fetchone()[0]

    repository.update_cleanup_status(
        conn,
        cleanup_id,
        status="executed",
        executed_by=operator_id,
    )
    conn.commit()

    return {
        "cleanup_id": cleanup_id,
        "status": "executed",
        "district": district,
        "infer": infer_result if isinstance(infer_result, dict) else json.loads(infer_result or "{}"),
        "snap": snap_result if isinstance(snap_result, dict) else snap_result,
        "promote": promote_result if isinstance(promote_result, dict) else promote_result,
        "import_status": refresh_result if isinstance(refresh_result, dict) else refresh_result,
        "connected_nodes": connected_result if isinstance(connected_result, dict) else connected_result,
    }
