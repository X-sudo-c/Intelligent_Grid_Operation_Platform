"""Integration dead-letter queue (FR-010)."""

from __future__ import annotations

import json
from typing import Any, Optional

import psycopg2


def insert_dlq(
    conn,
    *,
    source: str,
    payload: dict[str, Any],
    error_message: str,
) -> str:
    with conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO integration_dlq (source, payload, error_message)
            VALUES (%s::integration_dlq_source, %s::jsonb, %s)
            RETURNING id::text
            """,
            (source, json.dumps(payload), error_message[:2000]),
        )
        dlq_id = cur.fetchone()[0]
    from lineage import log_dlq_event

    log_dlq_event(
        conn,
        dlq_id=dlq_id,
        source=source,
        action_type="DLQ_OPEN",
        payload=payload,
        error_message=error_message,
    )
    return dlq_id


def list_dlq(conn, status: Optional[str] = "OPEN", limit: int = 100) -> list[dict[str, Any]]:
    with conn.cursor() as cur:
        if status:
            cur.execute(
                """
                SELECT id::text, source::text, payload, error_message,
                       status::text, retry_count, created_at, resolved_at
                FROM integration_dlq
                WHERE status = %s::integration_dlq_status
                ORDER BY created_at DESC
                LIMIT %s
                """,
                (status, limit),
            )
        else:
            cur.execute(
                """
                SELECT id::text, source::text, payload, error_message,
                       status::text, retry_count, created_at, resolved_at
                FROM integration_dlq
                ORDER BY created_at DESC
                LIMIT %s
                """,
                (limit,),
            )
        rows = cur.fetchall()
    return [
        {
            "id": row[0],
            "source": row[1],
            "payload": row[2],
            "error_message": row[3],
            "status": row[4],
            "retry_count": row[5],
            "created_at": row[6].isoformat() if row[6] else None,
            "resolved_at": row[7].isoformat() if row[7] else None,
        }
        for row in rows
    ]


def patch_dlq(conn, dlq_id: str, status: str, payload: dict[str, Any] | None = None) -> dict[str, Any]:
    with conn.cursor() as cur:
        if payload is not None:
            cur.execute(
                """
                UPDATE integration_dlq
                SET status = %s::integration_dlq_status, payload = %s::jsonb,
                    resolved_at = CASE WHEN %s IN ('RESOLVED', 'DISCARDED') THEN NOW() ELSE resolved_at END
                WHERE id = %s::uuid
                RETURNING id::text, status::text, source::text, payload
                """,
                (status, json.dumps(payload), status, dlq_id),
            )
        else:
            cur.execute(
                """
                UPDATE integration_dlq
                SET status = %s::integration_dlq_status,
                    resolved_at = CASE WHEN %s IN ('RESOLVED', 'DISCARDED') THEN NOW() ELSE resolved_at END
                WHERE id = %s::uuid
                RETURNING id::text, status::text, source::text, payload
                """,
                (status, status, dlq_id),
            )
        row = cur.fetchone()
        if not row:
            raise ValueError("DLQ item not found")
    return {"id": row[0], "status": row[1], "source": row[2], "payload": row[3]}


def mark_retrying(conn, dlq_id: str) -> dict[str, Any]:
    with conn.cursor() as cur:
        cur.execute(
            """
            UPDATE integration_dlq
            SET status = 'RETRYING', retry_count = retry_count + 1
            WHERE id = %s::uuid
            RETURNING id::text, retry_count, source::text, payload
            """,
            (dlq_id,),
        )
        row = cur.fetchone()
        if not row:
            raise ValueError("DLQ item not found")
    return {"id": row[0], "retry_count": row[1], "source": row[2], "payload": row[3]}
