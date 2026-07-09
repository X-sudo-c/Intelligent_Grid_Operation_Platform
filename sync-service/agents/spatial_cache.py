"""Redis-backed cache for spatial agent tools (voice + copilot)."""

from __future__ import annotations

from typing import Any

from redis_cache import (
    SPATIAL_INVENTORY_CACHE_TTL_SEC,
    SPATIAL_LIST_CACHE_TTL_SEC,
    SPATIAL_TERRITORY_CACHE_TTL_SEC,
    cached_json,
    get_json,
    spatial_inventory_key,
    spatial_list_key,
    spatial_network_summary_key,
    spatial_territory_key,
)


def _mark_cached(payload: dict[str, Any]) -> dict[str, Any]:
    out = dict(payload)
    out["cached"] = True
    return out


def cached_asset_inventory_counts(
    conn,
    *,
    tier: str = "master",
    asset_kind: str | None = None,
    district: str | None = None,
    region: str | None = None,
    bbox: dict[str, float] | None = None,
) -> dict[str, Any]:
    """Shared inventory counts cache for voice router and copilot spatial tools."""
    from agents import spatial

    west = south = east = north = None
    if bbox:
        west = bbox.get("west")
        south = bbox.get("south")
        east = bbox.get("east")
        north = bbox.get("north")

    key = spatial_inventory_key(
        tier=tier,
        asset_kind=asset_kind,
        district=district,
        region=region,
        west=west,
        south=south,
        east=east,
        north=north,
    )

    cached = get_json(key)
    if isinstance(cached, dict) and "total" in cached:
        return _mark_cached(cached)

    def _fetch() -> dict[str, Any]:
        return spatial.asset_inventory_counts(
            conn,
            tier=tier,
            asset_kind=asset_kind,
            district=district,
            region=region,
            bbox=bbox,
        )

    try:
        raw = cached_json(key, _fetch, ttl_sec=SPATIAL_INVENTORY_CACHE_TTL_SEC)
    except Exception:
        raw = _fetch()

    out = dict(raw) if isinstance(raw, dict) else _fetch()
    out["cached"] = False
    return out


def cached_list_assets_in_territory(
    conn,
    *,
    tier: str = "master",
    asset_kind: str | None = None,
    district: str | None = None,
    region: str | None = None,
    bbox: dict[str, float] | None = None,
    limit: int = 25,
    offset: int = 0,
    include_geom: bool = False,
) -> dict[str, Any]:
    from agents import spatial

    west = south = east = north = None
    if bbox:
        west = bbox.get("west")
        south = bbox.get("south")
        east = bbox.get("east")
        north = bbox.get("north")

    key = spatial_list_key(
        tier=tier,
        asset_kind=asset_kind,
        district=district,
        region=region,
        limit=limit,
        offset=offset,
        include_geom=include_geom,
        west=west,
        south=south,
        east=east,
        north=north,
    )

    def _fetch() -> dict[str, Any]:
        return spatial.list_assets_in_territory(
            conn,
            tier=tier,
            asset_kind=asset_kind,
            district=district,
            region=region,
            bbox=bbox,
            limit=limit,
            offset=offset,
            include_geom=include_geom,
        )

    try:
        return cached_json(key, _fetch, ttl_sec=SPATIAL_LIST_CACHE_TTL_SEC)
    except Exception:
        return _fetch()


def cached_resolve_territory(
    conn,
    *,
    district: str | None = None,
    region: str | None = None,
) -> dict[str, Any]:
    from agents import spatial

    key = spatial_territory_key(district=district, region=region)

    def _fetch() -> dict[str, Any]:
        return spatial.resolve_territory(conn, district=district, region=region)

    try:
        return cached_json(key, _fetch, ttl_sec=SPATIAL_TERRITORY_CACHE_TTL_SEC)
    except Exception:
        return _fetch()


def cached_territory_network_summary(
    conn,
    *,
    tier: str = "master",
    district: str | None = None,
    region: str | None = None,
    bbox: dict[str, float] | None = None,
) -> dict[str, Any]:
    from agents import spatial

    west = south = east = north = None
    if bbox:
        west = bbox.get("west")
        south = bbox.get("south")
        east = bbox.get("east")
        north = bbox.get("north")

    key = spatial_network_summary_key(
        tier=tier,
        district=district,
        region=region,
        west=west,
        south=south,
        east=east,
        north=north,
    )

    def _fetch() -> dict[str, Any]:
        return spatial.territory_network_summary(
            conn,
            tier=tier,
            district=district,
            region=region,
            bbox=bbox,
        )

    try:
        return cached_json(key, _fetch, ttl_sec=SPATIAL_INVENTORY_CACHE_TTL_SEC)
    except Exception:
        return _fetch()
