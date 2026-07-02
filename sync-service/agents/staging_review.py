"""Staging review analytics and per-asset assessment for field → master workflow."""

from __future__ import annotations

from typing import Any

from data_quality import run_asset_checks

_TERRITORY_JOIN = """
LEFT JOIN LATERAL (
  SELECT
    NULLIF(btrim(b.region::text), '') AS region,
    NULLIF(btrim(b.district::text), '') AS district
  FROM gis.ecg_admin_boundaries b
  WHERE cn.geom IS NOT NULL AND ST_Within(cn.geom, b.geom)
  ORDER BY ST_Area(b.geom::geography) ASC
  LIMIT 1
) territory ON TRUE
"""


def staging_summary(conn) -> dict[str, Any]:
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT io.validation::text, COUNT(*)::int
            FROM staging.identified_objects io
            GROUP BY io.validation
            """
        )
        by_validation = {row[0]: row[1] for row in cur.fetchall()}
        cur.execute(
            """
            SELECT COUNT(*)::int
            FROM staging.identified_objects io
            WHERE io.validation <> 'REJECTED'
            """
        )
        pending_total = int(cur.fetchone()[0])
        cur.execute(
            """
            SELECT COUNT(*)::int
            FROM staging.identified_objects io
            WHERE io.validation = 'IN_CONFLICT'
            """
        )
        conflicts = int(cur.fetchone()[0])
        cur.execute(
            """
            SELECT COUNT(DISTINCT io.submitted_by)::int
            FROM staging.identified_objects io
            WHERE io.submitted_by IS NOT NULL AND io.validation <> 'REJECTED'
            """
        )
        field_workers = int(cur.fetchone()[0])
    return {
        "pending_total": pending_total,
        "by_validation": by_validation,
        "in_conflict": conflicts,
        "active_field_workers": field_workers,
        "tier": "staging",
    }


def staging_territory_counts(
    conn,
    *,
    region: str | None = None,
    district: str | None = None,
    validation: str | None = None,
    limit: int = 100,
) -> list[dict[str, Any]]:
    filters = ["io.validation <> 'REJECTED'"]
    params: list[Any] = []
    if validation:
        filters.append("io.validation = %s::staging_validation_state")
        params.append(validation.upper())
    if region:
        filters.append("territory.region ILIKE %s")
        params.append(f"%{region.strip()}%")
    if district:
        filters.append("territory.district ILIKE %s")
        params.append(f"%{district.strip()}%")
    where = " AND ".join(filters)
    params.append(limit)
    with conn.cursor() as cur:
        cur.execute(
            f"""
            SELECT
              COALESCE(territory.region, 'Unknown') AS region,
              COALESCE(territory.district, 'Unknown') AS district,
              io.validation::text,
              COUNT(*)::int
            FROM staging.connectivity_nodes cn
            JOIN staging.identified_objects io ON io.mrid = cn.mrid
            {_TERRITORY_JOIN}
            WHERE {where}
            GROUP BY territory.region, territory.district, io.validation
            ORDER BY COUNT(*) DESC
            LIMIT %s
            """,
            params,
        )
        rows = cur.fetchall()
    return [
        {
            "region": r[0],
            "district": r[1],
            "validation": r[2],
            "count": r[3],
        }
        for r in rows
    ]


def staging_territory_totals(
    conn,
    *,
    group_by: str = "district",
    region: str | None = None,
    limit: int = 50,
) -> list[dict[str, Any]]:
    """Aggregate staging asset counts by ECG region or district."""
    if group_by not in ("region", "district"):
        group_by = "district"
    label = "territory.region" if group_by == "region" else "territory.district"
    filters = ["io.validation <> 'REJECTED'", "cn.geom IS NOT NULL"]
    params: list[Any] = []
    if region:
        filters.append("territory.region ILIKE %s")
        params.append(f"%{region.strip()}%")
    where = " AND ".join(filters)
    params.append(limit)
    with conn.cursor() as cur:
        cur.execute(
            f"""
            SELECT
              COALESCE({label}, 'Unknown') AS territory,
              COUNT(*)::int AS asset_count,
              COUNT(*) FILTER (WHERE io.validation = 'PENDING_FIELD')::int AS pending_field,
              COUNT(*) FILTER (WHERE io.validation = 'STAGED')::int AS staged,
              COUNT(*) FILTER (WHERE io.validation = 'IN_CONFLICT')::int AS in_conflict
            FROM staging.connectivity_nodes cn
            JOIN staging.identified_objects io ON io.mrid = cn.mrid
            {_TERRITORY_JOIN}
            WHERE {where}
            GROUP BY {label}
            ORDER BY asset_count DESC
            LIMIT %s
            """,
            params,
        )
        rows = cur.fetchall()
    return [
        {
            "territory": r[0],
            "group_by": group_by,
            "asset_count": r[1],
            "pending_field": r[2],
            "staged": r[3],
            "in_conflict": r[4],
        }
        for r in rows
    ]


def list_staging_queue(
    conn,
    *,
    validation: str | None = None,
    region: str | None = None,
    district: str | None = None,
    submitted_by: str | None = None,
    limit: int = 50,
) -> list[dict[str, Any]]:
    filters = ["io.validation <> 'REJECTED'"]
    params: list[Any] = []
    if validation:
        filters.append("io.validation = %s::staging_validation_state")
        params.append(validation.upper())
    if submitted_by:
        filters.append("io.submitted_by = %s")
        params.append(submitted_by)
    if region:
        filters.append("territory.region ILIKE %s")
        params.append(f"%{region.strip()}%")
    if district:
        filters.append("territory.district ILIKE %s")
        params.append(f"%{district.strip()}%")
    where = " AND ".join(filters)
    params.append(limit)
    with conn.cursor() as cur:
        cur.execute(
            f"""
            SELECT
              cn.mrid::text,
              io.name,
              io.validation::text,
              cn.boundary_feeder_id,
              io.submitted_by,
              io.updated_at,
              ST_X(cn.geom) AS lon,
              ST_Y(cn.geom) AS lat,
              territory.region,
              territory.district
            FROM staging.connectivity_nodes cn
            JOIN staging.identified_objects io ON io.mrid = cn.mrid
            {_TERRITORY_JOIN}
            WHERE {where}
            ORDER BY io.updated_at DESC
            LIMIT %s
            """,
            params,
        )
        rows = cur.fetchall()
    return [
        {
            "mrid": r[0],
            "name": r[1],
            "validation": r[2],
            "boundary_feeder_id": r[3],
            "submitted_by": r[4],
            "updated_at": r[5].isoformat() if r[5] else None,
            "lon": r[6],
            "lat": r[7],
            "region": r[8],
            "district": r[9],
            "tier": "staging",
        }
        for r in rows
    ]


def get_staging_asset(conn, mrid: str) -> dict[str, Any] | None:
    items = list_staging_queue(conn, limit=500)
    for item in items:
        if item["mrid"] == mrid:
            return item
    with conn.cursor() as cur:
        cur.execute(
            f"""
            SELECT
              cn.mrid::text,
              io.name,
              io.validation::text,
              cn.boundary_feeder_id,
              io.submitted_by,
              io.updated_at,
              ST_X(cn.geom) AS lon,
              ST_Y(cn.geom) AS lat,
              territory.region,
              territory.district
            FROM staging.connectivity_nodes cn
            JOIN staging.identified_objects io ON io.mrid = cn.mrid
            {_TERRITORY_JOIN}
            WHERE cn.mrid = %s::uuid
            """,
            (mrid,),
        )
        row = cur.fetchone()
    if not row:
        return None
    return {
        "mrid": row[0],
        "name": row[1],
        "validation": row[2],
        "boundary_feeder_id": row[3],
        "submitted_by": row[4],
        "updated_at": row[5].isoformat() if row[5] else None,
        "lon": row[6],
        "lat": row[7],
        "region": row[8],
        "district": row[9],
        "tier": "staging",
    }


def review_staging_asset(conn, mrid: str) -> dict[str, Any]:
    """Run DQ checks on staging asset and return steward recommendation (no promote)."""
    asset = get_staging_asset(conn, mrid)
    if not asset:
        raise ValueError(f"Staging asset {mrid} not found")

    checks = run_asset_checks(conn, mrid, "staging")
    open_failures = checks.get("failures") or []

    nearby_master = 0
    if asset.get("lon") is not None and asset.get("lat") is not None:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT COUNT(*)::int
                FROM public.connectivity_nodes cn
                WHERE cn.geom IS NOT NULL
                  AND ST_DWithin(
                    cn.geom::geography,
                    ST_SetSRID(ST_MakePoint(%s, %s), 4326)::geography,
                    100
                  )
                """,
                (asset["lon"], asset["lat"]),
            )
            nearby_master = int(cur.fetchone()[0])

    recommendation = "review_manually"
    rationale_parts: list[str] = []
    if asset["validation"] == "IN_CONFLICT":
        recommendation = "resolve_conflict"
        rationale_parts.append("Asset is IN_CONFLICT — compare field vs master before promote.")
    elif open_failures:
        recommendation = "fix_dq_then_review"
        rationale_parts.append(f"{len(open_failures)} open DQ failure(s) on staging tier.")
    elif asset["validation"] == "PENDING_FIELD" and not open_failures:
        recommendation = "release_to_operations"
        rationale_parts.append(
            "DQ checks passed — release from Data Quality to Operations (STAGED) before promote."
        )
    elif asset["validation"] == "STAGED" and not open_failures:
        recommendation = "ready_for_steward_approve"
        rationale_parts.append("Released from DQ — steward may approve promote to master.")
    else:
        rationale_parts.append(f"Validation state is {asset['validation']}.")

    if nearby_master == 0 and asset.get("region"):
        rationale_parts.append("No master nodes within 100m — verify connectivity in map.")
    elif nearby_master > 0:
        rationale_parts.append(f"{nearby_master} master node(s) within 100m.")

    return {
        "asset": asset,
        "dq_checks": checks,
        "open_failures": open_failures,
        "nearby_master_count": nearby_master,
        "recommendation": recommendation,
        "rationale": " ".join(rationale_parts),
        "next_step": (
            "Steward approves in Operations tab to promote_staged_asset"
            if recommendation == "ready_for_steward_approve"
            else "Release to Operations in Data Quality tab"
            if recommendation == "release_to_operations"
            else "Inspect in Operations or Map tab before promote"
        ),
    }
