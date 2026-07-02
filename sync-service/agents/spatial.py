"""Spatial queries — territory bounds, asset inventory by district/bbox."""

from __future__ import annotations

from typing import Any

POLE_KINDS = ("pole_11kv", "pole_33kv", "pole_lv")
TRANSFORMER_KINDS = ("distribution_transformer", "power_transformer")

ASSET_KIND_ALIASES: dict[str, tuple[str, ...]] = {
    "pole": POLE_KINDS,
    "poles": POLE_KINDS,
    "transformer": TRANSFORMER_KINDS,
    "transformers": TRANSFORMER_KINDS,
    "dt": ("distribution_transformer",),
    "distribution_transformer": ("distribution_transformer",),
    "power_transformer": ("power_transformer",),
    "node": ("connectivity_node",),
    "connectivity_node": ("connectivity_node",),
}


def _normalize_kinds(asset_kind: str | None) -> tuple[str, ...] | None:
    if not asset_kind:
        return None
    key = asset_kind.strip().lower()
    if key in ASSET_KIND_ALIASES:
        return ASSET_KIND_ALIASES[key]
    return (key,)


def _territory_filter_sql(
    *,
    district: str | None,
    region: str | None,
    bbox: dict[str, float] | None,
    geom_alias: str = "cn.geom",
) -> tuple[str, list[Any]]:
    clauses: list[str] = []
    params: list[Any] = []
    if district:
        clauses.append(
            f"""
            EXISTS (
              SELECT 1 FROM gis.ecg_admin_boundaries b
              WHERE ST_Within({geom_alias}, b.geom)
                AND b.district ILIKE %s
            )
            """
        )
        pattern = f"%{district.strip()}%"
        params.append(pattern)
    if region:
        clauses.append(
            f"""
            EXISTS (
              SELECT 1 FROM gis.ecg_admin_boundaries b
              WHERE ST_Within({geom_alias}, b.geom)
                AND b.region ILIKE %s
            )
            """
        )
        pattern = f"%{region.strip()}%"
        params.append(pattern)
    if bbox:
        clauses.append(
            f"{geom_alias} && ST_MakeEnvelope(%s, %s, %s, %s, 4326)"
        )
        params.extend([bbox["west"], bbox["south"], bbox["east"], bbox["north"]])
    if not clauses:
        return "", []
    return " AND " + " AND ".join(clauses), params


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
    kinds = _normalize_kinds(asset_kind)

    if tier == "staging":
        schema_io = "staging.identified_objects"
        schema_cn = "staging.connectivity_nodes"
        validation_filter = "io.validation <> 'REJECTED'"
        kind_expr = "'connectivity_node'"
        kind_note = (
            "Staging captures are not classified by pole/transformer yet; "
            "counts are total connectivity nodes unless asset_kind omitted."
        )
    else:
        schema_io = "public.identified_objects"
        schema_cn = "public.connectivity_nodes"
        validation_filter = "io.validation = 'APPROVED'"
        kind_expr = "public.asset_kind_for_mrid(cn.mrid)"
        kind_note = None

    territory_sql, territory_params = _territory_filter_sql(
        district=district, region=region, bbox=bbox
    )

    kind_filter = ""
    kind_params: list[Any] = []
    if kinds and tier == "master":
        if "connectivity_node" in kinds and len(kinds) == 1:
            kind_filter = f" AND {kind_expr} = 'connectivity_node'"
        else:
            kind_filter = f" AND {kind_expr} = ANY(%s)"
            kind_params.append(list(kinds))

    with conn.cursor() as cur:
        cur.execute(
            f"""
            SELECT {kind_expr} AS kind, COUNT(*)::int
            FROM {schema_cn} cn
            JOIN {schema_io} io ON io.mrid = cn.mrid
            WHERE {validation_filter}
              AND cn.geom IS NOT NULL
              {territory_sql}
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
            WHERE {validation_filter}
              AND cn.geom IS NOT NULL
              {territory_sql}
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
                WHERE {validation_filter}
                  AND cn.geom IS NOT NULL
                  {territory_sql}
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
    if kind_note:
        result["note"] = kind_note
    if kinds and tier == "master" and asset_kind in ("pole", "poles"):
        result["pole_total"] = sum(by_kind.get(k, 0) for k in POLE_KINDS)
    return result


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
