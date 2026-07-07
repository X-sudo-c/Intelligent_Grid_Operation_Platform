"""Ephemeral copilot progress steps (Redis) for portal loading UI."""

from __future__ import annotations

import time
import uuid
from typing import Any

from redis_cache import get_json, set_json

_PROGRESS_TTL_SEC = 120

_TOOL_LABELS: dict[str, str] = {
    "resolve_place": "Resolving place name",
    "resolve_territory": "Looking up district boundary",
    "asset_inventory_counts": "Counting assets in territory",
    "territory_network_summary": "Building network inventory summary",
    "list_assets_in_territory": "Listing assets",
    "pan_map": "Preparing map view",
    "topology_dq_summary": "Loading data quality summary",
    "staging_summary": "Loading staging summary",
    "list_work_orders_in_view": "Finding work orders",
    "trace_feeder": "Tracing feeder network",
    "trace_downstream_path": "Tracing downstream path",
}


def new_request_id() -> str:
    return uuid.uuid4().hex


def _key(request_id: str) -> str:
    return f"giop:copilot:progress:{request_id}"


def push_progress(
    request_id: str | None,
    label: str,
    *,
    detail: str | None = None,
    status: str = "active",
) -> None:
    if not request_id or not label.strip():
        return
    steps: list[dict[str, Any]] = get_json(_key(request_id)) or []
    entry = {
        "label": label.strip(),
        "detail": (detail or "").strip() or None,
        "status": status,
        "ts": time.time(),
    }
    if steps and steps[-1].get("label") == entry["label"] and steps[-1].get("detail") == entry["detail"]:
        return
    steps.append(entry)
    set_json(_key(request_id), steps[-12:], ttl_sec=_PROGRESS_TTL_SEC)


def complete_progress(request_id: str | None, label: str = "Done") -> None:
    push_progress(request_id, label, status="done")


def tool_progress(request_id: str | None, tool_name: str) -> None:
    label = _TOOL_LABELS.get(tool_name) or f"Running {tool_name.replace('_', ' ')}"
    push_progress(request_id, label)


def get_progress(request_id: str) -> list[dict[str, Any]]:
    steps = get_json(_key(request_id))
    return steps if isinstance(steps, list) else []
