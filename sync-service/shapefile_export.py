"""ESRI Shapefile export (FR-019 phase 1) — zipped point + line layers."""

from __future__ import annotations

import io
import tempfile
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import shapefile

from cim_export import validate_export_scope
from export_base import create_format_export_job, process_format_export_job, read_format_export_bytes
from gis_features import export_counts, fetch_export_lines, fetch_export_nodes

WGS84_PRJ = (
    'GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563]],'
    'PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433],AUTHORITY["EPSG","4326"]]'
)


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _line_coords_from_wkb(conn, wkb: bytes) -> list[tuple[float, float]]:
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT ST_X(dp.geom) AS x, ST_Y(dp.geom) AS y
            FROM ST_DumpPoints(ST_GeomFromWKB(%s, 4326)) AS dp
            ORDER BY dp.path
            """,
            (wkb,),
        )
        return [(float(r[0]), float(r[1])) for r in cur.fetchall()]


def _write_shapefile_set(
    base_path: Path,
    *,
    shp_type: int,
    fields: list[tuple[str, str, int, int]],
    records: list[tuple[Any, ...]],
    shapes: list,
) -> None:
    w = shapefile.Writer(str(base_path), shapeType=shp_type)
    w.autoBalance = 1
    for field in fields:
        w.field(*field)
    for shape, record in zip(shapes, records, strict=True):
        w.shape(shape)
        w.record(*record)
    w.close()
    base_path.with_suffix(".prj").write_text(WGS84_PRJ, encoding="utf-8")


def build_shapefile_zip(
    conn,
    *,
    clip: dict[str, float] | None,
    exclude_dq_blocked: bool = True,
    limit: int | None = None,
) -> tuple[bytes, dict[str, Any]]:
    nodes = fetch_export_nodes(conn, clip=clip, exclude_dq_blocked=exclude_dq_blocked, limit=limit)
    lines = fetch_export_lines(conn, clip=clip, exclude_dq_blocked=exclude_dq_blocked, limit=limit)

    with tempfile.TemporaryDirectory() as tmpdir:
        root = Path(tmpdir)

        if nodes:
            pt_base = root / "connectivity_nodes"
            pt_shapes = [shapefile.Point(n["lon"], n["lat"]) for n in nodes]
            pt_records = [
                (
                    n["mrid"][:254],
                    (n.get("name") or "")[:254],
                    (n.get("boundary_feeder_id") or "")[:254],
                    (n.get("nominal_voltage") or "")[:32],
                )
                for n in nodes
            ]
            _write_shapefile_set(
                pt_base,
                shp_type=shapefile.POINT,
                fields=[
                    ("mrid", "C", 254),
                    ("name", "C", 254),
                    ("feeder", "C", 254),
                    ("voltage", "C", 32),
                ],
                records=pt_records,
                shapes=pt_shapes,
            )

        if lines:
            ln_base = root / "ac_line_segments"
            ln_shapes = []
            ln_records = []
            for ln in lines:
                wkb = ln.get("wkb")
                if not wkb:
                    continue
                coords = _line_coords_from_wkb(conn, wkb)
                if len(coords) < 2:
                    continue
                ln_shapes.append(shapefile.Line([list(c) for c in coords]))
                ln_records.append(
                    (
                        ln["mrid"][:254],
                        (ln.get("name") or "")[:254],
                        (ln.get("source_node_mrid") or "")[:254],
                        (ln.get("target_node_mrid") or "")[:254],
                        (ln.get("nominal_voltage") or "")[:32],
                    )
                )
            if ln_shapes:
                _write_shapefile_set(
                    ln_base,
                    shp_type=shapefile.POLYLINE,
                    fields=[
                        ("mrid", "C", 254),
                        ("name", "C", 254),
                        ("src_mrid", "C", 254),
                        ("tgt_mrid", "C", 254),
                        ("voltage", "C", 32),
                    ],
                    records=ln_records,
                    shapes=ln_shapes,
                )

        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
            for path in root.rglob("*"):
                if path.is_file():
                    zf.write(path, arcname=path.relative_to(root).as_posix())

    meta = {
        "@format": "shapefile",
        "@crs": "EPSG:4326",
        "exported_at": _utc_now(),
        "filters": {"master_only": True, "exclude_dq_blocked": exclude_dq_blocked, "clip": clip},
        "layers": ["connectivity_nodes", "ac_line_segments"],
        "counts": export_counts(nodes, lines),
    }
    return buf.getvalue(), meta


def _build_job_body(conn, job: dict[str, Any]) -> tuple[bytes, dict[str, Any], str, str]:
    clip = job["clip"]
    if clip and None in clip.values():
        clip = None
    validate_export_scope(conn, clip)
    body, meta = build_shapefile_zip(conn, clip=clip)
    return body, meta, "export_shapefile.zip", "application/zip"


def create_shapefile_export_job(conn, *, clip, requested_by):
    return create_format_export_job(
        conn,
        fmt="shapefile",
        layers=["connectivity_nodes", "ac_line_segments"],
        clip=clip,
        requested_by=requested_by,
    )


def process_shapefile_export_job(conn, job_id: str) -> dict[str, Any]:
    return process_format_export_job(
        conn,
        job_id,
        build_body=_build_job_body,
        default_filename="export_shapefile.zip",
        content_type="application/zip",
    )


def read_shapefile_bytes(conn, job_id: str) -> tuple[bytes, str]:
    return read_format_export_bytes(
        conn,
        job_id,
        default_filename="export_shapefile.zip",
        content_type="application/zip",
    )
