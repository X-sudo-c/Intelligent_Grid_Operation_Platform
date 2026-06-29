"""Map node queries for mobile (proxies Supabase RPC over sync-service port)."""

from __future__ import annotations

import json
from typing import Any


def fetch_nodes_near_location(
    conn,
    *,
    lat: float,
    lon: float,
    limit: int = 500,
    prefer_wired: bool = True,
) -> list[dict[str, Any]]:
    lim = max(1, min(limit, 1000))
    with conn.cursor() as cur:
        cur.execute(
            "SELECT public.nodes_near_location(%s, %s, %s, NULL, %s)",
            (lat, lon, lim, prefer_wired),
        )
        row = cur.fetchone()
    if not row or row[0] is None:
        return []
    raw = row[0]
    if isinstance(raw, list):
        return raw
    if isinstance(raw, str):
        parsed = json.loads(raw)
        return parsed if isinstance(parsed, list) else []
    if isinstance(raw, dict):
        return [raw]
    return []
