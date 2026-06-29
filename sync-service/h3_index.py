"""H3 spatial-index helpers for GIOP.

Thin, dependency-isolated wrapper around the official `h3` Python bindings.
We never compute hexagon math by hand — everything delegates to `h3`.

The module degrades gracefully: if `h3` is not installed, `H3_AVAILABLE` is
False and callers should return HTTP 503 with `H3_IMPORT_ERROR` so the rest of
the gateway keeps running.

Supports both h3 v4 (snake_case API) and v3 (legacy names) so the service works
regardless of which wheel is installed.
"""

from __future__ import annotations

from typing import Iterable

H3_AVAILABLE = False
H3_IMPORT_ERROR: str | None = None

try:  # pragma: no cover - import guard
    import h3 as _h3

    H3_AVAILABLE = True
except Exception as exc:  # pragma: no cover - import guard
    _h3 = None
    H3_IMPORT_ERROR = str(exc)


DEFAULT_RES = 9
MIN_RES = 0
MAX_RES = 15


def _require() -> None:
    if not H3_AVAILABLE:
        raise RuntimeError(
            f"h3 library not available: {H3_IMPORT_ERROR or 'not installed'}. "
            "Add `h3>=4.0.0` to sync-service/requirements.txt and reinstall."
        )


# --- version-compatible primitives -------------------------------------------

def latlng_to_cell(lat: float, lng: float, res: int) -> str:
    _require()
    fn = getattr(_h3, "latlng_to_cell", None) or getattr(_h3, "geo_to_h3")
    return fn(lat, lng, res)


def cell_to_latlng(cell: str) -> tuple[float, float]:
    _require()
    fn = getattr(_h3, "cell_to_latlng", None) or getattr(_h3, "h3_to_geo")
    lat, lng = fn(cell)
    return lat, lng


def grid_disk(cell: str, k: int) -> list[str]:
    _require()
    fn = getattr(_h3, "grid_disk", None) or getattr(_h3, "k_ring")
    return list(fn(cell, k))


def cell_to_parent(cell: str, res: int) -> str:
    _require()
    fn = getattr(_h3, "cell_to_parent", None) or getattr(_h3, "h3_to_parent")
    return fn(cell, res)


def get_resolution(cell: str) -> int:
    _require()
    fn = getattr(_h3, "get_resolution", None) or getattr(_h3, "h3_get_resolution")
    return fn(cell)


def is_valid_cell(cell: str) -> bool:
    if not H3_AVAILABLE:
        return False
    fn = getattr(_h3, "is_valid_cell", None) or getattr(_h3, "h3_is_valid")
    try:
        return bool(fn(cell))
    except Exception:
        return False


def cell_boundary_latlng(cell: str) -> list[tuple[float, float]]:
    """Boundary vertices as (lat, lng) pairs."""
    _require()
    fn = getattr(_h3, "cell_to_boundary", None) or getattr(_h3, "h3_to_geo_boundary")
    try:
        return [(float(lat), float(lng)) for lat, lng in fn(cell)]
    except TypeError:
        # legacy signature accepted a geo_json flag
        return [(float(lat), float(lng)) for lat, lng in fn(cell, False)]


# --- derived helpers used by the gateway -------------------------------------

def clamp_resolution(res: int | None) -> int:
    if res is None:
        return DEFAULT_RES
    return max(MIN_RES, min(MAX_RES, int(res)))


def ring_cells(lat: float, lng: float, res: int, k: int) -> tuple[str, list[str]]:
    """Return (center_cell, all cells in the k-ring)."""
    center = latlng_to_cell(lat, lng, res)
    return center, grid_disk(center, max(0, int(k)))


def cell_to_polygon_wkt(cell: str) -> str:
    """Closed POLYGON WKT (lng lat order) for a single hexagon."""
    boundary = cell_boundary_latlng(cell)
    if not boundary:
        return ""
    ring = [f"{lng} {lat}" for lat, lng in boundary]
    ring.append(ring[0])  # close the ring
    return "POLYGON((" + ", ".join(ring) + "))"


def cells_bbox(cells: Iterable[str]) -> tuple[float, float, float, float] | None:
    """Bounding box (west, south, east, north) covering all cell boundaries."""
    west = south = east = north = None
    for cell in cells:
        for lat, lng in cell_boundary_latlng(cell):
            west = lng if west is None else min(west, lng)
            east = lng if east is None else max(east, lng)
            south = lat if south is None else min(south, lat)
            north = lat if north is None else max(north, lat)
    if west is None:
        return None
    return (west, south, east, north)


def cell_geojson_polygon(cell: str) -> dict:
    """GeoJSON Polygon geometry (lng,lat) for a hexagon."""
    boundary = cell_boundary_latlng(cell)
    coords = [[lng, lat] for lat, lng in boundary]
    if coords:
        coords.append(coords[0])
    return {"type": "Polygon", "coordinates": [coords]}


def bbox_cells(
    west: float,
    south: float,
    east: float,
    north: float,
    res: int,
    *,
    max_cells: int = 800,
) -> list[str]:
    """All H3 cells covering a geographic bounding box."""
    _require()
    geo = {
        "type": "Polygon",
        "coordinates": [
            [
                [west, south],
                [east, south],
                [east, north],
                [west, north],
                [west, south],
            ]
        ],
    }
    fn = getattr(_h3, "geo_to_cells", None) or getattr(_h3, "polyfill_geojson", None)
    if fn is None:
        raise RuntimeError("h3 library has no geo_to_cells / polyfill_geojson")
    cells = list(fn(geo, res))
    if len(cells) > max_cells:
        return cells[:max_cells]
    return cells
