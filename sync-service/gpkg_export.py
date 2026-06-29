"""GeoPackage export (FR-019 phase 1) — connectivity_nodes + ac_line_segments layers."""

from __future__ import annotations

import sqlite3
import struct
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from cim_export import validate_export_scope
from export_base import create_format_export_job, process_format_export_job, read_format_export_bytes
from gis_features import export_counts, fetch_export_lines, fetch_export_nodes

GPKG_MAGIC = b"GP"
SRS_WGS84 = 4326


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def wkb_to_gpkg_blob(wkb: bytes, *, minx: float, maxx: float, miny: float, maxy: float) -> bytes:
    """Wrap PostGIS WKB in a GeoPackage geometry blob (XY envelope, little-endian)."""
    flags = 0x01 | (0x01 << 1)  # little-endian + XY envelope
    header = bytearray()
    header.extend(GPKG_MAGIC)
    header.append(0)  # version
    header.append(flags)
    header.extend(struct.pack("<i", SRS_WGS84))
    header.extend(struct.pack("<dddd", minx, maxx, miny, maxy))
    return bytes(header) + wkb


def _envelope_from_wkb_point(wkb: bytes) -> tuple[float, float, float, float]:
    if len(wkb) < 21:
        return (0.0, 0.0, 0.0, 0.0)
    x, y = struct.unpack_from("<dd", wkb, 5)
    return (x, x, y, y)


def _envelope_from_wkb_line(wkb: bytes) -> tuple[float, float, float, float]:
    if len(wkb) < 9:
        return (0.0, 0.0, 0.0, 0.0)
    npts = struct.unpack_from("<I", wkb, 5)[0]
    offset = 9
    xs: list[float] = []
    ys: list[float] = []
    for _ in range(npts):
        x, y = struct.unpack_from("<dd", wkb, offset)
        xs.append(x)
        ys.append(y)
        offset += 16
    return (min(xs), max(xs), min(ys), max(ys))


def _init_gpkg(conn: sqlite3.Connection) -> None:
    conn.executescript(
        """
        PRAGMA application_id = 0x47504B47;

        CREATE TABLE gpkg_spatial_ref_sys (
          srs_name TEXT NOT NULL,
          srs_id INTEGER NOT NULL PRIMARY KEY,
          organization TEXT NOT NULL,
          organization_coordsys_id INTEGER NOT NULL,
          definition TEXT NOT NULL,
          description TEXT
        );

        INSERT INTO gpkg_spatial_ref_sys VALUES
          ('Undefined cartesian SRS', -1, 'NONE', -1, 'undefined', 'undefined'),
          ('Undefined geographic SRS', 0, 'NONE', 0, 'undefined', 'undefined'),
          ('WGS 84', 4326, 'EPSG', 4326,
           'GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563]],
            PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]]', 'WGS 84');

        CREATE TABLE gpkg_contents (
          table_name TEXT NOT NULL PRIMARY KEY,
          data_type TEXT NOT NULL,
          identifier TEXT UNIQUE,
          description TEXT DEFAULT '',
          last_change DATETIME NOT NULL DEFAULT (strftime('%%Y-%%m-%%dT%%H:%%M:%%fZ','now')),
          min_x DOUBLE, min_y DOUBLE, max_x DOUBLE, max_y DOUBLE,
          srs_id INTEGER,
          CONSTRAINT fk_gc_r_srs_id FOREIGN KEY (srs_id) REFERENCES gpkg_spatial_ref_sys(srs_id)
        );

        CREATE TABLE gpkg_geometry_columns (
          table_name TEXT NOT NULL,
          column_name TEXT NOT NULL,
          geometry_type_name TEXT NOT NULL,
          srs_id INTEGER NOT NULL,
          z TINYINT NOT NULL,
          m TINYINT NOT NULL,
          CONSTRAINT pk_geom_cols PRIMARY KEY (table_name, column_name),
          CONSTRAINT fk_gc_tn FOREIGN KEY (table_name) REFERENCES gpkg_contents(table_name),
          CONSTRAINT fk_gc_srs FOREIGN KEY (srs_id) REFERENCES gpkg_spatial_ref_sys(srs_id)
        );

        CREATE TABLE gpkg_ogr_contents (
          table_name TEXT NOT NULL PRIMARY KEY,
          feature_count INTEGER DEFAULT 0
        );
        """
    )


def _register_layer(
    conn: sqlite3.Connection,
    table: str,
    geom_type: str,
    *,
    min_x: float,
    min_y: float,
    max_x: float,
    max_y: float,
    count: int,
) -> None:
    conn.execute(
        """
        INSERT INTO gpkg_contents
          (table_name, data_type, identifier, description, min_x, min_y, max_x, max_y, srs_id)
        VALUES (?, 'features', ?, ?, ?, ?, ?, ?, ?)
        """,
        (table, table, f"GIOP {table}", min_x, min_y, max_x, max_y, SRS_WGS84),
    )
    conn.execute(
        """
        INSERT INTO gpkg_geometry_columns
          (table_name, column_name, geometry_type_name, srs_id, z, m)
        VALUES (?, 'geom', ?, ?, 0, 0)
        """,
        (table, geom_type, SRS_WGS84),
    )
    conn.execute(
        "INSERT INTO gpkg_ogr_contents (table_name, feature_count) VALUES (?, ?)",
        (table, count),
    )


def build_gpkg_bytes(
    conn,
    *,
    clip: dict[str, float] | None,
    exclude_dq_blocked: bool = True,
    limit: int | None = None,
) -> tuple[bytes, dict[str, Any]]:
    nodes = fetch_export_nodes(conn, clip=clip, exclude_dq_blocked=exclude_dq_blocked, limit=limit)
    lines = fetch_export_lines(conn, clip=clip, exclude_dq_blocked=exclude_dq_blocked, limit=limit)

    sqlite_conn = sqlite3.connect(":memory:")
    try:
        _init_gpkg(sqlite_conn)

        sqlite_conn.execute(
            """
            CREATE TABLE connectivity_nodes (
              fid INTEGER PRIMARY KEY AUTOINCREMENT,
              geom BLOB NOT NULL,
              mrid TEXT, name TEXT, boundary_feeder_id TEXT,
              nominal_voltage TEXT, lifecycle_state TEXT
            )
            """
        )
        n_env = [180.0, -180.0, 90.0, -90.0]
        for n in nodes:
            wkb = n.get("wkb")
            if not wkb:
                continue
            env = _envelope_from_wkb_point(wkb)
            blob = wkb_to_gpkg_blob(wkb, minx=env[0], maxx=env[1], miny=env[2], maxy=env[3])
            sqlite_conn.execute(
                """
                INSERT INTO connectivity_nodes
                  (geom, mrid, name, boundary_feeder_id, nominal_voltage, lifecycle_state)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (blob, n["mrid"], n["name"], n["boundary_feeder_id"], n["nominal_voltage"], n["lifecycle_state"]),
            )
            n_env[0] = min(n_env[0], env[0])
            n_env[1] = max(n_env[1], env[1])
            n_env[2] = min(n_env[2], env[2])
            n_env[3] = max(n_env[3], env[3])

        if nodes:
            _register_layer(
                sqlite_conn,
                "connectivity_nodes",
                "POINT",
                min_x=n_env[0],
                min_y=n_env[2],
                max_x=n_env[1],
                max_y=n_env[3],
                count=len(nodes),
            )

        sqlite_conn.execute(
            """
            CREATE TABLE ac_line_segments (
              fid INTEGER PRIMARY KEY AUTOINCREMENT,
              geom BLOB NOT NULL,
              mrid TEXT, name TEXT,
              source_node_mrid TEXT, target_node_mrid TEXT,
              nominal_voltage TEXT, phases TEXT
            )
            """
        )
        l_env = [180.0, -180.0, 90.0, -90.0]
        for ln in lines:
            wkb = ln.get("wkb")
            if not wkb:
                continue
            env = _envelope_from_wkb_line(wkb)
            blob = wkb_to_gpkg_blob(wkb, minx=env[0], maxx=env[1], miny=env[2], maxy=env[3])
            sqlite_conn.execute(
                """
                INSERT INTO ac_line_segments
                  (geom, mrid, name, source_node_mrid, target_node_mrid, nominal_voltage, phases)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    blob,
                    ln["mrid"],
                    ln["name"],
                    ln["source_node_mrid"],
                    ln["target_node_mrid"],
                    ln["nominal_voltage"],
                    ln["phases"],
                ),
            )
            l_env[0] = min(l_env[0], env[0])
            l_env[1] = max(l_env[1], env[1])
            l_env[2] = min(l_env[2], env[2])
            l_env[3] = max(l_env[3], env[3])

        if lines:
            _register_layer(
                sqlite_conn,
                "ac_line_segments",
                "LINESTRING",
                min_x=l_env[0],
                min_y=l_env[2],
                max_x=l_env[1],
                max_y=l_env[3],
                count=len(lines),
            )

        sqlite_conn.commit()
        with tempfile.NamedTemporaryFile(suffix=".gpkg") as tmp:
            disk = sqlite3.connect(tmp.name)
            sqlite_conn.backup(disk)
            disk.close()
            body_bytes = Path(tmp.name).read_bytes()
    finally:
        sqlite_conn.close()

    meta = {
        "@format": "geopackage",
        "@crs": "EPSG:4326",
        "exported_at": _utc_now(),
        "filters": {"master_only": True, "exclude_dq_blocked": exclude_dq_blocked, "clip": clip},
        "layers": ["connectivity_nodes", "ac_line_segments"],
        "counts": export_counts(nodes, lines),
    }
    return body_bytes, meta


def _build_job_body(conn, job: dict[str, Any]) -> tuple[bytes, dict[str, Any], str, str]:
    clip = job["clip"]
    if clip and None in clip.values():
        clip = None
    validate_export_scope(conn, clip)
    body, meta = build_gpkg_bytes(conn, clip=clip)
    return body, meta, "export.gpkg", "application/geopackage+sqlite3"


def create_gpkg_export_job(conn, *, clip, exclude_dq_blocked, requested_by):
    return create_format_export_job(
        conn,
        fmt="geopackage",
        layers=["connectivity_nodes", "ac_line_segments"],
        clip=clip,
        requested_by=requested_by,
    )


def process_gpkg_export_job(conn, job_id: str) -> dict[str, Any]:
    return process_format_export_job(
        conn,
        job_id,
        build_body=_build_job_body,
        default_filename="export.gpkg",
        content_type="application/geopackage+sqlite3",
    )


def read_gpkg_bytes(conn, job_id: str) -> tuple[bytes, str]:
    return read_format_export_bytes(
        conn,
        job_id,
        default_filename="export.gpkg",
        content_type="application/geopackage+sqlite3",
    )
