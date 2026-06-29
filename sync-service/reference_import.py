"""GIS reference layer imports — boundary-first path via gis_transfer_jobs."""

from __future__ import annotations

import os
import json
import shutil
import subprocess
import tempfile
import time
from pathlib import Path
from typing import Any
from urllib.parse import quote

import requests


from cim_export import SUPABASE_SERVICE_KEY, SUPABASE_URL, get_job
from reference_catalog import ensure_overview_view, resolve_import_target
from reference_render import list_reference_layers_full, refresh_all_render_policies, refresh_layer_render_policy

GIS_IMPORT_BUCKET = os.getenv("GIS_IMPORT_BUCKET", "gis-imports")
IMPORTS_DIR = Path(__file__).resolve().parent / "imports"
SUPABASE_DB_URI = os.getenv("SUPABASE_DB_URI", "")

BOUNDARY_LAYER_SLUGS = ("ecg-admin-boundaries",)
OGR_EXTENSIONS = {".gpkg", ".geojson", ".json", ".kml", ".kmz", ".zip", ".shp"}


def _ogr_pg_conn() -> str:
    uri = SUPABASE_DB_URI or "postgresql://postgres:postgres@127.0.0.1:54322/postgres"
    # ogr2ogr wants PG:host=... form
    if not uri.startswith("postgresql://"):
        return "PG:host=127.0.0.1 port=54322 dbname=postgres user=postgres password=postgres active_schema=gis"
    body = uri[len("postgresql://") :]
    creds, _, hostpart = body.rpartition("@")
    user, _, password = creds.partition(":")
    host_db = hostpart.split("/", 1)
    host_port = host_db[0]
    dbname = host_db[1].split("?")[0] if len(host_db) > 1 else "postgres"
    host, _, port = host_port.partition(":")
    port = port or "5432"
    return (
        f"PG:host={host} port={port} dbname={dbname} "
        f"user={user} password={password} active_schema=gis"
    )


def list_reference_layers(conn) -> list[dict[str, Any]]:
    return list_reference_layers_full(conn)


def get_reference_layer(conn, slug: str) -> dict[str, Any] | None:
    from reference_render import fetch_reference_layer_row

    return fetch_reference_layer_row(conn, slug)


def list_import_jobs(conn, *, limit: int = 50) -> list[dict[str, Any]]:
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT id::text, format, status::text, layers, feature_count,
                   error_message, created_at, completed_at
            FROM public.gis_transfer_jobs
            WHERE direction = 'import'
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
            "layers": r[3],
            "feature_count": r[4],
            "error_message": r[5],
            "created_at": r[6].isoformat() if r[6] else None,
            "completed_at": r[7].isoformat() if r[7] else None,
        }
        for r in rows
    ]


def create_boundary_import_job(
    conn,
    *,
    storage_bucket: str | None,
    storage_path: str,
    layer_slugs: list[str] | None = None,
    import_config: dict[str, Any] | None = None,
    requested_by: str | None = None,
) -> dict[str, Any]:
    slugs = layer_slugs or (
        [import_config["detail_slug"]]
        if import_config and import_config.get("detail_slug")
        else list(BOUNDARY_LAYER_SLUGS)
    )
    with conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO public.gis_transfer_jobs (
              direction, format, status, storage_bucket, storage_path,
              layers, import_config, requested_by
            )
            VALUES ('import', 'reference-boundary', 'pending', %s, %s, %s, %s::jsonb, %s)
            RETURNING id::text, status::text, created_at
            """,
            (
                storage_bucket,
                storage_path,
                slugs,
                json.dumps(import_config) if import_config else None,
                requested_by,
            ),
        )
        row = cur.fetchone()
        job_id = row[0]
        cur.execute("SELECT public.enqueue_gis_import_job(%s::uuid)", (job_id,))
        msg_id = cur.fetchone()[0]
        cur.execute(
            "UPDATE public.gis_transfer_jobs SET pgmq_msg_id = %s WHERE id = %s::uuid",
            (msg_id, job_id),
        )
    return {
        "id": job_id,
        "format": "reference-boundary",
        "status": row[1],
        "layers": slugs,
        "created_at": row[2].isoformat() if row[2] else None,
        "pgmq_msg_id": msg_id,
    }


def create_reference_import_from_inspect(
    conn,
    *,
    inspect_id: str,
    display_name: str,
    source_layer: str,
    dissolve_column: str | None = None,
    label_field: str | None = None,
    detail_min_zoom: float = 10,
    catalog_slug: str | None = None,
    requested_by: str | None = None,
) -> dict[str, Any]:
    """Wizard commit: resolve catalog target, persist upload, enqueue import job."""
    from reference_inspect import copy_inspect_to_job, load_inspect_path, validate_column

    validate_column(dissolve_column)
    validate_column(label_field)
    load_inspect_path(inspect_id)

    config_in = {
        "inspect_id": inspect_id,
        "display_name": display_name,
        "source_layer": source_layer,
        "dissolve_column": dissolve_column,
        "label_field": label_field,
        "detail_min_zoom": detail_min_zoom,
        "catalog_slug": catalog_slug,
    }
    resolved = resolve_import_target(conn, config_in)
    import_config = {
        **config_in,
        **resolved,
        "overview_slug": resolved.get("overview_slug"),
    }

    job = create_boundary_import_job(
        conn,
        storage_bucket=None,
        storage_path="pending",
        layer_slugs=[resolved["detail_slug"]],
        import_config=import_config,
        requested_by=requested_by,
    )
    bucket, storage_path = copy_inspect_to_job(inspect_id, job["id"])
    with conn.cursor() as cur:
        cur.execute(
            """
            UPDATE public.gis_transfer_jobs
            SET storage_bucket = %s, storage_path = %s, updated_at = NOW()
            WHERE id = %s::uuid
            """,
            (bucket, storage_path, job["id"]),
        )
    return {**job, "import_config": import_config}


def _upload_storage(bucket: str, path: str, body: bytes) -> bool:
    if not SUPABASE_SERVICE_KEY:
        return False
    url = f"{SUPABASE_URL.rstrip('/')}/storage/v1/object/{bucket}/{quote(path, safe='/')}"
    resp = requests.post(
        url,
        data=body,
        headers={
            "Authorization": f"Bearer {SUPABASE_SERVICE_KEY}",
            "Content-Type": "application/geopackage+sqlite3",
            "x-upsert": "true",
        },
        timeout=300,
    )
    return resp.status_code in (200, 201)


def _download_storage(bucket: str, path: str) -> bytes:
    if not SUPABASE_SERVICE_KEY:
        raise ValueError("SUPABASE_SERVICE_KEY required to download import artifact")
    url = f"{SUPABASE_URL.rstrip('/')}/storage/v1/object/{bucket}/{quote(path, safe='/')}"
    resp = requests.get(
        url,
        headers={"Authorization": f"Bearer {SUPABASE_SERVICE_KEY}"},
        timeout=300,
    )
    if resp.status_code != 200:
        raise ValueError(f"Storage download failed ({resp.status_code})")
    return resp.content


def save_import_upload(job_id: str, body: bytes, filename: str = "source.gpkg") -> tuple[str | None, str]:
    """Persist upload locally and optionally mirror to gis-imports bucket."""
    IMPORTS_DIR.mkdir(parents=True, exist_ok=True)
    ext = Path(filename).suffix.lower() if filename else ".gpkg"
    if ext not in OGR_EXTENSIONS:
        ext = ".gpkg"
    rel_path = f"{job_id}/source{ext}"
    local_path = IMPORTS_DIR / rel_path
    local_path.parent.mkdir(parents=True, exist_ok=True)
    local_path.write_bytes(body)

    content_type = "application/octet-stream"
    if ext == ".gpkg":
        content_type = "application/geopackage+sqlite3"
    elif ext in (".geojson", ".json"):
        content_type = "application/geo+json"
    elif ext == ".kml":
        content_type = "application/vnd.google-earth.kml+xml"

    bucket = None
    if SUPABASE_SERVICE_KEY:
        url = f"{SUPABASE_URL.rstrip('/')}/storage/v1/object/{GIS_IMPORT_BUCKET}/{quote(rel_path, safe='/')}"
        resp = requests.post(
            url,
            data=body,
            headers={
                "Authorization": f"Bearer {SUPABASE_SERVICE_KEY}",
                "Content-Type": content_type,
                "x-upsert": "true",
            },
            timeout=300,
        )
        if resp.status_code in (200, 201):
            bucket = GIS_IMPORT_BUCKET

    return bucket, rel_path if bucket else str(local_path)


def _resolve_import_path(job: dict[str, Any]) -> Path:
    bucket = job.get("storage_bucket")
    storage_path = job.get("storage_path") or ""
    if bucket:
        body = _download_storage(bucket, storage_path)
        tmp = Path(tempfile.mkdtemp(prefix="giop-gis-import-"))
        suffix = Path(storage_path).suffix or ".gpkg"
        path = tmp / f"source{suffix}"
        path.write_bytes(body)
        return path
    candidate = Path(storage_path)
    if candidate.is_file():
        return candidate
    local = IMPORTS_DIR / storage_path
    if local.is_file():
        return local
    raise ValueError(f"Import file not found: {storage_path}")


def _ogr_import_layer(
    conn,
    source_path: Path,
    source_layer: str | None,
    target_schema: str,
    target_table: str,
) -> int:
    if shutil.which("ogr2ogr") is None:
        raise RuntimeError("ogr2ogr not found — install GDAL (gdal-bin)")
    pg_conn = _ogr_pg_conn()
    started = time.time()
    cmd = [
        "ogr2ogr",
        "-f",
        "PostgreSQL",
        pg_conn,
        str(source_path),
    ]
    if source_layer:
        cmd.append(source_layer)
    cmd.extend(
        [
            "-overwrite",
            "-nln",
            f"{target_schema}.{target_table}",
            "-lco",
            "GEOMETRY_NAME=geom",
            "-lco",
            "FID=fid",
            "-lco",
            "SPATIAL_INDEX=GIST",
            "-nlt",
            "PROMOTE_TO_MULTI",
        ]
    )
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr.strip() or proc.stdout.strip() or "ogr2ogr failed")
    elapsed_ms = int((time.time() - started) * 1000)
    layer_label = source_layer or source_path.name
    with conn.cursor() as cur:
        cur.execute(f'SELECT COUNT(*) FROM {target_schema}."{target_table}"')
        count = int(cur.fetchone()[0])
        cur.execute(
            """
            INSERT INTO gis.import_runs (layer_name, target_table, feature_count, duration_ms)
            VALUES (%s, %s, %s, %s)
            """,
            (layer_label, f"{target_schema}.{target_table}", count, elapsed_ms),
        )
    return count


def _ogr_layer_for_upload(source_path: Path, catalog_layer: dict[str, Any]) -> str | None:
    ext = source_path.suffix.lower()
    gpkg_name = catalog_layer.get("gpkg_layer_name")
    if ext == ".gpkg" and gpkg_name:
        return gpkg_name
    if ext in (".geojson", ".json", ".kml", ".kmz", ".zip", ".shp"):
        return None
    return gpkg_name


def _update_reference_layer_meta(conn, slug: str, feature_count: int) -> None:
    refresh_layer_render_policy(conn, slug)
    with conn.cursor() as cur:
        cur.execute(
            """
            UPDATE gis.reference_layers
            SET last_imported_at = NOW(), updated_at = NOW()
            WHERE slug = %s
            """,
            (slug,),
        )


def process_boundary_import_job(conn, job_id: str) -> dict[str, Any]:
    job = get_job(conn, job_id)
    if not job:
        raise ValueError("Import job not found")
    if job.get("direction") != "import":
        raise ValueError("Not an import job")
    if job["status"] == "completed":
        return job

    layer_slugs = job.get("layers") or list(BOUNDARY_LAYER_SLUGS)
    import_config = job.get("import_config") or {}
    import_path: Path | None = None

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
        import_path = _resolve_import_path(job)
        total_features = 0

        if import_config.get("detail_slug"):
            slug = import_config["detail_slug"]
            target_table = import_config["target_table"]
            source_layer = import_config.get("source_layer")
            dissolve_column = import_config.get("dissolve_column")
            overview_table = import_config.get("overview_table")
            overview_slug = import_config.get("overview_slug")

            if slug == "ecg-admin-boundaries" and dissolve_column:
                overview_table = "ecg_admin_regions"
                overview_slug = "ecg-admin-regions"

            ogr_layer = source_layer
            if import_path.suffix.lower() == ".gpkg" and not ogr_layer:
                layer = get_reference_layer(conn, slug)
                if layer:
                    ogr_layer = layer.get("gpkg_layer_name")
            if import_path.suffix.lower() == ".gpkg" and not ogr_layer:
                raise ValueError("GPKG import requires source_layer in import config")

            count = _ogr_import_layer(
                conn,
                import_path,
                ogr_layer,
                "gis",
                target_table,
            )
            _update_reference_layer_meta(conn, slug, count)
            total_features += count

            if dissolve_column and overview_table:
                ensure_overview_view(
                    conn,
                    detail_table=target_table,
                    overview_table=overview_table,
                    dissolve_column=dissolve_column,
                )
                if overview_slug:
                    with conn.cursor() as cur:
                        cur.execute(
                            """
                            UPDATE gis.reference_layers
                            SET last_imported_at = NOW(), updated_at = NOW()
                            WHERE slug = %s
                            """,
                            (overview_slug,),
                        )
                    refresh_layer_render_policy(conn, overview_slug)
        else:
            for slug in layer_slugs:
                layer = get_reference_layer(conn, slug)
                if not layer:
                    raise ValueError(f"Unknown reference layer slug: {slug}")
                if layer["kind"] != "boundary":
                    raise ValueError(f"Layer {slug} is not a boundary import target")
                ogr_layer = _ogr_layer_for_upload(import_path, layer)
                if ogr_layer is None and import_path.suffix.lower() == ".gpkg" and not layer.get("gpkg_layer_name"):
                    raise ValueError(f"Layer {slug} has no gpkg_layer_name (derived view?)")
                if import_path.suffix.lower() == ".gpkg" and not ogr_layer:
                    raise ValueError(f"Layer {slug} requires a GPKG layer name")
                count = _ogr_import_layer(
                    conn,
                    import_path,
                    ogr_layer,
                    layer["target_schema"],
                    layer["target_table"],
                )
                _update_reference_layer_meta(conn, slug, count)
                total_features += count

                dissolve_column = layer.get("dissolve_column")
                if dissolve_column and slug == "ecg-admin-boundaries":
                    ensure_overview_view(
                        conn,
                        detail_table=layer["target_table"],
                        overview_table="ecg_admin_regions",
                        dissolve_column=dissolve_column,
                    )
                    refresh_layer_render_policy(conn, "ecg-admin-regions")

        refresh_all_render_policies(conn)

        touched_slugs = [slug]
        if import_config.get("detail_slug"):
            if overview_slug:
                touched_slugs.append(overview_slug)
        else:
            touched_slugs = list(layer_slugs)
            if any(s == "ecg-admin-boundaries" for s in layer_slugs):
                touched_slugs.append("ecg-admin-regions")

        with conn.cursor() as cur:
            for touched in touched_slugs:
                cur.execute(
                    """
                    UPDATE gis.reference_layers
                    SET last_imported_at = NOW(), updated_at = NOW()
                    WHERE slug = %s
                    """,
                    (touched,),
                )

        with conn.cursor() as cur:
            cur.execute(
                """
                UPDATE public.gis_transfer_jobs
                SET status = 'completed',
                    feature_count = %s,
                    completed_at = NOW(),
                    updated_at = NOW(),
                    error_message = NULL
                WHERE id = %s::uuid
                """,
                (total_features, job_id),
            )
        conn.commit()
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
        conn.commit()
        raise
    finally:
        if import_path and str(import_path).startswith(tempfile.gettempdir()):
            try:
                shutil.rmtree(import_path.parent, ignore_errors=True)
            except OSError:
                pass
