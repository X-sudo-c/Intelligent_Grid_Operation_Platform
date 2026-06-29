"""Render policy + GeoJSON delivery for gis.reference_layers."""

from __future__ import annotations

import json
import os
from typing import Any

GEOJSON_STATIC_MAX_FEATURES = int(os.getenv("GIS_REF_GEOJSON_STATIC_MAX", "500"))
GEOJSON_BBOX_MAX_FEATURES = int(os.getenv("GIS_REF_GEOJSON_BBOX_MAX", "5000"))
GEOJSON_BBOX_MAX_VERTICES = int(os.getenv("GIS_REF_GEOJSON_BBOX_MAX_VERTICES", "250000"))

REFERENCE_LAYER_ROW = """
    slug, display_name, description, kind,
    target_schema, target_table, martin_source_id, gpkg_layer_name,
    geometry_type, min_zoom, max_zoom, sort_order, active,
    requires_post_import_refresh, feature_count, last_imported_at,
    render_mode, built_in_map_style,
    bbox_west, bbox_south, bbox_east, bbox_north,
    vertex_count, table_bytes, render_stats,
    parent_slug, dissolve_column, label_field, detail_min_zoom, is_overview_derived
"""


def _row_to_layer(row: tuple[Any, ...]) -> dict[str, Any]:
    return {
        "slug": row[0],
        "display_name": row[1],
        "description": row[2],
        "kind": row[3],
        "target_schema": row[4],
        "target_table": row[5],
        "martin_source_id": row[6],
        "gpkg_layer_name": row[7],
        "geometry_type": row[8],
        "min_zoom": float(row[9]) if row[9] is not None else None,
        "max_zoom": float(row[10]) if row[10] is not None else None,
        "sort_order": row[11],
        "active": row[12],
        "requires_post_import_refresh": row[13],
        "feature_count": row[14],
        "last_imported_at": row[15].isoformat() if row[15] else None,
        "render_mode": row[16],
        "built_in_map_style": row[17],
        "bbox": {
            "west": row[18],
            "south": row[19],
            "east": row[20],
            "north": row[21],
        }
        if row[18] is not None
        else None,
        "vertex_count": row[22],
        "table_bytes": row[23],
        "render_stats": row[24] if isinstance(row[24], dict) else {},
        "parent_slug": row[25],
        "dissolve_column": row[26],
        "label_field": row[27],
        "detail_min_zoom": float(row[28]) if row[28] is not None else None,
        "is_overview_derived": row[29],
    }


def fetch_reference_layer_row(conn, slug: str) -> dict[str, Any] | None:
    with conn.cursor() as cur:
        cur.execute(
            f"""
            SELECT {REFERENCE_LAYER_ROW}
            FROM gis.reference_layers
            WHERE slug = %s
            """,
            (slug,),
        )
        row = cur.fetchone()
    return _row_to_layer(row) if row else None


def list_reference_layers_full(conn) -> list[dict[str, Any]]:
    with conn.cursor() as cur:
        cur.execute(
            f"""
            SELECT {REFERENCE_LAYER_ROW}
            FROM gis.reference_layers
            ORDER BY sort_order, display_name
            """
        )
        rows = cur.fetchall()
    return [_row_to_layer(r) for r in rows]


def compute_layer_stats(conn, layer: dict[str, Any]) -> dict[str, Any]:
    schema = layer["target_schema"]
    table = layer["target_table"]
    qualified = f'{schema}."{table}"'
    regclass = f"{schema}.{table}"

    try:
        with conn.cursor() as cur:
            cur.execute(
                f"""
                SELECT COUNT(*)::bigint,
                       COALESCE(SUM(ST_NPoints(geom)), 0)::bigint
                FROM {qualified}
                """
            )
            count_row = cur.fetchone()
            feature_count = int(count_row[0])
            vertex_count = int(count_row[1])

            cur.execute("SELECT pg_total_relation_size(%s::regclass)", (regclass,))
            table_bytes = int(cur.fetchone()[0] or 0)

            if feature_count == 0:
                return {
                    "feature_count": 0,
                    "vertex_count": 0,
                    "geometry_type": layer.get("geometry_type"),
                    "bbox": None,
                    "table_bytes": table_bytes,
                }

            cur.execute(
                f"SELECT ST_GeometryType(geom) FROM {qualified} WHERE geom IS NOT NULL LIMIT 1"
            )
            geom_row = cur.fetchone()
            geom_type = (geom_row[0] or layer.get("geometry_type") or "").replace("ST_", "")

            cur.execute(
                f"""
                SELECT ST_XMin(e), ST_YMin(e), ST_XMax(e), ST_YMax(e)
                FROM (SELECT ST_Extent(geom) AS e FROM {qualified}) s
                """
            )
            bbox_row = cur.fetchone()
    except Exception:
        return {
            "feature_count": 0,
            "vertex_count": 0,
            "geometry_type": layer.get("geometry_type"),
            "bbox": None,
            "table_bytes": 0,
        }

    bbox = None
    if bbox_row and bbox_row[0] is not None:
        bbox = {
            "west": float(bbox_row[0]),
            "south": float(bbox_row[1]),
            "east": float(bbox_row[2]),
            "north": float(bbox_row[3]),
        }

    return {
        "feature_count": feature_count,
        "vertex_count": vertex_count,
        "geometry_type": geom_type,
        "bbox": bbox,
        "table_bytes": table_bytes,
    }


def choose_render_mode(layer: dict[str, Any], stats: dict[str, Any]) -> str:
    feature_count = int(stats.get("feature_count") or 0)
    if feature_count <= 0:
        return "none"

    kind = layer.get("kind") or "overlay"
    geom = (stats.get("geometry_type") or layer.get("geometry_type") or "").upper()
    vertices = int(stats.get("vertex_count") or 0)

    if kind == "network":
        return "martin"

    if kind == "boundary":
        if layer.get("built_in_map_style") and feature_count > 0:
            return "martin"
        if feature_count <= GEOJSON_STATIC_MAX_FEATURES and "POLYGON" in geom:
            return "geojson_static"
        if (
            feature_count <= GEOJSON_BBOX_MAX_FEATURES
            and vertices <= GEOJSON_BBOX_MAX_VERTICES
        ):
            return "geojson_bbox"
        return "martin"

    # Generic overlays
    if feature_count <= GEOJSON_STATIC_MAX_FEATURES and vertices <= 50_000:
        return "geojson_static"
    if (
        feature_count <= GEOJSON_BBOX_MAX_FEATURES
        and vertices <= GEOJSON_BBOX_MAX_VERTICES
    ):
        return "geojson_bbox"
    return "martin"


def refresh_layer_render_policy(conn, slug: str) -> dict[str, Any]:
    layer = fetch_reference_layer_row(conn, slug)
    if not layer:
        raise ValueError(f"Unknown reference layer: {slug}")

    if not layer.get("gpkg_layer_name") and layer.get("kind") == "boundary":
        if layer.get("is_overview_derived"):
            parent_slug = layer.get("parent_slug")
            parent_count = 0
            if parent_slug:
                parent = fetch_reference_layer_row(conn, parent_slug)
                if parent:
                    with conn.cursor() as cur:
                        cur.execute(
                            f'SELECT COUNT(*) FROM {parent["target_schema"]}."{parent["target_table"]}"'
                        )
                        parent_count = int(cur.fetchone()[0])
                    dissolve = parent.get("dissolve_column")
                    if parent_count > 0 and dissolve:
                        with conn.cursor() as cur:
                            cur.execute(
                                "SELECT gis.ensure_boundary_overview_view(%s, %s, %s, %s)",
                                (
                                    parent["target_schema"],
                                    parent["target_table"],
                                    layer["target_table"],
                                    dissolve,
                                ),
                            )
            stats = compute_layer_stats(conn, layer) if parent_count > 0 else {"feature_count": 0}
            mode = "martin" if parent_count > 0 and stats.get("feature_count", 0) > 0 else "none"
            with conn.cursor() as cur:
                cur.execute(
                    """
                    UPDATE gis.reference_layers
                    SET render_mode = %s,
                        feature_count = %s,
                        updated_at = NOW()
                    WHERE slug = %s
                    """,
                    (mode, stats.get("feature_count", 0), slug),
                )
            return fetch_reference_layer_row(conn, slug) or layer

    stats = compute_layer_stats(conn, layer)
    mode = choose_render_mode(layer, stats)

    bbox = stats.get("bbox") or {}
    render_stats = {
        "policy_version": 1,
        "feature_count": stats["feature_count"],
        "vertex_count": stats["vertex_count"],
        "geometry_type": stats.get("geometry_type"),
        "table_bytes": stats.get("table_bytes"),
        "thresholds": {
            "geojson_static_max": GEOJSON_STATIC_MAX_FEATURES,
            "geojson_bbox_max": GEOJSON_BBOX_MAX_FEATURES,
        },
    }

    with conn.cursor() as cur:
        cur.execute(
            """
            UPDATE gis.reference_layers
            SET feature_count = %s,
                vertex_count = %s,
                geometry_type = COALESCE(%s, geometry_type),
                bbox_west = %s,
                bbox_south = %s,
                bbox_east = %s,
                bbox_north = %s,
                table_bytes = %s,
                render_mode = %s,
                render_stats = %s::jsonb,
                updated_at = NOW()
            WHERE slug = %s
            """,
            (
                stats["feature_count"],
                stats["vertex_count"],
                stats.get("geometry_type"),
                bbox.get("west"),
                bbox.get("south"),
                bbox.get("east"),
                bbox.get("north"),
                stats.get("table_bytes"),
                mode,
                json.dumps(render_stats),
                slug,
            ),
        )

    updated = fetch_reference_layer_row(conn, slug)
    return updated or layer


def refresh_all_render_policies(conn) -> None:
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT slug FROM gis.reference_layers
            WHERE active = TRUE
              AND (gpkg_layer_name IS NOT NULL OR is_overview_derived = TRUE)
            ORDER BY sort_order
            """
        )
        slugs = [r[0] for r in cur.fetchall()]
    for slug in slugs:
        try:
            with conn.cursor() as cur:
                cur.execute("SAVEPOINT refresh_layer_policy")
            refresh_layer_render_policy(conn, slug)
            with conn.cursor() as cur:
                cur.execute("RELEASE SAVEPOINT refresh_layer_policy")
        except Exception:
            with conn.cursor() as cur:
                cur.execute("ROLLBACK TO SAVEPOINT refresh_layer_policy")
                cur.execute("RELEASE SAVEPOINT refresh_layer_policy")
            continue
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                UPDATE gis.reference_layers
                SET render_mode = CASE
                  WHEN feature_count IS NULL OR feature_count = 0 THEN 'none'
                  ELSE render_mode
                END,
                updated_at = NOW()
                WHERE is_overview_derived = TRUE
                  AND gpkg_layer_name IS NULL
                """
            )
    except Exception:
        conn.rollback()


def reference_layer_geojson(
    conn,
    slug: str,
    *,
    west: float | None = None,
    south: float | None = None,
    east: float | None = None,
    north: float | None = None,
    limit: int = 10_000,
) -> dict[str, Any]:
    layer = fetch_reference_layer_row(conn, slug)
    if not layer:
        raise ValueError("Reference layer not found")
    if layer["render_mode"] not in ("geojson_static", "geojson_bbox"):
        raise ValueError(f"Layer {slug} is not served as GeoJSON")

    schema = layer["target_schema"]
    table = layer["target_table"]
    params: list[Any] = []
    bbox_sql = ""
    if None not in (west, south, east, north):
        bbox_sql = " AND geom && ST_MakeEnvelope(%s, %s, %s, %s, 4326)"
        params.extend([west, south, east, north])

    with conn.cursor() as cur:
        cur.execute(
            f"""
            SELECT json_build_object(
              'type', 'FeatureCollection',
              'features', COALESCE(json_agg(
                json_build_object(
                  'type', 'Feature',
                  'properties', (row_to_json(r)::jsonb - 'geom'),
                  'geometry', ST_AsGeoJSON(r.geom)::json
                )
              ), '[]'::json)
            )
            FROM (
              SELECT * FROM {schema}."{table}"
              WHERE geom IS NOT NULL
              {bbox_sql}
              LIMIT %s
            ) r
            """,
            [*params, limit],
        )
        row = cur.fetchone()

    if not row or not row[0]:
        return {"type": "FeatureCollection", "features": []}
    geojson = row[0]
    if isinstance(geojson, str):
        geojson = json.loads(geojson)
    return geojson


def build_map_config(conn, *, martin_url: str) -> list[dict[str, Any]]:
    layers = list_reference_layers_full(conn)
    configs: list[dict[str, Any]] = []
    base = martin_url.rstrip("/")

    for layer in layers:
        if not layer.get("active"):
            continue
        mode = layer.get("render_mode") or "none"
        if mode == "none":
            continue
        fc = layer.get("feature_count") or 0
        if fc <= 0 and layer.get("gpkg_layer_name"):
            continue
        if fc <= 0 and layer.get("is_overview_derived"):
            continue

        entry: dict[str, Any] = {
            "slug": layer["slug"],
            "display_name": layer["display_name"],
            "kind": layer["kind"],
            "render_mode": mode,
            "built_in_map_style": layer.get("built_in_map_style", False),
            "geometry_type": layer.get("geometry_type"),
            "min_zoom": layer.get("min_zoom"),
            "max_zoom": layer.get("max_zoom"),
            "feature_count": fc,
            "bbox": layer.get("bbox"),
            "parent_slug": layer.get("parent_slug"),
            "is_overview_derived": layer.get("is_overview_derived", False),
            "detail_min_zoom": layer.get("detail_min_zoom"),
            "label_field": layer.get("label_field"),
        }

        if mode == "martin" and layer.get("martin_source_id"):
            source_id = layer["martin_source_id"]
            if not layer.get("built_in_map_style"):
                entry["martin"] = {
                    "source_id": source_id,
                    "tiles": [f"{base}/{source_id}/{{z}}/{{x}}/{{y}}"],
                }
        elif mode in ("geojson_static", "geojson_bbox"):
            entry["geojson"] = {
                "url_template": f"/api/v1/reference-layers/{layer['slug']}/geojson",
                "bbox_fetch": mode == "geojson_bbox",
            }

        configs.append(entry)

    return configs
