"""Warm in-process reference data for voice/copilot agent tools at startup."""

from __future__ import annotations

import logging
import os
import threading
import time
from typing import Any

logger = logging.getLogger(__name__)

_PLACES_INDEX: list[dict[str, Any]] | None = None
_PLACES_INDEX_AT = 0.0
_BOUNDARY_NAMES: list[str] | None = None
_WARM_STATS: dict[str, Any] | None = None

PLACES_INDEX_TTL_SEC = int(os.getenv("AGENT_PLACES_INDEX_TTL_SEC", "3600"))
WARM_TOPOLOGY = os.getenv("AGENT_WARM_TOPOLOGY", "").strip().lower() in (
    "1",
    "true",
    "yes",
)


def get_warm_places_index(conn) -> list[dict[str, Any]]:
    """ECG district/region centroids — cached in process memory after warmup."""
    global _PLACES_INDEX, _PLACES_INDEX_AT
    now = time.time()
    if _PLACES_INDEX is not None and now - _PLACES_INDEX_AT < PLACES_INDEX_TTL_SEC:
        return _PLACES_INDEX

    from map_search import list_places_index

    _PLACES_INDEX = list_places_index(conn)
    _PLACES_INDEX_AT = now
    return _PLACES_INDEX


def get_warm_boundary_names() -> list[str] | None:
    return _BOUNDARY_NAMES


def warm_stats() -> dict[str, Any] | None:
    return dict(_WARM_STATS) if _WARM_STATS else None


def _load_boundary_names(conn) -> list[str]:
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT DISTINCT district FROM gis.ecg_admin_boundaries
            WHERE district IS NOT NULL AND TRIM(district) <> ''
            UNION
            SELECT DISTINCT region FROM gis.ecg_admin_boundaries
            WHERE region IS NOT NULL AND TRIM(region) <> ''
            ORDER BY 1
            LIMIT 200
            """
        )
        return [str(row[0]) for row in cur.fetchall() if row and row[0]]


def warm_agent_caches(conn) -> dict[str, Any]:
    """
    Preload reference catalogs agents hit on every spatial/voice turn.
    Safe to call from a background thread at startup.
    """
    global _BOUNDARY_NAMES, _WARM_STATS
    stats: dict[str, Any] = {"started_at": time.time()}

    try:
        places = get_warm_places_index(conn)
        stats["districts"] = len(places)
    except Exception:
        logger.warning("agent warm: places index failed", exc_info=True)
        stats["districts"] = 0

    try:
        from agents.voice_normalize import register_boundary_names

        names = _load_boundary_names(conn)
        register_boundary_names(names)
        _BOUNDARY_NAMES = names
        stats["boundary_names"] = len(names)
    except Exception:
        logger.warning("agent warm: boundary names failed", exc_info=True)
        stats["boundary_names"] = 0

    try:
        from map_autocomplete import map_places_table_ready

        stats["map_places_ready"] = map_places_table_ready(conn)
    except Exception:
        logger.warning("agent warm: map_places check failed", exc_info=True)
        stats["map_places_ready"] = False

    try:
        from agents.spatial import _district_asset_counts_mv_ready

        stats["district_asset_counts_mv"] = _district_asset_counts_mv_ready(conn)
    except Exception:
        logger.warning("agent warm: district asset counts MV check failed", exc_info=True)
        stats["district_asset_counts_mv"] = False

    if not stats.get("map_places_ready"):
        try:
            from map_autocomplete import get_autocomplete_index

            legacy = get_autocomplete_index(conn)
            stats["legacy_autocomplete_entries"] = len(legacy)
        except Exception:
            logger.warning("agent warm: legacy autocomplete index failed", exc_info=True)

    if WARM_TOPOLOGY:
        try:
            from topology_graph import load_master_digraph

            graph = load_master_digraph()
            stats["topology_nodes"] = int(graph.number_of_nodes())
            stats["topology_edges"] = int(graph.number_of_edges())
        except Exception:
            logger.warning("agent warm: topology preload failed", exc_info=True)

    stats["elapsed_sec"] = round(time.time() - float(stats["started_at"]), 2)
    _WARM_STATS = stats
    logger.info("agent reference caches warmed: %s", stats)
    return stats


def start_warm_agent_caches(connect_fn) -> None:
    """Background warmup using a fresh pooled connection."""

    def _run() -> None:
        try:
            conn = connect_fn()
            try:
                warm_agent_caches(conn)
            finally:
                conn.close()
        except Exception:
            logger.warning("agent warm thread failed", exc_info=True)

    threading.Thread(target=_run, name="agent-warmup", daemon=True).start()
