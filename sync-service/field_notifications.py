"""Field technician notifications (reject alerts, device tokens, optional FCM)."""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from typing import Any, Optional

from ops_common import queue_notification


def _notification_row(cur, row) -> dict[str, Any]:
    cols = [d[0] for d in cur.description]
    item = dict(zip(cols, row))
    if item.get("created_at"):
        item["created_at"] = item["created_at"].isoformat()
    if item.get("delivered_at"):
        item["delivered_at"] = item["delivered_at"].isoformat()
    if item.get("read_at"):
        item["read_at"] = item["read_at"].isoformat()
    if isinstance(item.get("payload"), str):
        item["payload"] = json.loads(item["payload"])
    return item


def notify_asset_rejected(
    conn,
    *,
    mrid: str,
    name: Optional[str],
    submitted_by: Optional[str],
    reason: Optional[str] = None,
    latitude: Optional[float] = None,
    longitude: Optional[float] = None,
) -> Optional[str]:
    """Queue a mobile notification for the technician who submitted the asset."""
    if not submitted_by:
        return None

    label = name or mrid
    body = f'"{label}" was rejected by backoffice.'
    if reason:
        body = f'{body} Reason: {reason}'

    with conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO notification_log (channel, recipient, message_type, status, payload)
            VALUES (%s, %s, %s, 'QUEUED'::notification_status, %s::jsonb)
            RETURNING id::text
            """,
            (
                "MOBILE_PUSH",
                submitted_by,
                "ASSET_REJECTED",
                json.dumps(
                    {
                        "mrid": mrid,
                        "name": name,
                        "reason": reason,
                        "title": "Asset rejected",
                        "body": body,
                        "latitude": latitude,
                        "longitude": longitude,
                    },
                ),
            ),
        )
        return cur.fetchone()[0]


def register_device_token(
    conn,
    *,
    technician_id: str,
    token: str,
    platform: str = "android",
) -> dict[str, Any]:
    with conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO field_device_tokens (technician_id, token, platform, updated_at)
            VALUES (%s, %s, %s, NOW())
            ON CONFLICT (technician_id, token) DO UPDATE
              SET platform = EXCLUDED.platform, updated_at = NOW()
            RETURNING technician_id, token, platform, updated_at
            """,
            (technician_id, token, platform),
        )
        row = cur.fetchone()
    return {
        "technician_id": row[0],
        "token": row[1],
        "platform": row[2],
        "updated_at": row[3].isoformat() if row[3] else None,
    }


def list_technician_notifications(
    conn,
    technician_id: str,
    *,
    undelivered_only: bool = False,
    limit: int = 50,
) -> list[dict[str, Any]]:
    clauses = ["recipient = %s"]
    params: list[Any] = [technician_id]
    if undelivered_only:
        clauses.append("delivered_at IS NULL")
    where = " AND ".join(clauses)
    with conn.cursor() as cur:
        cur.execute(
            f"""
            SELECT id::text, channel, recipient, message_type, status::text,
                   payload, created_at, delivered_at, read_at
            FROM notification_log
            WHERE {where}
            ORDER BY created_at DESC
            LIMIT %s
            """,
            (*params, limit),
        )
        return [_notification_row(cur, row) for row in cur.fetchall()]


def mark_notification_delivered(conn, notification_id: str) -> Optional[dict[str, Any]]:
    with conn.cursor() as cur:
        cur.execute(
            """
            UPDATE notification_log
            SET delivered_at = COALESCE(delivered_at, NOW()),
                status = CASE WHEN status = 'QUEUED'::notification_status THEN 'SENT'::notification_status ELSE status END
            WHERE id = %s::uuid
            RETURNING id::text, message_type, delivered_at
            """,
            (notification_id,),
        )
        row = cur.fetchone()
    if not row:
        return None
    return {
        "id": row[0],
        "message_type": row[1],
        "delivered_at": row[2].isoformat() if row[2] else None,
    }


def mark_notification_read(conn, notification_id: str, technician_id: str) -> Optional[dict[str, Any]]:
    with conn.cursor() as cur:
        cur.execute(
            """
            UPDATE notification_log
            SET read_at = COALESCE(read_at, NOW()),
                delivered_at = COALESCE(delivered_at, NOW()),
                status = CASE WHEN status = 'FAILED'::notification_status THEN status ELSE 'SENT'::notification_status END
            WHERE id = %s::uuid AND recipient = %s
            RETURNING id::text, read_at
            """,
            (notification_id, technician_id),
        )
        row = cur.fetchone()
    if not row:
        return None
    return {"id": row[0], "read_at": row[1].isoformat() if row[1] else None}


def fetch_device_tokens(conn, technician_id: str) -> list[str]:
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT token FROM field_device_tokens
            WHERE technician_id = %s
            ORDER BY updated_at DESC
            """,
            (technician_id,),
        )
        return [row[0] for row in cur.fetchall()]


def dispatch_fcm_push(
    *,
    tokens: list[str],
    title: str,
    body: str,
    data: dict[str, Any],
) -> bool:
    """Send FCM legacy HTTP push when FCM_SERVER_KEY is configured."""
    server_key = os.getenv("FCM_SERVER_KEY", "").strip()
    if not server_key or not tokens:
        return False

    payload = {
        "registration_ids": tokens,
        "notification": {"title": title, "body": body},
        "data": {k: str(v) for k, v in data.items() if v is not None},
        "priority": "high",
    }
    req = urllib.request.Request(
        "https://fcm.googleapis.com/fcm/send",
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Authorization": f"key={server_key}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            return 200 <= resp.status < 300
    except (urllib.error.URLError, TimeoutError):
        return False


def dispatch_rejection_push(
    conn,
    *,
    technician_id: str,
    title: str,
    body: str,
    payload: dict[str, Any],
) -> bool:
    tokens = fetch_device_tokens(conn, technician_id)
    return dispatch_fcm_push(tokens=tokens, title=title, body=body, data=payload)
