"""Catalog upsert + overview view wiring for reference boundary imports."""

from __future__ import annotations

import re
from typing import Any

SLUG_RE = re.compile(r"[^a-z0-9]+")
TABLE_RE = re.compile(r"[^a-z0-9_]+")


def slugify(value: str) -> str:
    slug = SLUG_RE.sub("-", value.lower()).strip("-")
    return slug[:80] or "reference-layer"


def table_name_from_slug(slug: str) -> str:
    return TABLE_RE.sub("_", slug.replace("-", "_"))[:63]


def upsert_boundary_detail_catalog(
    conn,
    *,
    slug: str,
    display_name: str,
    target_table: str,
    source_layer: str,
    dissolve_column: str | None,
    label_field: str | None,
    detail_min_zoom: float = 10,
    description: str | None = None,
) -> dict[str, Any]:
    overview_slug = f"{slug}-overview"
    overview_table = f"{target_table}_overview"
    if slug == "ecg-admin-boundaries":
        overview_slug = "ecg-admin-regions"
        overview_table = "ecg_admin_regions"
    with conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO gis.reference_layers (
              slug, display_name, description, kind,
              target_schema, target_table, martin_source_id, gpkg_layer_name,
              geometry_type, min_zoom, max_zoom, sort_order, active,
              requires_post_import_refresh, dissolve_column, label_field,
              detail_min_zoom, is_overview_derived, built_in_map_style
            )
            VALUES (
              %s, %s, %s, 'boundary',
              'gis', %s, %s, %s,
              'MULTIPOLYGON', %s, 14, 100, TRUE,
              FALSE, %s, %s,
              %s, FALSE, FALSE
            )
            ON CONFLICT (slug) DO UPDATE SET
              display_name = EXCLUDED.display_name,
              description = EXCLUDED.description,
              target_table = EXCLUDED.target_table,
              martin_source_id = EXCLUDED.martin_source_id,
              gpkg_layer_name = EXCLUDED.gpkg_layer_name,
              dissolve_column = EXCLUDED.dissolve_column,
              label_field = EXCLUDED.label_field,
              detail_min_zoom = EXCLUDED.detail_min_zoom,
              built_in_map_style = CASE
                WHEN gis.reference_layers.slug IN (
                  'ecg-admin-boundaries', 'ecg-admin-regions'
                ) THEN TRUE
                ELSE gis.reference_layers.built_in_map_style
              END,
              updated_at = NOW()
            """,
            (
                slug,
                display_name,
                description or f"Imported boundary detail — {display_name}",
                target_table,
                target_table,
                source_layer,
                detail_min_zoom,
                dissolve_column,
                label_field,
                detail_min_zoom,
            ),
        )
        if dissolve_column:
            cur.execute(
                """
                INSERT INTO gis.reference_layers (
                  slug, display_name, description, kind,
                  target_schema, target_table, martin_source_id, gpkg_layer_name,
                  geometry_type, min_zoom, max_zoom, sort_order, active,
                  requires_post_import_refresh, parent_slug, label_field,
                  detail_min_zoom, is_overview_derived, built_in_map_style
                )
                VALUES (
                  %s, %s, %s, 'boundary',
                  'gis', %s, %s, NULL,
                  'MULTIPOLYGON', 0, %s, 101, TRUE,
                  FALSE, %s, %s,
                  %s, TRUE, FALSE
                )
                ON CONFLICT (slug) DO UPDATE SET
                  display_name = EXCLUDED.display_name,
                  target_table = EXCLUDED.target_table,
                  martin_source_id = EXCLUDED.martin_source_id,
                  parent_slug = EXCLUDED.parent_slug,
                  label_field = EXCLUDED.label_field,
                  max_zoom = EXCLUDED.max_zoom,
                  detail_min_zoom = EXCLUDED.detail_min_zoom,
                  is_overview_derived = TRUE,
                  updated_at = NOW()
                """,
                (
                    overview_slug,
                    f"{display_name} (overview)",
                    f"Dissolved overview by {dissolve_column}",
                    overview_table,
                    overview_table,
                    detail_min_zoom,
                    slug,
                    label_field or dissolve_column,
                    detail_min_zoom,
                ),
            )
    return {
        "detail_slug": slug,
        "overview_slug": overview_slug if dissolve_column else None,
        "target_table": target_table,
        "overview_table": overview_table if dissolve_column else None,
    }


def ensure_overview_view(
    conn,
    *,
    detail_table: str,
    overview_table: str,
    dissolve_column: str,
) -> None:
    with conn.cursor() as cur:
        cur.execute(
            "SELECT gis.ensure_boundary_overview_view(%s, %s, %s, %s)",
            ("gis", detail_table, overview_table, dissolve_column),
        )


def resolve_import_target(
    conn,
    config: dict[str, Any],
) -> dict[str, Any]:
    """Resolve catalog slug/table from wizard config (existing or new layer)."""
    catalog_slug = config.get("catalog_slug")
    display_name = config.get("display_name") or "Imported boundary"
    source_layer = config.get("source_layer")
    dissolve_column = config.get("dissolve_column")
    label_field = config.get("label_field")
    detail_min_zoom = float(config.get("detail_min_zoom") or 10)

    if catalog_slug:
        from reference_render import fetch_reference_layer_row

        layer = fetch_reference_layer_row(conn, catalog_slug)
        if not layer:
            raise ValueError(f"Unknown catalog slug: {catalog_slug}")
        target_table = layer["target_table"]
        slug = catalog_slug
        with conn.cursor() as cur:
            cur.execute(
                """
                UPDATE gis.reference_layers
                SET gpkg_layer_name = COALESCE(%s, gpkg_layer_name),
                    dissolve_column = %s,
                    label_field = %s,
                    detail_min_zoom = %s,
                    updated_at = NOW()
                WHERE slug = %s
                """,
                (source_layer, dissolve_column, label_field, detail_min_zoom, slug),
            )
        overview_table = None
        overview_slug = None
        if dissolve_column:
            if slug == "ecg-admin-boundaries":
                overview_table = "ecg_admin_regions"
                overview_slug = "ecg-admin-regions"
            else:
                overview_table = f"{target_table}_overview"
                overview_slug = f"{slug}-overview"
        return {
            "detail_slug": slug,
            "target_table": target_table,
            "source_layer": source_layer,
            "dissolve_column": dissolve_column,
            "overview_table": overview_table,
            "overview_slug": overview_slug,
            "detail_min_zoom": detail_min_zoom,
        }

    slug = slugify(display_name)
    from reference_render import fetch_reference_layer_row

    existing = fetch_reference_layer_row(conn, slug)
    if existing and existing.get("kind") == "boundary":
        return resolve_import_target(
            conn,
            {**config, "catalog_slug": slug, "display_name": display_name},
        )

    target_table = table_name_from_slug(slug)
    meta = upsert_boundary_detail_catalog(
        conn,
        slug=slug,
        display_name=display_name,
        target_table=target_table,
        source_layer=source_layer or "",
        dissolve_column=dissolve_column,
        label_field=label_field,
        detail_min_zoom=detail_min_zoom,
    )
    return {
        "detail_slug": meta["detail_slug"],
        "target_table": meta["target_table"],
        "source_layer": source_layer,
        "dissolve_column": dissolve_column,
        "overview_table": meta["overview_table"],
        "overview_slug": meta["overview_slug"],
        "detail_min_zoom": detail_min_zoom,
    }
