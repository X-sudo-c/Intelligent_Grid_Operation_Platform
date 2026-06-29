"""Short-lived voice copilot session state (follow-ups like "and in Kumasi?")."""

from __future__ import annotations

import uuid
from typing import Any

from redis_cache import get_json, set_json

_SESSION_PREFIX = "giop:voice:session:"
_SESSION_TTL_SEC = int(__import__("os").getenv("VOICE_SESSION_TTL_SEC", "3600"))

# Fallback when Redis is offline (single-process dev).
_memory: dict[str, dict[str, Any]] = {}


def new_session_id() -> str:
    return uuid.uuid4().hex


def load(session_id: str | None) -> dict[str, Any]:
    if not session_id:
        return {}
    key = f"{_SESSION_PREFIX}{session_id}"
    data = get_json(key)
    if isinstance(data, dict):
        return data
    return dict(_memory.get(session_id) or {})


def save(session_id: str, state: dict[str, Any]) -> None:
    if not session_id:
        return
    key = f"{_SESSION_PREFIX}{session_id}"
    if not set_json(key, state, ttl_sec=_SESSION_TTL_SEC):
        _memory[session_id] = state


def merge(session_id: str | None, patch: dict[str, Any]) -> dict[str, Any]:
    state = load(session_id)
    state.update({k: v for k, v in patch.items() if v is not None})
    if session_id:
        save(session_id, state)
    return state
