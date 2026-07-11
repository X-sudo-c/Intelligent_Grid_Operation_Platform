"""Steward-reviewed endpoint fix proposals — GIS import and staging CIM lines."""

from __future__ import annotations

import hashlib
import os
import uuid
from typing import Any, Literal
from uuid import UUID

from endpoint_proposal_tier import DataTier, normalize_data_tier, tier_config

BulkReviewFilter = Literal["tier_a", "ai_high", "ai_agrees"]

AI_CLAIM_TTL_SEC = max(60, int(os.getenv("GIOP_ENDPOINT_AI_CLAIM_TTL_SEC", "600")))
TOPOLOGY_TOLERANCE_M = 1.0
MAX_SNAP_MOVE_M = 150.0


def _as_linestring_geom(geom: Any) -> dict[str, Any] | None:
    """MapLibre highlight layers expect LineString; GIS segments are often MultiLineString."""
    if not isinstance(geom, dict):
        return None
    gtype = geom.get("type")
    coords = geom.get("coordinates")
    if gtype == "LineString" and isinstance(coords, list) and len(coords) >= 2:
        return {"type": "LineString", "coordinates": coords}
    if gtype == "MultiLineString" and isinstance(coords, list) and coords:
        # Prefer the longest part (vertex count) so short spur parts do not win.
        best: list[Any] | None = None
        for part in coords:
            if not isinstance(part, list) or len(part) < 2:
                continue
            if best is None or len(part) > len(best):
                best = part
        if best is None:
            return None
        return {"type": "LineString", "coordinates": best}
    return None


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
    _enrich_proposal_topology_fields(data)
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


def _enrich_proposal_topology_fields(data: dict[str, Any]) -> None:
    """Geometry-first flags: can snap align IDs to line ends for Memgraph-safe promote."""

    def _effective_gap(
        stored: Any,
        current_id: Any,
        proposed_id: Any,
    ) -> float | None:
        if stored is not None:
            return float(stored)
        cur = str(current_id).strip() if current_id is not None else ""
        prop = str(proposed_id).strip() if proposed_id is not None else ""
        if cur and prop and cur == prop:
            return 0.0
        return None

    start_g = _effective_gap(
        data.get("start_dist_m"),
        data.get("current_from"),
        data.get("proposed_from"),
    )
    end_g = _effective_gap(
        data.get("end_dist_m"),
        data.get("current_to"),
        data.get("proposed_to"),
    )
    gaps = [g for g in (start_g, end_g) if g is not None]
    max_gap = max(gaps) if gaps else None
    data["max_gap_m"] = max_gap
    if max_gap is None:
        data["topology_ready"] = False
        data["topology_aligned"] = False
    else:
        data["topology_aligned"] = max_gap <= TOPOLOGY_TOLERANCE_M
        data["topology_ready"] = max_gap <= MAX_SNAP_MOVE_M
    if (
        start_g == 0.0
        and end_g == 0.0
        and str(data.get("current_from") or "").strip() == str(data.get("proposed_from") or "").strip()
        and str(data.get("current_to") or "").strip() == str(data.get("proposed_to") or "").strip()
    ):
        data["topology_noop"] = True


def _geometry_scan_lock_key(district: str, data_tier: str) -> int:
    """Stable advisory-lock key per district/tier geometry scan."""
    digest = hashlib.sha256(
        f"endpoint_fix_geom:{data_tier}:{district.strip().lower()}".encode()
    ).digest()
    return int.from_bytes(digest[:8], "big") & 0x7FFFFFFFFFFFFFFF


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
    lock_key = _geometry_scan_lock_key(district, tier)
    with conn.cursor() as cur:
        cur.execute("SELECT pg_try_advisory_lock(%s)", (lock_key,))
        locked = bool(cur.fetchone()[0])
        if not locked:
            raise ValueError(
                f"Geometry scan already running for {district}. Wait for it to finish or retry in a minute."
            )
        try:
            timeout_ms = max(30_000, int(os.getenv("GIOP_ENDPOINT_GEOM_SCAN_TIMEOUT_MS", "180000")))
            cur.execute("SET LOCAL statement_timeout = %s", (f"{timeout_ms}ms",))
            cur.execute(
                f"""
                SELECT {cfg["generate_fn"]}(
                  %s, %s, %s, %s, %s, %s
                )
                """,
                (district, tolerance_m, assisted_m, limit, include_tier_b, replace_pending),
            )
            row = cur.fetchone()
        finally:
            cur.execute("SELECT pg_advisory_unlock(%s)", (lock_key,))
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


_ASSET_KIND_LABELS: dict[str, str] = {
    "pole_11kv": "11 kV pole",
    "pole_33kv": "33 kV pole",
    "pole_lv": "LV pole",
    "distribution_transformer": "DT",
    "power_transformer": "PT",
    "connectivity_asset": "asset",
}


def _asset_kind_label(kind: str | None) -> str:
    if not kind:
        return "asset"
    return _ASSET_KIND_LABELS.get(kind, kind.replace("_", " "))


def _end_role(role: str) -> str:
    return "from" if role == "start" else "to"


def _point_map_label(*, role: str, node_id: str, proposed: bool, asset_kind: str | None) -> str:
    end = "FROM" if role == "start" else "TO"
    if proposed:
        kind = _asset_kind_label(asset_kind)
        if asset_kind:
            return f"{end} → {kind}: {node_id}"
        return f"{end} → {node_id}"
    return f"{end}: {node_id}"


def _point_feature(
    *,
    role: str,
    lon: float,
    lat: float,
    node_id: str,
    resolved: bool,
    proposed: bool = False,
    asset_kind: str | None = None,
) -> dict[str, Any]:
    map_label = _point_map_label(
        role=role, node_id=node_id, proposed=proposed, asset_kind=asset_kind
    )
    return {
        "type": "Feature",
        "properties": {
            "role": role,
            "end_role": _end_role(role),
            "node_id": map_label,
            "map_label": map_label,
            "asset_id": node_id,
            "asset_kind": asset_kind,
            "resolved": resolved,
            "proposed": proposed,
        },
        "geometry": {"type": "Point", "coordinates": [lon, lat]},
    }


def _link_feature(
    *,
    role: str,
    from_lon: float,
    from_lat: float,
    to_lon: float,
    to_lat: float,
    asset_id: str,
    asset_kind: str | None,
    dist_m: float | None,
) -> dict[str, Any]:
    dist_label = f"{float(dist_m):.1f} m" if dist_m is not None else None
    end = "FROM" if role == "start" else "TO"
    return {
        "type": "Feature",
        "properties": {
            "role": role,
            "end_role": _end_role(role),
            "asset_id": asset_id,
            "asset_kind": asset_kind,
            "dist_m": dist_m,
            "dist_label": dist_label,
            "map_label": f"{end} gap · {dist_label}" if dist_label else f"{end} gap",
        },
        "geometry": {
            "type": "LineString",
            "coordinates": [[from_lon, from_lat], [to_lon, to_lat]],
        },
    }


def _fallback_topology_alignment(
    *,
    start_dist_m: float | None,
    end_dist_m: float | None,
    current_from: str | None,
    current_to: str | None,
    proposed_from: str | None,
    proposed_to: str | None,
    district_from_resolved: bool,
    district_to_resolved: bool,
) -> dict[str, Any]:
    """When DB migration is not applied yet, derive coarse alignment from scan distances."""

    def _effective(stored: float | None, cur: str | None, prop: str | None) -> float | None:
        if stored is not None:
            return float(stored)
        c = (cur or "").strip()
        p = (prop or "").strip()
        if c and p and c == p:
            return 0.0
        return None

    start_g = _effective(start_dist_m, current_from, proposed_from)
    end_g = _effective(end_dist_m, current_to, proposed_to)
    gaps = [g for g in (start_g, end_g) if g is not None]
    max_gap = max(gaps) if gaps else None
    snap_ready = max_gap is not None and max_gap <= MAX_SNAP_MOVE_M
    return {
        "district_from_resolved": district_from_resolved,
        "district_to_resolved": district_to_resolved,
        "start_gap_m": start_g,
        "end_gap_m": end_g,
        "max_gap_m": max_gap,
        "snap_ready": snap_ready,
        "topology_ready": snap_ready,
        "snap_action": "fallback",
    }


def _endpoint_ids_match(a: str | None, b: str | None) -> bool:
    return (a or "").strip().casefold() == (b or "").strip().casefold()


def _gap_link_needed(
    *,
    current: str | None,
    proposed: str | None,
    live_dist_m: float | None,
    stored_dist_m: float | None,
) -> bool:
    if not (proposed or "").strip():
        return False
    live = float(live_dist_m) if live_dist_m is not None else None
    stored = float(stored_dist_m) if stored_dist_m is not None else None
    dist = live if live is not None else stored
    if dist is not None and dist <= 0.05:
        return False
    if dist is not None and dist > MAX_SNAP_MOVE_M:
        return False
    if (
        live is not None
        and stored is not None
        and live > max(stored * 3, TOPOLOGY_TOLERANCE_M * 5)
        and live > 50
    ):
        return False
    if _endpoint_ids_match(current, proposed):
        if dist is None or dist <= TOPOLOGY_TOLERANCE_M:
            return False
    return True


def _gap_dist_label(live_dist_m: float | None, stored_dist_m: float | None) -> float | None:
    live = float(live_dist_m) if live_dist_m is not None else None
    stored = float(stored_dist_m) if stored_dist_m is not None else None
    if live is not None and stored is not None:
        if live > max(stored * 3, TOPOLOGY_TOLERANCE_M * 5) and live > 50:
            return stored
    if live is not None:
        return live
    if stored is not None:
        return stored
    return None


def endpoint_fix_proposal_map_preview(conn, proposal_id: str) -> dict[str, Any]:
    """Map overlay: as-built line, district-scoped proposed nodes, snapped post-repair line."""
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT
              p.id,
              p.segment_id,
              p.district,
              p.current_from,
              p.current_to,
              p.proposed_from,
              p.proposed_to,
              p.proposed_from_kind,
              p.proposed_to_kind,
              p.start_dist_m,
              p.end_dist_m,
              p.tier,
              ST_AsGeoJSON(ST_Force2D(cs.geom))::json AS line_geom,
              ST_X(ST_StartPoint(ST_Force2D(cs.geom))) AS start_lon,
              ST_Y(ST_StartPoint(ST_Force2D(cs.geom))) AS start_lat,
              ST_X(ST_EndPoint(ST_Force2D(cs.geom))) AS end_lon,
              ST_Y(ST_EndPoint(ST_Force2D(cs.geom))) AS end_lat,
              (src.mrid IS NOT NULL) AS start_resolved,
              (tgt.mrid IS NOT NULL) AS end_resolved,
              ST_X(pfl.geom) AS prop_from_lon,
              ST_Y(pfl.geom) AS prop_from_lat,
              pfl.live_dist_m AS prop_from_gap_m,
              ST_X(ptl.geom) AS prop_to_lon,
              ST_Y(ptl.geom) AS prop_to_lat,
              ptl.live_dist_m AS prop_to_gap_m,
              (pfl.geom IS NOT NULL) AS district_from_resolved,
              (ptl.geom IS NOT NULL) AS district_to_resolved,
              ST_XMin(ST_Envelope(cs.geom)) AS west,
              ST_YMin(ST_Envelope(cs.geom)) AS south,
              ST_XMax(ST_Envelope(cs.geom)) AS east,
              ST_YMax(ST_Envelope(cs.geom)) AS north
            FROM gis.conductor_endpoint_proposals p
            JOIN gis.conductor_segments cs ON cs.id = p.segment_id
            LEFT JOIN LATERAL gis.resolve_endpoint(cs.district, cs.originating_node_id) src ON TRUE
            LEFT JOIN LATERAL gis.resolve_endpoint(cs.district, cs.end_node_id) tgt ON TRUE
            LEFT JOIN LATERAL (
              SELECT
                l.geom,
                ST_Distance(
                  ST_StartPoint(ST_Force2D(cs.geom))::geography,
                  l.geom::geography
                ) AS live_dist_m
              FROM gis.district_endpoint_lookup l
              WHERE l.district = cs.district
                AND btrim(l.unique_id) = btrim(p.proposed_from)
                AND ST_DWithin(
                  l.geom::geography,
                  ST_StartPoint(ST_Force2D(cs.geom))::geography,
                  GREATEST(COALESCE(p.start_dist_m, 15.0) * 4.0, 20.0)
                )
              ORDER BY l.geom <-> ST_StartPoint(ST_Force2D(cs.geom))
              LIMIT 1
            ) pfl ON btrim(COALESCE(p.proposed_from, '')) <> ''
            LEFT JOIN LATERAL (
              SELECT
                l.geom,
                ST_Distance(
                  ST_EndPoint(ST_Force2D(cs.geom))::geography,
                  l.geom::geography
                ) AS live_dist_m
              FROM gis.district_endpoint_lookup l
              WHERE l.district = cs.district
                AND btrim(l.unique_id) = btrim(p.proposed_to)
                AND ST_DWithin(
                  l.geom::geography,
                  ST_EndPoint(ST_Force2D(cs.geom))::geography,
                  GREATEST(COALESCE(p.end_dist_m, 15.0) * 4.0, 20.0)
                )
              ORDER BY l.geom <-> ST_EndPoint(ST_Force2D(cs.geom))
              LIMIT 1
            ) ptl ON btrim(COALESCE(p.proposed_to, '')) <> ''
            WHERE p.id = %s::uuid
            """,
            (proposal_id,),
        )
        row = cur.fetchone()

    if not row:
        raise ValueError("proposal_not_found")

    (
        _pid,
        segment_id,
        district,
        current_from,
        current_to,
        proposed_from,
        proposed_to,
        proposed_from_kind,
        proposed_to_kind,
        start_dist_m,
        end_dist_m,
        tier,
        line_geom,
        start_lon,
        start_lat,
        end_lon,
        end_lat,
        start_resolved,
        end_resolved,
        prop_from_lon,
        prop_from_lat,
        prop_from_gap_m,
        prop_to_lon,
        prop_to_lat,
        prop_to_gap_m,
        district_from_resolved,
        district_to_resolved,
        west,
        south,
        east,
        north,
    ) = row

    alignment: dict[str, Any] = {}
    with conn.cursor() as cur:
        try:
            cur.execute(
                """
                SELECT gis.preview_endpoint_topology_alignment(
                  %s::bigint, %s::text, %s::text, %s::text, %s::double precision, %s::double precision
                )
                """,
                (
                    int(segment_id),
                    district,
                    proposed_from,
                    proposed_to,
                    TOPOLOGY_TOLERANCE_M,
                    MAX_SNAP_MOVE_M,
                ),
            )
            align_row = cur.fetchone()
            if align_row and align_row[0]:
                alignment = align_row[0] if isinstance(align_row[0], dict) else {}
        except Exception as exc:
            if getattr(exc, "pgcode", None) != "42883":
                raise
            alignment = _fallback_topology_alignment(
                start_dist_m=start_dist_m,
                end_dist_m=end_dist_m,
                current_from=current_from,
                current_to=current_to,
                proposed_from=proposed_from,
                proposed_to=proposed_to,
                district_from_resolved=bool(district_from_resolved),
                district_to_resolved=bool(district_to_resolved),
            )

    line_before_features: list[dict[str, Any]] = []
    line_before_geom = _as_linestring_geom(line_geom)
    if line_before_geom:
        line_before_features.append(
            {
                "type": "Feature",
                "properties": {"segment_id": segment_id, "tier": tier, "role": "before"},
                "geometry": line_before_geom,
            }
        )

    snapped_geom = _as_linestring_geom(alignment.get("snapped_line"))
    line_features: list[dict[str, Any]] = []
    if snapped_geom:
        line_features.append(
            {
                "type": "Feature",
                "properties": {
                    "segment_id": segment_id,
                    "tier": tier,
                    "role": "after_snap",
                },
                "geometry": snapped_geom,
            }
        )
    elif line_before_features:
        line_features = [
            {
                **line_before_features[0],
                "properties": {**line_before_features[0]["properties"], "role": "as_built"},
            }
        ]

    endpoint_features: list[dict[str, Any]] = []
    if start_lon is not None and start_lat is not None:
        endpoint_features.append(
            _point_feature(
                role="start",
                lon=float(start_lon),
                lat=float(start_lat),
                node_id=current_from or "start",
                resolved=bool(start_resolved),
            )
        )
    if end_lon is not None and end_lat is not None:
        endpoint_features.append(
            _point_feature(
                role="end",
                lon=float(end_lon),
                lat=float(end_lat),
                node_id=current_to or "end",
                resolved=bool(end_resolved),
            )
        )

    proposed_features: list[dict[str, Any]] = []
    link_features: list[dict[str, Any]] = []

    if prop_from_lon is not None and prop_from_lat is not None and proposed_from:
        proposed_features.append(
            _point_feature(
                role="start",
                lon=float(prop_from_lon),
                lat=float(prop_from_lat),
                node_id=proposed_from,
                resolved=True,
                proposed=True,
                asset_kind=proposed_from_kind,
            )
        )
        if (
            start_lon is not None
            and start_lat is not None
            and _gap_link_needed(
                current=current_from,
                proposed=proposed_from,
                live_dist_m=prop_from_gap_m,
                stored_dist_m=start_dist_m,
            )
        ):
            link_features.append(
                _link_feature(
                    role="start",
                    from_lon=float(start_lon),
                    from_lat=float(start_lat),
                    to_lon=float(prop_from_lon),
                    to_lat=float(prop_from_lat),
                    asset_id=proposed_from,
                    asset_kind=proposed_from_kind,
                    dist_m=_gap_dist_label(prop_from_gap_m, start_dist_m),
                )
            )

    if prop_to_lon is not None and prop_to_lat is not None and proposed_to:
        proposed_features.append(
            _point_feature(
                role="end",
                lon=float(prop_to_lon),
                lat=float(prop_to_lat),
                node_id=proposed_to,
                resolved=True,
                proposed=True,
                asset_kind=proposed_to_kind,
            )
        )
        if (
            end_lon is not None
            and end_lat is not None
            and _gap_link_needed(
                current=current_to,
                proposed=proposed_to,
                live_dist_m=prop_to_gap_m,
                stored_dist_m=end_dist_m,
            )
        ):
            link_features.append(
                _link_feature(
                    role="end",
                    from_lon=float(end_lon),
                    from_lat=float(end_lat),
                    to_lon=float(prop_to_lon),
                    to_lat=float(prop_to_lat),
                    asset_id=proposed_to,
                    asset_kind=proposed_to_kind,
                    dist_m=_gap_dist_label(prop_to_gap_m, end_dist_m),
                )
            )

    bbox = None
    focus_lons: list[float] = []
    focus_lats: list[float] = []
    for lon, lat in (
        (start_lon, start_lat),
        (end_lon, end_lat),
        (prop_from_lon, prop_from_lat),
        (prop_to_lon, prop_to_lat),
    ):
        if lon is not None and lat is not None:
            focus_lons.append(float(lon))
            focus_lats.append(float(lat))
    if focus_lons and focus_lats:
        pad = 0.00015
        bbox = {
            "west": min(focus_lons) - pad,
            "south": min(focus_lats) - pad,
            "east": max(focus_lons) + pad,
            "north": max(focus_lats) + pad,
        }
    elif None not in (west, south, east, north):
        bbox = {
            "west": float(west),
            "south": float(south),
            "east": float(east),
            "north": float(north),
        }

    from_lbl = _asset_kind_label(proposed_from_kind)
    to_lbl = _asset_kind_label(proposed_to_kind)
    label = f"{district or 'GIS'} · {from_lbl} → {to_lbl} · {tier or 'proposal'}"

    return {
        "proposal_id": proposal_id,
        "segment_id": int(segment_id),
        "label": label,
        "proposed_from": proposed_from,
        "proposed_to": proposed_to,
        "proposed_from_kind": proposed_from_kind,
        "proposed_to_kind": proposed_to_kind,
        "topology": {
            **alignment,
            "district_from_resolved": bool(district_from_resolved),
            "district_to_resolved": bool(district_to_resolved),
        },
        "geojson": {
            "line": {"type": "FeatureCollection", "features": line_features},
            "line_before": {"type": "FeatureCollection", "features": line_before_features},
            "endpoints": {"type": "FeatureCollection", "features": endpoint_features},
            "proposed_assets": {"type": "FeatureCollection", "features": proposed_features},
            "suggested_links": {"type": "FeatureCollection", "features": link_features},
        },
        "bbox": bbox,
    }
