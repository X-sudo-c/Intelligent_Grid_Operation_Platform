"""Parse spatial scope from GIOP portal copilot context."""

from __future__ import annotations

import math
from typing import Any

# GiopMapView default camera (Pokuaa BSP area) — hands-free fallback when no live bbox yet.
_DEFAULT_MAP_CENTER = (-0.2941, 5.6812)
_DEFAULT_MAP_ZOOM = 13.0


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


def bbox_from_center_zoom(
    lon: float,
    lat: float,
    zoom: float,
    *,
    viewport_width_px: float = 900,
    viewport_height_px: float = 700,
) -> dict[str, float]:
    """Approximate map viewport bbox from center + zoom (MapLibre-style)."""
    lat_rad = math.radians(lat)
    lon_per_px = 360.0 / (256.0 * (2.0**zoom))
    lat_per_px = lon_per_px / max(math.cos(lat_rad), 0.01)
    half_w = (viewport_width_px / 2.0) * lon_per_px
    half_h = (viewport_height_px / 2.0) * lat_per_px
    return {
        "west": lon - half_w,
        "south": lat - half_h,
        "east": lon + half_w,
        "north": lat + half_h,
    }


def default_map_viewport_bbox() -> dict[str, float]:
    lon, lat = _DEFAULT_MAP_CENTER
    return bbox_from_center_zoom(lon, lat, _DEFAULT_MAP_ZOOM)


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
    flat = _normalize_bbox(viewport)
    if flat:
        return flat
    center = viewport.get("center")
    zoom = viewport.get("zoom")
    if isinstance(center, dict) and zoom is not None:
        try:
            return bbox_from_center_zoom(
                float(center["lon"]),
                float(center["lat"]),
                float(zoom),
            )
        except (TypeError, ValueError):
            pass
    return None


def portal_spatial_bbox(
    conn,
    context: dict[str, Any],
    *,
    allow_selected_territory: bool = True,
) -> dict[str, float]:
    """
    Best-effort map area for hands-free voice — never requires the user to pan.

    Priority: live viewport bbox → center+zoom estimate → selected district/region
    → default map camera (Pokuaa area at z13).
    """
    bbox = portal_viewport_bbox(context)
    if bbox:
        return bbox
    if allow_selected_territory:
        sel_d, sel_r = portal_selected_territory(context)
        if sel_d or sel_r:
            from agents import spatial

            try:
                return spatial.resolve_territory(conn, district=sel_d, region=sel_r)["bbox"]
            except ValueError:
                pass
    return default_map_viewport_bbox()


def portal_viewport_center(context: dict[str, Any]) -> dict[str, float] | None:
    """Map center from portal viewport context."""
    viewport = context.get("viewport")
    if not isinstance(viewport, dict):
        return None
    center = viewport.get("center")
    if not isinstance(center, dict):
        return None
    try:
        return {"lon": float(center["lon"]), "lat": float(center["lat"])}
    except (KeyError, TypeError, ValueError):
        return None


# Viewport node pick — highlight for confirmation when resolution is ambiguous.
_NODE_PICK_UNCERTAIN_DIST_M = 120.0
_NODE_PICK_AMBIGUITY_GAP_M = 25.0
_NODE_PICK_LOW_ZOOM = 14.0


def _node_pick_uncertain(
    *,
    distance_m: float,
    zoom: float | None,
    runner_up_distance_m: float | None,
) -> bool:
    """True when the nearest-node guess should be confirmed on the map."""
    if zoom is not None and zoom < _NODE_PICK_LOW_ZOOM:
        return True
    if distance_m > _NODE_PICK_UNCERTAIN_DIST_M:
        return True
    if runner_up_distance_m is not None:
        if runner_up_distance_m - distance_m < _NODE_PICK_AMBIGUITY_GAP_M:
            return True
    return False


def resolve_node_mrid(
    conn,
    context: dict[str, Any],
    *,
    explicit_mrid: str | None = None,
    tier: str = "master",
) -> dict[str, Any]:
    """
    Resolve which connectivity node the user means.

    Priority: explicit/selected focus_mrid → nearest node to map center in view.
    """
    focus = portal_focus_mrid(context)
    mrid = (explicit_mrid or focus or "").strip()
    if mrid:
        source = "selection" if focus and focus == mrid else "explicit"
        if explicit_mrid and not focus:
            source = "explicit"
        elif focus:
            source = "selection"
        return {
            "mrid": mrid,
            "source": source,
            "certain": True,
            "confirmation_needed": False,
        }

    center = portal_viewport_center(context)
    if not center:
        return {
            "error": "No node is selected — zoom the map to an area with visible nodes.",
            "mrid": None,
        }

    bbox = portal_spatial_bbox(conn, context)
    schema = "staging" if (tier or "master").strip().lower() == "staging" else "public"
    lon, lat = center["lon"], center["lat"]
    zoom_raw = (context.get("viewport") or {}).get("zoom") if isinstance(context.get("viewport"), dict) else None
    try:
        zoom = float(zoom_raw) if zoom_raw is not None else None
    except (TypeError, ValueError):
        zoom = None

    with conn.cursor() as cur:
        cur.execute(
            f"""
            SELECT cn.mrid::text,
                   io.name,
                   ST_Distance(
                     cn.geom::geography,
                     ST_SetSRID(ST_MakePoint(%s, %s), 4326)::geography
                   ) AS dist_m
            FROM {schema}.connectivity_nodes cn
            JOIN {schema}.identified_objects io ON io.mrid = cn.mrid
            WHERE cn.geom IS NOT NULL
              AND ST_Intersects(
                cn.geom,
                ST_MakeEnvelope(%s, %s, %s, %s, 4326)
              )
            ORDER BY cn.geom <-> ST_SetSRID(ST_MakePoint(%s, %s), 4326)
            LIMIT 3
            """,
            (
                lon,
                lat,
                bbox["west"],
                bbox["south"],
                bbox["east"],
                bbox["north"],
                lon,
                lat,
            ),
        )
        rows = cur.fetchall()

    if not rows:
        return {
            "error": "No connectivity node found in the current map view.",
            "mrid": None,
        }

    mrid, name, dist_m = rows[0]
    dist_m = float(dist_m)
    runner_up = float(rows[1][2]) if len(rows) > 1 else None
    uncertain = _node_pick_uncertain(
        distance_m=dist_m,
        zoom=zoom,
        runner_up_distance_m=runner_up,
    )

    result: dict[str, Any] = {
        "mrid": mrid,
        "name": name,
        "distance_m": round(dist_m, 1),
        "source": "viewport_center",
        "certain": not uncertain,
        "confirmation_needed": uncertain,
    }
    if uncertain and len(rows) > 1:
        result["alternates"] = [
            {
                "mrid": row[0],
                "name": row[1],
                "distance_m": round(float(row[2]), 1),
            }
            for row in rows[1:3]
        ]
    return result


def portal_focus_mrid(context: dict[str, Any]) -> str | None:
    raw = context.get("focus_mrid")
    if not raw:
        return None
    mrid = str(raw).strip()
    return mrid or None


def portal_boundary_feeder_id(context: dict[str, Any]) -> str | None:
    raw = context.get("boundary_feeder_id")
    if not raw:
        return None
    feeder = str(raw).strip()
    return feeder or None


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
    allow_selected_territory: bool = False,
) -> tuple[dict[str, float] | None, str | None, str | None]:
    """
    Resolve count filters for “here / this area” and named places.

    Priority when use_viewport: explicit territory bbox → live map viewport →
    (only when allow_selected_territory) selected highlight territory.
    """
    bbox = territory_bbox
    out_district = district
    out_region = region

    if use_viewport:
        if bbox is None:
            bbox = portal_viewport_bbox(context)
        if (
            allow_selected_territory
            and bbox is None
            and not out_district
            and not out_region
        ):
            sel_d, sel_r = portal_selected_territory(context)
            out_district = sel_d
            out_region = sel_r
        # Default map bbox only when nothing else scoped the query.
        if bbox is None and not out_district and not out_region:
            bbox = default_map_viewport_bbox()

    return bbox, out_district, out_region
