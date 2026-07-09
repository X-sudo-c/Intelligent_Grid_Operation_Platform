"""In-process request metrics for APM widget (FR-018)."""

from __future__ import annotations

import re
import statistics
import time
from collections import defaultdict, deque
from threading import Lock

_lock = Lock()
_latencies_ms: deque[float] = deque(maxlen=500)
_route_latencies: dict[str, deque[float]] = defaultdict(lambda: deque(maxlen=200))
_error_count = 0
_request_count = 0
_last_kafka_ingest_at: float | None = None

_UUID_RE = re.compile(
    r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}",
    re.I,
)


def normalize_route(method: str, path: str) -> str:
    """Collapse UUIDs and numeric ids for per-route latency grouping."""
    p = _UUID_RE.sub(":id", path)
    p = re.sub(r"/\d+(?=/)", "/:n", p)
    p = re.sub(r"/\d+$", "/:n", p)
    return f"{method.upper()} {p}"


def _route_category(route: str) -> str:
    upper = route.upper()
    if " /API/V1/HEALTH/" in f" {upper}" or " /API/V1/OPS/BADGES" in f" {upper}":
        return "health"
    if "/PORTAL/AI/" in upper:
        return "copilot"
    if "/MAP/" in upper:
        return "map"
    return "api"


def _percentile(samples: list[float], pct: float) -> float:
    if not samples:
        return 0.0
    if len(samples) == 1:
        return float(samples[0])
    ordered = sorted(samples)
    idx = min(len(ordered) - 1, int(len(ordered) * pct))
    return float(ordered[idx])


def record_request(
    duration_ms: float,
    is_error: bool = False,
    *,
    route: str | None = None,
) -> None:
    global _error_count, _request_count
    with _lock:
        _latencies_ms.append(duration_ms)
        _request_count += 1
        if is_error:
            _error_count += 1
        if route:
            _route_latencies[route].append(duration_ms)


def record_kafka_ingest() -> None:
    global _last_kafka_ingest_at
    with _lock:
        _last_kafka_ingest_at = time.time()


def _route_stats(route: str, samples: list[float]) -> dict:
    return {
        "route": route,
        "category": _route_category(route),
        "count": len(samples),
        "latency_p50_ms": round(_percentile(samples, 0.50), 2),
        "latency_p95_ms": round(_percentile(samples, 0.95), 2),
    }


def snapshot() -> dict:
    with _lock:
        samples = list(_latencies_ms)
        route_samples = {route: list(vals) for route, vals in _route_latencies.items()}
        total = _request_count
        errors = _error_count
        kafka_at = _last_kafka_ingest_at

    p50 = statistics.median(samples) if samples else 0.0
    p95 = _percentile(samples, 0.95)

    by_category: dict[str, list[float]] = {
        "health": [],
        "copilot": [],
        "map": [],
        "api": [],
    }
    route_rows: list[dict] = []
    for route, route_vals in route_samples.items():
        if not route_vals:
            continue
        route_rows.append(_route_stats(route, route_vals))
        by_category[_route_category(route)].extend(route_vals)

    route_rows.sort(
        key=lambda row: (float(row["latency_p95_ms"]), int(row["count"])),
        reverse=True,
    )

    copilot_p95 = _percentile(by_category["copilot"], 0.95)
    map_p95 = _percentile(by_category["map"], 0.95)
    api_p95 = _percentile(by_category["api"], 0.95)
    health_p95 = _percentile(by_category["health"], 0.95)

    # Status reflects user-facing latency (exclude health poll noise).
    interactive_samples = (
        by_category["copilot"] + by_category["map"] + by_category["api"]
    )
    interactive_p95 = _percentile(interactive_samples, 0.95)

    error_rate = (errors / total * 100.0) if total else 0.0
    status = "green"
    if interactive_p95 > 500 or error_rate > 5:
        status = "red"
    elif interactive_p95 > 200 or error_rate > 1:
        status = "amber"

    return {
        "status": status,
        "request_count": total,
        "error_count": errors,
        "error_rate_pct": round(error_rate, 2),
        "latency_p50_ms": round(p50, 2),
        "latency_p95_ms": round(p95, 2),
        "latency_p95_interactive_ms": round(interactive_p95, 2),
        "latency_p95_copilot_ms": round(copilot_p95, 2),
        "latency_p95_map_ms": round(map_p95, 2),
        "latency_p95_api_ms": round(api_p95, 2),
        "latency_p95_health_ms": round(health_p95, 2),
        "slowest_routes": route_rows[:8],
        "last_kafka_ingest_at": kafka_at,
    }
