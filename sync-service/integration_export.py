"""Integration batch exports (FR-019 phase 4) — MDMS and SAP CSV profiles."""

from __future__ import annotations

import csv
import io
from datetime import datetime, timezone
from typing import Any

from cim_export import validate_export_scope
from export_base import create_format_export_job, process_format_export_job, read_format_export_bytes
from gis_features import fetch_export_equipment, fetch_export_meters

MDMS_HEADERS = [
    "meter_mrid",
    "serial_number",
    "manufacturer",
    "installed_at",
    "lifecycle_state",
    "integration_batch_id",
    "exported_at",
]

SAP_HEADERS = [
    "equipment_mrid",
    "equipment_name",
    "nominal_voltage",
    "phases",
    "lifecycle_state",
    "boundary_feeder_id",
    "longitude",
    "latitude",
    "integration_batch_id",
    "exported_at",
]


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _csv_from_rows(headers: list[str], rows: list[list[Any]]) -> bytes:
    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(headers)
    for row in rows:
        writer.writerow(row)
    return buf.getvalue().encode("utf-8")


def build_mdms_csv(
    conn,
    *,
    batch_id: str | None = None,
    limit: int | None = None,
) -> tuple[bytes, dict[str, Any]]:
    batch = batch_id or f"MDMS-{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}"
    exported = _utc_now()
    meters = fetch_export_meters(conn, exclude_dq_blocked=True, limit=limit)
    rows = [
        [
            m["mrid"],
            m.get("serial_number"),
            m.get("manufacturer"),
            m.get("installed_at"),
            m.get("lifecycle_state"),
            batch,
            exported,
        ]
        for m in meters
    ]
    meta = {
        "@format": "mdms-csv",
        "integration_target": "MDMS",
        "batch_id": batch,
        "exported_at": exported,
        "counts": {"meters": len(meters), "total_features": len(meters)},
    }
    return _csv_from_rows(MDMS_HEADERS, rows), meta


def build_sap_csv(
    conn,
    *,
    clip: dict[str, float] | None,
    batch_id: str | None = None,
    limit: int | None = None,
) -> tuple[bytes, dict[str, Any]]:
    batch = batch_id or f"SAP-{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}"
    exported = _utc_now()
    equipment = fetch_export_equipment(conn, clip=clip, exclude_dq_blocked=True, limit=limit)
    rows = [
        [
            e["mrid"],
            e.get("name"),
            e.get("nominal_voltage"),
            e.get("phases"),
            e.get("lifecycle_state"),
            e.get("boundary_feeder_id"),
            e.get("lon"),
            e.get("lat"),
            batch,
            exported,
        ]
        for e in equipment
    ]
    meta = {
        "@format": "sap-csv",
        "integration_target": "SAP_S4HANA",
        "batch_id": batch,
        "exported_at": exported,
        "filters": {"master_only": True, "exclude_dq_blocked": True, "clip": clip},
        "counts": {"conducting_equipment": len(equipment), "total_features": len(equipment)},
    }
    return _csv_from_rows(SAP_HEADERS, rows), meta


def _build_mdms_body(conn, job: dict[str, Any]) -> tuple[bytes, dict[str, Any], str, str]:
    body, meta = build_mdms_csv(conn)
    return body, meta, "export_mdms.csv", "text/csv"


def _build_sap_body(conn, job: dict[str, Any]) -> tuple[bytes, dict[str, Any], str, str]:
    clip = job["clip"]
    if clip and None in clip.values():
        clip = None
    validate_export_scope(conn, clip)
    body, meta = build_sap_csv(conn, clip=clip)
    return body, meta, "export_sap.csv", "text/csv"


def create_mdms_export_job(conn, *, requested_by):
    return create_format_export_job(
        conn,
        fmt="mdms-csv",
        layers=["meters"],
        clip=None,
        requested_by=requested_by,
    )


def create_sap_export_job(conn, *, clip, requested_by):
    return create_format_export_job(
        conn,
        fmt="sap-csv",
        layers=["conducting_equipment"],
        clip=clip,
        requested_by=requested_by,
    )


def process_mdms_export_job(conn, job_id: str) -> dict[str, Any]:
    return process_format_export_job(
        conn,
        job_id,
        build_body=_build_mdms_body,
        default_filename="export_mdms.csv",
        content_type="text/csv",
    )


def process_sap_export_job(conn, job_id: str) -> dict[str, Any]:
    return process_format_export_job(
        conn,
        job_id,
        build_body=_build_sap_body,
        default_filename="export_sap.csv",
        content_type="text/csv",
    )


def read_mdms_bytes(conn, job_id: str) -> tuple[bytes, str]:
    return read_format_export_bytes(
        conn,
        job_id,
        default_filename="export_mdms.csv",
        content_type="text/csv",
    )


def read_sap_bytes(conn, job_id: str) -> tuple[bytes, str]:
    return read_format_export_bytes(
        conn,
        job_id,
        default_filename="export_sap.csv",
        content_type="text/csv",
    )
