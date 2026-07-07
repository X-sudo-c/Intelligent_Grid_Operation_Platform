"""Tool wrappers for spatial inventory and territory resolution."""

from __future__ import annotations

from typing import Any

from agents import spatial


def tool_resolve_place(conn, *, query: str, allow_geocode: bool | None = None) -> dict[str, Any]:
    from agents.place_resolve import resolve_place

    return resolve_place(conn, query, allow_geocode=allow_geocode)


def tool_resolve_territory(
    conn,
    *,
    district: str | None = None,
    region: str | None = None,
) -> dict[str, Any]:
    return spatial.resolve_territory(conn, district=district, region=region)


def tool_territory_geojson(
    conn,
    *,
    district: str | None = None,
    region: str | None = None,
) -> dict[str, Any]:
    return spatial.territory_geojson(conn, district=district, region=region)


def tool_asset_inventory_counts(
    conn,
    *,
    tier: str = "master",
    asset_kind: str | None = None,
    district: str | None = None,
    region: str | None = None,
    west: float | None = None,
    south: float | None = None,
    east: float | None = None,
    north: float | None = None,
) -> dict[str, Any]:
    bbox = None
    if None not in (west, south, east, north):
        bbox = {"west": west, "south": south, "east": east, "north": north}
    return spatial.asset_inventory_counts(
        conn,
        tier=tier,
        asset_kind=asset_kind,
        district=district,
        region=region,
        bbox=bbox,
    )


def tool_list_assets_in_territory(
    conn,
    *,
    tier: str = "master",
    asset_kind: str | None = None,
    district: str | None = None,
    region: str | None = None,
    west: float | None = None,
    south: float | None = None,
    east: float | None = None,
    north: float | None = None,
    limit: int = spatial.LIST_ASSETS_DEFAULT_LIMIT,
    offset: int = 0,
    include_geom: bool = False,
) -> dict[str, Any]:
    bbox = None
    if None not in (west, south, east, north):
        bbox = {"west": west, "south": south, "east": east, "north": north}
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


def tool_territory_network_summary(
    conn,
    *,
    tier: str = "master",
    district: str | None = None,
    region: str | None = None,
    west: float | None = None,
    south: float | None = None,
    east: float | None = None,
    north: float | None = None,
) -> dict[str, Any]:
    bbox = None
    if None not in (west, south, east, north):
        bbox = {"west": west, "south": south, "east": east, "north": north}
    return spatial.territory_network_summary(
        conn,
        tier=tier,
        district=district,
        region=region,
        bbox=bbox,
    )
