"""Work order CRUD and mobile assignment (FR-012)."""

from __future__ import annotations

import json
from typing import Any, Optional

from ops_common import (
    WORK_ORDER_TRANSITIONS,
    create_link,
    list_links,
    next_reference,
    queue_notification,
    validate_transition,
    write_audit,
)


def _row_to_dict(cur, row) -> dict[str, Any]:
    cols = [d[0] for d in cur.description]
    out = dict(zip(cols, row))
    for k, v in list(out.items()):
        if hasattr(v, "isoformat"):
            out[k] = v.isoformat()
        elif k == "geom" and v is not None:
            out[k] = None
        elif k in ("longitude", "latitude") and v is not None:
            out[k] = float(v)
    return out


def list_work_orders(
    conn,
    *,
    status: Optional[str] = None,
    assigned_user: Optional[str] = None,
    assigned_crew: Optional[str] = None,
    limit: int = 100,
) -> list[dict[str, Any]]:
    clauses = ["1=1"]
    params: list[Any] = []
    if status:
        clauses.append("status = %s::work_order_status")
        params.append(status)
    if assigned_user:
        clauses.append("assigned_user = %s")
        params.append(assigned_user)
    if assigned_crew:
        clauses.append("assigned_crew = %s")
        params.append(assigned_crew)
    params.append(limit)
    sql = f"""
        SELECT id::text, reference, work_type::text, priority, status::text,
               assigned_crew, assigned_user, due_at, account_mrid::text, asset_mrid::text,
               feeder_mrid::text, source_ticket_id::text, source_case_id::text,
               summary, notes, created_by, created_at, updated_at,
               COALESCE(ST_X(wo.geom), ST_X(cn.geom)) AS longitude,
               COALESCE(ST_Y(wo.geom), ST_Y(cn.geom)) AS latitude
        FROM work_orders wo
        LEFT JOIN public.connectivity_nodes cn ON cn.mrid = wo.asset_mrid
        WHERE {' AND '.join(clauses)}
        ORDER BY wo.created_at DESC
        LIMIT %s
    """
    with conn.cursor() as cur:
        cur.execute(sql, params)
        return [_row_to_dict(cur, row) for row in cur.fetchall()]


def get_work_order(conn, work_order_id: str) -> dict[str, Any]:
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT id::text, reference, work_type::text, priority, status::text,
                   assigned_crew, assigned_user, due_at, account_mrid::text, asset_mrid::text,
                   feeder_mrid::text, source_ticket_id::text, source_case_id::text,
                   summary, notes, created_by, created_at, updated_at
            FROM work_orders WHERE id = %s::uuid
            """,
            (work_order_id,),
        )
        row = cur.fetchone()
        if not row:
            raise ValueError("Work order not found")
        wo = _row_to_dict(cur, row)
    wo["links"] = list_links(conn, "WORK_ORDER", work_order_id)
    return wo


def create_work_order(conn, data: dict[str, Any]) -> dict[str, Any]:
    ref = next_reference(conn, "WORK_ORDER")
    with conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO work_orders (
              reference, work_type, priority, status, assigned_crew, assigned_user,
              due_at, account_mrid, asset_mrid, feeder_mrid, source_ticket_id,
              source_case_id, summary, notes, created_by
            ) VALUES (
              %s, %s::work_order_type, %s, %s::work_order_status, %s, %s,
              %s, %s::uuid, %s::uuid, %s::uuid, %s::uuid,
              %s::uuid, %s, %s, %s
            )
            RETURNING id::text
            """,
            (
                ref,
                data.get("work_type", "OTHER"),
                data.get("priority", 3),
                data.get("status", "DISPATCHED"),
                data.get("assigned_crew"),
                data.get("assigned_user"),
                data.get("due_at"),
                data.get("account_mrid"),
                data.get("asset_mrid"),
                data.get("feeder_mrid"),
                data.get("source_ticket_id"),
                data.get("source_case_id"),
                data["summary"],
                data.get("notes"),
                data.get("created_by"),
            ),
        )
        wo_id = cur.fetchone()[0]
    write_audit(
        conn,
        record_type="WORK_ORDER",
        record_id=wo_id,
        event_type="created",
        operator_id=data.get("created_by"),
        payload={"reference": ref},
    )
    if data.get("assigned_user"):
        queue_notification(
            conn,
            channel="IN_APP",
            recipient=data["assigned_user"],
            message_type="WORK_ORDER_DISPATCHED",
            payload={"work_order_id": wo_id, "reference": ref},
        )
    return get_work_order(conn, wo_id)


def patch_work_order(conn, work_order_id: str, data: dict[str, Any]) -> dict[str, Any]:
    current = get_work_order(conn, work_order_id)
    if "status" in data and data["status"]:
        validate_transition(current["status"], data["status"], WORK_ORDER_TRANSITIONS)
    fields = []
    params: list[Any] = []
    for col in (
        "work_type",
        "priority",
        "status",
        "assigned_crew",
        "assigned_user",
        "due_at",
        "summary",
        "notes",
    ):
        if col in data and data[col] is not None:
            if col == "work_type":
                fields.append("work_type = %s::work_order_type")
            elif col == "status":
                fields.append("status = %s::work_order_status")
            else:
                fields.append(f"{col} = %s")
            params.append(data[col])
    if not fields:
        return current
    fields.append("updated_at = NOW()")
    params.append(work_order_id)
    with conn.cursor() as cur:
        cur.execute(
            f"UPDATE work_orders SET {', '.join(fields)} WHERE id = %s::uuid",
            params,
        )
    write_audit(
        conn,
        record_type="WORK_ORDER",
        record_id=work_order_id,
        event_type="updated",
        operator_id=data.get("operator_id"),
        payload=data,
    )
    return get_work_order(conn, work_order_id)
