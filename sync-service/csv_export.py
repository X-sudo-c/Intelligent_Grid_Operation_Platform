"""CSV export (FR-019 phase 2) — tabular master dumps in a zip bundle."""

from __future__ import annotations

import csv
import io
import zipfile
from datetime import datetime, timezone
from typing import Any

from cim_export import validate_export_scope
from export_base import create_format_export_job, process_format_export_job, read_format_export_bytes
from gis_features import fetch_export_lines, fetch_export_meters, fetch_export_nodes


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _csv_bytes(headers: list[str], rows: list[list[Any]]) -> bytes:
    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(headers)
    for row in rows:
        writer.writerow(row)
    return buf.getvalue().encode("utf-8")


def build_csv_zip(
    conn,
    *,
    clip: dict[str, float] | None,
    exclude_dq_blocked: bool = True,
    include_meters: bool = True,
    limit: int | None = None,
) -> tuple[bytes, dict[str, Any]]:
    nodes = fetch_export_nodes(conn, clip=clip, exclude_dq_blocked=exclude_dq_blocked, limit=limit)
    lines = fetch_export_lines(conn, clip=clip, exclude_dq_blocked=exclude_dq_blocked, limit=limit)
    meters = fetch_export_meters(conn, exclude_dq_blocked=exclude_dq_blocked, limit=limit) if include_meters else []

    files: dict[str, bytes] = {
        "connectivity_nodes.csv": _csv_bytes(
            ["mrid", "name", "boundary_feeder_id", "nominal_voltage", "lifecycle_state", "lon", "lat"],
            [
                [
                    n["mrid"],
                    n.get("name"),
                    n.get("boundary_feeder_id"),
                    n.get("nominal_voltage"),
                    n.get("lifecycle_state"),
                    n["lon"],
                    n["lat"],
                ]
                for n in nodes
            ],
        ),
        "ac_line_segments.csv": _csv_bytes(
            ["mrid", "name", "source_node_mrid", "target_node_mrid", "nominal_voltage", "phases"],
            [
                [
                    ln["mrid"],
                    ln.get("name"),
                    ln.get("source_node_mrid"),
                    ln.get("target_node_mrid"),
                    ln.get("nominal_voltage"),
                    ln.get("phases"),
                ]
                for ln in lines
            ],
        ),
    }
    if include_meters:
        files["meters.csv"] = _csv_bytes(
            ["mrid", "name", "serial_number", "manufacturer", "installed_at", "lifecycle_state"],
            [
                [
                    m["mrid"],
                    m.get("name"),
                    m.get("serial_number"),
                    m.get("manufacturer"),
                    m.get("installed_at"),
                    m.get("lifecycle_state"),
                ]
                for m in meters
            ],
        )

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for name, data in files.items():
            zf.writestr(name, data)

    total = len(nodes) + len(lines) + len(meters)
    meta = {
        "@format": "csv",
        "exported_at": _utc_now(),
        "filters": {
            "master_only": True,
            "exclude_dq_blocked": exclude_dq_blocked,
            "clip": clip,
            "include_meters": include_meters,
        },
        "counts": {
            "connectivity_nodes": len(nodes),
            "ac_line_segments": len(lines),
            "meters": len(meters),
            "total_features": total,
        },
    }
    return buf.getvalue(), meta


def _build_job_body(conn, job: dict[str, Any]) -> tuple[bytes, dict[str, Any], str, str]:
    clip = job["clip"]
    if clip and None in clip.values():
        clip = None
    validate_export_scope(conn, clip)
    layers = job.get("layers") or []
    include_meters = "meters" in layers or not layers
    body, meta = build_csv_zip(conn, clip=clip, include_meters=include_meters)
    return body, meta, "export_csv.zip", "application/zip"


def create_csv_export_job(conn, *, clip, include_meters: bool, requested_by):
    layers = ["connectivity_nodes", "ac_line_segments"]
    if include_meters:
        layers.append("meters")
    return create_format_export_job(
        conn,
        fmt="csv",
        layers=layers,
        clip=clip,
        requested_by=requested_by,
    )


def process_csv_export_job(conn, job_id: str) -> dict[str, Any]:
    return process_format_export_job(
        conn,
        job_id,
        build_body=_build_job_body,
        default_filename="export_csv.zip",
        content_type="application/zip",
    )


def read_csv_bytes(conn, job_id: str) -> tuple[bytes, str]:
    return read_format_export_bytes(
        conn,
        job_id,
        default_filename="export_csv.zip",
        content_type="application/zip",
    )
