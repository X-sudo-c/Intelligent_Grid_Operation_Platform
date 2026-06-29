"""Optional Redis cache, locks, idempotency, and webhook dedup for sync-service."""

from __future__ import annotations

import hashlib
import json
import os
import threading
import uuid
from contextlib import contextmanager
from typing import Any, Callable, Iterator, TypeVar

REDIS_URL = os.getenv("REDIS_URL", "redis://127.0.0.1:6379/0")
CACHE_TTL_SEC = int(os.getenv("REDIS_CACHE_TTL_SEC", "600"))
OPS_CACHE_TTL_SEC = int(os.getenv("REDIS_OPS_CACHE_TTL_SEC", "60"))
SCHEMATIC_CACHE_TTL_SEC = int(os.getenv("REDIS_SCHEMATIC_CACHE_TTL_SEC", "900"))
CIM_PREVIEW_TTL_SEC = int(os.getenv("REDIS_CIM_PREVIEW_TTL_SEC", "300"))
RULES_CACHE_TTL_SEC = int(os.getenv("REDIS_RULES_CACHE_TTL_SEC", "3600"))
LOCK_TTL_SEC = int(os.getenv("REDIS_LOCK_TTL_SEC", "600"))
WEBHOOK_DEDUP_TTL_SEC = int(os.getenv("REDIS_WEBHOOK_DEDUP_TTL_SEC", "86400"))
IDEMPOTENCY_TTL_SEC = int(os.getenv("REDIS_IDEMPOTENCY_TTL_SEC", "86400"))

_KEY_PREFIX = "giop:"
_client: Any = None
_client_lock = threading.Lock()
_last_error: str | None = None

T = TypeVar("T")


def _connect() -> Any | None:
    global _client, _last_error
    if not REDIS_URL:
        return None
    with _client_lock:
        if _client is not None:
            return _client
        try:
            import redis

            client = redis.from_url(
                REDIS_URL,
                decode_responses=True,
                socket_connect_timeout=float(os.getenv("REDIS_CONNECT_TIMEOUT", "2")),
                socket_timeout=float(os.getenv("REDIS_SOCKET_TIMEOUT", "2")),
            )
            client.ping()
            _client = client
            _last_error = None
            return _client
        except Exception as exc:
            _last_error = str(exc)
            _client = None
            return None


def is_enabled() -> bool:
    return bool(REDIS_URL)


def is_available() -> bool:
    client = _connect()
    if client is None:
        return False
    try:
        client.ping()
        return True
    except Exception as exc:
        global _last_error
        _last_error = str(exc)
        _reset_client()
        return False


def _reset_client() -> None:
    global _client
    with _client_lock:
        _client = None


def status() -> dict[str, Any]:
    available = is_available()
    return {
        "enabled": is_enabled(),
        "available": available,
        "url": REDIS_URL if is_enabled() else None,
        "cache_ttl_sec": CACHE_TTL_SEC,
        "last_error": None if available else _last_error,
    }


def get_json(key: str) -> Any | None:
    client = _connect()
    if client is None:
        return None
    try:
        raw = client.get(key)
        if raw is None:
            return None
        return json.loads(raw)
    except Exception as exc:
        global _last_error
        _last_error = str(exc)
        _reset_client()
        return None


def set_json(key: str, value: Any, ttl_sec: int | None = None) -> bool:
    client = _connect()
    if client is None:
        return False
    try:
        payload = json.dumps(value, separators=(",", ":"), default=str)
        client.setex(key, ttl_sec or CACHE_TTL_SEC, payload)
        return True
    except Exception as exc:
        global _last_error
        _last_error = str(exc)
        _reset_client()
        return False


def cached_json(key: str, builder: Callable[[], T], ttl_sec: int | None = None) -> T:
    """Read-through JSON cache; falls back to builder when Redis is unavailable."""
    cached = get_json(key)
    if cached is not None:
        return cached
    result = builder()
    set_json(key, result, ttl_sec)
    return result


def delete_pattern(pattern: str) -> int:
    client = _connect()
    if client is None:
        return 0
    deleted = 0
    try:
        for key in client.scan_iter(match=pattern, count=200):
            deleted += int(client.delete(key))
        return deleted
    except Exception as exc:
        global _last_error
        _last_error = str(exc)
        _reset_client()
        return deleted


def invalidate_topology_cache() -> int:
    """Map, graph, topology, master assets, schematics."""
    total = 0
    for pattern in (
        f"{_KEY_PREFIX}chunk:*",
        f"{_KEY_PREFIX}trace:*",
        f"{_KEY_PREFIX}map:nodes:*",
        f"{_KEY_PREFIX}h3:cells:*",
        f"{_KEY_PREFIX}conn:bulk:*",
        f"{_KEY_PREFIX}conn:node:*",
        f"{_KEY_PREFIX}topology:*",
        f"{_KEY_PREFIX}assets:master:*",
        f"{_KEY_PREFIX}assets:detail:*",
        f"{_KEY_PREFIX}schematic:*",
        f"{_KEY_PREFIX}graph:parity",
        f"{_KEY_PREFIX}cim:preview:*",
    ):
        total += delete_pattern(pattern)
    return total


def invalidate_staging_cache() -> int:
    """Staging asset lists and cell queries that include staging."""
    total = 0
    for pattern in (
        f"{_KEY_PREFIX}assets:staging:*",
        f"{_KEY_PREFIX}assets:detail:*",
        f"{_KEY_PREFIX}map:nodes:*",
        f"{_KEY_PREFIX}h3:cells:*",
    ):
        total += delete_pattern(pattern)
    return total


def invalidate_h3_cache() -> int:
    total = 0
    for pattern in (
        f"{_KEY_PREFIX}h3:coverage:*",
        f"{_KEY_PREFIX}h3:grid:*",
        f"{_KEY_PREFIX}h3:assignments:*",
    ):
        total += delete_pattern(pattern)
    return total


def invalidate_ops_cache() -> int:
    """Dashboard lists: DQ, conflicts, exports, nav badges."""
    total = 0
    for pattern in (
        f"{_KEY_PREFIX}dq:*",
        f"{_KEY_PREFIX}conflicts:*",
        f"{_KEY_PREFIX}exports:list:*",
        f"{_KEY_PREFIX}ops:*",
    ):
        total += delete_pattern(pattern)
    return total


def invalidate_after_promote() -> None:
    invalidate_topology_cache()
    invalidate_staging_cache()
    invalidate_ops_cache()


def invalidate_after_staging_write() -> None:
    invalidate_staging_cache()
    invalidate_ops_cache()


# --------------------------------------------------------------------------- #
# Cache key builders
# --------------------------------------------------------------------------- #
def h3_cells_key(
    cells: list[str],
    res: int,
    limit: int,
    include_staging: bool,
) -> str:
    digest = hashlib.sha256(",".join(sorted(cells)).encode("utf-8")).hexdigest()[:24]
    return f"{_KEY_PREFIX}h3:cells:{res}:{limit}:{int(include_staging)}:{digest}"


def bulk_connections_key(mrids: list[str], limit_per_node: int) -> str:
    digest = hashlib.sha256(",".join(sorted(mrids)).encode("utf-8")).hexdigest()[:32]
    return f"{_KEY_PREFIX}conn:bulk:{limit_per_node}:{digest}"


def node_connections_key(mrid: str, limit: int) -> str:
    return f"{_KEY_PREFIX}conn:node:{mrid}:{limit}"


def topology_health_key() -> str:
    return f"{_KEY_PREFIX}topology:health"


def topology_gaps_key(
    limit: int,
    west: float | None,
    south: float | None,
    east: float | None,
    north: float | None,
) -> str:
    if None in (west, south, east, north):
        return f"{_KEY_PREFIX}topology:gaps:{limit}:global"
    return (
        f"{_KEY_PREFIX}topology:gaps:{limit}:"
        f"{round(west, 4)}:{round(south, 4)}:{round(east, 4)}:{round(north, 4)}"
    )


def topology_impact_key(start_mrid: str, max_nodes: int) -> str:
    return f"{_KEY_PREFIX}topology:impact:{start_mrid}:{max_nodes}"


def graph_chunk_key(
    west: float,
    south: float,
    east: float,
    north: float,
    limit: int,
    edge_limit: int,
    start_mrid: str | None,
) -> str:
    start = start_mrid or ""
    return (
        f"{_KEY_PREFIX}chunk:"
        f"{round(west, 5)}:{round(south, 5)}:{round(east, 5)}:{round(north, 5)}:"
        f"{limit}:{edge_limit}:{start}"
    )


def trace_key(start_mrid: str, scope: str, max_hops: int, max_nodes: int) -> str:
    return f"{_KEY_PREFIX}trace:{scope}:{max_hops}:{max_nodes}:{start_mrid}"


def map_nodes_key(lat: float, lon: float, limit: int, prefer_wired: bool) -> str:
    return (
        f"{_KEY_PREFIX}map:nodes:"
        f"{round(lat, 5)}:{round(lon, 5)}:{limit}:{int(prefer_wired)}"
    )


def assets_master_key(
    west: float, south: float, east: float, north: float, limit: int
) -> str:
    return (
        f"{_KEY_PREFIX}assets:master:"
        f"{round(west, 4)}:{round(south, 4)}:{round(east, 4)}:{round(north, 4)}:{limit}"
    )


def assets_staging_key(include_rejected: bool, submitted_by: str | None) -> str:
    who = submitted_by or "*"
    return f"{_KEY_PREFIX}assets:staging:{int(include_rejected)}:{who}"


def asset_detail_key(mrid: str) -> str:
    return f"{_KEY_PREFIX}assets:detail:{mrid}"


def schematic_key(mrid: str, depth: int) -> str:
    return f"{_KEY_PREFIX}schematic:{mrid}:{depth}"


def cim_preview_key(
    limit: int,
    west: float | None,
    south: float | None,
    east: float | None,
    north: float | None,
) -> str:
    if None in (west, south, east, north):
        return f"{_KEY_PREFIX}cim:preview:{limit}:global"
    return (
        f"{_KEY_PREFIX}cim:preview:{limit}:"
        f"{round(west, 4)}:{round(south, 4)}:{round(east, 4)}:{round(north, 4)}"
    )


def h3_coverage_key(
    west: float,
    south: float,
    east: float,
    north: float,
    res: int,
    include_reference: bool,
) -> str:
    return (
        f"{_KEY_PREFIX}h3:coverage:{res}:{int(include_reference)}:"
        f"{round(west, 4)}:{round(south, 4)}:{round(east, 4)}:{round(north, 4)}"
    )


def h3_grid_key(
    west: float,
    south: float,
    east: float,
    north: float,
    res: int,
    max_cells: int,
) -> str:
    return (
        f"{_KEY_PREFIX}h3:grid:{res}:{max_cells}:"
        f"{round(west, 4)}:{round(south, 4)}:{round(east, 4)}:{round(north, 4)}"
    )


def h3_assignments_geojson_key(assigned_to: str | None, status: str | None) -> str:
    return f"{_KEY_PREFIX}h3:assignments:{assigned_to or '*'}:{status or '*'}"


def graph_parity_key() -> str:
    return f"{_KEY_PREFIX}graph:parity"


def dq_summary_key() -> str:
    return f"{_KEY_PREFIX}dq:summary"


def nav_badges_key() -> str:
    return f"{_KEY_PREFIX}ops:badges"


def topology_dq_summary_key() -> str:
    """Under the topology: namespace so topology invalidation clears it."""
    return f"{_KEY_PREFIX}topology:dq:summary"


def dq_rules_key() -> str:
    return f"{_KEY_PREFIX}dq:rules"


def dq_exceptions_key(
    status: str | None,
    severity: str | None,
    domain: str | None,
    record_mrid: str | None,
    limit: int,
) -> str:
    return (
        f"{_KEY_PREFIX}dq:exceptions:"
        f"{status or '*'}:{severity or '*'}:{domain or '*'}:{record_mrid or '*'}:{limit}"
    )


def conflicts_key(limit: int) -> str:
    return f"{_KEY_PREFIX}conflicts:{limit}"


def exports_list_key(limit: int) -> str:
    return f"{_KEY_PREFIX}exports:list:{limit}"


def webhook_dedup_key(payload: dict[str, Any]) -> str:
    material = json.dumps(payload, sort_keys=True, default=str)
    digest = hashlib.sha256(material.encode("utf-8")).hexdigest()[:32]
    return f"{_KEY_PREFIX}webhook:{digest}"


def idempotency_key(scope: str, client_key: str) -> str:
    digest = hashlib.sha256(client_key.encode("utf-8")).hexdigest()[:32]
    return f"{_KEY_PREFIX}idem:{scope}:{digest}"


def get_idempotent_response(key: str) -> Any | None:
    return get_json(f"{key}:response")


def store_idempotent_response(key: str, response: Any, ttl_sec: int | None = None) -> None:
    set_json(f"{key}:response", response, ttl_sec or IDEMPOTENCY_TTL_SEC)


def claim_idempotency(key: str, ttl_sec: int | None = None) -> bool:
    """Return True if this is the first time we've seen key within TTL."""
    client = _connect()
    if client is None:
        return True
    try:
        return bool(client.set(key, "1", nx=True, ex=ttl_sec or WEBHOOK_DEDUP_TTL_SEC))
    except Exception as exc:
        global _last_error
        _last_error = str(exc)
        _reset_client()
        return True


def repair_lock_key(mrid: str) -> str:
    return f"repair:{mrid}"


def try_acquire_lock(name: str, ttl_sec: int | None = None) -> str | None:
    client = _connect()
    if client is None:
        return "local"
    token = str(uuid.uuid4())
    key = f"{_KEY_PREFIX}lock:{name}"
    try:
        if client.set(key, token, nx=True, ex=ttl_sec or LOCK_TTL_SEC):
            return token
        return None
    except Exception as exc:
        global _last_error
        _last_error = str(exc)
        _reset_client()
        return "local"


def release_lock(name: str, token: str | None) -> None:
    if not token or token == "local":
        return
    client = _connect()
    if client is None:
        return
    key = f"{_KEY_PREFIX}lock:{name}"
    release_script = """
    if redis.call("get", KEYS[1]) == ARGV[1] then
        return redis.call("del", KEYS[1])
    end
    return 0
    """
    try:
        client.eval(release_script, 1, key, token)
    except Exception as exc:
        global _last_error
        _last_error = str(exc)
        _reset_client()


@contextmanager
def lock(name: str, ttl_sec: int | None = None) -> Iterator[str | None]:
    token = try_acquire_lock(name, ttl_sec=ttl_sec)
    if token is None:
        yield None
        return
    try:
        yield token
    finally:
        release_lock(name, token)
