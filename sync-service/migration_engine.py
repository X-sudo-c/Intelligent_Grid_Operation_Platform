"""FR-017 migration adapter — DXF + GeoPackage parsing, affine georeferencing, commit.

Pure-Python parsers (no GDAL/shapely/ezdxf) so the engine runs in any environment:
  * DXF: minimal tagged-pair reader for POINT and LINE entities.
  * GeoPackage: SQLite feature tables; decode GPKG geometry blob header → WKB → coords.

Valid POINT features land in staging (PENDING_FIELD) and run data-quality checks;
LINE features land in the raw gis.conductor_segments registry. Failures route to the
migration DLQ and gis.migration_failed_elements with lineage evidence.
"""

from __future__ import annotations

import json
import math
import sqlite3
import struct
import uuid
from typing import Any, Iterable

# Ghana operating bbox (matches data_quality / cim_export).
GHANA_BBOX = (-3.5, 4.5, 1.5, 8.5)
_MRID_NS = uuid.UUID("6ba7b810-9dad-11d1-80b4-00c04fd430c8")


# --------------------------------------------------------------------------- #
# Affine georeferencing
# --------------------------------------------------------------------------- #
def affine_transform(
    x: float,
    y: float,
    *,
    anchor_lon: float,
    anchor_lat: float,
    scale: float = 1.0,
    rotation_deg: float = 0.0,
    origin_x: float = 0.0,
    origin_y: float = 0.0,
) -> tuple[float, float]:
    """Map a local drawing coordinate to WGS84 lon/lat.

    Local point is offset from (origin_x, origin_y), scaled, optionally rotated,
    then anchored at (anchor_lon, anchor_lat). `scale` is degrees per local unit.
    """
    dx = (x - origin_x) * scale
    dy = (y - origin_y) * scale
    if rotation_deg:
        rad = math.radians(rotation_deg)
        cos_r, sin_r = math.cos(rad), math.sin(rad)
        dx, dy = dx * cos_r - dy * sin_r, dx * sin_r + dy * cos_r
    return anchor_lon + dx, anchor_lat + dy


def _in_ghana(lon: float, lat: float) -> bool:
    w, s, e, n = GHANA_BBOX
    return w <= lon <= e and s <= lat <= n


def _valid_lonlat(lon: float, lat: float) -> bool:
    return -180 <= lon <= 180 and -90 <= lat <= 90


# --------------------------------------------------------------------------- #
# DXF parsing (POINT + LINE)
# --------------------------------------------------------------------------- #
def parse_dxf(text: str) -> list[dict[str, Any]]:
    """Read POINT and LINE primitives from DXF text as (group code, value) pairs."""
    lines = text.splitlines()
    pairs: list[tuple[int, str]] = []
    i = 0
    while i + 1 < len(lines):
        code_raw = lines[i].strip()
        value = lines[i + 1].strip()
        i += 2
        try:
            code = int(code_raw)
        except ValueError:
            continue
        pairs.append((code, value))

    features: list[dict[str, Any]] = []
    idx = 0
    n = len(pairs)
    fid = 0
    while idx < n:
        code, value = pairs[idx]
        if code == 0 and value in ("POINT", "LINE"):
            entity = value
            attrs: dict[int, float] = {}
            layer = ""
            j = idx + 1
            while j < n and pairs[j][0] != 0:
                gc, gv = pairs[j]
                if gc == 8:
                    layer = gv
                elif gc in (10, 20, 30, 11, 21, 31):
                    try:
                        attrs[gc] = float(gv)
                    except ValueError:
                        pass
                j += 1
            fid += 1
            if entity == "POINT" and 10 in attrs and 20 in attrs:
                features.append(
                    {
                        "primitive": "POINT",
                        "fid": fid,
                        "layer": layer or "dxf",
                        "coords": [(attrs[10], attrs[20])],
                    }
                )
            elif entity == "LINE" and {10, 20, 11, 21} <= attrs.keys():
                features.append(
                    {
                        "primitive": "LINE",
                        "fid": fid,
                        "layer": layer or "dxf",
                        "coords": [(attrs[10], attrs[20]), (attrs[11], attrs[21])],
                    }
                )
            idx = j
        else:
            idx += 1
    return features


# --------------------------------------------------------------------------- #
# GeoPackage blob → WKB → coords
# --------------------------------------------------------------------------- #
def gpkg_blob_to_wkb(blob: bytes) -> bytes:
    """Strip the GeoPackage binary header, returning the embedded WKB."""
    if len(blob) < 8 or blob[0:2] != b"GP":
        raise ValueError("Not a GeoPackage geometry blob")
    flags = blob[3]
    envelope_indicator = (flags >> 1) & 0x07
    env_sizes = {0: 0, 1: 32, 2: 48, 3: 48, 4: 64}
    if envelope_indicator not in env_sizes:
        raise ValueError("Invalid GPKG envelope indicator")
    header_len = 8 + env_sizes[envelope_indicator]
    return blob[header_len:]


def _wkb_coords(wkb: bytes) -> dict[str, Any]:
    """Parse WKB POINT / LINESTRING (with optional Z/M and SRID) into coords."""
    if len(wkb) < 5:
        raise ValueError("WKB too short")
    byte_order = wkb[0]
    endian = "<" if byte_order == 1 else ">"
    geom_type = struct.unpack_from(f"{endian}I", wkb, 1)[0]
    offset = 5
    has_srid = bool(geom_type & 0x20000000)
    base = geom_type & 0xFF
    dims = 2
    if geom_type & 0x80000000:
        dims += 1
    if geom_type & 0x40000000:
        dims += 1
    # ISO WKB high-range codes (1000s) also encode Z/M.
    iso = geom_type & 0xFFFF
    if iso in (1001, 2001, 3001):
        base = 1
    elif iso in (1002, 2002, 3002):
        base = 2
    if 1000 <= iso < 2000:
        dims = 3
    elif 2000 <= iso < 3000:
        dims = 3
    elif 3000 <= iso < 4000:
        dims = 4
    if has_srid:
        offset += 4

    coord_size = 8 * dims

    if base == 1:  # POINT
        x, y = struct.unpack_from(f"{endian}dd", wkb, offset)
        return {"type": "POINT", "coords": [(x, y)]}
    if base == 2:  # LINESTRING
        npts = struct.unpack_from(f"{endian}I", wkb, offset)[0]
        offset += 4
        coords = []
        for _ in range(npts):
            x, y = struct.unpack_from(f"{endian}dd", wkb, offset)
            coords.append((x, y))
            offset += coord_size
        return {"type": "LINESTRING", "coords": coords}
    raise ValueError(f"Unsupported WKB base geometry type {base}")


def _list_gpkg_geometry_tables(conn_sqlite: sqlite3.Connection) -> list[tuple[str, str]]:
    cur = conn_sqlite.execute(
        "SELECT table_name, column_name FROM gpkg_geometry_columns"
    )
    return [(r[0], r[1]) for r in cur.fetchall()]


def parse_geopackage(path: str, table: str | None = None) -> list[dict[str, Any]]:
    """Read POINT/LINESTRING features from a GeoPackage file via SQLite."""
    sqlite_conn = sqlite3.connect(path)
    try:
        tables = _list_gpkg_geometry_tables(sqlite_conn)
        if not tables:
            raise ValueError("No gpkg_geometry_columns found")
        targets = [t for t in tables if table is None or t[0] == table]
        if not targets:
            raise ValueError(f"Table {table} not found in GeoPackage")

        features: list[dict[str, Any]] = []
        for tbl, geom_col in targets:
            rows = sqlite_conn.execute(
                f'SELECT rowid, "{geom_col}" FROM "{tbl}"'
            ).fetchall()
            for rowid, blob in rows:
                if blob is None:
                    continue
                try:
                    wkb = gpkg_blob_to_wkb(bytes(blob))
                    parsed = _wkb_coords(wkb)
                except Exception as exc:  # noqa: BLE001
                    features.append(
                        {
                            "primitive": "INVALID",
                            "fid": rowid,
                            "layer": tbl,
                            "coords": [],
                            "error": str(exc),
                        }
                    )
                    continue
                features.append(
                    {
                        "primitive": "POINT" if parsed["type"] == "POINT" else "LINE",
                        "fid": rowid,
                        "layer": tbl,
                        "coords": parsed["coords"],
                    }
                )
        return features
    finally:
        sqlite_conn.close()


# --------------------------------------------------------------------------- #
# Commit orchestration
# --------------------------------------------------------------------------- #
def _mrid_for(source_ref: str) -> str:
    return str(uuid.uuid5(_MRID_NS, f"giop:migration:{source_ref}"))


def _linestring_wkt(coords: list[tuple[float, float]]) -> str:
    pts = ", ".join(f"{lon} {lat}" for lon, lat in coords)
    return f"LINESTRING({pts})"


def run_migration(
    conn,
    *,
    source_format: str,
    source_name: str,
    features: Iterable[dict[str, Any]],
    affine: dict[str, float],
    apply_affine: bool,
    default_feeder: str | None,
    default_utility: str,
    requested_by: str | None,
) -> dict[str, Any]:
    """Transform, validate, and commit parsed features; route failures to DLQ."""
    from dlq import insert_dlq
    from data_quality import run_asset_checks
    from lineage import log_lineage

    features = list(features)
    with conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO gis.migration_runs (
              source_format, source_name, status, feature_count, params, requested_by
            )
            VALUES (%s, %s, 'running', %s, %s::jsonb, %s)
            RETURNING id::text
            """,
            (
                source_format,
                source_name,
                len(features),
                json.dumps({"affine": affine, "apply_affine": apply_affine}),
                requested_by,
            ),
        )
        run_id = cur.fetchone()[0]

    committed = 0
    failed = 0
    committed_node_mrids: list[str] = []

    for feat in features:
        primitive = feat.get("primitive")
        source_ref = f"{source_name}:{feat.get('layer', '')}:{feat.get('fid')}"
        try:
            if primitive not in ("POINT", "LINE"):
                raise ValueError(feat.get("error") or f"Unsupported primitive {primitive}")

            raw_coords = feat.get("coords") or []
            if not raw_coords:
                raise ValueError("Feature has no coordinates")

            if apply_affine:
                coords = [
                    affine_transform(
                        x,
                        y,
                        anchor_lon=affine["anchor_lon"],
                        anchor_lat=affine["anchor_lat"],
                        scale=affine.get("scale", 1.0),
                        rotation_deg=affine.get("rotation_deg", 0.0),
                        origin_x=affine.get("origin_x", 0.0),
                        origin_y=affine.get("origin_y", 0.0),
                    )
                    for x, y in raw_coords
                ]
            else:
                coords = [(float(x), float(y)) for x, y in raw_coords]

            for lon, lat in coords:
                if not _valid_lonlat(lon, lat):
                    raise ValueError(f"Coordinate ({lon:.5f}, {lat:.5f}) outside valid lon/lat range")
            if not all(_in_ghana(lon, lat) for lon, lat in coords):
                raise ValueError("Transformed geometry falls outside the Ghana operating bbox")

            if primitive == "POINT":
                lon, lat = coords[0]
                mrid = _mrid_for(source_ref)
                with conn.cursor() as cur:
                    cur.execute(
                        """
                        SELECT gis.commit_migration_node(
                          %s::uuid, %s, %s, %s, %s, %s, %s, 'migration'
                        )
                        """,
                        (
                            mrid,
                            f"{feat.get('layer', 'dxf')} {feat.get('fid')}",
                            lon,
                            lat,
                            default_feeder,
                            default_utility,
                            None,
                        ),
                    )
                    inserted = cur.fetchone()[0]
                if not inserted:
                    raise ValueError(f"Asset {mrid} already exists (duplicate)")
                committed_node_mrids.append(mrid)
                committed += 1
            else:  # LINE
                wkt = _linestring_wkt(coords)
                with conn.cursor() as cur:
                    cur.execute(
                        "SELECT gis.commit_migration_line(%s, %s, %s, %s, %s)",
                        (f"migration:{source_name}", feat.get("fid"), wkt, None, None),
                    )
                committed += 1
        except Exception as exc:  # noqa: BLE001
            failed += 1
            dlq_id = insert_dlq(
                conn,
                source="MIGRATION",
                payload={
                    "run_id": run_id,
                    "source_ref": source_ref,
                    "primitive": primitive,
                    "coords": feat.get("coords"),
                },
                error_message=str(exc),
            )
            with conn.cursor() as cur:
                cur.execute(
                    """
                    INSERT INTO gis.migration_failed_elements (
                      run_id, source_ref, primitive, raw_payload, error_message, dlq_id
                    )
                    VALUES (%s::uuid, %s, %s, %s::jsonb, %s, %s::uuid)
                    """,
                    (
                        run_id,
                        source_ref,
                        primitive,
                        json.dumps({"coords": feat.get("coords")}),
                        str(exc)[:2000],
                        dlq_id,
                    ),
                )

    # Run data-quality checks on committed staging nodes.
    for mrid in committed_node_mrids:
        try:
            run_asset_checks(conn, mrid, "staging")
        except Exception:  # noqa: BLE001
            pass

    status = "completed" if failed == 0 else ("partial" if committed else "failed")
    with conn.cursor() as cur:
        cur.execute(
            """
            UPDATE gis.migration_runs
            SET status = %s, committed_count = %s, failed_count = %s, finished_at = NOW()
            WHERE id = %s::uuid
            """,
            (status, committed, failed, run_id),
        )

    log_lineage(
        conn,
        target_mrid=committed_node_mrids[0] if committed_node_mrids else run_id,
        source_type="SYSTEM",
        action_type="MIGRATION_COMMIT",
        operator_id=requested_by,
        provenance_ref=f"gis.migration_runs:{run_id}",
        after_state={
            "source_format": source_format,
            "source_name": source_name,
            "committed": committed,
            "failed": failed,
        },
    )

    return {
        "run_id": run_id,
        "source_format": source_format,
        "source_name": source_name,
        "feature_count": len(features),
        "committed": committed,
        "failed": failed,
        "status": status,
    }


def list_runs(conn, *, limit: int = 50) -> list[dict[str, Any]]:
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT id::text, source_format, source_name, status,
                   feature_count, committed_count, failed_count,
                   requested_by, started_at, finished_at
            FROM gis.migration_runs
            ORDER BY started_at DESC
            LIMIT %s
            """,
            (limit,),
        )
        rows = cur.fetchall()
    return [
        {
            "id": r[0],
            "source_format": r[1],
            "source_name": r[2],
            "status": r[3],
            "feature_count": r[4],
            "committed_count": r[5],
            "failed_count": r[6],
            "requested_by": r[7],
            "started_at": r[8].isoformat() if r[8] else None,
            "finished_at": r[9].isoformat() if r[9] else None,
        }
        for r in rows
    ]


def list_failed(conn, run_id: str, *, limit: int = 200) -> list[dict[str, Any]]:
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT id::text, source_ref, primitive, error_message, dlq_id::text, created_at
            FROM gis.migration_failed_elements
            WHERE run_id = %s::uuid
            ORDER BY created_at DESC
            LIMIT %s
            """,
            (run_id, limit),
        )
        rows = cur.fetchall()
    return [
        {
            "id": r[0],
            "source_ref": r[1],
            "primitive": r[2],
            "error_message": r[3],
            "dlq_id": r[4],
            "created_at": r[5].isoformat() if r[5] else None,
        }
        for r in rows
    ]
