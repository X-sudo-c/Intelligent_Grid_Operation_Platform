"""Resolve spoken or typed place names to ECG districts, regions, and map bounds."""

from __future__ import annotations

import os
import re
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

# Spoken city names that also match an ECG *region* row — geocode the city center,
# not the union of every district in that region (e.g. "Tema" ≠ all of Tema Region).
_CITY_LOCALITY_NAMES = frozenset(
    {
        "tema",
        "tamale",
        "takoradi",
        "cape coast",
        "sunyani",
        "ho",
        "kumasi",
        "ashaiman",
        "koforidua",
    }
)


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


def _pin_locality_center(
    result: dict[str, Any],
    lon: float,
    lat: float,
    *,
    matched_as: str | None = None,
    source: str | None = None,
    query: str | None = None,
    confidence: float | None = None,
) -> dict[str, Any]:
    """Ensure navigation targets the locality point, not an admin polygon centroid."""
    out = dict(result)
    out["center"] = {"lon": float(lon), "lat": float(lat)}
    if matched_as is not None:
        out["matched_as"] = matched_as
    if source is not None:
        out["source"] = source
    if query is not None:
        out["query"] = query
    if confidence is not None:
        out["confidence"] = confidence
    return out


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
    if lon is None or lat is None:
        return None
    if district and region:
        terr = _territory_for_names(conn, district=district, region=region)
        if terr:
            return _pin_locality_center(
                terr,
                lon,
                lat,
                matched_as=alias,
                source="alias_exact",
                query=query,
                confidence=CONFIDENCE_ALIAS_EXACT,
            )
    contained = _district_at_point(conn, float(lon), float(lat))
    if contained:
        return _pin_locality_center(
            contained,
            lon,
            lat,
            matched_as=alias,
            source="alias_exact",
            query=query,
            confidence=CONFIDENCE_ALIAS_EXACT,
        )
    return _pin_locality_center(
        {
            "query": query,
            "matched_as": alias,
            "confidence": CONFIDENCE_ALIAS_EXACT,
            "source": "alias_exact",
            "district": district,
            "region": region,
            "bbox": None,
            "candidates": [],
        },
        lon,
        lat,
    )


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
    district_name, region_name = row[0], row[1]
    matched = (
        district_name
        if district_name and str(district_name).lower() == q.lower()
        else (region_name or q)
    )
    # Region-only match (e.g. "Tema" → whole Tema Region polygon).
    source = (
        "region_exact"
        if region_name and str(region_name).lower() == q.lower()
        and (not district_name or str(district_name).lower() != q.lower())
        else "district_exact"
    )
    return _district_row_to_result(
        row,
        matched_as=str(matched),
        confidence=CONFIDENCE_DISTRICT_EXACT,
        source=source,
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


def _pick_osm_hit(query: str, hits: list[dict[str, Any]]) -> dict[str, Any] | None:
    if not hits:
        return None
    q_norm = re.sub(r"\s+", " ", (query or "").strip().lower())
    q_compact = q_norm.replace(" ", "")
    best: dict[str, Any] | None = None
    best_rank = 99
    for hit in hits:
        title = str(hit.get("title") or "").strip().lower()
        title_compact = title.replace(" ", "")
        rank = 99
        if title == q_norm or title_compact == q_compact:
            rank = 0
        elif q_norm and q_norm in title:
            rank = 1
        elif q_compact and q_compact in title_compact:
            rank = 2
        elif title and title in q_norm:
            rank = 3
        if best is None or rank < best_rank:
            best = hit
            best_rank = rank
    return best or hits[0]


def _resolve_osm(conn, query: str) -> dict[str, Any] | None:
    hits = geocode_map_places(query, limit=5)
    if not hits and "," not in query:
        q_low = query.strip().lower()
        if q_low in _CITY_LOCALITY_NAMES and q_low != "accra":
            hits = geocode_map_places(f"{query}, Ghana", limit=5)
        if not hits:
            hits = geocode_map_places(f"{query}, Accra, Ghana", limit=5)
    if not hits:
        return None
    best = _pick_osm_hit(query, hits)
    if not best:
        return None
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


def _enrich_with_h3(result: dict[str, Any]) -> dict[str, Any]:
    """Attach primary H3 cell for spatial cache keys / coverage joins."""
    if result.get("h3_primary"):
        return result
    center = result.get("center")
    if not isinstance(center, dict):
        return result
    lat, lon = center.get("lat"), center.get("lon")
    if lat is None or lon is None:
        return result
    try:
        import h3_index as h3x

        if h3x.H3_AVAILABLE:
            out = dict(result)
            out["h3_primary"] = h3x.latlng_to_cell(float(lat), float(lon), h3x.DEFAULT_RES)
            out["h3_resolution"] = h3x.DEFAULT_RES
            return out
    except Exception:
        pass
    return result


def _resolve_place_uncached(
    conn,
    query: str,
    *,
    geocode: bool,
) -> dict[str, Any]:
    q = query.strip()
    metro = _resolve_metro_region(conn, q)
    if metro:
        return metro

    hit = _lookup_alias_exact(conn, q)
    if hit:
        return hit

    # City names that collide with ECG region labels — prefer OSM city center.
    if geocode and q.strip().lower() in _CITY_LOCALITY_NAMES:
        hit = _resolve_osm(conn, q)
        if hit:
            return hit

    hit = _lookup_district_exact(conn, q)
    if hit:
        return hit

    # Geocode localities before fuzzy district match (Roman Ridge, East Legon, romanridge).
    if geocode:
        hit = _resolve_osm(conn, q)
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
                    lon, lat = best.get("lon"), best.get("lat")
                    if lon is not None and lat is not None:
                        return _pin_locality_center(terr, float(lon), float(lat))
                    return terr
            lon, lat = best.get("lon"), best.get("lat")
            if lon is not None and lat is not None:
                contained = _district_at_point(conn, float(lon), float(lat))
                if contained:
                    pinned = _pin_locality_center(
                        contained,
                        float(lon),
                        float(lat),
                        matched_as=best.get("label") or q,
                        source="alias_fuzzy",
                        query=q,
                        confidence=max(CONFIDENCE_DISTRICT_FUZZY, min(0.88, sim)),
                    )
                    pinned["candidates"] = merged_candidates[1:4]
                    return pinned

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


def resolve_place(
    conn,
    query: str,
    *,
    allow_geocode: bool | None = None,
) -> dict[str, Any]:
    """
    Resolve a locality or district name to ECG territory bounds.

    Order: alias exact → district exact → district fuzzy → OSM geocode (optional).
    Results are Redis-cached; repeat voice/map lookups skip Nominatim and DB fuzzy work.
    """
    q = (query or "").strip()
    if not q:
        raise ValueError("query is required")

    geocode = PLACE_GEOCODE_ENABLED if allow_geocode is None else allow_geocode

    from redis_cache import (
        PLACE_RESOLVE_CACHE_TTL_SEC,
        get_json,
        place_resolve_key,
        set_json,
    )

    cache_key = place_resolve_key(q, geocode_enabled=geocode)
    cached = get_json(cache_key)
    if isinstance(cached, dict) and cached.get("query"):
        out = _enrich_with_h3(dict(cached))
        out["cached"] = True
        return out

    result = _enrich_with_h3(_resolve_place_uncached(conn, q, geocode=geocode))
    store = {k: v for k, v in result.items() if k != "cached"}
    set_json(cache_key, store, PLACE_RESOLVE_CACHE_TTL_SEC)
    return result


LOCALITY_FLY_ZOOM = 16.5
DISTRICT_CLOSE_FLY_ZOOM = 15.0
LOCALITY_PAN_ZOOM = 15.5
LOCALITY_FIT_MAX_ZOOM = 17.0
# Metro regions and wide districts — fit the bbox instead of flying to a centroid.
LARGE_TERRITORY_SPAN_DEG = 0.12
METRO_FIT_MAX_ZOOM = 14.5
LOCALITY_SOURCES = frozenset(
    {"osm", "alias_exact", "alias", "alias_fuzzy", "point_in_polygon"}
)


def _bbox_span_deg(bbox: dict[str, Any]) -> tuple[float, float]:
    return (
        float(bbox["east"]) - float(bbox["west"]),
        float(bbox["north"]) - float(bbox["south"]),
    )


def place_viewport_ui_action(
    resolved: dict[str, Any],
    *,
    mode: str = "pan",
    tab: str = "map",
) -> dict[str, Any] | None:
    """
    Pick a map camera action for a resolved place.

    Localities (OSM, aliases) and explicit zoom requests fly in close instead of
    framing an entire ECG district.
    """
    source = str(resolved.get("source") or "")
    center = resolved.get("center")
    bbox = resolved.get("bbox")
    wants_close = mode == "zoom"
    navigate = mode in ("pan", "zoom")

    # Named localities — always center the map on the resolved point, not a wide bbox edge.
    if navigate and source in LOCALITY_SOURCES and isinstance(center, dict):
        lon = center.get("lon")
        lat = center.get("lat")
        if lon is not None and lat is not None:
            zoom = LOCALITY_FLY_ZOOM if wants_close else LOCALITY_PAN_ZOOM
            return {
                "type": "fly_to",
                "tab": tab,
                "center": {"lon": float(lon), "lat": float(lat)},
                "zoom": zoom,
            }

    if bbox and all(bbox.get(k) is not None for k in ("west", "south", "east", "north")):
        w, h = _bbox_span_deg(bbox)
        wide_territory = source in ("metro_region", "region_exact") or max(w, h) >= LARGE_TERRITORY_SPAN_DEG
        if wide_territory and not (wants_close and source == "region_exact" and isinstance(center, dict)):
            action: dict[str, Any] = {
                "type": "fit_bounds",
                "tab": tab,
                "bbox": bbox,
            }
            if wants_close:
                action["max_zoom"] = METRO_FIT_MAX_ZOOM
            return action
        # Zoom-into a region name without OSM — fly to polygon centroid, not fit_bounds.
        if wide_territory and wants_close and source == "region_exact" and isinstance(center, dict):
            lon = center.get("lon")
            lat = center.get("lat")
            if lon is not None and lat is not None:
                return {
                    "type": "fly_to",
                    "tab": tab,
                    "center": {"lon": float(lon), "lat": float(lat)},
                    "zoom": LOCALITY_FLY_ZOOM,
                }

    if center and isinstance(center, dict):
        lon = center.get("lon")
        lat = center.get("lat")
        if lon is not None and lat is not None:
            use_fly = wants_close or source in ("osm", "alias_exact")
            if use_fly and bbox and all(bbox.get(k) is not None for k in ("west", "south", "east", "north")):
                w, h = _bbox_span_deg(bbox)
                # Large district polygon — still fly to center when zooming in.
                if source == "district_exact" and max(w, h) > 0.07 and not wants_close:
                    use_fly = False
            if use_fly:
                zoom = LOCALITY_FLY_ZOOM
                if source == "district_exact":
                    zoom = DISTRICT_CLOSE_FLY_ZOOM
                return {
                    "type": "fly_to",
                    "tab": tab,
                    "center": {"lon": float(lon), "lat": float(lat)},
                    "zoom": zoom,
                }

    if bbox and all(bbox.get(k) is not None for k in ("west", "south", "east", "north")):
        w, h = _bbox_span_deg(bbox)
        if wants_close or max(w, h) < 0.12:
            return {
                "type": "fit_bounds",
                "tab": tab,
                "bbox": bbox,
                "max_zoom": LOCALITY_FIT_MAX_ZOOM,
            }

    return None
