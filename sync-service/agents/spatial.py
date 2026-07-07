"""Spatial queries — territory bounds, asset inventory by district/bbox."""

from __future__ import annotations

import os
from typing import Any

INVENTORY_TIMEOUT_MS = int(os.getenv("GIOP_INVENTORY_TIMEOUT_MS", "30000"))

_MASTER_KIND_CASE = """CASE am.source_layer
  WHEN 'distribution_transformer' THEN 'distribution_transformer'
  WHEN 'power_transformer' THEN 'power_transformer'
  WHEN 'oh_support_structure_11kv' THEN 'pole_11kv'
  WHEN 'oh_support_structure_33kv' THEN 'pole_33kv'
  WHEN 'oh_support_structure_lvle' THEN 'pole_lv'
  ELSE 'connectivity_node'
END"""

_MASTER_AM_JOIN = """
LEFT JOIN (
  SELECT DISTINCT ON (mrid) mrid, source_layer
  FROM gis.asset_id_map
  ORDER BY mrid, source_fid
) am ON am.mrid = cn.mrid"""

_POLE_SOURCE_LAYERS: dict[str, str] = {
    "pole_11kv": "oh_support_structure_11kv",
    "pole_33kv": "oh_support_structure_33kv",
    "pole_lv": "oh_support_structure_lvle",
}

POLE_KINDS = ("pole_11kv", "pole_33kv", "pole_lv")
TRANSFORMER_KINDS = ("distribution_transformer", "power_transformer")

ASSET_KIND_ALIASES: dict[str, tuple[str, ...]] = {
    "pole": POLE_KINDS,
    "poles": POLE_KINDS,
    "pole_11kv": ("pole_11kv",),
    "pole_33kv": ("pole_33kv",),
    "pole_lv": ("pole_lv",),
    "11kv": ("pole_11kv",),
    "11_kv": ("pole_11kv",),
    "33kv": ("pole_33kv",),
    "33_kv": ("pole_33kv",),
    "lv": ("pole_lv",),
    "lv_pole": ("pole_lv",),
    "transformer": TRANSFORMER_KINDS,
    "transformers": TRANSFORMER_KINDS,
    "dt": ("distribution_transformer",),
    "distribution_transformer": ("distribution_transformer",),
    "power_transformer": ("power_transformer",),
    "node": ("connectivity_node",),
    "connectivity_node": ("connectivity_node",),
    "line": ("ac_line_segment",),
    "lines": ("ac_line_segment",),
}

LIST_ASSETS_MAX_LIMIT = 100
LIST_ASSETS_DEFAULT_LIMIT = 25


def _require_territory_scope(
    *,
    district: str | None,
    region: str | None,
    bbox: dict[str, float] | None,
) -> None:
    if not district and not region and not bbox:
        raise ValueError("district, region, or bbox is required")


def _master_node_kind_expr() -> str:
    return _MASTER_KIND_CASE


def _staging_node_kind_expr() -> str:
    return "COALESCE(NULLIF(btrim(ga.asset_kind), ''), 'connectivity_node')"


def _node_inventory_scope(
    tier: str,
) -> tuple[str, str, str, str, str]:
    """Return (schema_io, schema_cn, validation_filter, kind_expr, extra_join)."""
    if tier == "staging":
        return (
            "staging.identified_objects",
            "staging.connectivity_nodes",
            "io.validation <> 'REJECTED'",
            _staging_node_kind_expr(),
            "",
        )
    if tier == "master":
        return (
            "public.identified_objects",
            "public.connectivity_nodes",
            "io.validation = 'APPROVED'",
            _master_node_kind_expr(),
            _MASTER_AM_JOIN,
        )
    raise ValueError("tier must be master or staging")


def _kind_filter_sql(
    kind_expr: str,
    kinds: tuple[str, ...] | None,
    *,
    tier: str,
) -> tuple[str, list[Any]]:
    if not kinds:
        return "", []
    if tier == "master" and kinds and all(k in POLE_KINDS for k in kinds):
        layers = [_POLE_SOURCE_LAYERS[k] for k in kinds]
        return " AND am.source_layer = ANY(%s)", [layers]
    if tier == "staging" and kinds == ("connectivity_node",):
        return f" AND {kind_expr} = 'connectivity_node'", []
    if "connectivity_node" in kinds and len(kinds) == 1:
        return f" AND {kind_expr} = 'connectivity_node'", []
    return f" AND {kind_expr} = ANY(%s)", [list(kinds)]


def _normalize_kinds(asset_kind: str | None) -> tuple[str, ...] | None:
    if not asset_kind:
        return None
    key = asset_kind.strip().lower()
    if key in ASSET_KIND_ALIASES:
        return ASSET_KIND_ALIASES[key]
    return (key,)


def _territory_scope_sql(
    *,
    district: str | None,
    region: str | None,
    bbox: dict[str, float] | None,
    geom_alias: str = "cn.geom",
) -> tuple[str, str, list[Any]]:
    """Return (join_sql, where_sql, params) for territory filtering."""
    joins: list[str] = []
    wheres: list[str] = []
    params: list[Any] = []
    if district:
        joins.append(
            f"JOIN gis.ecg_admin_boundaries b_dist "
            f"ON b_dist.district ILIKE %s AND ST_Within({geom_alias}, b_dist.geom)"
        )
        params.append(f"%{district.strip()}%")
    if region:
        joins.append(
            f"JOIN gis.ecg_admin_boundaries b_reg "
            f"ON b_reg.region ILIKE %s AND ST_Within({geom_alias}, b_reg.geom)"
        )
        params.append(f"%{region.strip()}%")
    if bbox:
        wheres.append(
            f"{geom_alias} && ST_MakeEnvelope(%s, %s, %s, %s, 4326)"
        )
        params.extend([bbox["west"], bbox["south"], bbox["east"], bbox["north"]])
    join_sql = "\n".join(joins)
    where_sql = (" AND " + " AND ".join(wheres)) if wheres else ""
    return join_sql, where_sql, params


def _territory_filter_sql(
    *,
    district: str | None,
    region: str | None,
    bbox: dict[str, float] | None,
    geom_alias: str = "cn.geom",
) -> tuple[str, list[Any]]:
    """WHERE-only territory filter (bbox-only queries)."""
    _join, where_sql, params = _territory_scope_sql(
        district=district, region=region, bbox=bbox, geom_alias=geom_alias
    )
    if _join:
        raise ValueError("district/region filters require _territory_scope_sql join form")
    return where_sql, params


def _prefetch_territory_bbox(
    conn,
    *,
    district: str | None,
    region: str | None,
    bbox: dict[str, float] | None,
) -> dict[str, float] | None:
    if bbox or (not district and not region):
        return bbox
    try:
        return resolve_territory(conn, district=district, region=region)["bbox"]
    except ValueError:
        return bbox


def _territory_where_clause(
    *,
    district: str | None,
    region: str | None,
) -> tuple[str, list[Any]]:
    if not district and not region:
        raise ValueError("district or region is required")

    filters: list[str] = []
    params: list[Any] = []
    if district:
        pattern = f"%{district.strip()}%"
        filters.append("district ILIKE %s")
        params.append(pattern)
    if region:
        pattern = f"%{region.strip()}%"
        filters.append("region ILIKE %s")
        params.append(pattern)
    return " AND ".join(filters), params


def resolve_territory(
    conn,
    *,
    district: str | None = None,
    region: str | None = None,
) -> dict[str, Any]:
    """Resolve ECG admin district/region to bbox and centroid."""
    where, params = _territory_where_clause(district=district, region=region)

    with conn.cursor() as cur:
        cur.execute(
            f"""
            SELECT
              MAX(district) AS district_label,
              MAX(region) AS region_label,
              COUNT(*)::int AS polygon_count,
              ST_X(ST_Centroid(ST_Union(geom))) AS center_lon,
              ST_Y(ST_Centroid(ST_Union(geom))) AS center_lat,
              ST_XMin(ST_Extent(geom)) AS west,
              ST_YMin(ST_Extent(geom)) AS south,
              ST_XMax(ST_Extent(geom)) AS east,
              ST_YMax(ST_Extent(geom)) AS north
            FROM gis.ecg_admin_boundaries
            WHERE {where}
            """,
            params,
        )
        row = cur.fetchone()

    if not row or row[3] is None:
        raise ValueError("Territory not found")

    return {
        "district": row[0],
        "region": row[1],
        "polygon_count": row[2],
        "center": {"lon": float(row[3]), "lat": float(row[4])},
        "bbox": {
            "west": float(row[5]),
            "south": float(row[6]),
            "east": float(row[7]),
            "north": float(row[8]),
        },
    }


def territory_geojson(
    conn,
    *,
    district: str | None = None,
    region: str | None = None,
) -> dict[str, Any]:
    """GeoJSON FeatureCollection for matching ECG admin boundary polygons."""
    where, params = _territory_where_clause(district=district, region=region)

    with conn.cursor() as cur:
        cur.execute(
            f"""
            SELECT json_build_object(
              'type', 'FeatureCollection',
              'features', COALESCE(json_agg(
                json_build_object(
                  'type', 'Feature',
                  'properties', json_build_object(
                    'district', district,
                    'region', region
                  ),
                  'geometry', ST_AsGeoJSON(geom)::json
                )
              ), '[]'::json)
            )
            FROM gis.ecg_admin_boundaries
            WHERE {where}
            """,
            params,
        )
        row = cur.fetchone()

    if not row or not row[0]:
        raise ValueError("Territory not found")

    geojson = row[0]
    if isinstance(geojson, str):
        import json

        geojson = json.loads(geojson)

    features = geojson.get("features") if isinstance(geojson, dict) else None
    if not features:
        raise ValueError("Territory not found")

    return geojson


def asset_inventory_counts(
    conn,
    *,
    tier: str = "master",
    asset_kind: str | None = None,
    district: str | None = None,
    region: str | None = None,
    bbox: dict[str, float] | None = None,
) -> dict[str, Any]:
    """Count assets by kind in staging or master, filtered by territory or viewport."""
    if tier not in ("master", "staging"):
        raise ValueError("tier must be master or staging")
    from db_pool import set_local_statement_timeout

    set_local_statement_timeout(conn, INVENTORY_TIMEOUT_MS)
    bbox = _prefetch_territory_bbox(conn, district=district, region=region, bbox=bbox)
    kinds = _normalize_kinds(asset_kind)
    schema_io, schema_cn, validation_filter, kind_expr, master_join = _node_inventory_scope(
        tier
    )

    territory_join, territory_where, territory_params = _territory_scope_sql(
        district=district, region=region, bbox=bbox
    )
    kind_filter, kind_params = _kind_filter_sql(kind_expr, kinds, tier=tier)

    staging_join = ""
    if tier == "staging":
        staging_join = "LEFT JOIN staging.ghana_grid_assets ga ON ga.mrid = cn.mrid"

    with conn.cursor() as cur:
        cur.execute(
            f"""
            SELECT {kind_expr} AS kind, COUNT(*)::int
            FROM {schema_cn} cn
            JOIN {schema_io} io ON io.mrid = cn.mrid
            {master_join}
            {staging_join}
            {territory_join}
            WHERE {validation_filter}
              AND cn.geom IS NOT NULL
              {territory_where}
              {kind_filter}
            GROUP BY 1
            ORDER BY COUNT(*) DESC
            """,
            territory_params + kind_params,
        )
        rows = cur.fetchall()
        cur.execute(
            f"""
            SELECT COUNT(*)::int
            FROM {schema_cn} cn
            JOIN {schema_io} io ON io.mrid = cn.mrid
            {master_join}
            {staging_join}
            {territory_join}
            WHERE {validation_filter}
              AND cn.geom IS NOT NULL
              {territory_where}
              {kind_filter}
            """,
            territory_params + kind_params,
        )
        total = int(cur.fetchone()[0])
        distinct_locations: int | None = None
        if tier == "staging":
            cur.execute(
                f"""
                SELECT COUNT(DISTINCT cn.geom)::int
                FROM {schema_cn} cn
                JOIN {schema_io} io ON io.mrid = cn.mrid
                {staging_join}
                {territory_join}
                WHERE {validation_filter}
                  AND cn.geom IS NOT NULL
                  {territory_where}
                  {kind_filter}
                """,
                territory_params + kind_params,
            )
            row = cur.fetchone()
            if row and row[0] is not None:
                distinct_locations = int(row[0])

    by_kind = {r[0]: r[1] for r in rows}
    result: dict[str, Any] = {
        "tier": tier,
        "asset_kind_filter": asset_kind,
        "total": total,
        "by_kind": by_kind,
        "district": district,
        "region": region,
        "bbox": bbox,
    }
    if distinct_locations is not None:
        result["distinct_locations"] = distinct_locations
    pole_keys = ("pole", "poles")
    if kinds and asset_kind in pole_keys:
        result["pole_total"] = sum(by_kind.get(k, 0) for k in POLE_KINDS)
    place_label = district or region or "the area"
    if district or region or bbox:
        result["formatted_summary"] = format_asset_inventory_text(
            result,
            place_label=place_label,
            asset_kind=asset_kind,
        )
    return result


def list_assets_in_territory(
    conn,
    *,
    tier: str = "master",
    asset_kind: str | None = None,
    district: str | None = None,
    region: str | None = None,
    bbox: dict[str, float] | None = None,
    limit: int = LIST_ASSETS_DEFAULT_LIMIT,
    offset: int = 0,
    include_geom: bool = False,
) -> dict[str, Any]:
    """Paginated asset list in a territory — sample rows plus total count."""
    if tier not in ("master", "staging"):
        raise ValueError("tier must be master or staging")
    _require_territory_scope(district=district, region=region, bbox=bbox)
    kinds = _normalize_kinds(asset_kind)
    if kinds and "ac_line_segment" in kinds:
        raise ValueError("use territory_network_summary for line counts; nodes only in list_assets")

    limit = max(1, min(int(limit), LIST_ASSETS_MAX_LIMIT))
    offset = max(0, int(offset))

    from db_pool import set_local_statement_timeout

    set_local_statement_timeout(conn, INVENTORY_TIMEOUT_MS)
    bbox = _prefetch_territory_bbox(conn, district=district, region=region, bbox=bbox)

    schema_io, schema_cn, validation_filter, kind_expr, master_join = _node_inventory_scope(
        tier
    )
    territory_join, territory_where, territory_params = _territory_scope_sql(
        district=district, region=region, bbox=bbox
    )
    kind_filter, kind_params = _kind_filter_sql(kind_expr, kinds, tier=tier)
    staging_join = ""
    if tier == "staging":
        staging_join = "LEFT JOIN staging.ghana_grid_assets ga ON ga.mrid = cn.mrid"

    geom_select = (
        ", ST_AsGeoJSON(cn.geom)::json AS geom" if include_geom else ""
    )

    with conn.cursor() as cur:
        cur.execute(
            f"""
            SELECT COUNT(*)::int
            FROM {schema_cn} cn
            JOIN {schema_io} io ON io.mrid = cn.mrid
            {master_join}
            {staging_join}
            {territory_join}
            WHERE {validation_filter}
              AND cn.geom IS NOT NULL
              {territory_where}
              {kind_filter}
            """,
            territory_params + kind_params,
        )
        total = int(cur.fetchone()[0])
        cur.execute(
            f"""
            SELECT
              cn.mrid::text,
              io.name,
              io.validation::text,
              {kind_expr} AS asset_kind,
              cn.boundary_feeder_id
              {geom_select}
            FROM {schema_cn} cn
            JOIN {schema_io} io ON io.mrid = cn.mrid
            {master_join}
            {staging_join}
            {territory_join}
            WHERE {validation_filter}
              AND cn.geom IS NOT NULL
              {territory_where}
              {kind_filter}
            ORDER BY io.name NULLS LAST, cn.mrid
            LIMIT %s OFFSET %s
            """,
            [*territory_params, *kind_params, limit, offset],
        )
        rows = cur.fetchall()

    assets: list[dict[str, Any]] = []
    for row in rows:
        item: dict[str, Any] = {
            "mrid": row[0],
            "name": row[1],
            "validation": row[2],
            "asset_kind": row[3],
            "boundary_feeder_id": row[4],
        }
        if include_geom and len(row) > 5:
            item["geom"] = row[5]
        assets.append(item)

    return {
        "tier": tier,
        "asset_kind_filter": asset_kind,
        "district": district,
        "region": region,
        "bbox": bbox,
        "total": total,
        "limit": limit,
        "offset": offset,
        "has_more": offset + len(assets) < total,
        "assets": assets,
    }


def _line_territory_filter_sql(
    *,
    district: str | None,
    region: str | None,
    bbox: dict[str, float] | None,
) -> tuple[str, str, list[Any]]:
    return _territory_scope_sql(
        district=district, region=region, bbox=bbox, geom_alias="als.geom"
    )


def territory_network_summary(
    conn,
    *,
    tier: str = "master",
    district: str | None = None,
    region: str | None = None,
    bbox: dict[str, float] | None = None,
) -> dict[str, Any]:
    """Node counts by kind plus line counts by nominal voltage in a territory."""
    if tier not in ("master", "staging"):
        raise ValueError("tier must be master or staging")
    _require_territory_scope(district=district, region=region, bbox=bbox)

    bbox = _prefetch_territory_bbox(conn, district=district, region=region, bbox=bbox)
    nodes = asset_inventory_counts(
        conn,
        tier=tier,
        district=district,
        region=region,
        bbox=bbox,
    )

    if tier == "staging":
        line_io = "staging.identified_objects"
        line_table = "staging.ac_line_segments"
        line_validation = "io.validation NOT IN ('REJECTED', 'APPROVED')"
    else:
        line_io = "public.identified_objects"
        line_table = "public.ac_line_segments"
        line_validation = "io.validation = 'APPROVED'"

    line_territory_join, line_territory_where, line_params = _line_territory_filter_sql(
        district=district, region=region, bbox=bbox
    )

    with conn.cursor() as cur:
        if tier == "master":
            cur.execute(
                f"""
                SELECT COALESCE(ce.nominal_voltage::text, 'unknown') AS voltage, COUNT(*)::int
                FROM {line_table} als
                JOIN {line_io} io ON io.mrid = als.mrid
                LEFT JOIN public.conducting_equipment ce ON ce.mrid = als.mrid
                {line_territory_join}
                WHERE {line_validation}
                  AND als.geom IS NOT NULL
                  {line_territory_where}
                GROUP BY 1
                ORDER BY COUNT(*) DESC
                """,
                line_params,
            )
        else:
            cur.execute(
                f"""
                SELECT 'staging_line' AS voltage, COUNT(*)::int
                FROM {line_table} als
                JOIN {line_io} io ON io.mrid = als.mrid
                {line_territory_join}
                WHERE {line_validation}
                  AND als.geom IS NOT NULL
                  {line_territory_where}
                """,
                line_params,
            )
        line_rows = cur.fetchall()
        cur.execute(
            f"""
            SELECT COUNT(*)::int
            FROM {line_table} als
            JOIN {line_io} io ON io.mrid = als.mrid
            {line_territory_join}
            WHERE {line_validation}
              AND als.geom IS NOT NULL
              {line_territory_where}
            """,
            line_params,
        )
        line_total = int(cur.fetchone()[0])

    lines_by_voltage = {r[0]: r[1] for r in line_rows}
    place_label = district or region or "the area"
    summary = {
        "tier": tier,
        "district": district,
        "region": region,
        "bbox": bbox,
        "place_label": place_label,
        "nodes": {
            "total": nodes.get("total", 0),
            "by_kind": nodes.get("by_kind", {}),
            "distinct_locations": nodes.get("distinct_locations"),
        },
        "lines": {
            "total": line_total,
            "by_voltage": lines_by_voltage,
        },
        "electrical_assets_total": int(nodes.get("total", 0)) + line_total,
    }
    summary["formatted_summary"] = format_network_summary_text(summary, place_label)
    summary["structured"] = network_summary_structured(summary, place_label)
    return summary


_NODE_KIND_LABELS: tuple[tuple[str, str], ...] = (
    ("pole_33kv", "33 kV poles"),
    ("pole_11kv", "11 kV poles"),
    ("pole_lv", "LV poles"),
    ("distribution_transformer", "Distribution transformers"),
    ("power_transformer", "Power transformers"),
    ("connectivity_node", "Connectivity nodes"),
)

_VOLTAGE_LABELS: dict[str, str] = {
    "33000": "MV 33 kV lines",
    "33": "MV 33 kV lines",
    "33kv": "MV 33 kV lines",
    "mv_33kv": "MV 33 kV lines",
    "11000": "MV 11 kV lines",
    "11": "MV 11 kV lines",
    "11kv": "MV 11 kV lines",
    "mv_11kv": "MV 11 kV lines",
    "400": "LV 400 V lines",
    "400v": "LV 400 V lines",
    "lv_400v": "LV 400 V lines",
    "lv": "LV lines",
    "staging_line": "Staging lines",
    "unknown": "Unknown voltage lines",
}


def _voltage_label(raw: str) -> str:
    key = (raw or "unknown").strip().lower().replace(" ", "_")
    if key in _VOLTAGE_LABELS:
        return _VOLTAGE_LABELS[key]
    if "33" in key:
        return "MV 33 kV lines"
    if "11" in key:
        return "MV 11 kV lines"
    if "400" in key or "lv" in key:
        return "LV 400 V lines"
    return raw or "Lines"


def network_summary_structured(
    summary: dict[str, Any],
    place_label: str,
) -> dict[str, Any]:
    nodes = summary.get("nodes") or {}
    lines = summary.get("lines") or {}
    by_kind: dict[str, int] = nodes.get("by_kind") or {}
    by_voltage: dict[str, int] = lines.get("by_voltage") or {}

    node_rows = [
        {"key": key, "label": label, "count": int(by_kind.get(key, 0))}
        for key, label in _NODE_KIND_LABELS
        if int(by_kind.get(key, 0)) > 0
    ]
    line_rows = sorted(
        [
            {"key": volt, "label": _voltage_label(str(volt)), "count": int(count)}
            for volt, count in by_voltage.items()
            if int(count) > 0
        ],
        key=lambda row: row["count"],
        reverse=True,
    )
    point_assets = sum(row["count"] for row in node_rows)

    return {
        "type": "network_summary",
        "place_label": place_label,
        "electrical_assets_total": int(summary.get("electrical_assets_total") or 0),
        "point_assets_total": point_assets,
        "nodes_total": int(nodes.get("total") or 0),
        "lines_total": int(lines.get("total") or 0),
        "node_rows": node_rows,
        "line_rows": line_rows,
    }


def format_network_summary_text(summary: dict[str, Any], place_label: str) -> str:
    """Single canonical steward-facing summary (nodes + lines, no duplicate counts)."""
    structured = network_summary_structured(summary, place_label)
    title = place_label.title() if place_label.islower() else place_label
    lines_out = [
        f"Electrical assets — {title}",
        "",
        f"Total: {structured['electrical_assets_total']:,} electrical assets "
        f"({structured['nodes_total']:,} nodes · {structured['lines_total']:,} lines)",
        "",
        "Point assets",
    ]
    for row in structured["node_rows"]:
        lines_out.append(f"• {row['count']:,} {row['label']}")
    if not structured["node_rows"]:
        lines_out.append("• No point assets in scope")

    lines_out.append("")
    lines_out.append("Lines by voltage")
    for row in structured["line_rows"]:
        lines_out.append(f"• {row['count']:,} {row['label']}")
    if not structured["line_rows"]:
        lines_out.append("• No lines in scope")

    return "\n".join(lines_out)


def format_asset_inventory_text(
    result: dict[str, Any],
    *,
    place_label: str,
    asset_kind: str | None = None,
) -> str:
    """Formatted count reply for a single inventory query."""
    title = place_label.title() if place_label.islower() else place_label
    by_kind: dict[str, int] = result.get("by_kind") or {}
    kind_key = (asset_kind or "").strip().lower()

    if kind_key in ("transformer", "transformers"):
        dt = int(by_kind.get("distribution_transformer", 0))
        pt = int(by_kind.get("power_transformer", 0))
        total = dt + pt if (dt or pt) else int(result.get("total") or 0)
        lines_out = [f"Transformers — {title}", "", f"Total: {total:,} transformers", ""]
        if dt:
            lines_out.append(f"• {dt:,} distribution transformers")
        if pt:
            lines_out.append(f"• {pt:,} power transformers")
        if total == 0:
            lines_out.append("• No transformers found in this area.")
        return "\n".join(lines_out)

    if kind_key in ("pole", "poles", "pole_11kv", "pole_33kv", "pole_lv") or (
        by_kind
        and set(by_kind).issubset({"pole_11kv", "pole_33kv", "pole_lv"})
    ):
        rows = [
            (label, int(by_kind.get(key, 0)))
            for key, label in _NODE_KIND_LABELS
            if key.startswith("pole_") and int(by_kind.get(key, 0)) > 0
        ]
        total = int(result.get("pole_total") or sum(c for _, c in rows) or result.get("total") or 0)
        lines_out = [f"Poles — {title}", "", f"Total: {total:,} poles", ""]
        for label, count in rows:
            lines_out.append(f"• {count:,} {label}")
        if total == 0:
            lines_out.append("• No poles found in this area.")
        return "\n".join(lines_out)

    total = int(result.get("total") or 0)
    lines_out = [f"Assets — {title}", "", f"Total: {total:,} assets", ""]
    for key, label in _NODE_KIND_LABELS:
        count = int(by_kind.get(key, 0))
        if count:
            lines_out.append(f"• {count:,} {label}")
    remaining = total - sum(int(by_kind.get(k, 0)) for k, _ in _NODE_KIND_LABELS)
    if remaining > 0:
        lines_out.append(f"• {remaining:,} other assets")
    return "\n".join(lines_out)


def format_list_assets_text(
    page: dict[str, Any],
    *,
    place_label: str,
) -> str:
    assets = page.get("assets") or []
    total = int(page.get("total") or 0)
    title = place_label.title() if place_label.islower() else place_label
    lines_out = [f"Assets in {title}", ""]
    if total == 0:
        lines_out.append("No matching assets in this area.")
        return "\n".join(lines_out)
    lines_out.append(f"Showing {len(assets)} of {total:,}:")
    lines_out.append("")
    for item in assets:
        name = (item.get("name") or "").strip() or item.get("mrid") or "Unnamed asset"
        kind = (item.get("asset_kind") or "asset").replace("_", " ")
        feeder = item.get("boundary_feeder_id")
        if feeder:
            lines_out.append(f"• {name} ({kind}, feeder {feeder})")
        else:
            lines_out.append(f"• {name} ({kind})")
    if page.get("has_more"):
        remaining = max(0, total - len(assets))
        lines_out.append("")
        lines_out.append(f"…and {remaining:,} more in this area.")
    return "\n".join(lines_out)


def inventory_in_viewport(
    conn,
    *,
    tier: str,
    west: float,
    south: float,
    east: float,
    north: float,
    asset_kind: str | None = None,
    limit: int = 25,
) -> dict[str, Any]:
    """Shortcut for asset counts + sample list in map viewport bbox."""
    bbox = {"west": west, "south": south, "east": east, "north": north}
    counts = asset_inventory_counts(conn, tier=tier, asset_kind=asset_kind, bbox=bbox)
    return counts
