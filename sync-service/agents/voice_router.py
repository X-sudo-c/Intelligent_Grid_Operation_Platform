"""Fast intent routing for voice copilot (counts, highlight, pan)."""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any

from agents.portal_context import (
    portal_boundary_feeder_id,
    portal_count_scope,
    portal_focus_mrid,
    portal_selected_territory,
    portal_spatial_bbox,
    portal_viewport_bbox,
    portal_viewport_center,
)
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
    kind: str  # count | highlight | pan | zoom_map | trace_feeder | trace_connection_path | trace_downstream_path | work_orders_in_view | inspect_node | pan_work_order
    asset_kind: str | None = None
    tier: str = "master"
    district: str | None = None
    region: str | None = None
    feeder_id: str | None = None
    use_viewport: bool = False
    """User said here / this view / visible area — may use map bbox or selected territory."""
    viewport_explicit: bool = False
    territory_bbox: dict[str, float] | None = None
    resolved_place: dict[str, Any] | None = None
    zoom_close: bool = False
    zoom_delta: float = 0.0


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


def _zoom_step_from_phrase(phrase: str | None) -> float:
    text = (phrase or "").strip().lower()
    if not text:
        return 1.5
    if "way" in text:
        return 3.0
    if re.search(r"a\s+(?:bit|little)\s+more", text) or "further" in text:
        return 2.4
    if "a bit" in text or "little" in text or "slight" in text:
        return 0.8
    if "more" in text:
        return 2.4
    return 1.5


_ZOOM_INTENSITY = (
    r"(?:\s+(?P<intensity>a\s+bit(?:\s+more)?|a\s+little(?:\s+more)?|little|slightly|more|further|way))?"
)
_ZOOM_MAP_SUFFIX = r"(?:\s+(?:on|at)\s+(?:the\s+)?map)?[\?.!]*"


def _normalize_zoom_command_text(lower: str) -> str:
    text = lower.strip()
    text = re.sub(
        r"^(?:please\s+|(?:(?:can|could|would)\s+you\s+(?:please\s+)?)+)+",
        "",
        text,
        flags=re.I,
    ).strip()
    text = re.sub(r"\s+please[\?.!]*$", "", text, flags=re.I).strip()
    return text


def _parse_zoom_relative_intent(lower: str) -> VoiceIntent | None:
    """Relative zoom on the current viewport (zoom in/out), not zoom-to-place."""
    text = _normalize_zoom_command_text(lower)

    # "zoom in to Tema" / "zoom out to Accra" — navigate to a place, not relative zoom.
    if re.search(r"\bzoom\s+(?:in|out)\s+to\s+\S", text, flags=re.I):
        return None

    zoom_relative = re.fullmatch(
        r"zoom\s+"
        r"(?:(?:the|this)\s+map\s+)?"
        r"(?P<dir>in|out)"
        f"{_ZOOM_INTENSITY}"
        f"{_ZOOM_MAP_SUFFIX}",
        text,
        flags=re.I,
    )
    if not zoom_relative:
        zoom_relative = re.search(
            r"\bzoom\s+"
            r"(?:(?:the|this)\s+map\s+)?"
            r"(?P<dir>in|out)\b"
            f"{_ZOOM_INTENSITY}"
            f"{_ZOOM_MAP_SUFFIX}",
            text,
            flags=re.I,
        )
    if not zoom_relative:
        return None

    direction = (zoom_relative.group("dir") or "").lower()
    intensity = zoom_relative.group("intensity")
    step = _zoom_step_from_phrase(intensity)
    return VoiceIntent(
        kind="zoom_map",
        use_viewport=True,
        viewport_explicit=True,
        zoom_delta=step if direction == "in" else -step,
    )


def _count_intent_from_text(lower: str) -> VoiceIntent | None:
    """Parse 'how many … in/at …' including 'staging elements are in X'."""
    count = re.match(
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

    viewport_explicit = _is_viewport_scope(lower)
    use_viewport = viewport_explicit
    place_raw = _extract_count_place(count.group("place"))
    if place_raw and _is_viewport_scope(place_raw):
        use_viewport = True
        viewport_explicit = True
        place_raw = None
    if use_viewport or not place_raw:
        return VoiceIntent(
            kind="count",
            asset_kind=asset_kind,
            tier=tier,
            use_viewport=True,
            viewport_explicit=viewport_explicit,
        )
    district, region = _place_slots(place_raw)
    return VoiceIntent(
        kind="count",
        asset_kind=asset_kind,
        tier=tier,
        district=district,
        region=region,
    )


def _clean_feeder_query(raw: str | None) -> str | None:
    if not raw:
        return None
    q = raw.strip().strip("?.!,")
    q = re.sub(r"^(?:the|feeder|boundary feeder)\s+", "", q, flags=re.I).strip()
    q = re.sub(r"\s+(?:feeder|boundary feeder)$", "", q, flags=re.I).strip()
    return q or None


def _parse_trace_downstream_path_intent(lower: str) -> VoiceIntent | None:
    if re.search(r"\b(?:connection|connections|link)\b", lower) and not re.search(
        r"\b(?:downstream|impact|affected)\b",
        lower,
    ):
        return None
    if re.search(
        r"\b(?:downstream|down stream|affected area|impact zone|"
        r"what(?:'?s| is)\s+(?:downstream|below|after)|below\s+this)\b",
        lower,
    ):
        return VoiceIntent(kind="trace_downstream_path")
    if re.search(
        r"\b(?:show|trace|highlight|display|map|estimate)\b.*\b(?:downstream|impact|affected)\b",
        lower,
    ):
        return VoiceIntent(kind="trace_downstream_path")
    if re.search(
        r"\b(?:downstream|impact)\b.*\b(?:show|trace|highlight|display|map|path)\b",
        lower,
    ):
        return VoiceIntent(kind="trace_downstream_path")
    return None


def _parse_trace_connection_path_intent(lower: str) -> VoiceIntent | None:
    if re.search(r"\b(?:downstream|impact|affected)\b", lower):
        return None
    if not re.search(r"\b(?:trace|show|highlight|display|draw)\b", lower):
        return None
    if re.search(r"\bfeeder\b", lower):
        return None
    if not re.search(r"\b(?:connection|connections|path|line|link)\b", lower):
        return None
    return VoiceIntent(kind="trace_connection_path")


def _parse_trace_feeder_intent(raw: str, lower: str) -> VoiceIntent | None:
    explicit = re.search(
        r"(?:show|highlight|trace|display|tell me about|what(?:'s| is)|see)"
        r"(?:\s+me)?(?:\s+(?:the\s+)?(?:nodes|assets|network|connections?|connectivity))?"
        r"(?:\s+(?:on|of|for))?"
        r"(?:\s+(?:the\s+)?(?:feeder|boundary feeder))?\s+"
        r"(?P<feeder>FEEDER[\w-]+)",
        raw,
        flags=re.I,
    )
    if explicit:
        feeder = explicit.group("feeder").strip()
        if feeder:
            return VoiceIntent(kind="trace_feeder", feeder_id=feeder)

    named = re.search(
        r"(?:"
        r"(?:show|highlight|trace|display|tell me about|what(?:'s| is)|see|pan to)"
        r"|(?:connections?|connectivity|network|nodes?|assets?)"
        r")"
        r"(?:\s+(?:me|the|about))?"
        r"(?:\s+(?:connections?|connectivity|network|nodes?|assets?))?"
        r"(?:\s+(?:on|of|for|to))?"
        r"(?:\s+the)?\s+"
        r"(?P<name>[\w][\w\s-]*?)\s+feeder\b",
        lower,
        flags=re.I,
    )
    if named:
        feeder = _clean_feeder_query(named.group("name"))
        if feeder and feeder.lower() not in {"this", "selected", "current", "the"}:
            return VoiceIntent(kind="trace_feeder", feeder_id=feeder)

    legacy = re.search(
        r"(?:show|highlight|trace|display)(?:\s+me)?(?:\s+(?:the\s+)?(?:nodes|assets|network))?"
        r"(?:\s+on)?(?:\s+(?:feeder|boundary feeder))\s+(?P<feeder>[\w-]+)",
        raw,
        flags=re.I,
    )
    if legacy:
        feeder = _clean_feeder_query(legacy.group("feeder"))
        if feeder:
            return VoiceIntent(kind="trace_feeder", feeder_id=feeder)

    this_feeder = re.search(
        r"(?:show|highlight|trace|display)(?:\s+me)?(?:\s+(?:the\s+)?(?:nodes|assets|network|connections?))?"
        r"(?:\s+on)?(?:\s+(?:this|the|selected))?\s+feeder",
        lower,
        flags=re.I,
    )
    if this_feeder:
        return VoiceIntent(kind="trace_feeder")

    return None


def _extract_work_orders_place(lower: str) -> str | None:
    """Named territory for work-order queries, e.g. 'work orders in Accra'."""
    patterns = (
        r"\bwork\s*orders?\s+(?:are\s+)?(?:in|at|for|around|near)\s+(?P<place>.+?)[\?.!]*$",
        r"\b(?:open|active|current)\s+work\s*orders?\s+(?:in|at|for)\s+(?P<place>.+?)[\?.!]*$",
        r"\b(?:tell me about|what|which|list|show|any|are there).+?"
        r"work\s*orders?.+?\b(?:in|at|for)\s+(?P<place>.+?)[\?.!]*$",
    )
    for pat in patterns:
        match = re.search(pat, lower, flags=re.I)
        if not match:
            continue
        place = _clean_place(match.group("place"))
        if not place:
            continue
        if place.lower() in {"view", "screen", "map"} or _is_viewport_scope(
            place
        ) or _is_viewport_scope(f"in {place}"):
            continue
        return place
    return None


def _parse_work_orders_in_view_intent(lower: str) -> VoiceIntent | None:
    if not re.search(r"\bwork\s*orders?\b", lower):
        return None

    place = _extract_work_orders_place(lower)
    if place:
        district, region = _place_slots(place)
        return VoiceIntent(
            kind="work_orders_in_view",
            district=district,
            region=region,
        )

    viewport_explicit = _is_viewport_scope(lower)
    on_map = bool(re.search(r"\b(?:on the map|map view|visible area|on screen)\b", lower))
    asks_list = bool(
        re.search(
            r"(?:what|which|list|show|tell me|any|are there)"
            r"(?:\s+(?:are|about|the))?\s+(?:the\s+)?"
            r"(?:open\s+|active\s+|current\s+)?work\s*orders?",
            lower,
        )
        or re.search(r"work\s*orders?\s+(?:in|on)\s+(?:view|the\s+map|screen)", lower)
        or re.search(r"(?:open|active|current)\s+work\s*orders?", lower)
    )
    if not asks_list:
        return None
    if not viewport_explicit and not on_map and not re.search(r"\b(?:current|here|this)\b", lower):
        return None
    return VoiceIntent(
        kind="work_orders_in_view",
        use_viewport=True,
        viewport_explicit=viewport_explicit or on_map,
    )


def _parse_pan_work_order_intent(lower: str) -> VoiceIntent | None:
    if not re.search(r"\bwork\s*orders?\b", lower):
        return None
    if not re.search(r"\b(?:pan|go|fly|zoom|show|take me|open|navigate)\b", lower):
        return None
    if _extract_work_orders_place(lower):
        return None
    targets_work_order = bool(
        re.search(
            r"\b(?:pan|go|fly|zoom|show|take me|open)\s+(?:to|into)?\s+"
            r"(?:the\s+)?(?:work\s*order|work\s*order\s+(?:node|nodes|pin|pins|location|site))",
            lower,
        )
        or re.search(
            r"\bwork\s*order\s+(?:node|nodes|pin|pins|location|site)s?\b.*"
            r"\b(?:on the map|in view|here|on screen)\b",
            lower,
        )
        or re.search(
            r"\b(?:pan|show|go|fly|zoom)\b.*\bwork\s*order\s+(?:node|nodes|pin|pins)\b",
            lower,
        )
    )
    if not targets_work_order:
        return None
    viewport_explicit = _is_viewport_scope(lower) or bool(
        re.search(r"\b(?:on the map|in view|here|on screen|the map)\b", lower)
    )
    return VoiceIntent(
        kind="pan_work_order",
        use_viewport=True,
        viewport_explicit=viewport_explicit,
    )


def _parse_inspect_node_intent(lower: str) -> VoiceIntent | None:
    node_words = r"\b(?:node|asset|pole|transformer|substation|bsp)\b"
    if not re.search(node_words, lower) and "looking at" not in lower:
        return None

    viewport_explicit = _is_viewport_scope(lower)
    on_map = bool(re.search(r"\b(?:in view|on screen|on the map|visible|here|this|selected)\b", lower))

    asks_about = bool(
        re.search(
            r"(?:tell me about|what is|what's|describe|info on|information about|"
            r"what am i looking at|what do i see|details on|about the)",
            lower,
        )
        or re.search(rf"(?:this|the|selected)\s+{node_words}", lower)
        or re.search(rf"{node_words}\s+(?:in view|on screen|here|selected|in the view)", lower)
        or re.search(r"what connects to (?:it|this|the node)", lower)
    )
    if not asks_about:
        return None
    if re.search(r"what am i looking at|what do i see", lower):
        return VoiceIntent(
            kind="inspect_node",
            use_viewport=True,
            viewport_explicit=True,
        )
    if not viewport_explicit and not on_map and not re.search(r"\b(?:this|selected|it)\b", lower):
        if not re.search(rf"what(?:'s| is) (?:this|the) {node_words}", lower):
            return None

    return VoiceIntent(
        kind="inspect_node",
        use_viewport=True,
        viewport_explicit=viewport_explicit or on_map,
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
        r"^(?:what about|how about)\s+(?P<place>.+?)[\?.!]*$",
        lower,
        flags=re.I,
    ) or re.match(
        r"^and\s+(?:in|at|for)\s+(?P<place>.+?)[\?.!]*$",
        lower,
        flags=re.I,
    )
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

    work_orders_intent = _parse_work_orders_in_view_intent(lower)
    if work_orders_intent:
        return work_orders_intent

    pan_work_order_intent = _parse_pan_work_order_intent(lower)
    if pan_work_order_intent:
        return pan_work_order_intent

    trace_downstream_intent = _parse_trace_downstream_path_intent(lower)
    if trace_downstream_intent:
        return trace_downstream_intent

    trace_connection_intent = _parse_trace_connection_path_intent(lower)
    if trace_connection_intent:
        return trace_connection_intent

    inspect_node_intent = _parse_inspect_node_intent(lower)
    if inspect_node_intent:
        return inspect_node_intent

    trace_feeder_intent = _parse_trace_feeder_intent(raw, lower)
    if trace_feeder_intent:
        return trace_feeder_intent

    zoom_in_to = re.search(r"zoom\s+in\s+to\s+(?P<place>.+?)[\?.!]*$", lower, flags=re.I)
    if zoom_in_to:
        place = _clean_place(zoom_in_to.group("place"))
        district, region = _place_slots(place)
        return VoiceIntent(kind="pan", district=district, region=region, zoom_close=True)

    zoom_relative_intent = _parse_zoom_relative_intent(lower)
    if zoom_relative_intent:
        return zoom_relative_intent

    pan_map = re.search(
        r"(?:pan|go to|take me to|zoom to|fly to|open|show)(?:\s+me)?\s+(?:the\s+)?map\s+to\s+(?P<place>.+?)[\?.!]*$",
        lower,
        flags=re.I,
    )
    if pan_map and "how many" not in lower:
        place = _clean_place(pan_map.group("place"))
        district, region = _place_slots(place)
        return VoiceIntent(
            kind="pan",
            district=district,
            region=region,
            zoom_close="zoom" in lower,
        )

    zoom_into = re.search(r"zoom\s+into\s+(?P<place>.+?)[\?.!]*$", lower, flags=re.I)
    if zoom_into:
        place = _clean_place(zoom_into.group("place"))
        district, region = _place_slots(place)
        return VoiceIntent(kind="pan", district=district, region=region, zoom_close=True)

    highlight = re.search(
        r"(?:highlight|show|emphasize|display)(?:\s+me)?\s+(?P<place>.+?)(?:\s+on\s+the\s+map)?[\?.!]*$",
        lower,
        flags=re.I,
    )
    if highlight and not re.search(r"\bwork\s*orders?\b", lower) and _parse_trace_feeder_intent(raw, lower) is None:
        place = _clean_place(highlight.group("place"))
        district, region = _place_slots(place)
        return VoiceIntent(kind="highlight", district=district, region=region)

    pan = re.search(
        r"(?:pan|go to|take me to|zoom(?:\s+to|\s+into)?|fly to)(?:\s+to|\s+into)?\s+(?:me\s+)?(?P<place>.+?)[\?.!]*$",
        lower,
        flags=re.I,
    )
    if (
        pan
        and "how many" not in lower
        and _parse_zoom_relative_intent(lower) is None
        and _parse_pan_work_order_intent(lower) is None
        and not re.search(r"\bwork\s*orders?\b", lower)
    ):
        place = _clean_place(pan.group("place"))
        district, region = _place_slots(place)
        return VoiceIntent(
            kind="pan",
            district=district,
            region=region,
            zoom_close="zoom" in lower,
        )

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


def _format_work_orders_speech(result: dict[str, Any], *, place_label: str | None = None) -> str:
    orders = result.get("work_orders") or []
    count = int(result.get("count") or len(orders))
    scope = place_label or "the current map view"
    if count == 0:
        return f"There are no open work orders in {scope}."
    if count == 1:
        wo = orders[0]
        ref = wo.get("reference") or wo.get("id") or "work order"
        summary = (wo.get("summary") or "").strip()
        status = wo.get("status") or ""
        detail = f"{ref} ({status})"
        if summary:
            detail += f" — {summary}"
        return f"There is 1 open work order in {scope}: {detail}."
    previews: list[str] = []
    for wo in orders[:5]:
        ref = wo.get("reference") or wo.get("id") or "work order"
        status = wo.get("status") or ""
        previews.append(f"{ref} ({status})")
    joined = ", ".join(previews)
    if count > 5:
        return f"There are {count} open work orders in {scope}, including {joined}, and others."
    return f"There are {count} open work orders in {scope}: {joined}."


def _work_orders_scope_label(intent: VoiceIntent) -> str | None:
    if intent.use_viewport and not intent.district and not intent.region:
        return None
    raw = (
        (intent.resolved_place or {}).get("matched_as")
        or intent.region
        or intent.district
    )
    if not raw:
        return None
    label = str(raw)
    return label.title() if label.islower() else label


def _work_orders_query_bbox(
    conn,
    intent: VoiceIntent,
    context: dict[str, Any],
) -> dict[str, float]:
    if intent.territory_bbox:
        return intent.territory_bbox
    if intent.district or intent.region:
        from agents import spatial

        return spatial.resolve_territory(
            conn,
            district=intent.district,
            region=intent.region,
        )["bbox"]
    return portal_spatial_bbox(conn, context)


def _pick_work_order_nearest(
    orders: list[dict[str, Any]],
    center: dict[str, float] | None,
) -> dict[str, Any] | None:
    located = [
        wo
        for wo in orders
        if wo.get("longitude") is not None and wo.get("latitude") is not None
    ]
    if not located:
        return None
    if not center:
        return located[0]
    best = located[0]
    best_dist = float("inf")
    for wo in located:
        lon = float(wo["longitude"])
        lat = float(wo["latitude"])
        dist = (lon - center["lon"]) ** 2 + (lat - center["lat"]) ** 2
        if dist < best_dist:
            best = wo
            best_dist = dist
    return best


def _format_inspect_node_speech(result: dict[str, Any]) -> str:
    if result.get("error"):
        return str(result["error"])
    name = result.get("name") or "This node"
    validation = result.get("validation") or "unknown status"
    feeder = result.get("boundary_feeder_id")
    district = result.get("district")
    region = result.get("region")
    degree = int(result.get("degree") or 0)
    where = district or region
    parts = [f"{name} is {validation.replace('_', ' ').lower()}"]
    if feeder:
        parts.append(f"on feeder {feeder}")
    if where:
        parts.append(f"in {where}")
    conn = "connection" if degree == 1 else "connections"
    parts.append(f"with {degree} {conn}")
    if result.get("connections"):
        neighbor = result["connections"][0].get("neighbor_name")
        if neighbor and degree == 1:
            parts.append(f"linked to {neighbor}")
    body = ". ".join(parts) + "."
    if result.get("confirmation_needed"):
        return (
            f"I think you mean {name}. I've highlighted it on the map so you can check. "
            f"{body} Is this the node you mean?"
        )
    return body


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
        viewport_explicit=intent.viewport_explicit,
        territory_bbox=territory_bbox,
        resolved_place=meta,
        zoom_close=intent.zoom_close,
    ), None


def execute_fast_path(
    conn,
    intent: VoiceIntent,
    *,
    context: dict[str, Any],
) -> dict[str, Any] | None:
    from agents.llm.react import _execute_tool

    if intent.resolved_place is None:
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
            allow_selected_territory=intent.viewport_explicit,
        )
        if intent.use_viewport and not bbox and not count_district and not count_region:
            bbox = portal_spatial_bbox(conn, context)
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

    if intent.kind == "work_orders_in_view":
        bbox = _work_orders_query_bbox(conn, intent, context)
        from agents import tools

        result = tools.tool_list_work_orders_in_view(
            conn,
            west=bbox["west"],
            south=bbox["south"],
            east=bbox["east"],
            north=bbox["north"],
            open_only=True,
        )
        speak = _format_work_orders_speech(
            result,
            place_label=_work_orders_scope_label(intent),
        )
        return {
            "content": speak,
            "speak": speak,
            "ui_actions": ui_actions,
            "session_patch": {**session_patch, "last_kind": intent.kind},
            "fast_path": True,
            "data": result,
        }

    if intent.kind == "pan_work_order":
        bbox = portal_spatial_bbox(conn, context)
        from agents import tools

        result = tools.tool_list_work_orders_in_view(
            conn,
            west=bbox["west"],
            south=bbox["south"],
            east=bbox["east"],
            north=bbox["north"],
            open_only=True,
        )
        wo = _pick_work_order_nearest(
            result.get("work_orders") or [],
            portal_viewport_center(context),
        )
        if not wo:
            speak = "There are no work orders with map locations in the current view."
            return {
                "content": speak,
                "speak": speak,
                "ui_actions": [],
                "session_patch": {**session_patch, "last_kind": intent.kind},
                "fast_path": True,
                "data": result,
            }
        lon = float(wo["longitude"])
        lat = float(wo["latitude"])
        ui_actions.append(
            {
                "type": "fly_to",
                "tab": "map",
                "center": {"lon": lon, "lat": lat},
                "zoom": 17,
            }
        )
        ref = wo.get("reference") or wo.get("id") or "work order"
        summary = (wo.get("summary") or "").strip()
        speak = f"Showing work order {ref} on the map."
        if summary:
            speak += f" {summary}."
        return {
            "content": speak,
            "speak": speak,
            "ui_actions": ui_actions,
            "session_patch": {**session_patch, "last_kind": intent.kind},
            "fast_path": True,
            "data": {"work_order": wo, **result},
        }

    if intent.kind == "inspect_node":
        from agents import tools

        result = tools.tool_inspect_node(
            conn,
            context=dict(context),
            show_on_map=True,
        )
        speak = _format_inspect_node_speech(result)
        ui = result.get("ui_action")
        if ui:
            ui_actions.append(ui)
        return {
            "content": speak,
            "speak": speak,
            "ui_actions": ui_actions,
            "session_patch": {
                **session_patch,
                "last_kind": intent.kind,
                "last_mrid": result.get("mrid"),
            },
            "fast_path": True,
            "data": result,
        }

    if intent.kind == "trace_downstream_path":
        from agents import graph_tools

        exec_ctx = dict(context)

        result = graph_tools.trace_downstream_path(
            conn,
            context=exec_ctx,
            show_on_map=True,
        )
        if result.get("error") and not result.get("ui_action"):
            speak = str(result["error"])
            return {
                "content": speak,
                "speak": speak,
                "ui_actions": [],
                "session_patch": session_patch,
                "fast_path": True,
                "data": result,
            }

        ui = result.get("ui_action")
        if ui:
            ui_actions.append(ui)
        name = result.get("name") or "this node"
        downstream = int(result.get("downstream_nodes") or 0)
        edge_count = int(result.get("edge_count") or 0)
        truncated = bool((result.get("metrics") or {}).get("truncated"))
        suffix = " (truncated at limit)" if truncated else ""
        speak = (
            f"Showing {downstream} downstream node{'s' if downstream != 1 else ''} "
            f"and {edge_count} line{'s' if edge_count != 1 else ''} "
            f"from {name} on the map{suffix}."
        )
        return {
            "content": speak,
            "speak": speak,
            "ui_actions": ui_actions,
            "session_patch": {
                **session_patch,
                "last_kind": intent.kind,
                "last_mrid": result.get("mrid"),
            },
            "fast_path": True,
            "data": result,
        }

    if intent.kind == "trace_connection_path":
        from agents import graph_tools

        exec_ctx = dict(context)

        result = graph_tools.trace_connection_path(
            conn,
            context=exec_ctx,
            show_on_map=True,
        )
        if result.get("error") and not result.get("ui_action"):
            speak = str(result["error"])
            return {
                "content": speak,
                "speak": speak,
                "ui_actions": [],
                "session_patch": session_patch,
                "fast_path": True,
                "data": result,
            }

        ui = result.get("ui_action")
        if ui:
            ui_actions.append(ui)
        name = result.get("name") or "this node"
        neighbors = result.get("neighbor_names") or []
        edge_count = int(result.get("connection_count") or 0)
        if neighbors:
            joined = ", ".join(neighbors[:3])
            if len(neighbors) > 3:
                joined += ", and others"
            speak = (
                f"Showing {edge_count} connection line{'s' if edge_count != 1 else ''} "
                f"from {name} to {joined} on the map."
            )
        else:
            speak = f"Showing connections at {name} on the map."
        return {
            "content": speak,
            "speak": speak,
            "ui_actions": ui_actions,
            "session_patch": {**session_patch, "last_kind": intent.kind, "last_mrid": result.get("mrid")},
            "fast_path": True,
            "data": result,
        }

    if intent.kind == "zoom_map":
        viewport = context.get("viewport") if isinstance(context.get("viewport"), dict) else {}
        center = viewport.get("center") if isinstance(viewport, dict) else None
        bbox = viewport.get("bbox") if isinstance(viewport, dict) else None
        zoom_raw = viewport.get("zoom") if isinstance(viewport, dict) else None
        try:
            current_zoom = float(zoom_raw) if zoom_raw is not None else 13.0
        except (TypeError, ValueError):
            current_zoom = 13.0

        lon = lat = None
        if isinstance(center, dict):
            lon = center.get("lon")
            lat = center.get("lat")
        if (lon is None or lat is None) and isinstance(bbox, dict):
            if all(bbox.get(k) is not None for k in ("west", "south", "east", "north")):
                lon = (float(bbox["west"]) + float(bbox["east"])) / 2.0
                lat = (float(bbox["south"]) + float(bbox["north"])) / 2.0
        if lon is None or lat is None:
            return None

        next_zoom = max(3.0, min(20.0, current_zoom + float(intent.zoom_delta or 0.0)))
        ui_actions.append(
            {
                "type": "fly_to",
                "tab": "map",
                "center": {"lon": float(lon), "lat": float(lat)},
                "zoom": round(next_zoom, 1),
            }
        )
        direction = "in" if intent.zoom_delta >= 0 else "out"
        strength = abs(float(intent.zoom_delta or 0.0))
        if strength < 1.0:
            speak = f"Zooming {direction} a bit on the current map view."
        elif strength > 2.0:
            speak = f"Zooming {direction} more on the current map view."
        else:
            speak = f"Zooming {direction} on the current map view."
        return {
            "content": speak,
            "speak": speak,
            "ui_actions": ui_actions,
            "session_patch": {**session_patch, "last_kind": "pan"},
            "fast_path": True,
        }

    if intent.kind in ("highlight", "pan"):
        if not intent.district and not intent.region and not intent.territory_bbox:
            return None

        from agents.place_resolve import place_viewport_ui_action

        action = "highlight_district" if intent.kind == "highlight" else "fit_district"
        tool_result: dict[str, Any] | None = None

        # Localities (OSM) and explicit zoom — fly in close, not whole district.
        if intent.resolved_place:
            mode = "zoom" if intent.zoom_close else intent.kind
            local_ui = place_viewport_ui_action(
                intent.resolved_place,
                mode="zoom" if intent.zoom_close else mode,
                tab="map",
            )
            if local_ui and (
                intent.kind == "pan"
                or intent.zoom_close
                or intent.resolved_place.get("source")
                in ("osm", "alias_exact", "alias", "alias_fuzzy", "point_in_polygon")
            ):
                if intent.kind == "highlight" and intent.district:
                    try:
                        tool_result = _execute_tool(
                            conn,
                            "pan_map",
                            {
                                "action": "highlight_district",
                                "district": intent.district,
                                "region": intent.region,
                                "tab": "map",
                            },
                        )
                    except ValueError:
                        tool_result = None
                ui_actions.append(local_ui)
                if tool_result and tool_result.get("ui_action"):
                    ui_actions.insert(0, tool_result["ui_action"])
                raw_label = (
                    intent.resolved_place.get("matched_as")
                    or intent.district
                    or intent.region
                    or "that area"
                )
                place_label = str(raw_label).title() if str(raw_label).islower() else str(raw_label)
                session_patch["last_district"] = intent.district
                session_patch["last_region"] = intent.region
                if intent.zoom_close:
                    speak = f"Zooming into {place_label} on the map."
                elif intent.kind == "highlight":
                    speak = f"Highlighting {place_label} on the map."
                else:
                    speak = f"Showing {place_label} on the map."
                return {
                    "content": speak,
                    "speak": speak,
                    "ui_actions": ui_actions,
                    "session_patch": session_patch,
                    "fast_path": True,
                    "data": intent.resolved_place,
                }

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

    if intent.kind == "trace_feeder":
        from agents import graph_tools

        feeder_query = (intent.feeder_id or "").strip() or None
        feeder_id = portal_boundary_feeder_id(context) if not feeder_query else None
        focus_mrid = None

        if feeder_query and not feeder_id:
            resolved = graph_tools.resolve_feeder_query(conn, feeder_query)
            if resolved.get("feeder_id"):
                feeder_id = str(resolved["feeder_id"])
            elif resolved.get("candidates"):
                labels = [
                    str(c.get("feeder_id"))
                    for c in resolved["candidates"][:4]
                    if c.get("feeder_id")
                ]
                options = ", ".join(labels) if labels else "a feeder id like FEEDER-ECG-MALLAM-04"
                speak = (
                    f"I'm not sure which feeder you mean for {feeder_query!r}. "
                    f"Did you mean {options}?"
                )
                return {
                    "content": speak,
                    "speak": speak,
                    "ui_actions": [],
                    "session_patch": session_patch,
                    "fast_path": True,
                    "data": resolved,
                }
            elif resolved.get("error"):
                speak = str(resolved["error"])
                return {
                    "content": speak,
                    "speak": speak,
                    "ui_actions": [],
                    "session_patch": session_patch,
                    "fast_path": True,
                    "data": resolved,
                }
            elif re.match(r"FEEDER[\w-]*", feeder_query, flags=re.I):
                feeder_id = feeder_query
            else:
                speak = f"I couldn't find a feeder matching {feeder_query!r}."
                return {
                    "content": speak,
                    "speak": speak,
                    "ui_actions": [],
                    "session_patch": session_patch,
                    "fast_path": True,
                    "data": resolved,
                }

        if not feeder_id:
            focus_mrid = portal_focus_mrid(context)

        if not feeder_id and not focus_mrid:
            speak = (
                "Select an asset on the map first, or name a feeder — "
                "for example show connections on the Mallam feeder."
            )
            return {
                "content": speak,
                "speak": speak,
                "ui_actions": [],
                "session_patch": session_patch,
                "fast_path": True,
            }

        result = graph_tools.trace_feeder(
            feeder_id,
            conn=conn,
            focus_mrid=focus_mrid,
            show_on_map=True,
        )
        if result.get("error") and not result.get("ui_action"):
            speak = str(result["error"])
            return {
                "content": speak,
                "speak": speak,
                "ui_actions": [],
                "session_patch": session_patch,
                "fast_path": True,
            }

        ui = result.get("ui_action")
        if ui:
            ui_actions.append(ui)
        resolved = result.get("feeder_id") or feeder_id or "feeder"
        count = int(result.get("reachable_nodes") or 0)
        edge_count = int(result.get("map_edge_count") or 0)
        speak = (
            f"Showing {count:,} nodes and {edge_count:,} line connections "
            f"on feeder {resolved} on the map."
        )
        if result.get("truncated"):
            speak += " Trace was truncated for performance."
        session_patch["last_feeder_id"] = resolved
        return {
            "content": speak,
            "speak": speak,
            "ui_actions": ui_actions,
            "session_patch": session_patch,
            "fast_path": True,
            "data": result,
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
    # Speaker echo — assistant TTS picked up as user speech.
    if re.match(
        r"^about\s+[\d,]+\s+staging\s+captures?\s+in\s+",
        message.strip(),
        flags=re.I,
    ):
        return None, None
    intent = parse_intent(message, session=session or {}, context=context)
    if not intent:
        return None, None
    exec_ctx = dict(context)
    if session:
        if session.get("last_mrid"):
            exec_ctx.setdefault("last_mrid", session["last_mrid"])
        if session.get("last_feeder_id"):
            exec_ctx.setdefault("last_feeder_id", session["last_feeder_id"])
    fast = execute_fast_path(conn, intent, context=exec_ctx)
    return intent, fast
