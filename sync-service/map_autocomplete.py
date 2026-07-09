"""Google-style map autocomplete — OSM index, aliases, districts, fuzzy + viewport bias."""

from __future__ import annotations

import logging
import math
import re
import threading
from typing import Any

logger = logging.getLogger(__name__)

_INDEX_LOCK = threading.RLock()
_INDEX: list[dict[str, Any]] | None = None
_INDEX_BUILT_AT = 0.0
_MAP_PLACES_READY: bool | None = None

INDEX_REFRESH_SEC = 600

_NORMALIZE_RE = re.compile(r"[^a-z0-9]+")

_SOURCE_PRIORITY = {
    "alias": 0,
    "osm": 1,
    "district": 2,
    "index": 3,
}


def _normalize(text: str) -> str:
    return _NORMALIZE_RE.sub(" ", (text or "").lower()).strip()


def normalize_name(text: str) -> str:
    """Shared normalization for autocomplete and OSM import."""
    return _normalize(text)


def _levenshtein(a: str, b: str) -> int:
    if a == b:
        return 0
    if not a:
        return len(b)
    if not b:
        return len(a)
    if abs(len(a) - len(b)) > 4:
        return 99
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, start=1):
        cur = [i]
        for j, cb in enumerate(b, start=1):
            cost = 0 if ca == cb else 1
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost))
        prev = cur
    return prev[-1]


def _float_or_none(value: Any) -> float | None:
    if value is None:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _bbox_from_point(lon: float, lat: float, span: float = 0.01) -> dict[str, float]:
    half = span / 2.0
    return {
        "west": lon - half,
        "south": lat - half,
        "east": lon + half,
        "north": lat + half,
    }


def _bbox_from_row(
    west: Any,
    south: Any,
    east: Any,
    north: Any,
    *,
    lon: float,
    lat: float,
) -> dict[str, float]:
    w, s, e, n = (
        _float_or_none(west),
        _float_or_none(south),
        _float_or_none(east),
        _float_or_none(north),
    )
    if None not in (w, s, e, n):
        return {"west": w, "south": s, "east": e, "north": n}
    return _bbox_from_point(lon, lat)


def _subtitle(parts: list[str | None], *, fallback: str) -> str:
    joined = " · ".join(p for p in parts if p)
    return joined or fallback


def _place_entry(
    *,
    entry_id: str,
    title: str,
    subtitle: str | None,
    place_type: str,
    lon: float | None,
    lat: float | None,
    bbox: dict[str, float] | None = None,
    source: str = "index",
    rank_score: float | None = None,
) -> dict[str, Any] | None:
    title = (title or "").strip()
    if not title:
        return None
    if lon is None or lat is None:
        return None
    out: dict[str, Any] = {
        "kind": "place",
        "id": entry_id,
        "title": title,
        "subtitle": subtitle,
        "place_type": place_type,
        "source": source,
        "longitude": float(lon),
        "latitude": float(lat),
        "bbox": bbox or _bbox_from_point(float(lon), float(lat)),
        "_norm": _normalize(title),
        "_tokens": _normalize(title).split(),
    }
    if rank_score is not None:
        out["_rank_score"] = float(rank_score)
    return out


def map_places_table_ready(conn) -> bool:
    """True when gis.map_places exists and has at least one active row."""
    global _MAP_PLACES_READY
    if _MAP_PLACES_READY is not None:
        return _MAP_PLACES_READY
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT EXISTS (
                  SELECT 1
                  FROM information_schema.tables
                  WHERE table_schema = 'gis' AND table_name = 'map_places'
                )
                """
            )
            exists = bool(cur.fetchone()[0])
            if not exists:
                _MAP_PLACES_READY = False
                return False
            cur.execute("SELECT 1 FROM gis.map_places WHERE active LIMIT 1")
            _MAP_PLACES_READY = cur.fetchone() is not None
    except Exception:
        logger.exception("map_places readiness check failed")
        try:
            conn.rollback()
        except Exception:
            pass
        _MAP_PLACES_READY = False
    return bool(_MAP_PLACES_READY)


def _search_map_places_sql(
    conn,
    query: str,
    *,
    limit: int,
    west: float | None = None,
    south: float | None = None,
    east: float | None = None,
    north: float | None = None,
    place_types: list[str] | None = None,
) -> list[dict[str, Any]]:
    if not map_places_table_ready(conn):
        return []

    q_norm = _normalize(query)
    if len(q_norm) < 2:
        return []

    has_bbox = None not in (west, south, east, north)
    type_filter = ""
    if place_types:
        type_filter = "AND place_type = ANY(%s)"

    prefix = f"{q_norm}%"
    sql = f"""
        SELECT
          id, name, place_type, city, district, region,
          lon, lat, west, south, east, north, source,
          GREATEST(
            similarity(name_norm, %s),
            CASE WHEN name_norm ILIKE %s THEN 0.95 ELSE 0 END
          ) AS sim,
          CASE
            WHEN %s IS NOT NULL
                 AND lon BETWEEN %s AND %s AND lat BETWEEN %s AND %s
            THEN 0
            ELSE 1
          END AS viewport_rank
        FROM gis.map_places
        WHERE active
          {type_filter}
          AND (
            name_norm %% %s
            OR name_norm ILIKE %s
          )
        ORDER BY viewport_rank, sim DESC, length(name), name
        LIMIT %s
    """
    if has_bbox:
        bind: list[Any] = [
            q_norm,
            prefix,
            west,
            west,
            east,
            south,
            north,
            q_norm,
            prefix,
        ]
    else:
        bind = [q_norm, prefix, None, None, None, None, None, q_norm, prefix]
    if place_types:
        bind.append(place_types)
    bind.append(limit)

    out: list[dict[str, Any]] = []
    try:
        with conn.cursor() as cur:
            cur.execute("SET LOCAL pg_trgm.similarity_threshold = 0.25")
            cur.execute(sql, bind)
            for (
                row_id,
                name,
                place_type,
                city,
                district,
                region,
                lon,
                lat,
                wb,
                sb,
                eb,
                nb,
                source,
                sim,
                _viewport_rank,
            ) in cur.fetchall():
                lon_f = _float_or_none(lon)
                lat_f = _float_or_none(lat)
                if lon_f is None or lat_f is None:
                    continue
                subtitle = _subtitle(
                    [city, district, region],
                    fallback=str(place_type or "place").replace("_", " ").title(),
                )
                entry = _place_entry(
                    entry_id=f"osm:{row_id}",
                    title=str(name),
                    subtitle=subtitle,
                    place_type=str(place_type or "place"),
                    lon=lon_f,
                    lat=lat_f,
                    bbox=_bbox_from_row(wb, sb, eb, nb, lon=lon_f, lat=lat_f),
                    source=str(source or "osm"),
                    rank_score=6.0 - float(sim or 0) * 4.0,
                )
                if entry:
                    out.append(entry)
    except Exception:
        logger.exception("map_places SQL search failed for query=%r", query)
        try:
            conn.rollback()
        except Exception:
            pass
    return out


def lookup_map_place(
    conn,
    query: str,
    *,
    limit: int = 5,
    place_types: list[str] | None = None,
) -> list[dict[str, Any]]:
    """Shared local place lookup for autocomplete and copilot place resolution."""
    return _search_map_places_sql(
        conn,
        query,
        limit=limit,
        place_types=place_types,
    )


def _search_aliases_sql(
    conn,
    query: str,
    *,
    limit: int,
    west: float | None = None,
    south: float | None = None,
    east: float | None = None,
    north: float | None = None,
) -> list[dict[str, Any]]:
    q = (query or "").strip()
    if len(q) < 2:
        return []

    has_bbox = None not in (west, south, east, north)
    sql = """
        SELECT alias, district, region, lon, lat, source,
               similarity(alias, %s) AS sim,
               CASE
                 WHEN %s IS NOT NULL AND lon BETWEEN %s AND %s AND lat BETWEEN %s AND %s
                 THEN 0 ELSE 1
               END AS viewport_rank
        FROM gis.place_aliases
        WHERE active
          AND lon IS NOT NULL
          AND lat IS NOT NULL
          AND (alias %% %s OR lower(alias) LIKE lower(%s))
        ORDER BY viewport_rank, sim DESC, length(alias), alias
        LIMIT %s
    """
    if has_bbox:
        bind = [q, west, west, east, south, north, q, f"{q}%", limit]
    else:
        bind = [q, None, None, None, None, None, q, f"{q}%", limit]

    out: list[dict[str, Any]] = []
    try:
        with conn.cursor() as cur:
            cur.execute("SET LOCAL pg_trgm.similarity_threshold = 0.25")
            cur.execute(sql, bind)
            for alias, district, region, lon, lat, source, sim, _vr in cur.fetchall():
                entry = _place_entry(
                    entry_id=f"alias:{alias}",
                    title=str(alias),
                    subtitle=_subtitle([district, region], fallback="Locality"),
                    place_type="alias",
                    lon=_float_or_none(lon),
                    lat=_float_or_none(lat),
                    source=str(source or "alias"),
                    rank_score=5.0 - float(sim or 0) * 3.0,
                )
                if entry:
                    out.append(entry)
    except Exception:
        logger.exception("alias SQL search failed for query=%r", query)
        try:
            conn.rollback()
        except Exception:
            pass
    return out


def _load_aliases(conn) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT alias, district, region, lon, lat, source
                FROM gis.place_aliases
                WHERE active
                  AND lon IS NOT NULL
                  AND lat IS NOT NULL
                """
            )
            for alias, district, region, lon, lat, source in cur.fetchall():
                entry = _place_entry(
                    entry_id=f"alias:{alias}",
                    title=str(alias),
                    subtitle=_subtitle([district, region], fallback="Locality"),
                    place_type="alias",
                    lon=_float_or_none(lon),
                    lat=_float_or_none(lat),
                    source=str(source or "alias"),
                )
                if entry:
                    out.append(entry)
    except Exception:
        logger.exception("autocomplete alias load failed")
        try:
            conn.rollback()
        except Exception:
            pass
    return out


def _load_districts(conn) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    try:
        try:
            from agent_warm_cache import get_warm_places_index

            places = get_warm_places_index(conn)
        except Exception:
            from map_search import list_places_index

            places = list_places_index(conn)

        for place in places:
            title = str(place.get("title") or "")
            lon = _float_or_none(place.get("longitude"))
            lat = _float_or_none(place.get("latitude"))
            bbox = place.get("bbox") if isinstance(place.get("bbox"), dict) else None
            entry = _place_entry(
                entry_id=str(place.get("id") or f"place:{title}"),
                title=title,
                subtitle=place.get("subtitle"),
                place_type=str(place.get("place_type") or "district"),
                lon=lon,
                lat=lat,
                bbox=bbox,
                source="district",
            )
            if entry:
                out.append(entry)
    except Exception:
        logger.exception("autocomplete district load failed")
        try:
            conn.rollback()
        except Exception:
            pass
    return out


def build_autocomplete_index(conn) -> list[dict[str, Any]]:
    """Merge districts + place aliases into one searchable catalog (legacy fallback)."""
    districts = _load_districts(conn)
    aliases = _load_aliases(conn)
    seen: set[str] = set()
    merged: list[dict[str, Any]] = []
    for item in aliases + districts:
        key = item["_norm"]
        if key in seen:
            continue
        seen.add(key)
        merged.append(item)
    return merged


def get_autocomplete_index(conn, *, force: bool = False) -> list[dict[str, Any]]:
    import time

    global _INDEX, _INDEX_BUILT_AT
    now = time.time()
    with _INDEX_LOCK:
        if (
            not force
            and _INDEX is not None
            and now - _INDEX_BUILT_AT < INDEX_REFRESH_SEC
        ):
            return _INDEX

    from redis_cache import AUTOCOMPLETE_INDEX_TTL_SEC, autocomplete_index_key, cached_json

    cache_key = autocomplete_index_key()

    def _fetch() -> list[dict[str, Any]]:
        return build_autocomplete_index(conn)

    try:
        raw = cached_json(cache_key, _fetch, ttl_sec=AUTOCOMPLETE_INDEX_TTL_SEC)
    except Exception:
        raw = _fetch()

    cleaned: list[dict[str, Any]] = []
    if isinstance(raw, list):
        for item in raw:
            if not isinstance(item, dict):
                continue
            title = str(item.get("title") or "")
            lon = _float_or_none(item.get("longitude"))
            lat = _float_or_none(item.get("latitude"))
            entry = _place_entry(
                entry_id=str(item.get("id") or title),
                title=title,
                subtitle=item.get("subtitle"),
                place_type=str(item.get("place_type") or "place"),
                lon=lon,
                lat=lat,
                bbox=item.get("bbox") if isinstance(item.get("bbox"), dict) else None,
                source=str(item.get("source") or "index"),
            )
            if entry:
                cleaned.append(entry)

    with _INDEX_LOCK:
        _INDEX = cleaned
        _INDEX_BUILT_AT = now
        return _INDEX


def _match_score(item: dict[str, Any], query: str) -> float | None:
    """Lower is better. None = no match."""
    q = _normalize(query)
    if len(q) < 2:
        return None
    title = item.get("_norm") or _normalize(str(item.get("title") or ""))
    tokens: list[str] = item.get("_tokens") or title.split()

    if title == q:
        return 0.0
    if title.startswith(q):
        return 1.0 + (len(title) - len(q)) * 0.01
    if f" {q}" in f" {title} ":
        return 2.0
    if q in title:
        return 3.0 + title.find(q) * 0.01

    best: float | None = None
    for token in tokens:
        if token.startswith(q):
            score = 4.0 + (len(token) - len(q)) * 0.02
            best = score if best is None else min(best, score)
            continue
        if len(q) >= 4 and len(token) >= 4:
            max_dist = 1 if len(q) <= 5 else 2 if len(q) <= 8 else 3
            dist = _levenshtein(q, token)
            if dist <= max_dist:
                score = 5.0 + dist + abs(len(token) - len(q)) * 0.05
                best = score if best is None else min(best, score)

    return best


def _viewport_bonus(
    item: dict[str, Any],
    *,
    west: float | None,
    south: float | None,
    east: float | None,
    north: float | None,
) -> float:
    """Negative bonus (improves rank) when point sits in map viewport."""
    if None in (west, south, east, north):
        return 0.0
    lon = _float_or_none(item.get("longitude"))
    lat = _float_or_none(item.get("latitude"))
    if lon is None or lat is None:
        return 0.0
    assert west is not None and south is not None and east is not None and north is not None
    if west <= lon <= east and south <= lat <= north:
        return -1.5
    cx = (west + east) / 2.0
    cy = (south + north) / 2.0
    dist = math.hypot(lon - cx, lat - cy)
    if dist < 0.15:
        return -0.8
    if dist < 0.4:
        return -0.3
    return 0.0


def _public_result(item: dict[str, Any]) -> dict[str, Any]:
    return {
        "kind": "place",
        "id": item["id"],
        "title": item["title"],
        "subtitle": item.get("subtitle"),
        "longitude": item.get("longitude"),
        "latitude": item.get("latitude"),
        "bbox": item.get("bbox"),
        "source": item.get("source"),
        "place_type": item.get("place_type"),
    }


def _merge_scored_results(
    scored: list[tuple[float, dict[str, Any]]],
    *,
    limit: int,
) -> list[dict[str, Any]]:
    scored.sort(
        key=lambda pair: (
            pair[0],
            _SOURCE_PRIORITY.get(str(pair[1].get("source") or ""), 9),
            str(pair[1].get("title") or "").lower(),
        )
    )
    seen: set[str] = set()
    out: list[dict[str, Any]] = []
    for _, item in scored:
        key = item.get("_norm") or _normalize(str(item.get("title") or ""))
        if not key or key in seen:
            continue
        seen.add(key)
        out.append(_public_result(item))
        if len(out) >= limit:
            break
    return out


def autocomplete_places(
    conn,
    *,
    query: str,
    limit: int = 8,
    west: float | None = None,
    south: float | None = None,
    east: float | None = None,
    north: float | None = None,
) -> list[dict[str, Any]]:
    """
    Prefix + fuzzy autocomplete over OSM map_places, aliases, and districts.
    Biases toward the current map viewport when bounds are provided.
    """
    q = (query or "").strip()
    if len(q) < 2:
        return []

    limit = max(1, min(int(limit), 20))
    scored: list[tuple[float, dict[str, Any]]] = []

    if map_places_table_ready(conn):
        fetch_limit = max(limit * 3, 24)
        for item in _search_map_places_sql(
            conn,
            q,
            limit=fetch_limit,
            west=west,
            south=south,
            east=east,
            north=north,
        ):
            base = item.get("_rank_score")
            if base is None:
                base = _match_score(item, q)
            if base is None:
                continue
            bonus = _viewport_bonus(item, west=west, south=south, east=east, north=north)
            scored.append((float(base) + bonus, item))

        for item in _search_aliases_sql(
            conn,
            q,
            limit=fetch_limit,
            west=west,
            south=south,
            east=east,
            north=north,
        ):
            base = item.get("_rank_score")
            if base is None:
                base = _match_score(item, q)
            if base is None:
                continue
            bonus = _viewport_bonus(item, west=west, south=south, east=east, north=north)
            scored.append((float(base) - 0.5 + bonus, item))

        for item in _load_districts(conn):
            base = _match_score(item, q)
            if base is None:
                continue
            bonus = _viewport_bonus(item, west=west, south=south, east=east, north=north)
            scored.append((base + 1.0 + bonus, item))

        if scored:
            return _merge_scored_results(scored, limit=limit)

    index = get_autocomplete_index(conn)
    for item in index:
        base = _match_score(item, q)
        if base is None:
            continue
        bonus = _viewport_bonus(
            item, west=west, south=south, east=east, north=north
        )
        scored.append((base + bonus, item))

    return _merge_scored_results(scored, limit=limit)
