"""CIM-aligned master data export (FR-019) — JSON profile + async gis_transfer_jobs."""

from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import requests

CIM_PROFILE = "GIOP-Distribution-MVP-1.0"
# Ghana operating bbox — required for bulk export when node count exceeds cap.
GHANA_BBOX = {"west": -3.5, "south": 4.5, "east": 1.5, "north": 8.5}
FULL_EXPORT_NODE_CAP = 10_000
DEFAULT_LAYERS = [
    "identified_objects",
    "connectivity_nodes",
    "conducting_equipment",
    "ac_line_segments",
    "usage_points",
    "meters",
    "ghana_grid_assets",
]

EXPORTS_DIR = Path(__file__).resolve().parent / "exports"
SUPABASE_URL = os.getenv("SUPABASE_URL", "http://127.0.0.1:54321")
SUPABASE_SERVICE_KEY = os.getenv("SUPABASE_SERVICE_KEY") or os.getenv("SUPABASE_SERVICE_ROLE_KEY", "")
GIS_EXPORT_BUCKET = os.getenv("GIS_EXPORT_BUCKET", "gis-exports")


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _bbox_clause(alias: str, geom_col: str, clip: dict[str, float] | None) -> tuple[str, list[Any]]:
    if not clip:
        return "", []
    return (
        f" AND {alias}.{geom_col} && ST_MakeEnvelope(%s, %s, %s, %s, 4326)",
        [clip["west"], clip["south"], clip["east"], clip["north"]],
    )


def _blocked_mrids(conn, exclude: bool) -> set[str]:
    if not exclude:
        return set()
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT DISTINCT e.record_mrid::text
            FROM public.data_quality_exceptions e
            JOIN public.data_quality_rules r ON r.rule_code = e.rule_code
            WHERE e.status = 'OPEN' AND r.blocks_promotion = TRUE
            """
        )
        return {row[0] for row in cur.fetchall()}


def count_export_nodes(conn, clip: dict[str, float] | None) -> int:
    bbox_sql, bbox_params = _bbox_clause("cn", "geom", clip)
    with conn.cursor() as cur:
        cur.execute(
            f"""
            SELECT COUNT(*)
            FROM public.connectivity_nodes cn
            JOIN public.identified_objects io ON io.mrid = cn.mrid
            WHERE io.validation = 'APPROVED'
            {bbox_sql}
            """,
            bbox_params,
        )
        return int(cur.fetchone()[0])


def validate_export_scope(conn, clip: dict[str, float] | None) -> None:
    """Reject unbounded exports when the master network exceeds FULL_EXPORT_NODE_CAP."""
    if clip:
        from topology_dq import validate_export_topology

        validate_export_topology(conn, clip)
        return
    total = count_export_nodes(conn, None)
    if total > FULL_EXPORT_NODE_CAP:
        raise ValueError(
            f"clip bbox is required when exporting more than {FULL_EXPORT_NODE_CAP} nodes "
            f"(master has {total}). Use Ghana bbox or a district window."
        )


def fetch_mapping_register(conn) -> list[dict[str, Any]]:
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT canonical_object, cim_class, cim_profile, local_schema, local_field,
                   source_system, target_system, transformation_rule, owner, approval_status
            FROM public.cim_mapping_register
            WHERE approval_status = 'approved'
            ORDER BY cim_class, local_field
            """
        )
        rows = cur.fetchall()
    return [
        {
            "canonical_object": r[0],
            "cim_class": r[1],
            "cim_profile": r[2],
            "local_schema": r[3],
            "local_field": r[4],
            "source_system": r[5],
            "target_system": r[6],
            "transformation_rule": r[7],
            "owner": r[8],
            "approval_status": r[9],
        }
        for r in rows
    ]


def build_cim_payload(
    conn,
    *,
    layers: list[str] | None = None,
    clip: dict[str, float] | None = None,
    exclude_dq_blocked: bool = True,
    limit: int | None = None,
) -> dict[str, Any]:
    """Assemble CIM-aligned JSON from master public tables."""
    selected = layers or DEFAULT_LAYERS
    blocked = _blocked_mrids(conn, exclude_dq_blocked)
    payload: dict[str, Any] = {
        "@profile": CIM_PROFILE,
        "@format": "cim-json",
        "exported_at": _utc_now(),
        "filters": {
            "master_only": True,
            "exclude_dq_blocked": exclude_dq_blocked,
            "clip": clip,
            "layers": selected,
        },
        "counts": {},
    }

    bbox_sql, bbox_params = _bbox_clause("cn", "geom", clip)

    node_mrids: set[str] = set()
    if "connectivity_nodes" in selected or any(
        layer in selected
        for layer in (
            "identified_objects",
            "conducting_equipment",
            "ac_line_segments",
            "ghana_grid_assets",
        )
    ):
        with conn.cursor() as cur:
            lim = f" LIMIT {int(limit)}" if limit else ""
            cur.execute(
                f"""
                SELECT cn.mrid::text,
                       io.name,
                       io.lifecycle_state::text,
                       io.validation::text,
                       cn.boundary_feeder_id,
                       ST_AsGeoJSON(cn.geom)::json AS geom
                FROM public.connectivity_nodes cn
                JOIN public.identified_objects io ON io.mrid = cn.mrid
                WHERE io.validation = 'APPROVED'
                {bbox_sql}
                ORDER BY io.name
                {lim}
                """,
                bbox_params,
            )
            nodes = []
            for row in cur.fetchall():
                mrid = row[0]
                if mrid in blocked:
                    continue
                node_mrids.add(mrid)
                nodes.append(
                    {
                        "@type": "ConnectivityNode",
                        "mrid": mrid,
                        "name": row[1],
                        "lifecycle_state": row[2],
                        "validation": row[3],
                        "boundary_feeder_id": row[4],
                        "location": row[5],
                    }
                )
        payload["ConnectivityNode"] = nodes
        payload["counts"]["ConnectivityNode"] = len(nodes)

    if "ac_line_segments" in selected:
        line_bbox, line_params = _bbox_clause("als", "geom", clip)
        with conn.cursor() as cur:
            cur.execute(
                f"""
                SELECT als.mrid::text, io.name,
                       als.source_node_id::text, als.target_node_id::text,
                       ce.nominal_voltage::text, ce.phases,
                       als.direction_downstream,
                       ST_AsGeoJSON(als.geom)::json AS geom
                FROM public.ac_line_segments als
                JOIN public.identified_objects io ON io.mrid = als.mrid
                JOIN public.conducting_equipment ce ON ce.mrid = als.mrid
                WHERE io.validation = 'APPROVED'
                {line_bbox}
                ORDER BY io.name
                """,
                line_params,
            )
            lines = []
            for row in cur.fetchall():
                if row[2] in blocked or row[3] in blocked:
                    continue
                if node_mrids and row[2] not in node_mrids and row[3] not in node_mrids:
                    continue
                lines.append(
                    {
                        "@type": "ACLineSegment",
                        "mrid": row[0],
                        "name": row[1],
                        "source_node_mrid": row[2],
                        "target_node_mrid": row[3],
                        "nominal_voltage": row[4],
                        "phases": row[5],
                        "direction_downstream": row[6],
                        "geometry": row[7],
                    }
                )
        payload["ACLineSegment"] = lines
        payload["counts"]["ACLineSegment"] = len(lines)

    if "usage_points" in selected:
        up_bbox, up_params = _bbox_clause("up", "geom", clip)
        with conn.cursor() as cur:
            cur.execute(
                f"""
                SELECT up.mrid::text, io.name, up.account_mrid::text,
                       ST_AsGeoJSON(up.geom)::json AS geom
                FROM public.usage_points up
                JOIN public.identified_objects io ON io.mrid = up.mrid
                WHERE io.validation = 'APPROVED'
                {up_bbox}
                """,
                up_params,
            )
            ups = [
                {
                    "@type": "UsagePoint",
                    "mrid": r[0],
                    "name": r[1],
                    "account_mrid": r[2],
                    "location": r[3],
                }
                for r in cur.fetchall()
                if r[0] not in blocked
            ]
        payload["UsagePoint"] = ups
        payload["counts"]["UsagePoint"] = len(ups)

    if "meters" in selected:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT m.mrid::text, io.name, m.serial_number, m.manufacturer,
                       m.installed_at
                FROM public.meters m
                JOIN public.identified_objects io ON io.mrid = m.mrid
                WHERE io.validation = 'APPROVED'
                ORDER BY m.serial_number
                """
            )
            meters = [
                {
                    "@type": "Meter",
                    "mrid": r[0],
                    "name": r[1],
                    "serial_number": r[2],
                    "manufacturer": r[3],
                    "installed_at": r[4].isoformat() if r[4] else None,
                }
                for r in cur.fetchall()
                if r[0] not in blocked
            ]
        payload["Meter"] = meters
        payload["counts"]["Meter"] = len(meters)

    if "ghana_grid_assets" in selected and node_mrids:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT gga.mrid::text, gga.operating_utility::text, gga.substation_name
                FROM public.ghana_grid_assets gga
                WHERE gga.mrid = ANY(%s::uuid[])
                """,
                (list(node_mrids),),
            )
            ext = [
                {
                    "@type": "GhanaGridAsset",
                    "mrid": r[0],
                    "operating_utility": r[1],
                    "substation_name": r[2],
                }
                for r in cur.fetchall()
            ]
        payload.setdefault("extensions", {})["GhanaGridAsset"] = ext
        payload["counts"]["GhanaGridAsset"] = len(ext)

    payload["cim_mapping_register"] = fetch_mapping_register(conn)
    payload["counts"]["total_features"] = sum(
        v for k, v in payload["counts"].items() if k != "total_features"
    )
    return payload


def create_export_job(
    conn,
    *,
    layers: list[str],
    clip: dict[str, float] | None,
    exclude_dq_blocked: bool,
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
              'export', 'cim-json', 'pending', %s,
              %s, %s, %s, %s,
              %s
            )
            RETURNING id::text, status::text, created_at
            """,
            (
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
        "status": row[1],
        "created_at": row[2].isoformat() if row[2] else None,
        "pgmq_msg_id": msg_id,
    }


def get_job(conn, job_id: str) -> dict[str, Any] | None:
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT id::text, direction::text, format, status::text,
                   storage_bucket, storage_path, layers,
                   clip_west, clip_south, clip_east, clip_north,
                   feature_count, error_message, requested_by,
                   created_at, started_at, completed_at
            FROM public.gis_transfer_jobs
            WHERE id = %s::uuid
            """,
            (job_id,),
        )
        row = cur.fetchone()
    if not row:
        return None
    return {
        "id": row[0],
        "direction": row[1],
        "format": row[2],
        "status": row[3],
        "storage_bucket": row[4],
        "storage_path": row[5],
        "layers": row[6],
        "clip": {
            "west": row[7],
            "south": row[8],
            "east": row[9],
            "north": row[10],
        }
        if row[7] is not None
        else None,
        "feature_count": row[11],
        "error_message": row[12],
        "requested_by": row[13],
        "created_at": row[14].isoformat() if row[14] else None,
        "started_at": row[15].isoformat() if row[15] else None,
        "completed_at": row[16].isoformat() if row[16] else None,
    }


def list_jobs(conn, *, limit: int = 50) -> list[dict[str, Any]]:
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT id::text, format, status::text, feature_count, created_at, completed_at
            FROM public.gis_transfer_jobs
            WHERE direction = 'export'
            ORDER BY created_at DESC
            LIMIT %s
            """,
            (limit,),
        )
        rows = cur.fetchall()
    return [
        {
            "id": r[0],
            "format": r[1],
            "status": r[2],
            "feature_count": r[3],
            "created_at": r[4].isoformat() if r[4] else None,
            "completed_at": r[5].isoformat() if r[5] else None,
        }
        for r in rows
    ]


def _upload_storage(bucket: str, path: str, body: bytes, content_type: str = "application/json") -> bool:
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


def process_export_job(conn, job_id: str) -> dict[str, Any]:
    job = get_job(conn, job_id)
    if not job:
        raise ValueError("Export job not found")
    if job["status"] == "completed":
        return job

    clip = job["clip"]
    if clip and None in clip.values():
        clip = None
    validate_export_scope(conn, clip)
    layers = job["layers"] or DEFAULT_LAYERS

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
        payload = build_cim_payload(conn, layers=layers, clip=clip, exclude_dq_blocked=True)
        body = json.dumps(payload, indent=2, default=str).encode("utf-8")
        storage_path = f"{job_id}/export.cim.json"

        EXPORTS_DIR.mkdir(parents=True, exist_ok=True)
        local_path = EXPORTS_DIR / job_id / "export.cim.json"
        local_path.parent.mkdir(parents=True, exist_ok=True)
        local_path.write_bytes(body)

        bucket = GIS_EXPORT_BUCKET
        uploaded = _upload_storage(bucket, storage_path, body)
        if not uploaded:
            bucket = "local"

        feature_count = payload["counts"].get("total_features", 0)
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


def read_export_bytes(conn, job_id: str) -> tuple[bytes, str]:
    job = get_job(conn, job_id)
    if not job or job["status"] != "completed":
        raise ValueError("Export not ready")
    path = job["storage_path"] or ""
    if job["storage_bucket"] == "local" or path.startswith("/"):
        file_path = Path(path)
        if not file_path.is_file():
            file_path = EXPORTS_DIR / job_id / "export.cim.json"
        return file_path.read_bytes(), "application/json"
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
    return resp.content, "application/json"
