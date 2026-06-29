"""KML export (FR-019 phase 1) — Google Earth compatible network layers."""

from __future__ import annotations

import html
from datetime import datetime, timezone
from typing import Any

from cim_export import validate_export_scope
from export_base import create_format_export_job, process_format_export_job, read_format_export_bytes
from gis_features import export_counts, fetch_export_lines, fetch_export_nodes


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _coords_from_line_wkb(conn, line: dict[str, Any]) -> str:
    if not line.get("wkb"):
        return ""
    with conn.cursor() as cur:
        cur.execute(
            "SELECT ST_AsText(ST_GeomFromWKB(%s, 4326))",
            (line["wkb"],),
        )
        wkt = cur.fetchone()[0]
    if not wkt or not wkt.startswith("LINESTRING"):
        return ""
    inner = wkt.replace("LINESTRING(", "").rstrip(")")
    parts = []
    for pair in inner.split(","):
        xy = pair.strip().split()
        if len(xy) >= 2:
            parts.append(f"{xy[0]},{xy[1]},0")
    return " ".join(parts)


def build_kml_text(
    conn,
    *,
    clip: dict[str, float] | None,
    exclude_dq_blocked: bool = True,
    limit: int | None = None,
) -> tuple[str, dict[str, Any]]:
    nodes = fetch_export_nodes(conn, clip=clip, exclude_dq_blocked=exclude_dq_blocked, limit=limit)
    lines = fetch_export_lines(conn, clip=clip, exclude_dq_blocked=exclude_dq_blocked, limit=limit)

    node_marks: list[str] = []
    for n in nodes:
        name = html.escape(n.get("name") or n["mrid"])
        desc = html.escape(
            f"mrid={n['mrid']}; feeder={n.get('boundary_feeder_id') or ''}; "
            f"voltage={n.get('nominal_voltage') or ''}"
        )
        node_marks.append(
            f"<Placemark><name>{name}</name><description>{desc}</description>"
            f"<Point><coordinates>{n['lon']},{n['lat']},0</coordinates></Point></Placemark>"
        )

    line_marks: list[str] = []
    for ln in lines:
        coords = _coords_from_line_wkb(conn, ln)
        if not coords:
            continue
        name = html.escape(ln.get("name") or ln["mrid"])
        desc = html.escape(
            f"mrid={ln['mrid']}; src={ln.get('source_node_mrid')}; "
            f"tgt={ln.get('target_node_mrid')}; voltage={ln.get('nominal_voltage') or ''}"
        )
        line_marks.append(
            f"<Placemark><name>{name}</name><description>{desc}</description>"
            f"<LineString><coordinates>{coords}</coordinates></LineString></Placemark>"
        )

    kml = (
        '<?xml version="1.0" encoding="UTF-8"?>'
        '<kml xmlns="http://www.opengis.net/kml/2.2">'
        "<Document>"
        "<name>GIOP Master Export</name>"
        f'<description>Exported {_utc_now()} — EPSG:4326</description>'
        '<Folder><name>connectivity_nodes</name>'
        + "".join(node_marks)
        + "</Folder>"
        '<Folder><name>ac_line_segments</name>'
        + "".join(line_marks)
        + "</Folder></Document></kml>"
    )
    meta = {
        "@format": "kml",
        "@crs": "EPSG:4326",
        "exported_at": _utc_now(),
        "filters": {"master_only": True, "exclude_dq_blocked": exclude_dq_blocked, "clip": clip},
        "counts": export_counts(nodes, lines),
    }
    return kml, meta


def _build_job_body(conn, job: dict[str, Any]) -> tuple[bytes, dict[str, Any], str, str]:
    clip = job["clip"]
    if clip and None in clip.values():
        clip = None
    validate_export_scope(conn, clip)
    kml, meta = build_kml_text(conn, clip=clip)
    return kml.encode("utf-8"), meta, "export.kml", "application/vnd.google-earth.kml+xml"


def create_kml_export_job(conn, *, clip, requested_by):
    return create_format_export_job(
        conn,
        fmt="kml",
        layers=["connectivity_nodes", "ac_line_segments"],
        clip=clip,
        requested_by=requested_by,
    )


def process_kml_export_job(conn, job_id: str) -> dict[str, Any]:
    return process_format_export_job(
        conn,
        job_id,
        build_body=_build_job_body,
        default_filename="export.kml",
        content_type="application/vnd.google-earth.kml+xml",
    )


def read_kml_bytes(conn, job_id: str) -> tuple[bytes, str]:
    return read_format_export_bytes(
        conn,
        job_id,
        default_filename="export.kml",
        content_type="application/vnd.google-earth.kml+xml",
    )
