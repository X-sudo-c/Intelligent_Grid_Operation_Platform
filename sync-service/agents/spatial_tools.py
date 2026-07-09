"""Tool wrappers for spatial inventory and territory resolution."""

from __future__ import annotations

from typing import Any

from agents import spatial, spatial_cache


def tool_resolve_place(conn, *, query: str, allow_geocode: bool | None = None) -> dict[str, Any]:
    from agents.place_resolve import resolve_place

    return resolve_place(conn, query, allow_geocode=allow_geocode)


def tool_resolve_territory(
    conn,
    *,
    district: str | None = None,
    region: str | None = None,
) -> dict[str, Any]:
    return spatial_cache.cached_resolve_territory(conn, district=district, region=region)


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
    return spatial_cache.cached_asset_inventory_counts(
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
    show_on_map: bool = False,
) -> dict[str, Any]:
    bbox = None
    if None not in (west, south, east, north):
        bbox = {"west": west, "south": south, "east": east, "north": north}
    page = spatial_cache.cached_list_assets_in_territory(
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
    if show_on_map:
        kind = (asset_kind or "asset").replace("_", " ")
        total = int(page.get("total") or 0)
        place = district or region or "this area"
        label = f"{total:,} {kind}s in {place}" if total else place
        ui = spatial.assets_to_map_highlight_ui(page, label=str(label), tab="map")
        if ui:
            page = {**page, "ui_action": ui}
    return page


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
    return spatial_cache.cached_territory_network_summary(
        conn,
        tier=tier,
        district=district,
        region=region,
        bbox=bbox,
    )
