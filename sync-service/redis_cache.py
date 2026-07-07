"""Optional Redis cache, locks, idempotency, and webhook dedup for sync-service."""

from __future__ import annotations

import base64
import gzip
import hashlib
import json
import os
import threading
import uuid
from contextlib import contextmanager
from typing import Any, Callable, Iterator, TypeVar

REDIS_URL = os.getenv("REDIS_URL", "redis://127.0.0.1:6379/0")
CACHE_TTL_SEC = int(os.getenv("REDIS_CACHE_TTL_SEC", "600"))
GRAPH_CHUNK_CACHE_TTL_SEC = int(os.getenv("REDIS_GRAPH_CHUNK_CACHE_TTL_SEC", "1800"))
REFERENCE_LAYERS_CACHE_TTL_SEC = int(os.getenv("REDIS_REFERENCE_LAYERS_CACHE_TTL_SEC", "900"))
OPS_CACHE_TTL_SEC = int(os.getenv("REDIS_OPS_CACHE_TTL_SEC", "60"))
TOPOLOGY_SNAPSHOT_CACHE_TTL_SEC = int(
    os.getenv("REDIS_TOPOLOGY_SNAPSHOT_CACHE_TTL_SEC", "600")
)
SCHEMATIC_CACHE_TTL_SEC = int(os.getenv("REDIS_SCHEMATIC_CACHE_TTL_SEC", "900"))
CIM_PREVIEW_TTL_SEC = int(os.getenv("REDIS_CIM_PREVIEW_TTL_SEC", "300"))
RULES_CACHE_TTL_SEC = int(os.getenv("REDIS_RULES_CACHE_TTL_SEC", "3600"))
LOCK_TTL_SEC = int(os.getenv("REDIS_LOCK_TTL_SEC", "600"))
WEBHOOK_DEDUP_TTL_SEC = int(os.getenv("REDIS_WEBHOOK_DEDUP_TTL_SEC", "86400"))
IDEMPOTENCY_TTL_SEC = int(os.getenv("REDIS_IDEMPOTENCY_TTL_SEC", "86400"))
PLACE_GEOCODE_CACHE_TTL_SEC = int(os.getenv("PLACE_GEOCODE_CACHE_TTL_SEC", "86400"))
PLACE_RESOLVE_CACHE_TTL_SEC = int(os.getenv("PLACE_RESOLVE_CACHE_TTL_SEC", "3600"))
MAP_SEARCH_CACHE_TTL_SEC = int(os.getenv("MAP_SEARCH_CACHE_TTL_SEC", "300"))
REDIS_MAX_CONNECTIONS = int(os.getenv("REDIS_MAX_CONNECTIONS", "32"))
REDIS_HEALTH_CHECK_INTERVAL = int(os.getenv("REDIS_HEALTH_CHECK_INTERVAL", "30"))
REDIS_DELETE_BATCH_SIZE = int(os.getenv("REDIS_DELETE_BATCH_SIZE", "500"))
REDIS_SCAN_COUNT = int(os.getenv("REDIS_SCAN_COUNT", "500"))
REDIS_COMPRESS_MIN_BYTES = int(os.getenv("REDIS_COMPRESS_MIN_BYTES", "8192"))
REDIS_COMPRESS_LEVEL = int(os.getenv("REDIS_COMPRESS_LEVEL", "6"))
REDIS_SINGLEFLIGHT_WAIT_SEC = float(os.getenv("REDIS_SINGLEFLIGHT_WAIT_SEC", "45"))

_KEY_PREFIX = "giop:"
_client: Any = None
_pool: Any = None
_client_lock = threading.Lock()
_last_error: str | None = None
_singleflight_lock = threading.Lock()
_singleflight_events: dict[str, threading.Event] = {}

T = TypeVar("T")


def _connect() -> Any | None:
    global _client, _pool, _last_error
    if not REDIS_URL:
        return None
    with _client_lock:
        if _client is not None:
            return _client
        try:
            import redis

            if _pool is None:
                _pool = redis.ConnectionPool.from_url(
                    REDIS_URL,
                    decode_responses=True,
                    max_connections=REDIS_MAX_CONNECTIONS,
                    socket_connect_timeout=float(os.getenv("REDIS_CONNECT_TIMEOUT", "2")),
                    socket_timeout=float(os.getenv("REDIS_SOCKET_TIMEOUT", "2")),
                    health_check_interval=REDIS_HEALTH_CHECK_INTERVAL,
                    retry_on_timeout=True,
                )
            client = redis.Redis(connection_pool=_pool)
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
    payload: dict[str, Any] = {
        "enabled": is_enabled(),
        "available": available,
        "url": REDIS_URL if is_enabled() else None,
        "cache_ttl_sec": CACHE_TTL_SEC,
        "max_connections": REDIS_MAX_CONNECTIONS,
        "delete_batch_size": REDIS_DELETE_BATCH_SIZE,
        "compress_min_bytes": REDIS_COMPRESS_MIN_BYTES,
        "singleflight_wait_sec": REDIS_SINGLEFLIGHT_WAIT_SEC,
        "last_error": None if available else _last_error,
    }
    if available:
        payload.update(cache_stats())
    return payload


def cache_stats() -> dict[str, Any]:
    """Lightweight Redis observability for /health/metrics."""
    client = _connect()
    if client is None:
        return {}
    try:
        memory = client.info("memory")
        stats = client.info("stats")
        return {
            "keys": int(client.dbsize()),
            "used_memory_human": memory.get("used_memory_human"),
            "maxmemory_human": memory.get("maxmemory_human"),
            "maxmemory_policy": memory.get("maxmemory_policy"),
            "evicted_keys": int(stats.get("evicted_keys", 0)),
            "keyspace_hits": int(stats.get("keyspace_hits", 0)),
            "keyspace_misses": int(stats.get("keyspace_misses", 0)),
            "pool_max_connections": REDIS_MAX_CONNECTIONS,
        }
    except Exception as exc:
        global _last_error
        _last_error = str(exc)
        _reset_client()
        return {"stats_error": str(exc)}


def _decode_cache_raw(raw: str) -> Any:
    if raw.startswith('{"__giop_enc"'):
        wrapper = json.loads(raw)
        if wrapper.get("__giop_enc") == "gzip" and isinstance(wrapper.get("p"), str):
            decoded = gzip.decompress(base64.b64decode(wrapper["p"]))
            return json.loads(decoded)
    return json.loads(raw)


def _encode_cache_value(value: Any) -> str:
    payload = json.dumps(value, separators=(",", ":"), default=str)
    raw_bytes = payload.encode("utf-8")
    if len(raw_bytes) < REDIS_COMPRESS_MIN_BYTES:
        return payload
    compressed = gzip.compress(raw_bytes, compresslevel=REDIS_COMPRESS_LEVEL)
    if len(compressed) >= len(raw_bytes):
        return payload
    return json.dumps(
        {"__giop_enc": "gzip", "p": base64.b64encode(compressed).decode("ascii")},
        separators=(",", ":"),
    )


def get_json(key: str) -> Any | None:
    client = _connect()
    if client is None:
        return None
    try:
        raw = client.get(key)
        if raw is None:
            return None
        return _decode_cache_raw(raw)
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
        payload = _encode_cache_value(value)
        client.setex(key, ttl_sec or CACHE_TTL_SEC, payload)
        return True
    except Exception as exc:
        global _last_error
        _last_error = str(exc)
        _reset_client()
        return False


def cached_json(key: str, builder: Callable[[], T], ttl_sec: int | None = None) -> T:
    """Read-through JSON cache with single-flight coalescing on cache miss."""
    cached = get_json(key)
    if cached is not None:
        return cached

    with _singleflight_lock:
        if key in _singleflight_events:
            event = _singleflight_events[key]
            is_leader = False
        else:
            event = threading.Event()
            _singleflight_events[key] = event
            is_leader = True

    if not is_leader:
        event.wait(timeout=REDIS_SINGLEFLIGHT_WAIT_SEC)
        cached = get_json(key)
        if cached is not None:
            return cached
        result = builder()
        set_json(key, result, ttl_sec)
        return result

    try:
        result = builder()
        set_json(key, result, ttl_sec)
        return result
    finally:
        with _singleflight_lock:
            done = _singleflight_events.pop(key, None)
        if done is not None:
            done.set()


def delete_key(key: str) -> bool:
    client = _connect()
    if client is None:
        return False
    try:
        return bool(client.delete(key))
    except Exception as exc:
        global _last_error
        _last_error = str(exc)
        _reset_client()
        return False


def _unlink_batch(client: Any, keys: list[str]) -> int:
    if not keys:
        return 0
    pipe = client.pipeline(transaction=False)
    for key in keys:
        pipe.unlink(key)
    return int(sum(pipe.execute()))


def delete_pattern(pattern: str) -> int:
    """Delete keys matching pattern using SCAN + pipelined UNLINK."""
    client = _connect()
    if client is None:
        return 0
    deleted = 0
    batch: list[str] = []
    try:
        for key in client.scan_iter(match=pattern, count=REDIS_SCAN_COUNT):
            batch.append(key)
            if len(batch) >= REDIS_DELETE_BATCH_SIZE:
                deleted += _unlink_batch(client, batch)
                batch = []
        if batch:
            deleted += _unlink_batch(client, batch)
        return deleted
    except Exception as exc:
        global _last_error
        _last_error = str(exc)
        _reset_client()
        return deleted


def delete_patterns(patterns: list[str]) -> int:
    """Invalidate multiple key patterns with one connection and batched UNLINK."""
    return sum(delete_pattern(pattern) for pattern in patterns)


def invalidate_topology_cache() -> int:
    """Map, graph, topology, master assets, schematics."""
    return delete_patterns(
        [
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
            f"{_KEY_PREFIX}gis:import:*",
            f"{_KEY_PREFIX}reference:layers",
        ]
    )


def invalidate_staging_cache() -> int:
    """Staging asset lists and cell queries that include staging."""
    return delete_patterns(
        [
            f"{_KEY_PREFIX}assets:staging:*",
            f"{_KEY_PREFIX}assets:detail:*",
            f"{_KEY_PREFIX}map:nodes:*",
            f"{_KEY_PREFIX}h3:cells:*",
        ]
    )


def invalidate_h3_cache() -> int:
    return delete_patterns(
        [
            f"{_KEY_PREFIX}h3:coverage:*",
            f"{_KEY_PREFIX}h3:grid:*",
            f"{_KEY_PREFIX}h3:assignments:*",
        ]
    )


def invalidate_ops_cache() -> int:
    """Dashboard lists: DQ, conflicts, exports, nav badges."""
    return delete_patterns(
        [
            f"{_KEY_PREFIX}dq:*",
            f"{_KEY_PREFIX}conflicts:*",
            f"{_KEY_PREFIX}exports:list:*",
            f"{_KEY_PREFIX}ops:*",
        ]
    )


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


def reference_layers_key() -> str:
    return f"{_KEY_PREFIX}reference:layers"


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


def assets_staging_key(
    include_rejected: bool,
    submitted_by: str | None,
    limit: int | None = None,
    queue: str | None = None,
) -> str:
    who = submitted_by or "*"
    cap = limit if limit is not None else "*"
    q = queue or "*"
    return f"{_KEY_PREFIX}assets:staging:{int(include_rejected)}:{who}:{cap}:{q}"


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


def geocode_places_key(query: str, limit: int) -> str:
    normalized = " ".join((query or "").strip().lower().split())
    digest = hashlib.sha256(normalized.encode("utf-8")).hexdigest()[:16]
    return f"{_KEY_PREFIX}geocode:{limit}:{digest}"


def map_search_key(query: str, limit: int, kinds: str | None) -> str:
    normalized = " ".join((query or "").strip().lower().split())
    digest = hashlib.sha256(normalized.encode("utf-8")).hexdigest()[:16]
    kind_tag = kinds or "*"
    return f"{_KEY_PREFIX}map:search:{limit}:{kind_tag}:{digest}"


def place_resolve_key(query: str, *, geocode_enabled: bool) -> str:
    normalized = " ".join((query or "").strip().lower().split())
    digest = hashlib.sha256(normalized.encode("utf-8")).hexdigest()[:16]
    return f"{_KEY_PREFIX}place:resolve:{int(geocode_enabled)}:{digest}"


def graph_parity_key() -> str:
    return f"{_KEY_PREFIX}graph:parity"


def dq_summary_key(tier: str | None = None) -> str:
    return f"{_KEY_PREFIX}dq:summary:{tier or 'all'}"


def nav_badges_key() -> str:
    return f"{_KEY_PREFIX}ops:badges"


def topology_dq_summary_key(tier: str = "master", mode: str = "snapshot") -> str:
    """Under the topology: namespace so topology invalidation clears it."""
    return f"{_KEY_PREFIX}topology:dq:summary:{tier}:{mode}"


def topology_scan_progress_key(run_id: str) -> str:
    return f"{_KEY_PREFIX}topology:scan:progress:{run_id}"


def topology_scan_active_key() -> str:
    return f"{_KEY_PREFIX}topology:scan:active"


TOPOLOGY_SCAN_LOCK_NAME = "topology_master_scan"
TOPOLOGY_SCAN_LOCK_TTL_SEC = int(os.getenv("TOPOLOGY_SCAN_LOCK_TTL_SEC", "7200"))


def gis_import_summary_key(district: str | None = None) -> str:
    return f"{_KEY_PREFIX}gis:import:summary:{district or 'all'}"


def dq_rules_key() -> str:
    return f"{_KEY_PREFIX}dq:rules"


def dq_exceptions_key(
    status: str | None,
    severity: str | None,
    domain: str | None,
    record_mrid: str | None,
    limit: int,
    queue: str | None = None,
    offset: int = 0,
) -> str:
    return (
        f"{_KEY_PREFIX}dq:exceptions:"
        f"{status or '*'}:{severity or '*'}:{domain or '*'}:{record_mrid or '*'}:{limit}:"
        f"{queue or '*'}:{offset}"
    )


def dq_queue_key(
    validation: str | None,
    exception_status: str | None,
    severity: str | None,
    domain: str | None,
    limit: int,
    offset: int = 0,
    duplicates_only: bool = False,
) -> str:
    return (
        f"{_KEY_PREFIX}dq:queue:"
        f"{validation or '*'}:{exception_status or '*'}:{severity or '*'}:{domain or '*'}:"
        f"{'dup' if duplicates_only else '-'}:{limit}:{offset}"
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


def lock_held(name: str) -> bool:
    client = _connect()
    if client is None:
        return False
    key = f"{_KEY_PREFIX}lock:{name}"
    try:
        return bool(client.exists(key))
    except Exception as exc:
        global _last_error
        _last_error = str(exc)
        _reset_client()
        return False


def force_release_lock(name: str) -> None:
    client = _connect()
    if client is None:
        return
    key = f"{_KEY_PREFIX}lock:{name}"
    try:
        client.delete(key)
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
