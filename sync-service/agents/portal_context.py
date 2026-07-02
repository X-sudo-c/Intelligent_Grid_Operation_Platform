"""Parse spatial scope from GIOP portal copilot context."""

from __future__ import annotations

from typing import Any


def _normalize_bbox(raw: dict[str, Any]) -> dict[str, float] | None:
    try:
        return {
            "west": float(raw["west"]),
            "south": float(raw["south"]),
            "east": float(raw["east"]),
            "north": float(raw["north"]),
        }
    except (KeyError, TypeError, ValueError):
        return None


def portal_viewport_bbox(context: dict[str, Any]) -> dict[str, float] | None:
    """Map viewport bounds from portal context (nested or flat bbox)."""
    viewport = context.get("viewport")
    if not isinstance(viewport, dict):
        return None
    nested = viewport.get("bbox")
    if isinstance(nested, dict):
        bbox = _normalize_bbox(nested)
        if bbox:
            return bbox
    return _normalize_bbox(viewport)


def portal_selected_territory(context: dict[str, Any]) -> tuple[str | None, str | None]:
    """Highlighted or clicked admin territory from the map chrome."""
    district = context.get("selected_district")
    region = context.get("selected_region")
    d = str(district).strip() if district else None
    r = str(region).strip() if region else None
    return d or None, r or None


def portal_count_scope(
    *,
    use_viewport: bool,
    territory_bbox: dict[str, float] | None,
    district: str | None,
    region: str | None,
    context: dict[str, Any],
) -> tuple[dict[str, float] | None, str | None, str | None]:
    """
    Resolve count filters for “here / this area” and named places.

    Priority when use_viewport: explicit territory bbox → live map viewport →
  selected highlight territory.
    """
    bbox = territory_bbox
    out_district = district
    out_region = region

    if use_viewport:
        if bbox is None:
            bbox = portal_viewport_bbox(context)
        if bbox is None and not out_district and not out_region:
            sel_d, sel_r = portal_selected_territory(context)
            out_district = sel_d
            out_region = sel_r

    return bbox, out_district, out_region
