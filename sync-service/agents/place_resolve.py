"""Resolve spoken or typed place names to ECG districts, regions, and map bounds."""

from __future__ import annotations

import os
from typing import Any

from geocode import geocode_map_places

PLACE_GEOCODE_ENABLED = os.getenv("PLACE_GEOCODE_ENABLED", "1").strip().lower() in (
    "1",
    "true",
    "yes",
)

CONFIDENCE_ALIAS_EXACT = 0.93
CONFIDENCE_DISTRICT_EXACT = 0.96
CONFIDENCE_DISTRICT_FUZZY = 0.74
CONFIDENCE_OSM = 0.8
CONFIDENCE_LOW = 0.45

_METRO_REGION_QUERIES: dict[str, str] = {
    "accra": "%Accra%",
    "greater accra": "%Accra%",
    "accra metro": "%Accra%",
}


def _district_row_to_result(
    row: tuple[Any, ...],
    *,
    matched_as: str,
    confidence: float,
    source: str,
    query: str,
) -> dict[str, Any]:
    district, region, clon, clat, west, south, east, north = row
    return {
        "query": query,
        "matched_as": matched_as,
        "confidence": confidence,
        "source": source,
        "district": district,
        "region": region,
        "center": {"lon": float(clon), "lat": float(clat)},
        "bbox": {
            "west": float(west),
            "south": float(south),
            "east": float(east),
            "north": float(north),
        },
        "candidates": [],
    }


def _lookup_alias_exact(conn, query: str) -> dict[str, Any] | None:
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT alias, district, region, lon, lat
            FROM gis.place_aliases
            WHERE active AND lower(trim(alias)) = lower(trim(%s))
            LIMIT 1
            """,
            (query,),
        )
        row = cur.fetchone()
    if not row:
        return None
    alias, district, region, lon, lat = row
    if district and region and lon is not None and lat is not None:
        terr = _territory_for_names(conn, district=district, region=region)
        if terr:
            terr["matched_as"] = alias
            terr["confidence"] = CONFIDENCE_ALIAS_EXACT
            terr["source"] = "alias"
            terr["query"] = query
            return terr
    if lon is not None and lat is not None:
        contained = _district_at_point(conn, float(lon), float(lat))
        if contained:
            contained["matched_as"] = alias
            contained["confidence"] = CONFIDENCE_ALIAS_EXACT
            contained["source"] = "alias"
            contained["query"] = query
            return contained
    return None


def _lookup_alias_fuzzy(conn, query: str, limit: int = 5) -> list[dict[str, Any]]:
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT alias, district, region, lon, lat,
                   similarity(alias, %s) AS sim
            FROM gis.place_aliases
            WHERE active AND alias %% %s
            ORDER BY sim DESC
            LIMIT %s
            """,
            (query, query, limit),
        )
        rows = cur.fetchall()
    out: list[dict[str, Any]] = []
    for alias, district, region, lon, lat, sim in rows:
        label = alias
        out.append(
            {
                "label": label,
                "district": district,
                "region": region,
                "lon": lon,
                "lat": lat,
                "similarity": float(sim),
                "source": "alias_fuzzy",
            }
        )
    return out


def _territory_for_names(
    conn,
    *,
    district: str | None = None,
    region: str | None = None,
) -> dict[str, Any] | None:
    from agents.spatial import resolve_territory

    try:
        return resolve_territory(conn, district=district, region=region)
    except ValueError:
        return None


def _district_at_point(conn, lon: float, lat: float) -> dict[str, Any] | None:
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT
              district,
              region,
              ST_X(ST_Centroid(geom)) AS center_lon,
              ST_Y(ST_Centroid(geom)) AS center_lat,
              ST_XMin(geom) AS west,
              ST_YMin(geom) AS south,
              ST_XMax(geom) AS east,
              ST_YMax(geom) AS north
            FROM gis.ecg_admin_boundaries
            WHERE ST_Within(ST_SetSRID(ST_MakePoint(%s, %s), 4326), geom)
            ORDER BY ST_Area(geom) ASC
            LIMIT 1
            """,
            (lon, lat),
        )
        row = cur.fetchone()
    if not row or row[0] is None:
        return None
    return _district_row_to_result(
        row,
        matched_as=row[0],
        confidence=CONFIDENCE_OSM,
        source="point_in_polygon",
        query="",
    )


def _lookup_district_exact(conn, query: str) -> dict[str, Any] | None:
    q = query.strip()
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT
              district,
              MAX(region) AS region,
              ST_X(ST_Centroid(ST_Union(geom))) AS center_lon,
              ST_Y(ST_Centroid(ST_Union(geom))) AS center_lat,
              ST_XMin(ST_Extent(geom)) AS west,
              ST_YMin(ST_Extent(geom)) AS south,
              ST_XMax(ST_Extent(geom)) AS east,
              ST_YMax(ST_Extent(geom)) AS north
            FROM gis.ecg_admin_boundaries
            WHERE lower(district) = lower(%s)
            GROUP BY district
            LIMIT 1
            """,
            (q,),
        )
        row = cur.fetchone()
        if not row or row[0] is None:
            cur.execute(
                """
                SELECT
                  MAX(district) AS district,
                  region,
                  ST_X(ST_Centroid(ST_Union(geom))) AS center_lon,
                  ST_Y(ST_Centroid(ST_Union(geom))) AS center_lat,
                  ST_XMin(ST_Extent(geom)) AS west,
                  ST_YMin(ST_Extent(geom)) AS south,
                  ST_XMax(ST_Extent(geom)) AS east,
                  ST_YMax(ST_Extent(geom)) AS north
                FROM gis.ecg_admin_boundaries
                WHERE lower(region) = lower(%s)
                GROUP BY region
                LIMIT 1
                """,
                (q,),
            )
            row = cur.fetchone()
    if not row or row[0] is None:
        return None
    matched = row[0] if row[0] and str(row[0]).lower() == q.lower() else (row[1] or q)
    return _district_row_to_result(
        row,
        matched_as=str(matched),
        confidence=CONFIDENCE_DISTRICT_EXACT,
        source="district_exact",
        query=query,
    )


def _lookup_district_fuzzy(conn, query: str, limit: int = 5) -> list[dict[str, Any]]:
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT district, MAX(region) AS region,
                   MAX(similarity(district, %s)) AS sim
            FROM gis.ecg_admin_boundaries
            WHERE district IS NOT NULL
              AND district %% %s
            GROUP BY district
            ORDER BY sim DESC
            LIMIT %s
            """,
            (query, query, limit),
        )
        rows = cur.fetchall()
        if not rows:
            cur.execute(
                """
                SELECT MAX(district) AS district, region,
                       similarity(region, %s) AS sim
                FROM gis.ecg_admin_boundaries
                WHERE region IS NOT NULL
                  AND region %% %s
                GROUP BY region
                ORDER BY sim DESC
                LIMIT %s
                """,
                (query, query, limit),
            )
            rows = cur.fetchall()
    return [
        {
            "label": district or region,
            "district": district,
            "region": region,
            "similarity": float(sim),
            "source": "district_fuzzy",
        }
        for district, region, sim in rows
        if district or region
    ]


def _resolve_osm(conn, query: str) -> dict[str, Any] | None:
    hits = geocode_map_places(query, limit=3)
    if not hits:
        return None
    best = hits[0]
    lon = best.get("longitude")
    lat = best.get("latitude")
    if lon is None or lat is None:
        return None

    contained = _district_at_point(conn, float(lon), float(lat))
    bbox = best.get("bbox")
    center = {"lon": float(lon), "lat": float(lat)}
    if contained:
        contained["query"] = query
        contained["matched_as"] = best.get("title") or query
        contained["confidence"] = CONFIDENCE_OSM
        contained["source"] = "osm"
        if bbox and all(bbox.get(k) is not None for k in ("west", "south", "east", "north")):
            contained["bbox"] = bbox
        contained["center"] = center
        return contained

    if bbox and all(bbox.get(k) is not None for k in ("west", "south", "east", "north")):
        return {
            "query": query,
            "matched_as": best.get("title") or query,
            "confidence": CONFIDENCE_OSM,
            "source": "osm",
            "district": None,
            "region": best.get("subtitle"),
            "center": center,
            "bbox": bbox,
            "candidates": [],
        }
    return None


def _resolve_metro_region(conn, query: str) -> dict[str, Any] | None:
    pattern = _METRO_REGION_QUERIES.get(query.strip().lower())
    if not pattern:
        return None
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT
              %s AS district_label,
              string_agg(DISTINCT region, ', ' ORDER BY region) AS region_label,
              ST_X(ST_Centroid(ST_Union(geom))) AS center_lon,
              ST_Y(ST_Centroid(ST_Union(geom))) AS center_lat,
              ST_XMin(ST_Extent(geom)) AS west,
              ST_YMin(ST_Extent(geom)) AS south,
              ST_XMax(ST_Extent(geom)) AS east,
              ST_YMax(ST_Extent(geom)) AS north
            FROM gis.ecg_admin_boundaries
            WHERE region ILIKE %s
            """,
            (query.strip(), pattern),
        )
        row = cur.fetchone()
    if not row or row[3] is None:
        return None
    # Use the spoken metro name (e.g. "Accra") as the region filter token — not the
    # comma-joined sub-region labels from string_agg, which break ILIKE lookups.
    return _district_row_to_result(
        (row[0], query.strip(), row[2], row[3], row[4], row[5], row[6], row[7]),
        matched_as=query.strip(),
        confidence=CONFIDENCE_DISTRICT_EXACT,
        source="metro_region",
        query=query,
    )


def resolve_place(
    conn,
    query: str,
    *,
    allow_geocode: bool | None = None,
) -> dict[str, Any]:
    """
    Resolve a locality or district name to ECG territory bounds.

    Order: alias exact → district exact → district fuzzy → OSM geocode (optional).
    """
    q = (query or "").strip()
    if not q:
        raise ValueError("query is required")

    geocode = PLACE_GEOCODE_ENABLED if allow_geocode is None else allow_geocode

    metro = _resolve_metro_region(conn, q)
    if metro:
        return metro

    hit = _lookup_alias_exact(conn, q)
    if hit:
        return hit

    hit = _lookup_district_exact(conn, q)
    if hit:
        return hit

    alias_fuzzy = _lookup_alias_fuzzy(conn, q)
    district_fuzzy = _lookup_district_fuzzy(conn, q)
    merged_candidates: list[dict[str, Any]] = []
    seen: set[str] = set()
    for cand in alias_fuzzy + district_fuzzy:
        label = (cand.get("label") or cand.get("district") or "").strip()
        key = label.lower()
        if not label or key in seen:
            continue
        seen.add(key)
        merged_candidates.append(cand)

    if merged_candidates:
        best = merged_candidates[0]
        sim = float(best.get("similarity") or 0)
        if sim >= 0.55:
            district = best.get("district") or best.get("label")
            region = best.get("region")
            if district:
                terr = _territory_for_names(conn, district=district, region=region)
                if terr:
                    terr["query"] = q
                    terr["matched_as"] = best.get("label") or district
                    terr["confidence"] = max(CONFIDENCE_DISTRICT_FUZZY, min(0.88, sim))
                    terr["source"] = best.get("source") or "fuzzy"
                    terr["candidates"] = merged_candidates[1:4]
                    return terr
            lon, lat = best.get("lon"), best.get("lat")
            if lon is not None and lat is not None:
                contained = _district_at_point(conn, float(lon), float(lat))
                if contained:
                    contained["query"] = q
                    contained["matched_as"] = best.get("label") or q
                    contained["confidence"] = max(CONFIDENCE_DISTRICT_FUZZY, min(0.88, sim))
                    contained["source"] = "alias_fuzzy"
                    contained["candidates"] = merged_candidates[1:4]
                    return contained

    if geocode:
        hit = _resolve_osm(conn, q)
        if hit:
            return hit

    if merged_candidates:
        return {
            "query": q,
            "matched_as": None,
            "confidence": CONFIDENCE_LOW,
            "source": "ambiguous",
            "district": None,
            "region": None,
            "center": None,
            "bbox": None,
            "candidates": merged_candidates[:5],
        }

    raise ValueError(f"Place not found: {q}")
