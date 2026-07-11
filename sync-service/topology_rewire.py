"""Geom-preserving master line endpoint FK rewire (bbox-scoped)."""

from __future__ import annotations

from typing import Any


def rewire_line_endpoints_by_geometry(
    conn,
    *,
    west: float,
    south: float,
    east: float,
    north: float,
    tip_tol_m: float = 1.0,
    far_fk_m: float = 50.0,
    dry_run: bool = True,
) -> dict[str, Any]:
    """Call public.rewire_line_endpoints_by_geometry and return the jsonb result."""
    if west >= east or south >= north:
        raise ValueError("invalid bbox: require west < east and south < north")
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT public.rewire_line_endpoints_by_geometry(
              %s, %s, %s, %s, %s, %s, %s
            )
            """,
            (west, south, east, north, tip_tol_m, far_fk_m, dry_run),
        )
        row = cur.fetchone()
    if not row or row[0] is None:
        return {}
    result = row[0]
    return result if isinstance(result, dict) else dict(result)
