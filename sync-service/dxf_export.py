"""AutoCAD DXF export (FR-019 extension) — master POINT/LINE via gis_transfer_jobs."""

from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from cim_export import (
    EXPORTS_DIR,
    GIS_EXPORT_BUCKET,
    SUPABASE_SERVICE_KEY,
    SUPABASE_URL,
    _blocked_mrids,
    _bbox_clause,
    _upload_storage,
    get_job,
    validate_export_scope,
)

DXF_VERSION = "AC1015"
DEFAULT_LAYERS = ["nodes", "lines"]


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _sanitize_layer(name: str | None, fallback: str) -> str:
    raw = (name or fallback).strip() or fallback
    return re.sub(r"[^A-Za-z0-9_\-]", "_", raw)[:31]


def _dxf_pair(code: int, value: str | float | int) -> str:
    return f"{code}\n{value}\n"


def _point_entity(layer: str, x: float, y: float, z: float = 0.0) -> str:
    return "".join(
        [
            _dxf_pair(0, "POINT"),
            _dxf_pair(8, layer),
            _dxf_pair(10, round(x, 8)),
            _dxf_pair(20, round(y, 8)),
            _dxf_pair(30, round(z, 8)),
        ]
    )


def _line_entity(
    layer: str, x1: float, y1: float, x2: float, y2: float, z: float = 0.0
) -> str:
    return "".join(
        [
            _dxf_pair(0, "LINE"),
            _dxf_pair(8, layer),
            _dxf_pair(10, round(x1, 8)),
            _dxf_pair(20, round(y1, 8)),
            _dxf_pair(30, round(z, 8)),
            _dxf_pair(11, round(x2, 8)),
            _dxf_pair(21, round(y2, 8)),
            _dxf_pair(31, round(z, 8)),
        ]
    )


def build_dxf_text(entities: str) -> str:
    """Minimal DXF R2000 with ENTITIES section (WGS84 lon/lat as X/Y)."""
    header = "".join(
        [
            _dxf_pair(0, "SECTION"),
            _dxf_pair(2, "HEADER"),
            _dxf_pair(9, "$ACADVER"),
            _dxf_pair(1, DXF_VERSION),
            _dxf_pair(9, "$INSUNITS"),
            _dxf_pair(70, 0),
            _dxf_pair(0, "ENDSEC"),
        ]
    )
    body = "".join(
        [
            _dxf_pair(0, "SECTION"),
            _dxf_pair(2, "ENTITIES"),
            entities,
            _dxf_pair(0, "ENDSEC"),
        ]
    )
    return header + body + _dxf_pair(0, "EOF")


def fetch_dxf_features(
    conn,
    *,
    clip: dict[str, float] | None,
    exclude_dq_blocked: bool = True,
    include_nodes: bool = True,
    include_lines: bool = True,
    limit: int | None = None,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    blocked = _blocked_mrids(conn, exclude_dq_blocked)
    bbox_sql, bbox_params = _bbox_clause("cn", "geom", clip)
    nodes: list[dict[str, Any]] = []

    if include_nodes:
        lim = f" LIMIT {int(limit)}" if limit else ""
        with conn.cursor() as cur:
            cur.execute(
                f"""
                SELECT cn.mrid::text, io.name, cn.boundary_feeder_id,
                       ST_X(cn.geom) AS lon, ST_Y(cn.geom) AS lat,
                       ce.nominal_voltage::text
                FROM public.connectivity_nodes cn
                JOIN public.identified_objects io ON io.mrid = cn.mrid
                LEFT JOIN public.conducting_equipment ce ON ce.mrid = cn.mrid
                WHERE io.validation = 'APPROVED'
                {bbox_sql}
                ORDER BY io.name
                {lim}
                """,
                bbox_params,
            )
            for row in cur.fetchall():
                mrid = row[0]
                if mrid in blocked:
                    continue
                voltage = row[5]
                nodes.append(
                    {
                        "mrid": mrid,
                        "name": row[1],
                        "feeder": row[2],
                        "lon": float(row[3]),
                        "lat": float(row[4]),
                        "layer": _sanitize_layer(voltage, "GIOP_NODES"),
                    }
                )

    lines: list[dict[str, Any]] = []
    if include_lines:
        line_bbox, line_params = _bbox_clause("als", "geom", clip)
        lim = f" LIMIT {int(limit)}" if limit else ""
        with conn.cursor() as cur:
            cur.execute(
                f"""
                SELECT als.mrid::text, io.name, ce.nominal_voltage::text,
                       ST_X(ST_StartPoint(als.geom)) AS x1,
                       ST_Y(ST_StartPoint(als.geom)) AS y1,
                       ST_X(ST_EndPoint(als.geom)) AS x2,
                       ST_Y(ST_EndPoint(als.geom)) AS y2
                FROM public.ac_line_segments als
                JOIN public.identified_objects io ON io.mrid = als.mrid
                JOIN public.conducting_equipment ce ON ce.mrid = als.mrid
                WHERE io.validation = 'APPROVED'
                {line_bbox}
                ORDER BY io.name
                {lim}
                """,
                line_params,
            )
            for row in cur.fetchall():
                if row[0] in blocked:
                    continue
                lines.append(
                    {
                        "mrid": row[0],
                        "name": row[1],
                        "lon1": float(row[3]),
                        "lat1": float(row[4]),
                        "lon2": float(row[5]),
                        "lat2": float(row[6]),
                        "layer": _sanitize_layer(row[2], "GIOP_LINES"),
                    }
                )

    return nodes, lines


def build_dxf_payload(
    conn,
    *,
    clip: dict[str, float] | None,
    exclude_dq_blocked: bool = True,
    include_nodes: bool = True,
    include_lines: bool = True,
    limit: int | None = None,
) -> tuple[str, dict[str, Any]]:
    nodes, lines = fetch_dxf_features(
        conn,
        clip=clip,
        exclude_dq_blocked=exclude_dq_blocked,
        include_nodes=include_nodes,
        include_lines=include_lines,
        limit=limit,
    )
    parts: list[str] = []
    for n in nodes:
        parts.append(_point_entity(n["layer"], n["lon"], n["lat"]))
    for ln in lines:
        parts.append(
            _line_entity(ln["layer"], ln["lon1"], ln["lat1"], ln["lon2"], ln["lat2"])
        )

    meta = {
        "@format": "dxf",
        "@crs": "EPSG:4326",
        "note": "X=longitude, Y=latitude (WGS84 degrees)",
        "exported_at": _utc_now(),
        "filters": {
            "master_only": True,
            "exclude_dq_blocked": exclude_dq_blocked,
            "clip": clip,
            "include_nodes": include_nodes,
            "include_lines": include_lines,
        },
        "counts": {
            "POINT": len(nodes),
            "LINE": len(lines),
            "total_features": len(nodes) + len(lines),
        },
    }
    return build_dxf_text("".join(parts)), meta


def create_dxf_export_job(
    conn,
    *,
    clip: dict[str, float] | None,
    exclude_dq_blocked: bool,
    include_nodes: bool,
    include_lines: bool,
    requested_by: str | None,
) -> dict[str, Any]:
    layers = []
    if include_nodes:
        layers.append("nodes")
    if include_lines:
        layers.append("lines")
    if not layers:
        layers = list(DEFAULT_LAYERS)

    with conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO public.gis_transfer_jobs (
              direction, format, status, layers,
              clip_west, clip_south, clip_east, clip_north,
              requested_by
            )
            VALUES (
              'export', 'dxf', 'pending', %s,
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
        "format": "dxf",
        "status": row[1],
        "created_at": row[2].isoformat() if row[2] else None,
        "pgmq_msg_id": msg_id,
    }


def process_dxf_export_job(conn, job_id: str) -> dict[str, Any]:
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
    include_nodes = "nodes" in layers
    include_lines = "lines" in layers

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
        dxf_text, meta = build_dxf_payload(
            conn,
            clip=clip,
            exclude_dq_blocked=True,
            include_nodes=include_nodes,
            include_lines=include_lines,
        )
        body = dxf_text.encode("utf-8")
        storage_path = f"{job_id}/export.dxf"

        EXPORTS_DIR.mkdir(parents=True, exist_ok=True)
        local_dir = EXPORTS_DIR / job_id
        local_dir.mkdir(parents=True, exist_ok=True)
        local_path = local_dir / "export.dxf"
        local_path.write_bytes(body)
        (local_dir / "export.meta.json").write_text(
            json.dumps(meta, indent=2), encoding="utf-8"
        )

        bucket = GIS_EXPORT_BUCKET
        uploaded = _upload_storage(bucket, storage_path, body, content_type="application/dxf")
        if not uploaded:
            bucket = "local"

        feature_count = meta["counts"]["total_features"]
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


def read_dxf_bytes(conn, job_id: str) -> tuple[bytes, str]:
    job = get_job(conn, job_id)
    if not job or job["status"] != "completed":
        raise ValueError("Export not ready")
    path = job["storage_path"] or ""
    if job["storage_bucket"] == "local" or path.startswith("/"):
        file_path = Path(path)
        if not file_path.is_file():
            file_path = EXPORTS_DIR / job_id / "export.dxf"
        return file_path.read_bytes(), "application/dxf"
    if not SUPABASE_SERVICE_KEY:
        raise ValueError("Storage download requires SUPABASE_SERVICE_KEY")
    import requests

    url = f"{SUPABASE_URL.rstrip('/')}/storage/v1/object/{job['storage_bucket']}/{path}"
    resp = requests.get(
        url,
        headers={"Authorization": f"Bearer {SUPABASE_SERVICE_KEY}"},
        timeout=120,
    )
    if resp.status_code != 200:
        raise ValueError(f"Storage download failed: HTTP {resp.status_code}")
    return resp.content, "application/dxf"
