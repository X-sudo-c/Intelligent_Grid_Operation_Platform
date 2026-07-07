"""Redis cache for endpoint-fix district AI run progress (poll-friendly)."""

from __future__ import annotations

import os
from typing import Any

from redis_cache import delete_key, get_json, set_json

RUN_KEY_PREFIX = "endpoint_fix_ai_run:"
ACTIVE_KEY_PREFIX = "endpoint_fix_ai_run:active:"
RUN_CACHE_TTL_SEC = int(os.getenv("REDIS_ENDPOINT_FIX_RUN_TTL_SEC", "7200"))


def _run_key(run_id: str) -> str:
    return f"{RUN_KEY_PREFIX}{run_id}"


def _active_key(district: str, data_tier: str = "gis") -> str:
    tier = (data_tier or "gis").strip() or "gis"
    return f"{ACTIVE_KEY_PREFIX}{tier}:{(district or '').strip()}"


def get_cached_endpoint_fix_ai_run(run_id: str) -> dict[str, Any] | None:
    cached = get_json(_run_key(run_id))
    return cached if isinstance(cached, dict) else None


def cache_endpoint_fix_ai_run(run: dict[str, Any]) -> bool:
    run_id = run.get("id")
    if not run_id:
        return False
    ok = set_json(_run_key(str(run_id)), run, RUN_CACHE_TTL_SEC)
    district = (run.get("district") or "").strip()
    data_tier = (run.get("data_tier") or "gis").strip() or "gis"
    if district and run.get("status") == "running":
        set_json(
            _active_key(district, data_tier),
            {"run_id": str(run_id), "district": district, "data_tier": data_tier},
            RUN_CACHE_TTL_SEC,
        )
    elif district and run.get("status") in ("completed", "failed", "cancelled"):
        delete_key(_active_key(district, data_tier))
    return ok


def get_cached_active_run_id(district: str, data_tier: str = "gis") -> str | None:
    district = (district or "").strip()
    if not district:
        return None
    cached = get_json(_active_key(district, data_tier))
    if isinstance(cached, dict):
        run_id = cached.get("run_id")
        return str(run_id) if run_id else None
    return None


def invalidate_endpoint_fix_ai_run(
    run_id: str, district: str | None = None, data_tier: str = "gis"
) -> None:
    delete_key(_run_key(run_id))
    if district:
        delete_key(_active_key(district.strip(), data_tier))
