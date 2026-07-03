"""LLM provider abstraction for agent orchestration."""

from __future__ import annotations

import json
import os
import time
from typing import Any

import requests


def llm_configured() -> bool:
    return bool(os.getenv("GIOP_LLM_API_KEY") or os.getenv("OPENAI_API_KEY"))


def llm_base_url() -> str:
    return (os.getenv("GIOP_LLM_BASE_URL") or "https://api.openai.com/v1").rstrip("/")


def llm_model() -> str:
    return os.getenv("GIOP_LLM_MODEL") or "gpt-4o-mini"


def _llm_temperature() -> float:
    try:
        return float(os.getenv("GIOP_LLM_TEMPERATURE", "0.2"))
    except ValueError:
        return 0.2


def _llm_timeout() -> int:
    try:
        return max(5, int(os.getenv("GIOP_LLM_TIMEOUT_SEC", "60")))
    except ValueError:
        return 60


# Cache the reachability probe so status polling never hammers the provider.
_HEALTH_TTL_SEC = 60
_health_cache: dict[str, Any] = {"ts": 0.0, "value": None}


def llm_health(*, force: bool = False) -> dict[str, Any]:
    """Lightweight, cached provider reachability check (GET /models)."""
    now = time.time()
    cached = _health_cache["value"]
    if not force and cached is not None and now - float(_health_cache["ts"]) < _HEALTH_TTL_SEC:
        return cached

    base = llm_base_url()
    model = llm_model()
    api_key = os.getenv("GIOP_LLM_API_KEY") or os.getenv("OPENAI_API_KEY")
    result: dict[str, Any] = {
        "configured": bool(api_key),
        "base_url": base,
        "model": model,
        "reachable": False,
        "error": None,
    }
    if not api_key:
        result["error"] = "No API key (GIOP_LLM_API_KEY)."
        _health_cache.update(ts=now, value=result)
        return result

    headers = {"Authorization": f"Bearer {api_key}"}
    workspace_id = (
        os.getenv("GIOP_LLM_WORKSPACE_ID") or os.getenv("DASHSCOPE_WORKSPACE_ID") or ""
    ).strip()
    if workspace_id:
        headers["X-DashScope-Workspace"] = workspace_id
    try:
        resp = requests.get(f"{base}/models", headers=headers, timeout=8)
        if resp.status_code < 400:
            result["reachable"] = True
        else:
            detail = resp.text[:200]
            try:
                err = resp.json().get("error") or {}
                detail = err.get("message") or detail
            except Exception:
                pass
            result["error"] = f"HTTP {resp.status_code}: {detail}"
    except requests.RequestException as exc:
        result["error"] = f"{type(exc).__name__}: {exc}"
    _health_cache.update(ts=now, value=result)
    return result


def _deterministic_fallback(
    messages: list[dict[str, str]], *, reason: str = "LLM not configured"
) -> dict[str, Any]:
    """No-LLM answer assembled from context/tool output so the copilot never dies."""
    user = next((m["content"] for m in reversed(messages) if m["role"] == "user"), "")
    for msg in reversed(messages):
        if msg.get("role") == "tool":
            snippet = (msg.get("content") or "")[:1500]
            return {
                "content": (
                    f"[GIOP agent — {reason}] Tool results available. "
                    f"Question context: {user[:400]}\n\nLatest tool output:\n{snippet}"
                ),
                "model": "deterministic-fallback",
                "tools_used": [],
                "raw": {"content": snippet},
            }
    return {
        "content": f"[GIOP agent — {reason}] Based on available data: {user[:500]}",
        "model": "deterministic-fallback",
        "tools_used": [],
        "raw": {"content": user[:500]},
    }


def complete_chat(
    messages: list[dict[str, str]],
    *,
    tools: list[dict[str, Any]] | None = None,
    model: str | None = None,
    max_tokens: int = 1024,
) -> dict[str, Any]:
    """Call OpenAI-compatible chat completions API."""
    api_key = os.getenv("GIOP_LLM_API_KEY") or os.getenv("OPENAI_API_KEY")
    base_url = llm_base_url()
    model = model or llm_model()

    if not api_key:
        return _deterministic_fallback(messages)

    payload: dict[str, Any] = {
        "model": model,
        "messages": messages,
        "max_tokens": max_tokens,
        "temperature": _llm_temperature(),
    }
    if tools:
        payload["tools"] = tools
        payload["tool_choice"] = "auto"

    headers: dict[str, str] = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }
    workspace_id = (os.getenv("GIOP_LLM_WORKSPACE_ID") or os.getenv("DASHSCOPE_WORKSPACE_ID") or "").strip()
    if workspace_id:
        headers["X-DashScope-Workspace"] = workspace_id

    try:
        resp = requests.post(
            f"{base_url}/chat/completions",
            headers=headers,
            json=payload,
            timeout=_llm_timeout(),
        )
    except requests.RequestException:
        # Provider unreachable (offline, DNS, timeout) — degrade, don't 500.
        return _deterministic_fallback(messages, reason="LLM unreachable")
    if resp.status_code >= 400:
        detail = resp.text[:500]
        try:
            err_body = resp.json().get("error") or {}
            code = err_body.get("code") or err_body.get("type") or ""
            message = err_body.get("message") or detail
            detail = f"{code}: {message}" if code else message
        except Exception:
            pass
        if resp.status_code in (401, 402, 403) or resp.status_code >= 500:
            # Bad key / unpurchased model / provider outage — the copilot
            # must still answer from tools instead of crashing the request.
            return _deterministic_fallback(messages, reason=f"LLM error: {detail[:160]}")
        resp.reason = detail
    resp.raise_for_status()
    data = resp.json()
    choice = data["choices"][0]["message"]
    tools_used = []
    if choice.get("tool_calls"):
        tools_used = [tc["function"]["name"] for tc in choice["tool_calls"]]

    return {
        "content": choice.get("content") or "",
        "model": data.get("model") or model,
        "tools_used": tools_used,
        "raw": choice,
    }
