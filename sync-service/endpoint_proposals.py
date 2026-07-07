"""Steward-reviewed endpoint fix proposals — GIS import and staging CIM lines."""

from __future__ import annotations

import os
import uuid
from typing import Any, Literal
from uuid import UUID

from endpoint_proposal_tier import DataTier, normalize_data_tier, tier_config

BulkReviewFilter = Literal["tier_a", "ai_high", "ai_agrees"]

AI_CLAIM_TTL_SEC = max(60, int(os.getenv("GIOP_ENDPOINT_AI_CLAIM_TTL_SEC", "600")))


def _row_to_proposal(row: tuple, columns: list[str], *, data_tier: DataTier) -> dict[str, Any]:
    data = dict(zip(columns, row, strict=True))
    for key in ("id", "batch_id"):
        if data.get(key) is not None:
            data[key] = str(data[key])
    for key in ("created_at", "reviewed_at", "applied_at"):
        if data.get(key) is not None:
            data[key] = data[key].isoformat()
    for key in ("start_dist_m", "end_dist_m"):
        if data.get(key) is not None:
            data[key] = float(data[key])
    if data.get("ai_scan_id") is not None:
        data["ai_scan_id"] = str(data["ai_scan_id"])
    if data.get("ai_claim_token") is not None:
        data["ai_claim_token"] = str(data["ai_claim_token"])
    for key in ("ai_claimed_at", "ai_claim_expires_at"):
        if data.get(key) is not None:
            data[key] = data[key].isoformat()

    data["data_tier"] = data_tier
    if data_tier == "staging":
        segment_mrid = data.pop("segment_mrid", None)
        if segment_mrid is not None:
            data["segment_mrid"] = str(segment_mrid)
            data["segment_id"] = 0
        for src_key, dst_key in (
            ("current_source", "current_from"),
            ("current_target", "current_to"),
            ("proposed_source", "proposed_from"),
            ("proposed_target", "proposed_to"),
            ("start_nearest", "start_nearest_pole"),
            ("end_nearest", "end_nearest_pole"),
        ):
            if src_key in data:
                val = data.pop(src_key)
                data[dst_key] = str(val) if val is not None else None
    return data


def generate_endpoint_fix_proposals(
    conn,
    district: str,
    *,
    data_tier: DataTier | str = "gis",
    tolerance_m: float = 5.0,
    assisted_m: float = 15.0,
    limit: int = 5000,
    include_tier_b: bool = True,
    replace_pending: bool = False,
) -> dict[str, Any]:
    tier = normalize_data_tier(data_tier)
    cfg = tier_config(tier)
    district = (district or "").strip()
    if not district:
        raise ValueError("district is required")
    if tier == "staging":
        tolerance_m = min(tolerance_m, 5.0) if tolerance_m > 5.0 else tolerance_m
        assisted_m = min(assisted_m, 15.0) if assisted_m > 15.0 else assisted_m
    with conn.cursor() as cur:
        cur.execute(
            f"""
            SELECT {cfg["generate_fn"]}(
              %s, %s, %s, %s, %s, %s
            )
            """,
            (district, tolerance_m, assisted_m, limit, include_tier_b, replace_pending),
        )
        row = cur.fetchone()
    conn.commit()
    result = row[0] if row else {}
    if isinstance(result, dict):
        result.setdefault("data_tier", tier)
    return result


def list_endpoint_fix_proposals(
    conn,
    *,
    data_tier: DataTier | str = "gis",
    district: str | None = None,
    status: str | None = "pending",
    tier: str | None = None,
    batch_id: str | None = None,
    unscanned_only: bool = False,
    limit: int = 50,
    offset: int = 0,
) -> dict[str, Any]:
    tier_name = normalize_data_tier(data_tier)
    cfg = tier_config(tier_name)
    table = cfg["proposals_table"]
    columns = cfg["columns"]
    order_col = cfg["order_col"]

    clauses = ["1=1"]
    params: list[Any] = []
    if district:
        clauses.append("district = %s")
        params.append(district.strip())
    if status:
        clauses.append("status = %s")
        params.append(status)
    if tier:
        clauses.append("tier = %s")
        params.append(tier)
    if batch_id:
        clauses.append("batch_id = %s::uuid")
        params.append(batch_id)
    if unscanned_only:
        clauses.append("ai_rationale IS NULL")
    where_sql = " AND ".join(clauses)
    with conn.cursor() as cur:
        cur.execute(f"SELECT COUNT(*) FROM {table} WHERE {where_sql}", params)
        total = int(cur.fetchone()[0])
        cur.execute(
            f"""
            SELECT {", ".join(columns)}
            FROM {table}
            WHERE {where_sql}
            ORDER BY
              CASE tier WHEN 'tier_a' THEN 0 ELSE 1 END,
              created_at DESC,
              {order_col}
            LIMIT %s OFFSET %s
            """,
            [*params, limit, offset],
        )
        rows = cur.fetchall()
    return {
        "data_tier": tier_name,
        "total": total,
        "limit": limit,
        "offset": offset,
        "proposals": [_row_to_proposal(r, columns, data_tier=tier_name) for r in rows],
    }


def review_endpoint_fix_proposals(
    conn,
    proposal_ids: list[str],
    *,
    data_tier: DataTier | str = "gis",
    status: str,
    reviewed_by: str | None = None,
) -> dict[str, Any]:
    if status not in ("approved", "rejected"):
        raise ValueError("status must be approved or rejected")
    if not proposal_ids:
        raise ValueError("proposal_ids required")
    tier_name = normalize_data_tier(data_tier)
    table = tier_config(tier_name)["proposals_table"]
    ids = [str(UUID(pid)) for pid in proposal_ids]
    with conn.cursor() as cur:
        cur.execute(
            f"""
            UPDATE {table}
            SET status = %s,
                reviewed_at = now(),
                reviewed_by = %s
            WHERE id = ANY(%s::uuid[])
              AND status = 'pending'
            RETURNING id
            """,
            (status, reviewed_by, ids),
        )
        updated = [str(row[0]) for row in cur.fetchall()]
    conn.commit()
    return {"updated": len(updated), "proposal_ids": updated, "status": status, "data_tier": tier_name}


def apply_endpoint_fix_proposals(
    conn,
    *,
    data_tier: DataTier | str = "gis",
    proposal_ids: list[str] | None = None,
    district: str | None = None,
    operator_id: str | None = None,
) -> dict[str, Any]:
    tier_name = normalize_data_tier(data_tier)
    apply_fn = tier_config(tier_name)["apply_fn"]
    uuid_ids = None
    if proposal_ids:
        uuid_ids = [str(UUID(pid)) for pid in proposal_ids]
    district_val = (district or "").strip() or None
    with conn.cursor() as cur:
        cur.execute(
            f"""
            SELECT {apply_fn}(%s::uuid[], %s, %s)
            """,
            (uuid_ids, district_val, operator_id),
        )
        row = cur.fetchone()
    conn.commit()
    result = row[0] if row else {}
    if isinstance(result, dict):
        result.setdefault("data_tier", tier_name)
    return result


def endpoint_fix_proposal_summary(
    conn,
    district: str | None = None,
    *,
    data_tier: DataTier | str = "gis",
) -> dict[str, Any]:
    tier_name = normalize_data_tier(data_tier)
    table = tier_config(tier_name)["proposals_table"]
    district_val = (district or "").strip() or None
    with conn.cursor() as cur:
        if district_val:
            cur.execute(
                f"""
                SELECT status, tier, COUNT(*)::bigint
                FROM {table}
                WHERE district = %s
                GROUP BY status, tier
                """,
                (district_val,),
            )
        else:
            cur.execute(
                f"""
                SELECT status, tier, COUNT(*)::bigint
                FROM {table}
                GROUP BY status, tier
                """
            )
        rows = cur.fetchall()
    summary: dict[str, Any] = {
        "data_tier": tier_name,
        "by_status_tier": {},
        "pending": 0,
        "approved": 0,
    }
    for status, tier, count in rows:
        summary["by_status_tier"][f"{status}:{tier}"] = int(count)
        if status == "pending":
            summary["pending"] += int(count)
        if status == "approved":
            summary["approved"] += int(count)
    return summary


def count_pending_unscanned(conn, district: str, *, data_tier: DataTier | str = "gis") -> int:
    """Unscanned rows available to claim (excludes active claims held by other workers)."""
    tier_name = normalize_data_tier(data_tier)
    table = tier_config(tier_name)["proposals_table"]
    district_val = (district or "").strip()
    if not district_val:
        return 0
    with conn.cursor() as cur:
        cur.execute(
            f"""
            SELECT COUNT(*)::bigint
            FROM {table}
            WHERE district = %s
              AND status = 'pending'
              AND ai_rationale IS NULL
              AND (ai_claim_expires_at IS NULL OR ai_claim_expires_at < now())
            """,
            (district_val,),
        )
        return int(cur.fetchone()[0])


def count_pending_without_ai_review(
    conn, district: str, *, data_tier: DataTier | str = "gis"
) -> int:
    """All pending rows not yet AI-reviewed (includes in-flight claims)."""
    tier_name = normalize_data_tier(data_tier)
    table = tier_config(tier_name)["proposals_table"]
    district_val = (district or "").strip()
    if not district_val:
        return 0
    with conn.cursor() as cur:
        cur.execute(
            f"""
            SELECT COUNT(*)::bigint
            FROM {table}
            WHERE district = %s
              AND status = 'pending'
              AND ai_rationale IS NULL
            """,
            (district_val,),
        )
        return int(cur.fetchone()[0])


def release_ai_scan_claims(
    conn, claim_token: str, *, data_tier: DataTier | str = "gis"
) -> int:
    tier_name = normalize_data_tier(data_tier)
    table = tier_config(tier_name)["proposals_table"]
    with conn.cursor() as cur:
        cur.execute(
            f"""
            UPDATE {table}
            SET ai_claim_token = NULL,
                ai_claimed_at = NULL,
                ai_claim_expires_at = NULL
            WHERE ai_claim_token = %s::uuid
              AND ai_rationale IS NULL
            """,
            (claim_token,),
        )
        released = cur.rowcount
    conn.commit()
    return released


def claim_proposals_for_ai_scan(
    conn,
    district: str,
    limit: int,
    *,
    data_tier: DataTier | str = "gis",
) -> tuple[str | None, list[dict[str, Any]]]:
    """Claim up to `limit` unscanned pending rows for one swarm worker (SKIP LOCKED)."""
    tier_name = normalize_data_tier(data_tier)
    cfg = tier_config(tier_name)
    table = cfg["proposals_table"]
    columns = cfg["columns"]
    order_col = cfg["order_col"]
    district_val = (district or "").strip()
    if not district_val:
        return None, []
    if limit < 1:
        return None, []
    claim_token = str(uuid.uuid4())
    cols = ", ".join(f"p.{c}" for c in columns)
    with conn.cursor() as cur:
        cur.execute(
            f"""
            WITH picked AS (
              SELECT id
              FROM {table}
              WHERE district = %s
                AND status = 'pending'
                AND ai_rationale IS NULL
                AND (ai_claim_expires_at IS NULL OR ai_claim_expires_at < now())
              ORDER BY
                CASE tier WHEN 'tier_a' THEN 0 ELSE 1 END,
                {order_col}
              LIMIT %s
              FOR UPDATE SKIP LOCKED
            )
            UPDATE {table} p
            SET ai_claim_token = %s::uuid,
                ai_claimed_at = now(),
                ai_claim_expires_at = now() + make_interval(secs => %s)
            FROM picked
            WHERE p.id = picked.id
            RETURNING {cols}
            """,
            (district_val, limit, claim_token, float(AI_CLAIM_TTL_SEC)),
        )
        rows = cur.fetchall()
    conn.commit()
    if not rows:
        return None, []
    return claim_token, [
        _row_to_proposal(r, columns, data_tier=tier_name) for r in rows
    ]


def bulk_review_endpoint_fix_proposals(
    conn,
    district: str,
    *,
    data_tier: DataTier | str = "gis",
    filter: BulkReviewFilter,
    reviewed_by: str | None = None,
) -> dict[str, Any]:
    """Approve pending rows matching steward-safe bulk filters."""
    tier_name = normalize_data_tier(data_tier)
    table = tier_config(tier_name)["proposals_table"]
    district_val = (district or "").strip()
    if not district_val:
        raise ValueError("district is required")

    extra = ""
    if filter == "tier_a":
        extra = "AND tier = 'tier_a'"
    elif filter == "ai_high":
        extra = (
            "AND ai_agrees IS TRUE AND ai_confidence = 'high' AND ai_rationale IS NOT NULL"
        )
    elif filter == "ai_agrees":
        extra = "AND ai_agrees IS TRUE AND ai_rationale IS NOT NULL"
    else:
        raise ValueError("invalid bulk filter")

    with conn.cursor() as cur:
        cur.execute(
            f"""
            UPDATE {table}
            SET status = 'approved',
                reviewed_at = now(),
                reviewed_by = %s
            WHERE district = %s
              AND status = 'pending'
              {extra}
            RETURNING id
            """,
            (reviewed_by, district_val),
        )
        updated = [str(row[0]) for row in cur.fetchall()]
    conn.commit()
    return {
        "updated": len(updated),
        "proposal_ids": updated,
        "status": "approved",
        "filter": filter,
        "district": district_val,
        "data_tier": tier_name,
    }
