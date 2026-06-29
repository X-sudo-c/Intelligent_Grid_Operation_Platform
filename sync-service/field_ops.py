"""Field technician tracking and submission helpers."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any, Optional


def upsert_technician_position(
    conn,
    *,
    technician_id: str,
    longitude: float,
    latitude: float,
    display_name: str | None = None,
    accuracy_m: float | None = None,
    heading_deg: float | None = None,
    speed_mps: float | None = None,
    work_order_id: str | None = None,
    session_started_at: str | None = None,
) -> dict[str, Any]:
    session_ts = None
    if session_started_at:
        session_ts = datetime.fromisoformat(session_started_at.replace("Z", "+00:00"))

    with conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO public.field_technician_positions (
              technician_id, display_name, longitude, latitude,
              accuracy_m, heading_deg, speed_mps, work_order_id,
              session_started_at, reported_at
            )
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, NOW())
            ON CONFLICT (technician_id) DO UPDATE SET
              display_name = COALESCE(EXCLUDED.display_name, field_technician_positions.display_name),
              longitude = EXCLUDED.longitude,
              latitude = EXCLUDED.latitude,
              accuracy_m = EXCLUDED.accuracy_m,
              heading_deg = EXCLUDED.heading_deg,
              speed_mps = EXCLUDED.speed_mps,
              work_order_id = COALESCE(EXCLUDED.work_order_id, field_technician_positions.work_order_id),
              session_started_at = COALESCE(
                EXCLUDED.session_started_at, field_technician_positions.session_started_at
              ),
              reported_at = NOW()
            RETURNING technician_id, display_name, longitude, latitude,
                      accuracy_m, heading_deg, speed_mps, work_order_id,
                      session_started_at, reported_at
            """,
            (
                technician_id,
                display_name or technician_id,
                longitude,
                latitude,
                accuracy_m,
                heading_deg,
                speed_mps,
                work_order_id,
                session_ts,
            ),
        )
        row = cur.fetchone()
    return {
        "technician_id": row[0],
        "display_name": row[1],
        "longitude": row[2],
        "latitude": row[3],
        "accuracy_m": row[4],
        "heading_deg": row[5],
        "speed_mps": row[6],
        "work_order_id": row[7],
        "session_started_at": row[8].isoformat() if row[8] else None,
        "reported_at": row[9].isoformat() if row[9] else None,
    }


def list_active_technicians(conn, *, stale_minutes: int = 30) -> list[dict[str, Any]]:
    cutoff = datetime.now(timezone.utc) - timedelta(minutes=stale_minutes)
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT
              p.technician_id,
              p.display_name,
              p.longitude,
              p.latitude,
              p.accuracy_m,
              p.heading_deg,
              p.speed_mps,
              p.work_order_id,
              p.session_started_at,
              p.reported_at,
              COALESCE(s.pending_count, 0) AS pending_submissions,
              COALESCE(s.total_count, 0) AS total_submissions
            FROM public.field_technician_positions p
            LEFT JOIN LATERAL (
              SELECT
                COUNT(*) FILTER (
                  WHERE io.validation IN ('PENDING_FIELD', 'STAGED', 'IN_CONFLICT')
                ) AS pending_count,
                COUNT(*) AS total_count
              FROM staging.identified_objects io
              WHERE io.submitted_by = p.technician_id
            ) s ON TRUE
            WHERE p.reported_at >= %s
            ORDER BY p.reported_at DESC
            """,
            (cutoff,),
        )
        rows = cur.fetchall()
    return [
        {
            "technician_id": row[0],
            "display_name": row[1],
            "longitude": row[2],
            "latitude": row[3],
            "accuracy_m": row[4],
            "heading_deg": row[5],
            "speed_mps": row[6],
            "work_order_id": row[7],
            "session_started_at": row[8].isoformat() if row[8] else None,
            "reported_at": row[9].isoformat() if row[9] else None,
            "pending_submissions": row[10],
            "total_submissions": row[11],
        }
        for row in rows
    ]


def list_technician_submissions(
    conn,
    technician_id: str,
    *,
    limit: int = 100,
) -> list[dict[str, Any]]:
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT
              cn.mrid::text,
              io.name,
              io.validation::text,
              io.submitted_by,
              io.error_log,
              io.updated_at,
              ST_AsGeoJSON(cn.geom)::json AS geom
            FROM staging.identified_objects io
            JOIN staging.connectivity_nodes cn ON cn.mrid = io.mrid
            WHERE io.submitted_by = %s
            ORDER BY io.updated_at DESC
            LIMIT %s
            """,
            (technician_id, limit),
        )
        rows = cur.fetchall()
    return [
        {
            "mrid": row[0],
            "name": row[1],
            "validation": row[2],
            "submitted_by": row[3],
            "error_log": row[4],
            "updated_at": row[5].isoformat() if row[5] else None,
            "geom": row[6],
        }
        for row in rows
    ]


def fetch_staging_validation(conn, mrid: str) -> Optional[str]:
    with conn.cursor() as cur:
        cur.execute(
            "SELECT validation::text FROM staging.identified_objects WHERE mrid = %s",
            (mrid,),
        )
        row = cur.fetchone()
        return row[0] if row else None
