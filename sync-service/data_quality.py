"""FR-020 data cleansing & validation engine.

Rules run server-side (here), not in the database, so cross-table and
spatial/duplicate logic stays maintainable. Hard integrity stays as DB
constraints; these checks produce reviewable exceptions for stewards.
"""

from __future__ import annotations

import json
import os
import uuid
from typing import Any, Callable

from lineage import log_lineage

# Ghana operating bbox (matches config/martin.yaml): west, south, east, north.
GHANA_BBOX = (-3.5, 4.5, 1.5, 8.5)
STALE_ASSET_DAYS = int(os.getenv("DQ_STALE_ASSET_DAYS", "365"))
_CAPACITY_COLUMN: str | None = None

# rule_code -> (severity, evaluator). Evaluator returns one of:
#   ("FAIL", message, details_dict) | ("PASS", None, None) | ("SKIP", None, None)
RuleResult = tuple[str, str | None, dict[str, Any] | None]


def _r_name(ctx: dict[str, Any]) -> RuleResult:
    name = (ctx.get("name") or "").strip()
    if not name:
        return ("FAIL", "Asset name is missing or empty.", None)
    return ("PASS", None, None)


def _r_geom_required(ctx: dict[str, Any]) -> RuleResult:
    if not ctx.get("geom_present"):
        return ("FAIL", "Connectivity node has no geometry.", None)
    if not ctx.get("geom_valid"):
        return ("FAIL", "Connectivity node geometry is invalid.", None)
    return ("PASS", None, None)


def _r_geom_in_ghana(ctx: dict[str, Any]) -> RuleResult:
    if not ctx.get("geom_present"):
        return ("SKIP", None, None)
    lon, lat = ctx.get("lon"), ctx.get("lat")
    if lon is None or lat is None:
        return ("SKIP", None, None)
    w, s, e, n = GHANA_BBOX
    if not (w <= lon <= e and s <= lat <= n):
        return (
            "FAIL",
            f"Coordinates ({lon:.5f}, {lat:.5f}) fall outside the Ghana bbox.",
            {"longitude": lon, "latitude": lat, "bbox": list(GHANA_BBOX)},
        )
    return ("PASS", None, None)


def _r_feeder(ctx: dict[str, Any]) -> RuleResult:
    if not ctx.get("geom_present"):
        return ("SKIP", None, None)
    if not (ctx.get("feeder") or "").strip():
        return ("FAIL", "Connectivity node has no boundary feeder id.", None)
    return ("PASS", None, None)


def _r_orphan(ctx: dict[str, Any]) -> RuleResult:
    # Orphan topology only meaningful for promoted (master) nodes.
    if ctx.get("tier") != "master":
        return ("SKIP", None, None)
    if ctx.get("line_count", 0) == 0:
        return ("FAIL", "Master node has no connected line segment.", None)
    return ("PASS", None, None)


def _r_voltage(ctx: dict[str, Any]) -> RuleResult:
    if ctx.get("tier") != "master" or not ctx.get("has_equipment"):
        return ("SKIP", None, None)
    if not ctx.get("voltage"):
        return ("FAIL", "Conducting equipment has no nominal voltage.", None)
    return ("PASS", None, None)


def _r_duplicate(ctx: dict[str, Any]) -> RuleResult:
    dup = ctx.get("duplicate")
    if dup is None:
        return ("SKIP" if not ctx.get("geom_present") else "PASS", None, None)
    return (
        "FAIL",
        f"Possible duplicate of {dup['mrid']} ({dup['name']}) ~{dup['distance_m']:.1f}m away.",
        dup,
    )


def _r_geom_valid(ctx: dict[str, Any]) -> RuleResult:
    if not ctx.get("geom_present"):
        return ("SKIP", None, None)
    if not ctx.get("geom_valid"):
        return ("FAIL", "Asset geometry is invalid (ST_IsValid failed).", None)
    return ("PASS", None, None)


def _r_transformer_capacity(ctx: dict[str, Any]) -> RuleResult:
    if not ctx.get("is_transformer"):
        return ("SKIP", None, None)
    if ctx.get("transformer_capacity") is not None:
        return ("PASS", None, None)
    if ctx.get("has_equipment") and ctx.get("equipment_serial"):
        return ("PASS", None, None)
    return ("FAIL", "Transformer must declare rated capacity or equipment serial.", None)


def _r_in_service_boundary(ctx: dict[str, Any]) -> RuleResult:
    if not ctx.get("geom_present"):
        return ("SKIP", None, None)
    if ctx.get("in_ecg_region") is True:
        return ("PASS", None, None)
    if ctx.get("in_ecg_region") is False:
        return ("FAIL", "Asset falls outside all ECG admin regions.", None)
    return ("SKIP", None, None)


def _r_transformer_feeder(ctx: dict[str, Any]) -> RuleResult:
    if not ctx.get("is_transformer") or ctx.get("tier") != "master":
        return ("SKIP", None, None)
    if (ctx.get("feeder") or "").strip() and ctx.get("line_count", 0) > 0:
        return ("PASS", None, None)
    return ("FAIL", "Transformer node must trace to a feeder with connected lines.", None)


def _r_timeliness(ctx: dict[str, Any]) -> RuleResult:
    if ctx.get("tier") != "master":
        return ("SKIP", None, None)
    days = ctx.get("days_since_update")
    if days is None:
        return ("SKIP", None, None)
    if days > STALE_ASSET_DAYS:
        return (
            "FAIL",
            f"Asset not updated in {days} days (threshold {STALE_ASSET_DAYS}).",
            {"days_since_update": days},
        )
    return ("PASS", None, None)


def _r_phases_consistent(ctx: dict[str, Any]) -> RuleResult:
    if not ctx.get("has_equipment"):
        return ("SKIP", None, None)
    phases = (ctx.get("phases") or "").strip()
    if not phases:
        return ("FAIL", "Conducting equipment phases must be declared.", None)
    return ("PASS", None, None)


def _r_voltage_consistent(ctx: dict[str, Any]) -> RuleResult:
    if not ctx.get("has_equipment"):
        return ("SKIP", None, None)
    if ctx.get("voltage"):
        return ("PASS", None, None)
    return ("FAIL", "Connected equipment voltages must be compatible and declared.", None)


def _r_network_only(_ctx: dict[str, Any]) -> RuleResult:
    """Evaluated via batch/graph scans, not per-node."""
    return ("SKIP", None, None)


def _r_batch_only(_ctx: dict[str, Any]) -> RuleResult:
    """Evaluated via batch scans for meters/customers/lines."""
    return ("SKIP", None, None)


RULES: dict[str, Callable[[dict[str, Any]], RuleResult]] = {
    "ASSET_NAME_REQUIRED": _r_name,
    "ASSET_GEOM_REQUIRED": _r_geom_required,
    "ASSET_GEOM_IN_GHANA": _r_geom_in_ghana,
    "ASSET_GEOM_VALID": _r_geom_valid,
    "ASSET_FEEDER_REQUIRED": _r_feeder,
    "ASSET_ORPHAN_NODE": _r_orphan,
    "EQUIP_VOLTAGE_PRESENT": _r_voltage,
    "ASSET_DUPLICATE_NEAR": _r_duplicate,
    "TRANSFORMER_CAPACITY_NOT_NULL": _r_transformer_capacity,
    "ASSET_IN_SERVICE_BOUNDARY": _r_in_service_boundary,
    "TRANSFORMER_CONNECTED_TO_FEEDER": _r_transformer_feeder,
    "FEEDER_NO_DISCONNECTED_SEGMENTS": _r_network_only,
    "TOPO_NETWORK_LOOP": _r_network_only,
    "TOPO_ISLAND_COMPONENT": _r_network_only,
    "LINE_ENDPOINTS_EXIST": _r_batch_only,
    "CUSTOMER_TRACEABLE_TO_TRANSFORMER": _r_batch_only,
    "METER_VALID_CUSTOMER": _r_batch_only,
    "CUSTOMER_VALID_TRANSFORMER": _r_batch_only,
    "ASSET_ID_UNIQUE": _r_batch_only,
    "METER_SERIAL_UNIQUE": _r_batch_only,
    "CUSTOMER_NAME_REQUIRED": _r_batch_only,
    "METER_SERIAL_REQUIRED": _r_batch_only,
    "USAGE_POINT_GEOM_REQUIRED": _r_batch_only,
    "PHASES_CONSISTENT": _r_phases_consistent,
    "VOLTAGE_LEVEL_CONSISTENT": _r_voltage_consistent,
    "SAP_BP_RECONCILIATION": _r_batch_only,
    "MDMS_METER_RECONCILIATION": _r_batch_only,
    "TIMELINESS_STALE_ASSET": _r_timeliness,
    "DUPLICATE_CUSTOMER_ACCOUNT": _r_batch_only,
    "DUPLICATE_METER_SERIAL": _r_batch_only,
    "BILLING_ACCOUNT_ACTIVE": _r_batch_only,
    "FEEDER_TRACE_COMPLETE": _r_network_only,
    "TOPO_DANGLING_LINE_ENDPOINT": _r_batch_only,
    "TOPO_LINE_ENDPOINT_NOT_APPROVED": _r_batch_only,
}


def _enabled_rules(conn) -> dict[str, dict[str, Any]]:
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT rule_code, domain, severity::text, description, blocks_promotion,
                   COALESCE(autofix_allowed, FALSE)
            FROM public.data_quality_rules
            WHERE enabled = TRUE
            """
        )
        rows = cur.fetchall()
    return {
        r[0]: {
            "domain": r[1],
            "severity": r[2],
            "description": r[3],
            "blocks_promotion": r[4],
            "autofix_allowed": r[5],
        }
        for r in rows
    }


def _transformer_capacity_column(conn) -> str | None:
    global _CAPACITY_COLUMN
    if _CAPACITY_COLUMN is not None:
        return _CAPACITY_COLUMN or None
    with conn.cursor() as cur:
        for col in ("rated_kva", "rated_power", "capacity_kva", "kva_rating", "nameplate_kva"):
            cur.execute(
                """
                SELECT 1 FROM information_schema.columns
                WHERE table_schema = 'gis' AND table_name = 'distribution_transformer'
                  AND column_name = %s
                """,
                (col,),
            )
            if cur.fetchone():
                _CAPACITY_COLUMN = col
                return col
    _CAPACITY_COLUMN = ""
    return None


def _build_ctx(conn, mrid: str, tier: str) -> dict[str, Any] | None:
    schema = "staging" if tier == "staging" else "public"
    cap_col = _transformer_capacity_column(conn)
    cap_sql = "NULL::text"
    if cap_col:
        cap_sql = f"""
            (SELECT NULLIF(btrim(dt.{cap_col}::text), '')
             FROM gis.asset_id_map am
             JOIN gis.distribution_transformer dt
               ON dt.fid = am.source_fid AND am.source_layer = 'distribution_transformer'
             WHERE am.mrid = cn.mrid
             LIMIT 1)
        """
    with conn.cursor() as cur:
        cur.execute(
            f"""
            SELECT io.name,
                   cn.boundary_feeder_id,
                   CASE WHEN cn.geom IS NULL THEN NULL ELSE ST_X(cn.geom) END,
                   CASE WHEN cn.geom IS NULL THEN NULL ELSE ST_Y(cn.geom) END,
                   (cn.geom IS NOT NULL) AS geom_present,
                   COALESCE(ST_IsValid(cn.geom), FALSE) AS geom_valid,
                   io.updated_at,
                   EXISTS (
                     SELECT 1 FROM gis.asset_id_map am
                     WHERE am.mrid = cn.mrid
                       AND am.source_layer IN ('distribution_transformer', 'power_transformer')
                   ) AS is_transformer,
                   {cap_sql} AS transformer_capacity,
                   CASE WHEN cn.geom IS NULL THEN NULL ELSE
                     EXISTS (
                       SELECT 1 FROM gis.ecg_admin_regions r
                       WHERE ST_Within(cn.geom, r.geom)
                     )
                   END AS in_ecg_region
            FROM {schema}.identified_objects io
            LEFT JOIN {schema}.connectivity_nodes cn ON cn.mrid = io.mrid
            WHERE io.mrid = %s
            """,
            (mrid,),
        )
        row = cur.fetchone()
        if not row:
            return None
        updated_at = row[6]
        days_since = None
        if updated_at is not None:
            cur.execute("SELECT EXTRACT(DAY FROM NOW() - %s::timestamptz)", (updated_at,))
            days_since = int(cur.fetchone()[0])
        ctx: dict[str, Any] = {
            "mrid": mrid,
            "tier": tier,
            "name": row[0],
            "feeder": row[1],
            "lon": row[2],
            "lat": row[3],
            "geom_present": row[4],
            "geom_valid": row[5],
            "days_since_update": days_since,
            "is_transformer": bool(row[7]),
            "transformer_capacity": row[8],
            "in_ecg_region": row[9],
            "has_equipment": False,
            "voltage": None,
            "phases": None,
            "equipment_serial": None,
            "line_count": 0,
            "duplicate": None,
        }
        if tier == "master":
            cur.execute(
                """
                SELECT nominal_voltage::text, phases, serial_number
                FROM public.conducting_equipment WHERE mrid = %s
                """,
                (mrid,),
            )
            eq = cur.fetchone()
            if eq:
                ctx["has_equipment"] = True
                ctx["voltage"] = eq[0]
                ctx["phases"] = eq[1]
                ctx["equipment_serial"] = eq[2]
            cur.execute(
                """
                SELECT COUNT(*) FROM public.ac_line_segments
                WHERE source_node_id = %s OR target_node_id = %s
                """,
                (mrid, mrid),
            )
            ctx["line_count"] = int(cur.fetchone()[0])

        if ctx["geom_present"] and ctx["lon"] is not None:
            cur.execute(
                """
                SELECT io.mrid::text, io.name,
                       ST_Distance(cn.geom::geography,
                                   ST_SetSRID(ST_MakePoint(%s, %s), 4326)::geography) AS dist_m
                FROM public.connectivity_nodes cn
                JOIN public.identified_objects io ON io.mrid = cn.mrid
                WHERE cn.mrid <> %s::uuid
                  AND ST_DWithin(cn.geom::geography,
                                 ST_SetSRID(ST_MakePoint(%s, %s), 4326)::geography, 5)
                  AND similarity(io.name, %s) > 0.4
                ORDER BY dist_m ASC
                LIMIT 1
                """,
                (ctx["lon"], ctx["lat"], mrid, ctx["lon"], ctx["lat"], ctx["name"] or ""),
            )
            dup = cur.fetchone()
            if dup:
                ctx["duplicate"] = {
                    "mrid": dup[0],
                    "name": dup[1],
                    "distance_m": float(dup[2]),
                }
    return ctx


def run_asset_checks(conn, mrid: str, tier: str) -> dict[str, Any]:
    """Run enabled rules for one asset; upsert/auto-clear exceptions."""
    ctx = _build_ctx(conn, mrid, tier)
    if ctx is None:
        return {"mrid": mrid, "checked": 0, "failures": []}

    rules = _enabled_rules(conn)
    failures: list[dict[str, Any]] = []
    checked = 0
    with conn.cursor() as cur:
        for rule_code, meta in rules.items():
            evaluator = RULES.get(rule_code)
            if evaluator is None:
                continue
            status, message, details = evaluator(ctx)
            if status == "SKIP":
                continue
            checked += 1
            if status == "FAIL":
                cur.execute(
                    """
                    INSERT INTO public.data_quality_exceptions
                      (record_type, record_mrid, rule_code, severity, error_message, details)
                    VALUES ('connectivity_node', %s::uuid, %s, %s::dq_severity, %s, %s::jsonb)
                    ON CONFLICT (record_mrid, rule_code) WHERE status = 'OPEN'
                    DO NOTHING
                    """,
                    (
                        mrid,
                        rule_code,
                        meta["severity"],
                        message,
                        json.dumps(details) if details is not None else None,
                    ),
                )
                failures.append(
                    {"rule_code": rule_code, "severity": meta["severity"], "message": message}
                )
            else:  # PASS — auto-clear any open exception for this rule.
                cur.execute(
                    """
                    UPDATE public.data_quality_exceptions
                    SET status = 'RESOLVED', resolved_at = NOW(),
                        resolved_by = 'system', resolution_note = 'Auto-cleared: rule now passes'
                    WHERE record_mrid = %s::uuid AND rule_code = %s AND status = 'OPEN'
                    """,
                    (mrid, rule_code),
                )
    return {"mrid": mrid, "tier": tier, "checked": checked, "failures": failures}


def upsert_record_exception(
    conn,
    *,
    record_type: str,
    record_mrid: str,
    rule_code: str,
    message: str,
    details: dict[str, Any] | None = None,
    queue_name: str | None = None,
) -> bool:
    """Insert open exception if rule enabled; returns True if inserted."""
    rules = _enabled_rules(conn)
    meta = rules.get(rule_code)
    if not meta:
        return False
    with conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO public.data_quality_exceptions
              (record_type, record_mrid, rule_code, severity, error_message, details, queue_name)
            VALUES (%s, %s::uuid, %s, %s::dq_severity, %s, %s::jsonb, %s)
            ON CONFLICT (record_mrid, rule_code) WHERE status = 'OPEN'
            DO NOTHING
            RETURNING id::text
            """,
            (
                record_type,
                record_mrid,
                rule_code,
                meta["severity"],
                message,
                json.dumps(details) if details is not None else None,
                queue_name,
            ),
        )
        return cur.fetchone() is not None


def upsert_network_topology_exceptions(
    conn,
    *,
    rule_code: str,
    node_mrids: list[str],
    message: str,
    details: dict[str, Any] | None = None,
    queue_name: str | None = "ex_gis_topology",
    limit: int = 20,
) -> int:
    """Upsert topology network findings (loops/islands) into DQ exception queue."""
    inserted = 0
    for mrid in node_mrids[:limit]:
        try:
            uuid.UUID(str(mrid))
        except (ValueError, TypeError):
            continue
        if upsert_record_exception(
            conn,
            record_type="connectivity_node",
            record_mrid=mrid,
            rule_code=rule_code,
            message=message,
            details=details,
            queue_name=queue_name,
        ):
            inserted += 1
    return inserted


def run_meter_batch_checks(conn) -> dict[str, Any]:
    results: dict[str, Any] = {}
    with conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO public.data_quality_exceptions
              (record_type, record_mrid, rule_code, severity, error_message, details)
            SELECT 'meter', m.mrid, 'METER_SERIAL_REQUIRED', r.severity,
                   'Meter serial number must be present.',
                   jsonb_build_object('serial_number', m.serial_number)
            FROM public.meters m
            JOIN public.data_quality_rules r ON r.rule_code = 'METER_SERIAL_REQUIRED'
            WHERE r.enabled AND (m.serial_number IS NULL OR btrim(m.serial_number) = '')
            ON CONFLICT (record_mrid, rule_code) WHERE status = 'OPEN' DO NOTHING
            """
        )
        results["meter_serial_required"] = cur.rowcount

        cur.execute(
            """
            INSERT INTO public.data_quality_exceptions
              (record_type, record_mrid, rule_code, severity, error_message, details)
            SELECT 'meter', d.mrid, 'DUPLICATE_METER_SERIAL', r.severity,
                   'Duplicate meter serial in master.',
                   jsonb_build_object('serial_number', d.serial_number, 'duplicate_count', d.cnt)
            FROM (
              SELECT mrid, serial_number, COUNT(*) OVER (PARTITION BY serial_number) AS cnt
              FROM public.meters WHERE serial_number IS NOT NULL AND btrim(serial_number) <> ''
            ) d
            JOIN public.data_quality_rules r ON r.rule_code = 'DUPLICATE_METER_SERIAL'
            WHERE r.enabled AND d.cnt > 1
            ON CONFLICT (record_mrid, rule_code) WHERE status = 'OPEN' DO NOTHING
            """
        )
        results["duplicate_meter_serial"] = cur.rowcount

        cur.execute(
            """
            INSERT INTO public.data_quality_exceptions
              (record_type, record_mrid, rule_code, severity, error_message, details)
            SELECT 'meter', m.mrid, 'METER_VALID_CUSTOMER', r.severity,
                   'Meter must reference a valid customer usage point.',
                   jsonb_build_object('serial_number', m.serial_number)
            FROM public.meters m
            JOIN public.data_quality_rules r ON r.rule_code = 'METER_VALID_CUSTOMER'
            WHERE r.enabled
              AND NOT EXISTS (SELECT 1 FROM public.usage_points up WHERE up.mrid = m.mrid)
            ON CONFLICT (record_mrid, rule_code) WHERE status = 'OPEN' DO NOTHING
            """
        )
        results["meter_valid_customer"] = cur.rowcount

        cur.execute(
            """
            INSERT INTO public.data_quality_exceptions
              (record_type, record_mrid, rule_code, severity, error_message, details)
            SELECT 'meter', m.mrid, 'MDMS_METER_RECONCILIATION', r.severity,
                   'Meter not linked to usage point (MDMS reconciliation proxy).',
                   jsonb_build_object('serial_number', m.serial_number)
            FROM public.meters m
            JOIN public.data_quality_rules r ON r.rule_code = 'MDMS_METER_RECONCILIATION'
            WHERE r.enabled
              AND NOT EXISTS (SELECT 1 FROM public.usage_points up WHERE up.mrid = m.mrid)
            ON CONFLICT (record_mrid, rule_code) WHERE status = 'OPEN' DO NOTHING
            """
        )
        results["mdms_reconciliation"] = cur.rowcount
    return results


def run_customer_batch_checks(conn) -> dict[str, Any]:
    results: dict[str, Any] = {}
    with conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO public.data_quality_exceptions
              (record_type, record_mrid, rule_code, severity, error_message, details)
            SELECT 'customer_account', ca.account_mrid, 'CUSTOMER_NAME_REQUIRED', r.severity,
                   'Customer name must be present.',
                   jsonb_build_object('account_number', ca.account_number)
            FROM public.customer_accounts ca
            JOIN public.data_quality_rules r ON r.rule_code = 'CUSTOMER_NAME_REQUIRED'
            WHERE r.enabled AND (ca.customer_name IS NULL OR btrim(ca.customer_name) = '')
            ON CONFLICT (record_mrid, rule_code) WHERE status = 'OPEN' DO NOTHING
            """
        )
        results["customer_name_required"] = cur.rowcount

        cur.execute(
            """
            INSERT INTO public.data_quality_exceptions
              (record_type, record_mrid, rule_code, severity, error_message, details)
            SELECT 'customer_account', ca.account_mrid, 'SAP_BP_RECONCILIATION', r.severity,
                   'Customer must reconcile to SAP business partner.',
                   jsonb_build_object('account_number', ca.account_number, 'source_system', ca.source_system)
            FROM public.customer_accounts ca
            JOIN public.data_quality_rules r ON r.rule_code = 'SAP_BP_RECONCILIATION'
            WHERE r.enabled
              AND ca.source_system = 'SAP'
              AND (ca.sap_business_partner_id IS NULL OR btrim(ca.sap_business_partner_id) = '')
            ON CONFLICT (record_mrid, rule_code) WHERE status = 'OPEN' DO NOTHING
            """
        )
        results["sap_bp_reconciliation"] = cur.rowcount

        cur.execute(
            """
            INSERT INTO public.data_quality_exceptions
              (record_type, record_mrid, rule_code, severity, error_message, details)
            SELECT 'customer_account', d.account_mrid, 'DUPLICATE_CUSTOMER_ACCOUNT', r.severity,
                   'Possible duplicate customer account.',
                   jsonb_build_object('account_number', d.account_number, 'duplicate_count', d.cnt)
            FROM (
              SELECT account_mrid, account_number,
                     COUNT(*) OVER (PARTITION BY lower(btrim(customer_name))) AS cnt
              FROM public.customer_accounts
            ) d
            JOIN public.data_quality_rules r ON r.rule_code = 'DUPLICATE_CUSTOMER_ACCOUNT'
            WHERE r.enabled AND d.cnt > 1
            ON CONFLICT (record_mrid, rule_code) WHERE status = 'OPEN' DO NOTHING
            """
        )
        results["duplicate_customer"] = cur.rowcount

        cur.execute(
            """
            INSERT INTO public.data_quality_exceptions
              (record_type, record_mrid, rule_code, severity, error_message, details)
            SELECT 'usage_point', up.mrid, 'USAGE_POINT_GEOM_REQUIRED', r.severity,
                   'Usage point must have valid geometry.',
                   jsonb_build_object('account_mrid', up.account_mrid::text)
            FROM public.usage_points up
            JOIN public.data_quality_rules r ON r.rule_code = 'USAGE_POINT_GEOM_REQUIRED'
            WHERE r.enabled
              AND (up.geom IS NULL OR NOT ST_IsValid(up.geom))
            ON CONFLICT (record_mrid, rule_code) WHERE status = 'OPEN' DO NOTHING
            """
        )
        results["usage_point_geom"] = cur.rowcount

        cur.execute(
            """
            INSERT INTO public.data_quality_exceptions
              (record_type, record_mrid, rule_code, severity, error_message, details)
            SELECT 'usage_point', up.mrid, 'CUSTOMER_TRACEABLE_TO_TRANSFORMER', r.severity,
                   'Customer usage point has no nearby distribution transformer within 500m.',
                   jsonb_build_object('account_mrid', up.account_mrid::text)
            FROM public.usage_points up
            JOIN public.data_quality_rules r ON r.rule_code = 'CUSTOMER_TRACEABLE_TO_TRANSFORMER'
            WHERE r.enabled
              AND NOT EXISTS (
                SELECT 1 FROM gis.asset_id_map am
                JOIN public.connectivity_nodes cn ON cn.mrid = am.mrid
                WHERE am.source_layer = 'distribution_transformer'
                  AND ST_DWithin(up.geom::geography, cn.geom::geography, 500)
              )
            ON CONFLICT (record_mrid, rule_code) WHERE status = 'OPEN' DO NOTHING
            """
        )
        results["customer_traceable_transformer"] = cur.rowcount
    return results


def run_referential_batch_checks(conn) -> dict[str, Any]:
    """Line endpoint and dangling line batch checks."""
    results: dict[str, Any] = {}
    with conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO public.data_quality_exceptions
              (record_type, record_mrid, rule_code, severity, error_message, details)
            SELECT 'ac_line_segment', als.mrid, 'LINE_ENDPOINTS_EXIST', r.severity,
                   'Line segment endpoint references missing connectivity node.',
                   jsonb_build_object(
                     'source_node_id', als.source_node_id::text,
                     'target_node_id', als.target_node_id::text
                   )
            FROM public.ac_line_segments als
            JOIN public.identified_objects io ON io.mrid = als.mrid
            JOIN public.data_quality_rules r ON r.rule_code = 'LINE_ENDPOINTS_EXIST'
            WHERE r.enabled AND io.validation = 'APPROVED'
              AND (
                NOT EXISTS (SELECT 1 FROM public.connectivity_nodes cn WHERE cn.mrid = als.source_node_id)
                OR NOT EXISTS (SELECT 1 FROM public.connectivity_nodes cn WHERE cn.mrid = als.target_node_id)
              )
            ON CONFLICT (record_mrid, rule_code) WHERE status = 'OPEN' DO NOTHING
            """
        )
        results["line_endpoints"] = cur.rowcount

        cur.execute(
            """
            INSERT INTO public.data_quality_exceptions
              (record_type, record_mrid, rule_code, severity, error_message, details)
            SELECT 'ac_line_segment', als.mrid, 'TOPO_DANGLING_LINE_ENDPOINT', r.severity,
                   'Line segment has dangling endpoint (missing node).',
                   jsonb_build_object('source_node_id', als.source_node_id::text)
            FROM public.ac_line_segments als
            JOIN public.identified_objects io ON io.mrid = als.mrid
            JOIN public.data_quality_rules r ON r.rule_code = 'TOPO_DANGLING_LINE_ENDPOINT'
            WHERE r.enabled AND io.validation = 'APPROVED'
              AND (
                NOT EXISTS (SELECT 1 FROM public.connectivity_nodes cn WHERE cn.mrid = als.source_node_id)
                OR NOT EXISTS (SELECT 1 FROM public.connectivity_nodes cn WHERE cn.mrid = als.target_node_id)
              )
            ON CONFLICT (record_mrid, rule_code) WHERE status = 'OPEN' DO NOTHING
            """
        )
        results["dangling_endpoints"] = cur.rowcount

        cur.execute(
            """
            INSERT INTO public.data_quality_exceptions
              (record_type, record_mrid, rule_code, severity, error_message, details)
            SELECT 'ac_line_segment', als.mrid, 'TOPO_LINE_ENDPOINT_NOT_APPROVED', r.severity,
                   'Line endpoint node is not APPROVED.',
                   jsonb_build_object('source_node_id', als.source_node_id::text)
            FROM public.ac_line_segments als
            JOIN public.identified_objects io ON io.mrid = als.mrid
            JOIN public.data_quality_rules r ON r.rule_code = 'TOPO_LINE_ENDPOINT_NOT_APPROVED'
            WHERE r.enabled AND io.validation = 'APPROVED'
              AND EXISTS (
                SELECT 1 FROM public.identified_objects nio
                WHERE nio.mrid IN (als.source_node_id, als.target_node_id)
                  AND nio.validation <> 'APPROVED'
              )
            ON CONFLICT (record_mrid, rule_code) WHERE status = 'OPEN' DO NOTHING
            """
        )
        results["unapproved_endpoints"] = cur.rowcount
    return results


def run_feeder_batch_checks(conn) -> dict[str, Any]:
    results: dict[str, Any] = {}
    with conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO public.data_quality_exceptions
              (record_type, record_mrid, rule_code, severity, error_message, details)
            SELECT 'connectivity_node', cn.mrid, 'FEEDER_NO_DISCONNECTED_SEGMENTS', r.severity,
                   'Feeder node has no connected lines despite feeder assignment.',
                   jsonb_build_object('feeder_id', cn.boundary_feeder_id)
            FROM public.connectivity_nodes cn
            JOIN public.identified_objects io ON io.mrid = cn.mrid
            JOIN public.data_quality_rules r ON r.rule_code = 'FEEDER_NO_DISCONNECTED_SEGMENTS'
            WHERE r.enabled AND io.validation = 'APPROVED'
              AND cn.boundary_feeder_id IS NOT NULL AND btrim(cn.boundary_feeder_id) <> ''
              AND NOT EXISTS (
                SELECT 1 FROM public.ac_line_segments als
                WHERE als.source_node_id = cn.mrid OR als.target_node_id = cn.mrid
              )
            ON CONFLICT (record_mrid, rule_code) WHERE status = 'OPEN' DO NOTHING
            """
        )
        results["feeder_disconnected"] = cur.rowcount

        cur.execute(
            """
            INSERT INTO public.data_quality_exceptions
              (record_type, record_mrid, rule_code, severity, error_message, details)
            SELECT 'connectivity_node', cn.mrid, 'FEEDER_TRACE_COMPLETE', r.severity,
                   'Feeder node missing boundary feeder id for upstream trace.',
                   jsonb_build_object('name', io.name)
            FROM public.connectivity_nodes cn
            JOIN public.identified_objects io ON io.mrid = cn.mrid
            JOIN public.data_quality_rules r ON r.rule_code = 'FEEDER_TRACE_COMPLETE'
            WHERE r.enabled AND io.validation = 'APPROVED'
              AND EXISTS (
                SELECT 1 FROM gis.asset_id_map am
                WHERE am.mrid = cn.mrid AND am.source_layer IN ('distribution_transformer', 'power_transformer')
              )
              AND (cn.boundary_feeder_id IS NULL OR btrim(cn.boundary_feeder_id) = '')
            ON CONFLICT (record_mrid, rule_code) WHERE status = 'OPEN' DO NOTHING
            """
        )
        results["feeder_trace_incomplete"] = cur.rowcount
    return results


def run_batch_validation(conn) -> dict[str, Any]:
    """Run all batch-level rule checks (meters, customers, referential, feeders)."""
    return {
        "meters": run_meter_batch_checks(conn),
        "customers": run_customer_batch_checks(conn),
        "referential": run_referential_batch_checks(conn),
        "feeders": run_feeder_batch_checks(conn),
    }


def count_blocking_open(conn, mrid: str) -> list[dict[str, Any]]:
    """Open exceptions whose rule blocks promotion — used as a promote gate."""
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT e.rule_code, e.severity::text, e.error_message
            FROM public.data_quality_exceptions e
            JOIN public.data_quality_rules r ON r.rule_code = e.rule_code
            WHERE e.record_mrid = %s::uuid
              AND e.status = 'OPEN'
              AND r.blocks_promotion = TRUE
            ORDER BY e.severity
            """,
            (mrid,),
        )
        rows = cur.fetchall()
    return [{"rule_code": r[0], "severity": r[1], "message": r[2]} for r in rows]


def list_exceptions(
    conn,
    *,
    status: str | None = "OPEN",
    severity: str | None = None,
    domain: str | None = None,
    record_mrid: str | None = None,
    limit: int = 100,
) -> list[dict[str, Any]]:
    filters: list[str] = []
    params: list[Any] = []
    if status:
        filters.append("e.status = %s::dq_exception_status")
        params.append(status)
    if severity:
        filters.append("e.severity = %s::dq_severity")
        params.append(severity)
    if domain:
        filters.append("r.domain = %s")
        params.append(domain)
    if record_mrid:
        filters.append("e.record_mrid = %s::uuid")
        params.append(record_mrid)
    where = f"WHERE {' AND '.join(filters)}" if filters else ""
    params.append(limit)
    with conn.cursor() as cur:
        cur.execute(
            f"""
            SELECT e.id::text, e.record_type, e.record_mrid::text, e.rule_code,
                   r.domain, e.severity::text, e.status::text, e.error_message,
                   e.details, e.owner, e.resolution_note, e.resolved_by,
                   e.created_at, e.resolved_at,
                   COALESCE(sio.name, pio.name) AS asset_name
            FROM public.data_quality_exceptions e
            JOIN public.data_quality_rules r ON r.rule_code = e.rule_code
            LEFT JOIN staging.identified_objects sio ON sio.mrid = e.record_mrid
            LEFT JOIN public.identified_objects pio ON pio.mrid = e.record_mrid
            {where}
            ORDER BY e.created_at DESC
            LIMIT %s
            """,
            params,
        )
        rows = cur.fetchall()
    return [
        {
            "id": r[0],
            "record_type": r[1],
            "record_mrid": r[2],
            "rule_code": r[3],
            "domain": r[4],
            "severity": r[5],
            "status": r[6],
            "error_message": r[7],
            "details": r[8],
            "owner": r[9],
            "resolution_note": r[10],
            "resolved_by": r[11],
            "created_at": r[12].isoformat() if r[12] else None,
            "resolved_at": r[13].isoformat() if r[13] else None,
            "asset_name": r[14],
        }
        for r in rows
    ]


def list_rules(conn) -> list[dict[str, Any]]:
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT rule_code, domain, severity::text, description, enabled, blocks_promotion
            FROM public.data_quality_rules
            ORDER BY domain, rule_code
            """
        )
        rows = cur.fetchall()
    return [
        {
            "rule_code": r[0],
            "domain": r[1],
            "severity": r[2],
            "description": r[3],
            "enabled": r[4],
            "blocks_promotion": r[5],
        }
        for r in rows
    ]


def summary(conn) -> dict[str, Any]:
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT e.severity::text, COUNT(*)
            FROM public.data_quality_exceptions e
            WHERE e.status = 'OPEN'
            GROUP BY e.severity
            """
        )
        by_sev = {r[0]: int(r[1]) for r in cur.fetchall()}
        cur.execute(
            """
            SELECT r.domain, COUNT(*)
            FROM public.data_quality_exceptions e
            JOIN public.data_quality_rules r ON r.rule_code = e.rule_code
            WHERE e.status = 'OPEN'
            GROUP BY r.domain
            """
        )
        by_domain = {r[0]: int(r[1]) for r in cur.fetchall()}
    return {
        "open_by_severity": by_sev,
        "open_by_domain": by_domain,
        "open_total": sum(by_sev.values()),
    }


_VALID_RESOLUTIONS = {"RESOLVED", "DEFERRED", "QUARANTINED", "REJECTED"}


def resolve_exception(
    conn,
    exception_id: str,
    *,
    status: str,
    note: str | None = None,
    operator: str | None = None,
) -> dict[str, Any]:
    if status not in _VALID_RESOLUTIONS:
        raise ValueError(f"status must be one of {sorted(_VALID_RESOLUTIONS)}")
    with conn.cursor() as cur:
        cur.execute(
            """
            UPDATE public.data_quality_exceptions
            SET status = %s::dq_exception_status,
                resolution_note = COALESCE(%s, resolution_note),
                resolved_by = COALESCE(%s, resolved_by),
                resolved_at = CASE WHEN %s IN ('RESOLVED','REJECTED') THEN NOW() ELSE resolved_at END
            WHERE id = %s::uuid
            RETURNING record_mrid::text, rule_code, status::text
            """,
            (status, note, operator, status, exception_id),
        )
        row = cur.fetchone()
        if not row:
            raise ValueError("Exception not found")
    log_lineage(
        conn,
        target_mrid=row[0],
        source_type="MANUAL_EDIT",
        action_type=f"DQ_{status}",
        operator_id=operator,
        provenance_ref=f"data_quality_exceptions:{exception_id}",
        after_state={"rule_code": row[1], "status": row[2], "note": note},
    )
    return {"id": exception_id, "record_mrid": row[0], "status": row[2]}
