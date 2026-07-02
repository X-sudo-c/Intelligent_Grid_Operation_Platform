"""Fast intent routing for voice copilot (counts, highlight, pan)."""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any

from agents.portal_context import portal_count_scope, portal_selected_territory, portal_viewport_bbox
from redis_cache import get_json, set_json

_COUNT_CACHE_TTL_SEC = int(__import__("os").getenv("VOICE_COUNT_CACHE_TTL_SEC", "900"))

_STOP_PHRASES = (
    "on the map",
    "please",
    "the map",
    "for me",
    "right now",
)

_VIEWPORT_SCOPE_RE = re.compile(
    r"\b("
    r"here|this area|my area|this view|my view|the view|current view|"
    r"map view|my map view|current map view|this map view|map viewport|"
    r"visible area|on screen|in view|what i see"
    r")\b",
    re.I,
)


def _is_viewport_scope(text: str) -> bool:
    return bool(_VIEWPORT_SCOPE_RE.search(text))


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
    territory_bbox: dict[str, float] | None = None


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
    place = re.sub(r"^(?:me|the|us)\s+", "", place, flags=re.I)
    place = re.sub(r"^(?:the\s+)?map\s+to\s+", "", place, flags=re.I)
    place = place.strip()
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


def _extract_count_place(place_raw: str | None) -> str | None:
    """Pull the locality out of phrases like 'elements are in Accra'."""
    place = _clean_place(place_raw)
    if not place:
        return None
    trailing = re.search(
        r"(?:elements?|captures?|assets?|nodes?|poles?|transformers?)"
        r"(?:\s+(?:are|is))?\s+(?:in|at|for|on)\s+(?P<place>.+)$",
        place,
        flags=re.I,
    )
    if trailing:
        return _clean_place(trailing.group("place"))
    leading = re.search(
        r"^(?:in|at|for|on)\s+(?P<place>.+)$",
        place,
        flags=re.I,
    )
    if leading:
        return _clean_place(leading.group("place"))
    return place


def _count_intent_from_text(lower: str) -> VoiceIntent | None:
    """Parse 'how many … in/at …' including 'staging elements are in X'."""
    count = re.search(
        r"(?:how many|count|number of)\s+"
        r"(?:"
        r"(?P<asset>poles?|transformers?|nodes?|captures?|staging(?:\s+(?:elements?|assets?))?)"
        r"(?:\s+(?:are|is))?\s+"
        r")?"
        r"(?:(?:in|at|for|on)\s+)?"
        r"(?P<place>[^?.!]+)?[\?.!]*$",
        lower,
        flags=re.I,
    )
    if not count:
        return None

    asset_raw = (count.group("asset") or "").lower()
    tier = "master"
    if asset_raw.startswith("staging") or asset_raw in ("capture", "captures"):
        tier = "staging"
    elif re.search(r"\bstaging\b", lower) and re.search(
        r"\b(?:elements?|assets?|captures?)\b", lower
    ):
        tier = "staging"

    asset_kind = _ASSET_ALIASES.get(asset_raw.rstrip("s") if asset_raw else "", None)
    if asset_raw in ("pole", "poles"):
        asset_kind = "pole"
    elif asset_raw in ("transformer", "transformers"):
        asset_kind = "transformer"
    elif tier == "staging":
        asset_kind = None

    use_viewport = _is_viewport_scope(lower)
    place_raw = _extract_count_place(count.group("place"))
    if place_raw and _is_viewport_scope(place_raw):
        use_viewport = True
        place_raw = None
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

    count_intent = _count_intent_from_text(lower)
    if count_intent:
        return count_intent

    pan_map = re.search(
        r"(?:pan|go to|zoom to|fly to|open|show)(?:\s+me)?\s+(?:the\s+)?map\s+to\s+(?P<place>.+?)[\?.!]*$",
        lower,
        flags=re.I,
    )
    if pan_map and "how many" not in lower:
        place = _clean_place(pan_map.group("place"))
        district, region = _place_slots(place)
        return VoiceIntent(kind="pan", district=district, region=region)

    highlight = re.search(
        r"(?:highlight|show|emphasize|display)(?:\s+me)?\s+(?P<place>.+?)(?:\s+on\s+the\s+map)?[\?.!]*$",
        lower,
        flags=re.I,
    )
    if highlight:
        place = _clean_place(highlight.group("place"))
        district, region = _place_slots(place)
        return VoiceIntent(kind="highlight", district=district, region=region)

    pan = re.search(
        r"(?:pan|go to|zoom to|fly to)(?:\s+to)?\s+(?:me\s+)?(?P<place>.+?)[\?.!]*$",
        lower,
        flags=re.I,
    )
    if pan and "how many" not in lower:
        place = _clean_place(pan.group("place"))
        district, region = _place_slots(place)
        return VoiceIntent(kind="pan", district=district, region=region)

    return None


def _count_cache_key(
    intent: VoiceIntent,
    bbox: dict[str, float] | None,
    *,
    district: str | None = None,
    region: str | None = None,
) -> str:
    parts = [
        intent.tier,
        intent.asset_kind or "all",
        district or intent.district or "",
        region or intent.region or "",
    ]
    if bbox:
        parts.append(
            f"{bbox['west']:.4f}:{bbox['south']:.4f}:{bbox['east']:.4f}:{bbox['north']:.4f}"
        )
    return "giop:voice:count:" + ":".join(parts)


def _cached_counts(
    conn,
    intent: VoiceIntent,
    bbox: dict[str, float] | None,
    *,
    district: str | None = None,
    region: str | None = None,
) -> dict[str, Any]:
    from agents import spatial

    key = _count_cache_key(intent, bbox, district=district, region=region)
    cached = get_json(key)
    if isinstance(cached, dict) and "total" in cached:
        cached = dict(cached)
        cached["cached"] = True
        return cached

    use_bbox = bbox is not None and not district and not region
    result = spatial.asset_inventory_counts(
        conn,
        tier=intent.tier,
        asset_kind=intent.asset_kind,
        district=None if use_bbox else district,
        region=None if use_bbox else region,
        bbox=bbox if use_bbox else None,
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
        sites = result.get("distinct_locations")
        if isinstance(sites, int) and sites > 0 and sites != total:
            site_noun = "location" if sites == 1 else "locations"
            return f"About {total:,} {noun} at {sites:,} {site_noun} in {place_label}."
        return f"About {total:,} {noun} in {place_label}."
    else:
        noun = "asset" if total == 1 else "assets"
    return f"About {total:,} {noun} in {place_label}."


def _viewport_bbox(context: dict[str, Any]) -> dict[str, float] | None:
    return portal_viewport_bbox(context)


def _count_place_label(
    intent: VoiceIntent,
    context: dict[str, Any],
    *,
    district: str | None,
    region: str | None,
    bbox: dict[str, float] | None,
) -> str:
    sel_d, sel_r = portal_selected_territory(context)
    raw = (
        intent.district
        or intent.region
        or district
        or region
        or sel_d
        or sel_r
        or ("this area" if bbox else None)
        or "this map view"
    )
    label = str(raw)
    return label.title() if label.islower() else label


def _resolve_voice_place(
    conn,
    place: str | None,
) -> tuple[str | None, str | None, dict[str, Any] | None]:
    if not place:
        return None, None, None
    from agents.place_resolve import resolve_place

    try:
        resolved = resolve_place(conn, place)
    except ValueError:
        district, region = _place_slots(place)
        return district, region, None
    return resolved.get("district"), resolved.get("region"), resolved


def _apply_resolved_place(
    conn,
    intent: VoiceIntent,
) -> tuple[VoiceIntent, dict[str, Any] | None]:
    if intent.use_viewport:
        return intent, None
    place = intent.district or intent.region
    if not place:
        return intent, None

    district, region, meta = _resolve_voice_place(conn, place)
    if meta and float(meta.get("confidence") or 0) < 0.55 and meta.get("candidates"):
        labels = [str(c.get("label")) for c in meta["candidates"][:4] if c.get("label")]
        if labels:
            options = ", ".join(labels)
            speak = f"I'm not sure which area you mean. Did you mean {options}?"
            return intent, {
                "content": speak,
                "speak": speak,
                "ui_actions": [],
                "session_patch": {},
                "fast_path": True,
            }

    if not district and not region:
        return intent, None

    resolved_district = district or intent.district
    resolved_region = region or intent.region
    territory_bbox = None
    if meta and meta.get("bbox") and meta.get("source") != "district":
        # Keep the resolved bbox for non-exact sources (metro grouping, alias,
        # OSM locality) — it's the camera/count target when the resolved name
        # has no exact admin boundary row. Exact district matches keep using
        # the district polygon filter, which is tighter than a bbox.
        territory_bbox = meta["bbox"]
        if meta.get("source") == "metro_region":
            # "Accra" is a metro label — filter by region ILIKE, not district name.
            resolved_district = None
            resolved_region = meta.get("region") or place
        else:
            resolved_district = meta.get("district") or resolved_district
            resolved_region = meta.get("region") or resolved_region

    return VoiceIntent(
        kind=intent.kind,
        asset_kind=intent.asset_kind,
        tier=intent.tier,
        district=resolved_district,
        region=resolved_region,
        use_viewport=intent.use_viewport,
        territory_bbox=territory_bbox,
    ), None


def execute_fast_path(
    conn,
    intent: VoiceIntent,
    *,
    context: dict[str, Any],
) -> dict[str, Any] | None:
    from agents.llm.react import _execute_tool

    intent, clarify = _apply_resolved_place(conn, intent)
    if clarify:
        return clarify

    ui_actions: list[dict[str, Any]] = []
    session_patch: dict[str, Any] = {
        "last_kind": intent.kind,
        "last_asset_kind": intent.asset_kind,
        "last_tier": intent.tier,
        "last_district": intent.district,
        "last_region": intent.region,
    }

    if intent.kind == "count":
        bbox, count_district, count_region = portal_count_scope(
            use_viewport=intent.use_viewport,
            territory_bbox=intent.territory_bbox,
            district=intent.district,
            region=intent.region,
            context=context,
        )
        if intent.use_viewport and not bbox and not count_district and not count_region:
            tab = str(context.get("active_tab") or "").lower()
            if tab in ("map", "combined", "operations"):
                speak = (
                    "I don't have the current map bounds yet — pan or zoom the map once, "
                    "then ask again."
                )
            else:
                speak = "Open the map tab and pan to an area, then ask how many are here."
            return {
                "content": speak,
                "speak": speak,
                "ui_actions": [],
                "session_patch": session_patch,
                "fast_path": True,
            }
        if not intent.use_viewport and not count_district and not count_region and not bbox:
            return None

        result = _cached_counts(
            conn,
            intent,
            bbox,
            district=count_district,
            region=count_region,
        )
        place_label = _count_place_label(
            intent,
            context,
            district=count_district,
            region=count_region,
            bbox=bbox,
        )
        speak = _format_count_speech(result, intent, place_label)
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
        if not intent.district and not intent.region and not intent.territory_bbox:
            return None
        action = "highlight_district" if intent.kind == "highlight" else "fit_district"
        tool_result: dict[str, Any] | None = None
        if intent.district or intent.region:
            try:
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
            except ValueError:
                # Resolved name has no admin boundary (metro alias, OSM
                # locality) — fall back to the resolved bbox below.
                tool_result = None
        if tool_result is None and intent.territory_bbox:
            tool_result = _execute_tool(
                conn,
                "pan_map",
                {
                    "action": "fit_bounds",
                    "tab": "map",
                    **intent.territory_bbox,
                },
            )
        if tool_result is None:
            place = intent.district or intent.region or "that area"
            speak = f"I couldn't find {place} on the map. Try a district or region name."
            return {
                "content": speak,
                "speak": speak,
                "ui_actions": [],
                "session_patch": session_patch,
                "fast_path": True,
            }
        ui = tool_result.get("ui_action")
        if ui:
            ui_actions.append(ui)
        terr = tool_result.get("territory") or {}
        raw_label = (
            (ui or {}).get("label")
            or intent.region
            or intent.district
            or terr.get("district")
            or terr.get("region")
            or ""
        )
        place_label = str(raw_label).title() if str(raw_label).islower() else str(raw_label)
        session_patch["last_district"] = terr.get("district") or intent.district
        session_patch["last_region"] = terr.get("region") or intent.region
        if intent.kind == "highlight" and (ui or {}).get("type") == "highlight_territory":
            speak = f"Highlighting {place_label} on the map."
        else:
            speak = f"Showing {place_label} on the map."
        return {
            "content": speak,
            "speak": speak,
            "ui_actions": ui_actions,
            "session_patch": session_patch,
            "fast_path": True,
            "data": terr,
        }

    return None


def try_copilot_fast_path(
    conn,
    text: str,
    *,
    context: dict[str, Any],
    session: dict[str, Any] | None = None,
    normalize: bool = True,
) -> tuple[VoiceIntent | None, dict[str, Any] | None]:
    """
    Match simple map/count commands without the LLM (voice or typed chat).
    Returns (intent, fast_path_result).
    """
    from agents.voice_normalize import normalize_transcript

    message = text
    if normalize:
        message, _ = normalize_transcript(text)
    intent = parse_intent(message, session=session or {}, context=context)
    if not intent:
        return None, None
    fast = execute_fast_path(conn, intent, context=context)
    return intent, fast
