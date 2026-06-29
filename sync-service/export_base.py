"""Shared helpers for async gis_transfer_jobs export pipelines."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Callable

import requests

from cim_export import EXPORTS_DIR, GIS_EXPORT_BUCKET, SUPABASE_SERVICE_KEY, SUPABASE_URL, get_job

ExportBodyFn = Callable[[Any, dict[str, Any]], tuple[bytes, dict[str, Any], str, str]]


def create_format_export_job(
    conn,
    *,
    fmt: str,
    layers: list[str],
    clip: dict[str, float] | None,
    requested_by: str | None,
) -> dict[str, Any]:
    with conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO public.gis_transfer_jobs (
              direction, format, status, layers,
              clip_west, clip_south, clip_east, clip_north,
              requested_by
            )
            VALUES (
              'export', %s, 'pending', %s,
              %s, %s, %s, %s,
              %s
            )
            RETURNING id::text, status::text, created_at
            """,
            (
                fmt,
                layers,
                clip["west"] if clip else None,
                clip["south"] if clip else None,
                clip["east"] if clip else None,
                clip["north"] if clip else None,
                requested_by,
            ),
        )
        row = cur.fetchone()
        job_id = row[0]
        cur.execute("SELECT public.enqueue_gis_export_job(%s::uuid)", (job_id,))
        msg_id = cur.fetchone()[0]
        cur.execute(
            "UPDATE public.gis_transfer_jobs SET pgmq_msg_id = %s WHERE id = %s::uuid",
            (msg_id, job_id),
        )
    return {
        "id": job_id,
        "format": fmt,
        "status": row[1],
        "created_at": row[2].isoformat() if row[2] else None,
        "pgmq_msg_id": msg_id,
    }


def _upload_storage(bucket: str, path: str, body: bytes, content_type: str) -> bool:
    if not SUPABASE_SERVICE_KEY:
        return False
    url = f"{SUPABASE_URL.rstrip('/')}/storage/v1/object/{bucket}/{path}"
    resp = requests.post(
        url,
        data=body,
        headers={
            "Authorization": f"Bearer {SUPABASE_SERVICE_KEY}",
            "Content-Type": content_type,
            "x-upsert": "true",
        },
        timeout=120,
    )
    return resp.status_code in (200, 201)


def process_format_export_job(
    conn,
    job_id: str,
    *,
    build_body: ExportBodyFn,
    default_filename: str,
    content_type: str,
) -> dict[str, Any]:
    job = get_job(conn, job_id)
    if not job:
        raise ValueError("Export job not found")
    if job["status"] == "completed":
        return job

    clip = job["clip"]
    if clip and None in clip.values():
        clip = None

    with conn.cursor() as cur:
        cur.execute(
            """
            UPDATE public.gis_transfer_jobs
            SET status = 'running', started_at = NOW(), updated_at = NOW()
            WHERE id = %s::uuid
            """,
            (job_id,),
        )

    try:
        body, meta, filename, resolved_type = build_body(conn, job)
        storage_path = f"{job_id}/{filename}"
        media_type = resolved_type or content_type

        EXPORTS_DIR.mkdir(parents=True, exist_ok=True)
        local_dir = EXPORTS_DIR / job_id
        local_dir.mkdir(parents=True, exist_ok=True)
        local_path = local_dir / filename
        local_path.write_bytes(body)
        (local_dir / "export.meta.json").write_text(
            json.dumps(meta, indent=2, default=str), encoding="utf-8"
        )

        bucket = GIS_EXPORT_BUCKET
        uploaded = _upload_storage(bucket, storage_path, body, media_type)
        if not uploaded:
            bucket = "local"

        feature_count = meta.get("counts", {}).get("total_features", 0)
        with conn.cursor() as cur:
            cur.execute(
                """
                UPDATE public.gis_transfer_jobs
                SET status = 'completed',
                    storage_bucket = %s,
                    storage_path = %s,
                    feature_count = %s,
                    completed_at = NOW(),
                    updated_at = NOW(),
                    error_message = NULL
                WHERE id = %s::uuid
                """,
                (bucket, storage_path if uploaded else str(local_path), feature_count, job_id),
            )
        return get_job(conn, job_id) or {}
    except Exception as exc:
        with conn.cursor() as cur:
            cur.execute(
                """
                UPDATE public.gis_transfer_jobs
                SET status = 'failed',
                    error_message = %s,
                    completed_at = NOW(),
                    updated_at = NOW()
                WHERE id = %s::uuid
                """,
                (str(exc)[:2000], job_id),
            )
        raise


def read_format_export_bytes(
    conn,
    job_id: str,
    *,
    default_filename: str,
    content_type: str,
) -> tuple[bytes, str]:
    job = get_job(conn, job_id)
    if not job or job["status"] != "completed":
        raise ValueError("Export not ready")
    path = job["storage_path"] or ""
    if job["storage_bucket"] == "local" or path.startswith("/"):
        file_path = Path(path)
        if not file_path.is_file():
            file_path = EXPORTS_DIR / job_id / default_filename
        return file_path.read_bytes(), content_type
    if not SUPABASE_SERVICE_KEY:
        raise ValueError("Storage download requires SUPABASE_SERVICE_KEY")
    url = f"{SUPABASE_URL.rstrip('/')}/storage/v1/object/{job['storage_bucket']}/{path}"
    resp = requests.get(
        url,
        headers={"Authorization": f"Bearer {SUPABASE_SERVICE_KEY}"},
        timeout=120,
    )
    if resp.status_code != 200:
        raise ValueError(f"Storage download failed: HTTP {resp.status_code}")
    return resp.content, content_type


DOWNLOAD_INFO: dict[str, tuple[str, str]] = {
    "cim-json": ("export.cim.json", "application/json"),
    "dxf": ("export.dxf", "application/dxf"),
    "geopackage": ("export.gpkg", "application/geopackage+sqlite3"),
    "kml": ("export.kml", "application/vnd.google-earth.kml+xml"),
    "shapefile": ("export_shapefile.zip", "application/zip"),
    "csv": ("export_csv.zip", "application/zip"),
    "cim-xml": ("export.cim.xml", "application/rdf+xml"),
    "cim-rdf": ("export.cim.rdf.xml", "application/rdf+xml"),
    "mdms-csv": ("export_mdms.csv", "text/csv"),
    "sap-csv": ("export_sap.csv", "text/csv"),
}
