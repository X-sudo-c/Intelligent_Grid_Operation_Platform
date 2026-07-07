"""Forward geocoding for map search — OpenStreetMap / Nominatim (Ghana)."""

from __future__ import annotations

from typing import Any

import requests

from redis_cache import (
    PLACE_GEOCODE_CACHE_TTL_SEC,
    geocode_places_key,
    get_json,
    set_json,
)

NOMINATIM_URL = "https://nominatim.openstreetmap.org/search"
USER_AGENT = "GIOP-MapSearch/1.0 (ECG grid operations; contact: ops@localhost)"
# Ghana approximate viewbox: left, top, right, bottom (lon, lat)
GHANA_VIEWBOX = "-3.35,11.35,1.35,4.5"


def _geocode_query_variants(query: str) -> list[str]:
    """Typo / partial-word variants for OSM (e.g. continenta → continental)."""
    q = (query or "").strip()
    if len(q) < 2:
        return []
    seen: set[str] = set()
    out: list[str] = []

    def add(candidate: str) -> None:
        item = candidate.strip()
        key = item.lower()
        if item and key not in seen:
            seen.add(key)
            out.append(item)

    add(q)
    low = q.lower()
    if len(low) >= 5:
        for suffix in ("l", "al", "le", "n"):
            add(f"{q}{suffix}")
        if low.endswith("a"):
            add(f"{q}l")
        if low.endswith("ta"):
            add(f"{q}l")
    if len(low) >= 5:
        add(q[:-1])
    return out


def _geocode_map_places_uncached(query: str, *, limit: int = 6) -> list[dict[str, Any]]:
    q = (query or "").strip()
    if len(q) < 2:
        return []

    limit = max(1, min(limit, 10))
    try:
        resp = requests.get(
            NOMINATIM_URL,
            params={
                "q": q,
                "format": "json",
                "limit": str(limit),
                "countrycodes": "gh",
                "viewbox": GHANA_VIEWBOX,
                "bounded": "0",
                "addressdetails": "1",
            },
            headers={"User-Agent": USER_AGENT},
            timeout=8,
        )
        resp.raise_for_status()
        payload = resp.json()
    except Exception:
        return []

    if not isinstance(payload, list):
        return []

    out: list[dict[str, Any]] = []
    for item in payload:
        if not isinstance(item, dict):
            continue
        name = (item.get("name") or item.get("display_name") or "").strip()
        if not name:
            continue
        try:
            lat = float(item["lat"])
            lon = float(item["lon"])
        except (KeyError, TypeError, ValueError):
            continue

        bbox_raw = item.get("boundingbox")
        bbox: dict[str, float] | None = None
        if isinstance(bbox_raw, list) and len(bbox_raw) >= 4:
            try:
                bbox = {
                    "south": float(bbox_raw[0]),
                    "north": float(bbox_raw[1]),
                    "west": float(bbox_raw[2]),
                    "east": float(bbox_raw[3]),
                }
            except (TypeError, ValueError):
                bbox = None

        place_id = item.get("place_id")
        display = item.get("display_name") or name
        addr = item.get("address") if isinstance(item.get("address"), dict) else {}
        region = addr.get("state") or addr.get("region")
        subtitle_parts = [p for p in (item.get("type"), region) if p]
        subtitle = " · ".join(subtitle_parts) if subtitle_parts else "OpenStreetMap"

        out.append(
            {
                "kind": "place",
                "id": f"osm:{place_id or name}",
                "title": name,
                "subtitle": subtitle,
                "source": "osm",
                "display_name": display,
                "longitude": lon,
                "latitude": lat,
                "bbox": bbox,
            }
        )

    return out


def geocode_map_places(query: str, *, limit: int = 6) -> list[dict[str, Any]]:
    """Geocode with optional Redis cache (repeat voice/map place lookups)."""
    q = (query or "").strip()
    if len(q) < 2:
        return []

    limit = max(1, min(limit, 10))
    cache_key = geocode_places_key(q, limit)
    cached = get_json(cache_key)
    if isinstance(cached, list):
        return cached

    results = _geocode_map_places_uncached(q, limit=limit)
    if not results:
        for variant in _geocode_query_variants(q)[1:]:
            results = _geocode_map_places_uncached(variant, limit=limit)
            if results:
                break
    if results:
        set_json(cache_key, results, PLACE_GEOCODE_CACHE_TTL_SEC)
    return results
