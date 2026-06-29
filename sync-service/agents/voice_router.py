"""Fast intent routing for voice copilot (counts, highlight, pan)."""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any

from redis_cache import get_json, set_json

_COUNT_CACHE_TTL_SEC = int(__import__("os").getenv("VOICE_COUNT_CACHE_TTL_SEC", "900"))

_STOP_PHRASES = (
    "on the map",
    "please",
    "the map",
    "for me",
    "right now",
)

_ASSET_ALIASES: dict[str, str] = {
    "pole": "pole",
    "poles": "pole",
    "transformer": "transformer",
    "transformers": "transformer",
    "node": "node",
    "nodes": "node",
    "capture": "node",
    "captures": "node",
    "staging": "node",
}


@dataclass
class VoiceIntent:
    kind: str  # count | highlight | pan
    asset_kind: str | None = None
    tier: str = "master"
    district: str | None = None
    region: str | None = None
    use_viewport: bool = False


def _clean_place(raw: str | None) -> str | None:
    if not raw:
        return None
    place = raw.strip().strip("?.!,")
    low = place.lower()
    for phrase in _STOP_PHRASES:
        low = low.replace(phrase, "")
    place = low.strip()
    if not place:
        return None
    if place.endswith(" region"):
        return place[: -len(" region")].strip()
    return place


def _place_slots(place: str | None) -> tuple[str | None, str | None]:
    """Return (district, region) query slots from spoken place."""
    if not place:
        return None, None
    if "region" in place.lower():
        return None, _clean_place(place.replace("region", "").strip())
    return place, None


def parse_intent(
    text: str,
    *,
    session: dict[str, Any],
    context: dict[str, Any],
) -> VoiceIntent | None:
    raw = (text or "").strip()
    if not raw:
        return None
    lower = raw.lower()

    # Follow-up: "and in Kumasi?", "what about Ashanti region?"
    follow = re.match(
        r"^(?:and\s+)?(?:what about|how about)\s+(?P<place>.+?)[\?.!]*$",
        lower,
        flags=re.I,
    ) or re.match(r"^(?:and\s+)?(?:in|at|for)\s+(?P<place>.+?)[\?.!]*$", lower, flags=re.I)
    if follow and session.get("last_kind"):
        place = _clean_place(follow.group("place"))
        district, region = _place_slots(place)
        return VoiceIntent(
            kind=session["last_kind"],
            asset_kind=session.get("last_asset_kind"),
            tier=session.get("last_tier") or "master",
            district=district or session.get("last_district"),
            region=region or session.get("last_region"),
        )

    use_viewport = bool(re.search(r"\b(here|this area|this view|current view|map view)\b", lower))

    count = re.search(
        r"(?:how many|count|number of)\s+"
        r"(?:(?P<asset>poles?|transformers?|nodes?|captures?|staging)\s+)?"
        r"(?:in|at|for|on)?\s*(?P<place>[^?.!]+)?",
        lower,
        flags=re.I,
    )
    if count:
        asset_raw = (count.group("asset") or "").lower()
        tier = "staging" if asset_raw in ("capture", "captures", "staging") else "master"
        asset_kind = _ASSET_ALIASES.get(asset_raw.rstrip("s") if asset_raw else "", None)
        if asset_raw in ("pole", "poles"):
            asset_kind = "pole"
        elif asset_raw in ("transformer", "transformers"):
            asset_kind = "transformer"
        elif tier == "staging":
            asset_kind = None
        place_raw = _clean_place(count.group("place"))
        if use_viewport or not place_raw:
            return VoiceIntent(
                kind="count",
                asset_kind=asset_kind,
                tier=tier,
                use_viewport=True,
            )
        district, region = _place_slots(place_raw)
        return VoiceIntent(
            kind="count",
            asset_kind=asset_kind,
            tier=tier,
            district=district,
            region=region,
        )

    highlight = re.search(
        r"(?:highlight|show|emphasize|display)\s+(?P<place>.+?)(?:\s+on\s+the\s+map)?[\?.!]*$",
        lower,
        flags=re.I,
    )
    if highlight:
        place = _clean_place(highlight.group("place"))
        district, region = _place_slots(place)
        return VoiceIntent(kind="highlight", district=district, region=region)

    pan = re.search(
        r"(?:pan|go to|zoom to|fly to|open|show)\s+(?:the\s+)?(?:map\s+to\s+)?(?P<place>.+?)[\?.!]*$",
        lower,
        flags=re.I,
    )
    if pan and "how many" not in lower:
        place = _clean_place(pan.group("place"))
        district, region = _place_slots(place)
        return VoiceIntent(kind="pan", district=district, region=region)

    return None


def _count_cache_key(intent: VoiceIntent, bbox: dict[str, float] | None) -> str:
    parts = [
        intent.tier,
        intent.asset_kind or "all",
        intent.district or "",
        intent.region or "",
    ]
    if bbox:
        parts.append(
            f"{bbox['west']:.4f}:{bbox['south']:.4f}:{bbox['east']:.4f}:{bbox['north']:.4f}"
        )
    return "giop:voice:count:" + ":".join(parts)


def _cached_counts(conn, intent: VoiceIntent, bbox: dict[str, float] | None) -> dict[str, Any]:
    from agents import spatial

    key = _count_cache_key(intent, bbox)
    cached = get_json(key)
    if isinstance(cached, dict) and "total" in cached:
        cached = dict(cached)
        cached["cached"] = True
        return cached

    result = spatial.asset_inventory_counts(
        conn,
        tier=intent.tier,
        asset_kind=intent.asset_kind,
        district=intent.district,
        region=intent.region,
        bbox=bbox,
    )
    set_json(key, result, ttl_sec=_COUNT_CACHE_TTL_SEC)
    result["cached"] = False
    return result


def _format_count_speech(result: dict[str, Any], intent: VoiceIntent, place_label: str) -> str:
    total = int(result.get("pole_total") or result.get("total") or 0)
    if intent.asset_kind == "pole":
        noun = "pole" if total == 1 else "poles"
    elif intent.asset_kind == "transformer":
        noun = "transformer" if total == 1 else "transformers"
    elif intent.tier == "staging":
        noun = "staging capture" if total == 1 else "staging captures"
    else:
        noun = "asset" if total == 1 else "assets"
    return f"About {total:,} {noun} in {place_label}."


def _viewport_bbox(context: dict[str, Any]) -> dict[str, float] | None:
    viewport = context.get("viewport")
    if not isinstance(viewport, dict):
        return None
    try:
        return {
            "west": float(viewport["west"]),
            "south": float(viewport["south"]),
            "east": float(viewport["east"]),
            "north": float(viewport["north"]),
        }
    except (KeyError, TypeError, ValueError):
        return None


def execute_fast_path(
    conn,
    intent: VoiceIntent,
    *,
    context: dict[str, Any],
) -> dict[str, Any] | None:
    from agents.llm.react import _execute_tool

    ui_actions: list[dict[str, Any]] = []
    session_patch: dict[str, Any] = {
        "last_kind": intent.kind,
        "last_asset_kind": intent.asset_kind,
        "last_tier": intent.tier,
        "last_district": intent.district,
        "last_region": intent.region,
    }

    if intent.kind == "count":
        bbox = _viewport_bbox(context) if intent.use_viewport else None
        if intent.use_viewport and not bbox:
            return {
                "content": "Open the map tab and pan to an area, then ask how many poles are here.",
                "speak": "Open the map and pan to an area first, then ask how many are here.",
                "ui_actions": [],
                "session_patch": session_patch,
                "fast_path": True,
            }
        if not intent.use_viewport and not intent.district and not intent.region:
            return None

        result = _cached_counts(conn, intent, bbox)
        place_label = (
            intent.district
            or intent.region
            or (context.get("selected_district") if intent.use_viewport else None)
            or "this map view"
        )
        speak = _format_count_speech(result, intent, str(place_label))
        content = speak
        if result.get("cached"):
            content += " (cached count)"
        return {
            "content": content,
            "speak": speak,
            "ui_actions": ui_actions,
            "session_patch": session_patch,
            "fast_path": True,
            "data": result,
        }

    if intent.kind in ("highlight", "pan"):
        if not intent.district and not intent.region:
            return None
        action = "highlight_district" if intent.kind == "highlight" else "fit_district"
        tool_result = _execute_tool(
            conn,
            "pan_map",
            {
                "action": action,
                "district": intent.district,
                "region": intent.region,
                "tab": "map",
            },
        )
        ui = tool_result.get("ui_action")
        if ui:
            ui_actions.append(ui)
        terr = tool_result.get("territory") or {}
        place_label = terr.get("district") or terr.get("region") or intent.district or intent.region
        session_patch["last_district"] = terr.get("district") or intent.district
        session_patch["last_region"] = terr.get("region") or intent.region
        if intent.kind == "highlight":
            speak = f"Highlighting {place_label} on the map."
        else:
            speak = f"Panning to {place_label}."
        return {
            "content": speak,
            "speak": speak,
            "ui_actions": ui_actions,
            "session_patch": session_patch,
            "fast_path": True,
            "data": terr,
        }

    return None
