"""LLM provider abstraction for agent orchestration."""

from __future__ import annotations

import os
import time
from dataclasses import dataclass
from typing import Any, Literal

import requests

LlmProfileName = Literal["copilot", "cleanup"]


@dataclass(frozen=True)
class LlmProfile:
    name: str
    api_key: str | None
    base_url: str
    model: str
    workspace_id: str
    temperature: float
    timeout_sec: int
    max_tool_turns: int

    @property
    def configured(self) -> bool:
        return bool(self.api_key)


def _env_str(name: str, fallback: str = "") -> str:
    return (os.getenv(name) or fallback).strip()


def _env_float(name: str, fallback: float) -> float:
    try:
        return float(os.getenv(name, str(fallback)))
    except ValueError:
        return fallback


def _env_int(name: str, fallback: int, *, minimum: int = 1) -> int:
    try:
        return max(minimum, int(os.getenv(name, str(fallback))))
    except ValueError:
        return fallback


def get_llm_profile(profile: LlmProfileName = "copilot") -> LlmProfile:
    """Resolve LLM settings for copilot (map chat) or cleanup (DQ agent cycle)."""
    if profile == "copilot":
        return LlmProfile(
            name="copilot",
            api_key=_env_str("GIOP_LLM_API_KEY") or _env_str("OPENAI_API_KEY") or None,
            base_url=_env_str("GIOP_LLM_BASE_URL", "https://api.openai.com/v1").rstrip("/"),
            model=_env_str("GIOP_LLM_MODEL", "gpt-4o-mini"),
            workspace_id=_env_str("GIOP_LLM_WORKSPACE_ID") or _env_str("DASHSCOPE_WORKSPACE_ID"),
            temperature=_env_float("GIOP_LLM_TEMPERATURE", 0.2),
            timeout_sec=_env_int("GIOP_LLM_TIMEOUT_SEC", 60, minimum=5),
            max_tool_turns=_env_int("GIOP_LLM_MAX_TOOL_TURNS", 8, minimum=1),
        )

    copilot = get_llm_profile("copilot")
    return LlmProfile(
        name="cleanup",
        api_key=_env_str("GIOP_CLEANUP_LLM_API_KEY") or copilot.api_key,
        base_url=_env_str("GIOP_CLEANUP_LLM_BASE_URL") or copilot.base_url,
        model=_env_str("GIOP_CLEANUP_LLM_MODEL") or copilot.model,
        workspace_id=_env_str("GIOP_CLEANUP_LLM_WORKSPACE_ID") or copilot.workspace_id,
        temperature=_env_float("GIOP_CLEANUP_LLM_TEMPERATURE", copilot.temperature),
        timeout_sec=_env_int("GIOP_CLEANUP_LLM_TIMEOUT_SEC", max(copilot.timeout_sec, 90), minimum=5),
        max_tool_turns=_env_int("GIOP_CLEANUP_LLM_MAX_TOOL_TURNS", copilot.max_tool_turns, minimum=1),
    )


def llm_configured() -> bool:
    return get_llm_profile("copilot").configured


def cleanup_llm_configured() -> bool:
    return get_llm_profile("cleanup").configured


def llm_base_url() -> str:
    return get_llm_profile("copilot").base_url


def llm_model() -> str:
    return get_llm_profile("copilot").model


def cleanup_llm_model() -> str:
    return get_llm_profile("cleanup").model


def cleanup_llm_deep_model() -> str:
    """Model for deep steward scans (tool loop + longer reasoning)."""
    return _env_str("GIOP_CLEANUP_LLM_DEEP_MODEL", "deepseek-v4-pro")


def cleanup_llm_deep_max_tool_turns() -> int:
    return _env_int("GIOP_CLEANUP_LLM_DEEP_MAX_TOOL_TURNS", 12, minimum=4)


def cleanup_llm_uses_distinct_provider() -> bool:
    """True when cleanup agent has its own key, base URL, or model."""
    copilot = get_llm_profile("copilot")
    cleanup = get_llm_profile("cleanup")
    return (
        bool(_env_str("GIOP_CLEANUP_LLM_API_KEY"))
        or bool(_env_str("GIOP_CLEANUP_LLM_BASE_URL"))
        or bool(_env_str("GIOP_CLEANUP_LLM_MODEL"))
        or bool(_env_str("GIOP_CLEANUP_LLM_WORKSPACE_ID"))
        or cleanup.model != copilot.model
        or cleanup.base_url != copilot.base_url
    )


# Cache reachability probes per profile so status polling never hammers providers.
_HEALTH_TTL_SEC = 60
_health_cache: dict[str, dict[str, Any]] = {}


def llm_health(*, profile: LlmProfileName = "copilot", force: bool = False) -> dict[str, Any]:
    """Lightweight, cached provider reachability check (GET /models)."""
    now = time.time()
    bucket = _health_cache.get(profile) or {}
    cached = bucket.get("value")
    if not force and cached is not None and now - float(bucket.get("ts", 0.0)) < _HEALTH_TTL_SEC:
        return cached

    cfg = get_llm_profile(profile)
    result: dict[str, Any] = {
        "profile": profile,
        "configured": cfg.configured,
        "base_url": cfg.base_url,
        "model": cfg.model,
        "reachable": False,
        "error": None,
    }
    if not cfg.api_key:
        key_name = "GIOP_CLEANUP_LLM_API_KEY" if profile == "cleanup" else "GIOP_LLM_API_KEY"
        result["error"] = f"No API key ({key_name})."
        _health_cache[profile] = {"ts": now, "value": result}
        return result

    headers = {"Authorization": f"Bearer {cfg.api_key}"}
    if cfg.workspace_id:
        headers["X-DashScope-Workspace"] = cfg.workspace_id
    try:
        resp = requests.get(f"{cfg.base_url}/models", headers=headers, timeout=8)
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
    _health_cache[profile] = {"ts": now, "value": result}
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
    profile: LlmProfileName = "copilot",
) -> dict[str, Any]:
    """Call OpenAI-compatible chat completions API."""
    cfg = get_llm_profile(profile)
    api_key = cfg.api_key
    base_url = cfg.base_url
    model = model or cfg.model

    if not api_key:
        return _deterministic_fallback(messages)

    payload: dict[str, Any] = {
        "model": model,
        "messages": messages,
        "max_tokens": max_tokens,
        "temperature": cfg.temperature,
    }
    if tools:
        payload["tools"] = tools
        payload["tool_choice"] = "auto"

    headers: dict[str, str] = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }
    if cfg.workspace_id:
        headers["X-DashScope-Workspace"] = cfg.workspace_id

    try:
        resp = requests.post(
            f"{base_url}/chat/completions",
            headers=headers,
            json=payload,
            timeout=cfg.timeout_sec,
        )
    except requests.RequestException:
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
        "profile": profile,
    }
