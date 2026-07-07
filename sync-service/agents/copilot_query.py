"""Copilot query understanding — sanitize typos, salvage places, LLM fallback."""

from __future__ import annotations

import json
import logging
import re
from typing import Any

logger = logging.getLogger(__name__)

_ROAD_SUFFIX = r"(?:road|rd|street|st|avenue|ave|highway|lane|dr|drive|boulevard|blvd)"
_ROAD_NAME_RE = re.compile(
    rf"(?:the\s+)?(?P<road>[\w'.-]+(?:\s+[\w'.-]+)*\s+{_ROAD_SUFFIX})\b",
    re.I,
)
_ROAD_IN_CITY_RE = re.compile(
    rf"^(?P<road>.+?\b{_ROAD_SUFFIX})\s+in\s+(?P<city>.+)$",
    re.I,
)

# Pattern-based STT / typo repairs (not one-off place names).
_QUERY_REPAIRS: tuple[tuple[re.Pattern[str], str], ...] = (
    (re.compile(r"\bar\s+e\s*along\b", re.I), "along"),
    (re.compile(r"\be\s*along\b", re.I), "along"),
    (re.compile(r"\ba\s+long\b", re.I), "along"),
    (re.compile(r"\br\s+along\b", re.I), "along"),
    (re.compile(r"\bare\s+a\s+long\b", re.I), "are along"),
    (re.compile(r"\bhow\s+many\s+(\w+)\s+ar\s+along\b", re.I), r"how many \1 are along"),
    (re.compile(r"\btransformer\s+s\b", re.I), "transformers"),
    (re.compile(r"\bpoles\s+s\b", re.I), "poles"),
)

# Common Ghana road-name spelling variants (phonetic / STT).
_ROAD_SPELLING_MAP: dict[str, str] = {
    "anaokye": "anokye",
    "asantewa": "asantewaa",
    "okomfo anaokye": "okomfo anokye",
}

_GARBLED_PLACE_RE = re.compile(
    r"\b(?:ar|ealong|a\s+long|r\s+along)\b",
    re.I,
)


def sanitize_copilot_query(text: str) -> str:
    """Normalize spoken/typed copilot queries before intent parsing."""
    out = " ".join((text or "").split()).strip()
    if not out:
        return out
    for pattern, repl in _QUERY_REPAIRS:
        out = pattern.sub(repl, out)
    return out


def normalize_road_spelling(place: str) -> str:
    """Fix common phonetic road-name variants."""
    out = place.strip()
    for wrong, right in sorted(_ROAD_SPELLING_MAP.items(), key=lambda kv: -len(kv[0])):
        out = re.sub(rf"\b{re.escape(wrong)}\b", right, out, flags=re.I)
    return out.lower() if place == place.lower() else out


def extract_road_name(text: str) -> str | None:
    """Pull the best road name from a full user query."""
    cleaned = sanitize_copilot_query(text)
    chunk = cleaned
    if re.search(r"\balong\b", cleaned, re.I):
        chunk = re.split(r"\balong\b", cleaned, maxsplit=1, flags=re.I)[-1]
    matches = list(_ROAD_NAME_RE.finditer(chunk))
    if not matches:
        return None
    road = matches[-1].group("road").strip()
    road = re.sub(r"^(?:along|in|at|on|the)\s+", "", road, flags=re.I).strip()
    city_match = _ROAD_IN_CITY_RE.match(road)
    if city_match:
        road = city_match.group("road").strip()
    return normalize_road_spelling(road) or None


def salvage_place_name(place: str | None, full_query: str) -> str | None:
    """
    Recover a clean place when parsing left junk prefixes (e.g. 'ar ealong the … road').
    """
    if not place and not full_query:
        return None
    candidate = (place or "").strip()
    if candidate and not _GARBLED_PLACE_RE.search(candidate):
        cleaned = normalize_road_spelling(candidate)
        if _ROAD_NAME_RE.search(cleaned):
            m = _ROAD_IN_CITY_RE.match(cleaned)
            return m.group("road").strip() if m else cleaned
        return cleaned or candidate

    road = extract_road_name(full_query)
    if road:
        return road
    if candidate:
        stripped = re.sub(
            r"^(?:(?:are|ar)\s+)?(?:e)?along\s+(?:the\s+)?",
            "",
            candidate,
            flags=re.I,
        ).strip()
        stripped = normalize_road_spelling(stripped)
        if stripped and not _GARBLED_PLACE_RE.search(stripped):
            m = _ROAD_IN_CITY_RE.match(stripped)
            return m.group("road").strip() if m else stripped
    return None


def map_context_city_hint(context: dict[str, Any] | None) -> str | None:
    """City/area hint from map selection or viewport."""
    ctx = context or {}
    for key in ("selected_district", "selection_name", "selected_region"):
        raw = ctx.get(key)
        if isinstance(raw, str) and raw.strip():
            return raw.strip()
    viewport = ctx.get("viewport")
    if isinstance(viewport, dict):
        center = viewport.get("center")
        if isinstance(center, dict):
            lat = center.get("lat")
            if isinstance(lat, (int, float)) and lat < 6.0:
                return "Accra"
            if isinstance(lat, (int, float)) and lat > 6.3:
                return "Kumasi"
    return None


def try_llm_spatial_intent(
    text: str,
    *,
    context: dict[str, Any] | None = None,
) -> dict[str, Any] | None:
    """
    Lightweight LLM extraction when regex/geocoding fails.
    Returns normalized intent fields or None.
    """
    from agents.llm.provider import complete_chat, llm_configured

    if not llm_configured():
        return None

    city_hint = map_context_city_hint(context)
    hint_line = f" Map context city hint: {city_hint}." if city_hint else ""
    system = (
        "You extract structured GIS copilot intents from messy voice transcripts. "
        "Reply with JSON only, no markdown. Fields: "
        '{"intent":"count|list_assets|pan|network_summary|unknown",'
        '"asset_kind":"pole|transformer|node|null",'
        '"place_name":"canonical place or road name",'
        '"place_type":"road|district|region|viewport|unknown",'
        '"city":"city name or null",'
        '"use_viewport":false}. '
        "Fix typos and STT errors. For roads, return the proper road name without filler words."
    )
    messages = [
        {"role": "system", "content": system},
        {"role": "user", "content": f"Query: {text.strip()}.{hint_line}"},
    ]
    try:
        resp = complete_chat(messages, max_tokens=200)
        raw = (resp.get("content") or "").strip()
        if not raw:
            return None
        if raw.startswith("```"):
            raw = re.sub(r"^```(?:json)?\s*|\s*```$", "", raw, flags=re.I).strip()
        data = json.loads(raw)
        if not isinstance(data, dict):
            return None
        return data
    except Exception as exc:
        logger.debug("LLM spatial intent extraction failed: %s", exc)
        return None


def place_query_with_city(place: str, city: str | None) -> str:
    if not city or re.search(r"\bin\s+", place, flags=re.I):
        return place
    return f"{place} in {city}"
