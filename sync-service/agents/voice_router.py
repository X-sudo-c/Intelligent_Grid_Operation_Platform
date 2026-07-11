"""Fast intent routing for voice copilot (counts, highlight, pan)."""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any

from agents.copilot_query import normalize_road_spelling
from agents.portal_context import (
    portal_boundary_feeder_id,
    portal_count_scope,
    portal_focus_mrid,
    portal_selected_territory,
    portal_spatial_bbox,
    portal_viewport_bbox,
    portal_viewport_center,
)

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
    "pole_11kv": "pole_11kv",
    "pole_33kv": "pole_33kv",
    "pole_lv": "pole_lv",
    "transformer": "transformer",
    "transformers": "transformer",
    "node": "node",
    "nodes": "node",
    "capture": "node",
    "captures": "node",
    "staging": "node",
}


def _voltage_pole_kind_from_text(lower: str) -> str | None:
    """Detect 11 kV / 33 kV / LV pole counts from natural language."""
    if not re.search(r"\bpoles?\b", lower):
        return None
    if re.search(r"\b(?:11\s*kv|11kv|11\s*kilo(?:volt)?)\b", lower):
        return "pole_11kv"
    if re.search(r"\b(?:33\s*kv|33kv|33\s*kilo(?:volt)?)\b", lower):
        return "pole_33kv"
    if re.search(r"\b(?:lv|low\s+voltage)\s+poles?\b", lower) or re.search(
        r"\bpoles?\s+(?:on\s+)?lv\b", lower
    ):
        return "pole_lv"
    return None


@dataclass
class VoiceIntent:
    kind: str  # count | list_assets | network_summary | highlight | pan | ...
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
    also_list_assets: bool = False
    """When listing assets, pin them on the map only if the user asked to highlight."""
    highlight_on_map: bool = False


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
    place = re.sub(r"^(?:are\s+|ar\s+)?e?along\s+", "", place, flags=re.I)
    place = place.strip()
    if not place:
        return None
    # Keep "this district" / "my region" intact for selected-territory counts.
    if re.match(r"^(?:this|the|my)\s+(?:district|region|territory)$", place, flags=re.I):
        return place
    if place.endswith(" region"):
        return place[: -len(" region")].strip()
    if place.endswith(" district"):
        return place[: -len(" district")].strip()
    place = re.sub(r"^(?:are\s+|ar\s+)?e?along\s+", "", place, flags=re.I).strip()
    place = normalize_road_spelling(place)
    return _strip_road_city_qualifier(place)


def _place_slots(place: str | None) -> tuple[str | None, str | None]:
    """Return (district, region) query slots from spoken place."""
    if not place:
        return None, None
    if "region" in place.lower():
        return None, _clean_place(place.replace("region", "").strip())
    return place, None


def _strip_followup_clauses(text: str | None) -> str | None:
    """Remove trailing 'can you name them' / 'show me the transformers' from a place phrase."""
    if not text:
        return None
    cleaned = text.strip()
    # "… and that it should show me the transformers" / "… and show me the transformers"
    cleaned = re.sub(
        r"\s+(?:,|\band\b)?\s*(?:that\s+it\s+should\s+)?"
        r"(?:can you |could you |please )?"
        r"(?:name|list|show|identify|display)(?:\s+me)?\s+"
        r"(?:them|those|the(?:m)?(?:\s+(?:poles?|assets?|transformers?|nodes?))?)"
        r"[\?.!]*$",
        "",
        cleaned,
        flags=re.I,
    )
    cleaned = re.sub(
        r"\s+(?:,|\band\b)?\s*(?:what are (?:they|their names)(?: called)?)[\?.!]*$",
        "",
        cleaned,
        flags=re.I,
    )
    return cleaned.strip() or None


def _wants_map_highlight(lower: str) -> bool:
    """True when the user explicitly wants listed assets pinned on the map."""
    return bool(
        re.search(
            r"\b(?:highlight|pin|plot|mark)(?:\s+them|\s+those|\s+the\s+(?:assets?|transformers?|poles?|nodes?))?"
            r"(?:\s+on\s+(?:the\s+)?map)?\b",
            lower,
        )
        or re.search(
            r"\b(?:show|display)(?:\s+them|\s+those)?\s+on\s+(?:the\s+)?map\b",
            lower,
        )
        or re.search(
            r"\b(?:yes|yeah|yep|sure|please|ok|okay)\b.*\b(?:highlight|pin|plot|on\s+(?:the\s+)?map)\b",
            lower,
        )
    )


def _wants_asset_list(lower: str) -> bool:
    return bool(
        re.search(
            r"\b(?:name|list|show|identify|display)(?:\s+me)?\s+"
            r"(?:them|those|the(?:m)?(?:\s+(?:poles?|assets?|transformers?|nodes?))?)\b",
            lower,
        )
        or re.search(r"\bwhat are (?:they|their names)(?: called)?\b", lower)
    )


def _strip_road_city_qualifier(place: str) -> str:
    """'yaa asantewaa road in kumasi' → 'yaa asantewaa road' for geocoding."""
    m = re.match(
        r"^(?P<road>.+?\b(?:road|rd|street|st|avenue|ave|highway|lane|dr|drive|boulevard|blvd))"
        r"\s+in\s+(?P<city>.+)$",
        place.strip(),
        flags=re.I,
    )
    if m:
        return m.group("road").strip()
    return place


def _extract_count_place(place_raw: str | None) -> str | None:
    """Pull the locality out of phrases like 'elements are in Accra'."""
    place = _clean_place(_strip_followup_clauses(place_raw))
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
        r"^(?:(?:are|ar)\s+)?(?:e)?along\s+(?P<place>.+)$",
        place,
        flags=re.I,
    )
    if leading:
        return _clean_place(leading.group("place"))
    leading = re.search(
        r"^(?:in|at|for|on)\s+(?P<place>.+)$",
        place,
        flags=re.I,
    )
    if leading:
        return _clean_place(leading.group("place"))
    return _strip_road_city_qualifier(place)


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


def _is_selected_territory_place(place: str | None) -> bool:
    if not place:
        return False
    # "this area" / "my area" stay viewport-scoped; district/region mean the map selection.
    return bool(
        re.match(
            r"^(?:this|the|my)\s+(?:district|region|territory)$",
            place.strip(),
            flags=re.I,
        )
    )


def _count_intent_from_text(
    lower: str,
    *,
    context: dict[str, Any] | None = None,
) -> VoiceIntent | None:
    """Parse 'how many … in/at …' including 'staging elements are in X'."""
    count = re.match(
        r"(?:how many|count|number of)\s+"
        r"(?:"
        r"(?P<asset>poles?|transformers?|nodes?|captures?|"
        r"staging(?:\s+(?:elements?|assets?|captures?))?)"
        r"(?:\s+(?:are|is))?\s+"
        r")?"
        r"(?:(?:in|at|for|on|along|ar\s+ealong|ealong)\s+)?"
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
    voltage_kind = _voltage_pole_kind_from_text(lower)
    if voltage_kind:
        asset_kind = voltage_kind
    elif asset_raw in ("pole", "poles"):
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
    if place_raw and _is_selected_territory_place(place_raw):
        sel_d, sel_r = portal_selected_territory(context or {})
        if sel_d or sel_r:
            return VoiceIntent(
                kind="count",
                asset_kind=asset_kind,
                tier=tier,
                district=sel_d,
                region=sel_r,
                also_list_assets=_wants_asset_list(lower),
                highlight_on_map=_wants_map_highlight(lower),
            )
        # Nothing selected on the map — fall back to the live viewport.
        return VoiceIntent(
            kind="count",
            asset_kind=asset_kind,
            tier=tier,
            use_viewport=True,
            viewport_explicit=True,
            also_list_assets=_wants_asset_list(lower),
            highlight_on_map=_wants_map_highlight(lower),
        )
    if use_viewport or not place_raw:
        return VoiceIntent(
            kind="count",
            asset_kind=asset_kind,
            tier=tier,
            use_viewport=True,
            viewport_explicit=viewport_explicit,
            also_list_assets=_wants_asset_list(lower),
            highlight_on_map=_wants_map_highlight(lower),
        )
    district, region = _place_slots(place_raw)
    return VoiceIntent(
        kind="count",
        asset_kind=asset_kind,
        tier=tier,
        district=district,
        region=region,
        also_list_assets=_wants_asset_list(lower),
        highlight_on_map=_wants_map_highlight(lower),
    )


def _parse_asset_correction_intent(
    lower: str,
    session: dict[str, Any],
) -> VoiceIntent | None:
    """Re-run the last spatial count with corrected asset kind (e.g. 'I asked about transformers')."""
    if not session.get("last_kind") == "count":
        return None
    # Require a correction cue — bare "tell me about those transformers" is a list follow-up.
    if not re.search(
        r"\b(?:i\s+)?(?:asked|meant|wanted|said)\b.*\b(?:transformers?|poles?|nodes?)\b",
        lower,
    ) and not re.search(
        r"\b(?:transformers?|poles?|nodes?)\b.*\b(?:not\s+poles?|not\s+transformers?)\b",
        lower,
    ):
        return None
    asset_kind = session.get("last_asset_kind") or "pole"
    if "transformer" in lower:
        asset_kind = "transformer"
    elif re.search(r"\bpoles?\b", lower):
        asset_kind = "pole"
    elif "node" in lower:
        asset_kind = "node"
    territory_bbox = session.get("last_bbox")
    if isinstance(territory_bbox, dict):
        territory_bbox = dict(territory_bbox)
    return VoiceIntent(
        kind="count",
        asset_kind=asset_kind,
        tier=session.get("last_tier") or "master",
        district=session.get("last_district"),
        region=session.get("last_region"),
        use_viewport=bool(session.get("last_use_viewport")),
        viewport_explicit=bool(session.get("last_use_viewport")),
        territory_bbox=territory_bbox,
    )


def _parse_list_assets_intent(
    lower: str,
    session: dict[str, Any],
) -> VoiceIntent | None:
    """List/name assets — direct query, highlight confirmation, or pronoun follow-up."""
    # Singular node inspect phrases belong to inspect_node, not list.
    if re.search(
        r"\b(?:tell me about|describe|what is|what's|details? on|info on)\s+"
        r"(?:this|the|selected)\s+(?:node|asset|pole|transformer|substation|bsp)\b",
        lower,
    ) and not re.search(r"\b(?:those|them|these|ones)\b", lower):
        return None
    if re.search(
        r"\b(?:the|this|selected)\s+(?:node|asset)\s+(?:in view|on screen|here|in the view)\b",
        lower,
    ):
        return None

    highlight_confirm = re.match(
        r"^(?:yes|yeah|yep|sure|please|ok|okay)(?:[,.]?\s+(?:please|sure|thanks)?)?"
        r"(?:\s*[,.]?\s*(?:highlight|pin|plot|show)(?:\s+them)?(?:\s+on\s+(?:the\s+)?map)?)?"
        r"[\?.!]*$",
        lower,
        flags=re.I,
    ) or re.match(
        r"^(?:highlight|pin|plot)(?:\s+them|\s+those)?(?:\s+on\s+(?:the\s+)?map)?[\?.!]*$",
        lower,
        flags=re.I,
    )
    follow = re.match(
        r"^(?:can you |could you |please )?(?:name|list|show)(?:\s+me)?\s+"
        r"(?:them|those|the ones|the poles|the assets|the transformers|the nodes)"
        r"[\?.!]*$",
        lower,
        flags=re.I,
    ) or re.match(
        r"^(?:what are they called|what are their names)[\?.!]*$",
        lower,
        flags=re.I,
    ) or re.match(
        # "tell me about those transformers" / "describe them" after a count
        r"^(?:can you |could you |please )?"
        r"(?:tell me about|describe|details? on|info on|information about|what about)\s+"
        r"(?:them|those|these|the ones)"
        r"(?:\s+(?:poles?|assets?|transformers?|nodes?))?"
        r"[\?.!]*$",
        lower,
        flags=re.I,
    )
    direct = re.search(
        r"\b(?:name|list|show|identify|display)(?:\s+me)?\s+"
        r"(?:(?:them|those|these|the ones|the)\s+)?"
        r"(?:poles?|assets?|transformers?|nodes?)\b",
        lower,
    ) or re.search(
        r"\b(?:tell me about|describe|details? on|info on|information about)\s+"
        r"(?:(?:them|those|these|the ones|the)\s+)?"
        r"(?:poles?|assets?|transformers?|nodes?)\b",
        lower,
    )
    if not highlight_confirm and not follow and not direct:
        return None

    asset_kind = session.get("last_asset_kind") or "pole"
    if "transformer" in lower:
        asset_kind = "transformer"
    elif re.search(r"\bpoles?\b", lower):
        asset_kind = "pole"

    use_viewport = bool(session.get("last_use_viewport")) or _is_viewport_scope(lower)
    district = session.get("last_district")
    region = session.get("last_region")
    territory_bbox = session.get("last_bbox")
    highlight_on_map = _wants_map_highlight(lower) or bool(highlight_confirm)

    if highlight_confirm:
        if not session.get("last_kind") or not (
            use_viewport or district or region or territory_bbox
        ):
            return None
        return VoiceIntent(
            kind="list_assets",
            asset_kind=asset_kind,
            tier=session.get("last_tier") or "master",
            district=district,
            region=region,
            use_viewport=use_viewport,
            viewport_explicit=use_viewport,
            territory_bbox=territory_bbox if isinstance(territory_bbox, dict) else None,
            highlight_on_map=True,
        )

    if follow:
        if not session.get("last_kind") or not (
            use_viewport or district or region or territory_bbox
        ):
            return None
    elif direct:
        place_match = re.search(
            r"\b(?:in|at|for|on)\s+(?P<place>.+?)(?:[\?.!]|$)",
            lower,
        )
        if place_match:
            place_raw = _extract_count_place(place_match.group("place"))
            if place_raw and _is_viewport_scope(place_raw):
                use_viewport = True
                district = None
                region = None
            elif place_raw:
                district, region = _place_slots(place_raw)
                use_viewport = False
        elif _is_viewport_scope(lower):
            use_viewport = True
            district = None
            region = None

    if not use_viewport and not district and not region and not territory_bbox:
        return None

    return VoiceIntent(
        kind="list_assets",
        asset_kind=asset_kind,
        tier=session.get("last_tier") or "master",
        district=district,
        region=region,
        use_viewport=use_viewport,
        viewport_explicit=use_viewport,
        territory_bbox=territory_bbox if isinstance(territory_bbox, dict) else None,
        highlight_on_map=highlight_on_map,
    )


def _network_summary_intent_from_text(lower: str) -> VoiceIntent | None:
    """Parse requests for full electrical asset / network summaries in a territory."""
    if "how many" in lower or re.search(r"\bcount\b", lower):
        return None
    patterns = (
        r"(?:tell me about|what are|what's|whats|give me|show me|summarize|summary of)"
        r".{0,48}?(?:electrical\s+)?(?:assets?|network)"
        r".{0,24}?(?:in|at|for|on)\s+(?P<place>.+?)[\?.!]*$",
        r"(?:electrical\s+)?(?:assets?|network(?:\s+summary)?)"
        r".{0,12}?(?:in|at|for|on)\s+(?P<place>.+?)[\?.!]*$",
        r"(?P<place>.+?)\s+(?:electrical\s+)?(?:assets?|network)\s+summary[\?.!]*$",
    )
    place_raw: str | None = None
    for pattern in patterns:
        match = re.search(pattern, lower, flags=re.I)
        if match:
            place_raw = _extract_count_place(match.group("place"))
            break
    if not place_raw:
        return None
    if _is_viewport_scope(place_raw) or _is_viewport_scope(lower):
        return VoiceIntent(
            kind="network_summary",
            tier="master",
            use_viewport=True,
            viewport_explicit=True,
        )
    district, region = _place_slots(place_raw)
    return VoiceIntent(
        kind="network_summary",
        tier="master",
        district=district,
        region=region,
    )


def _parse_describe_viewport_intent(lower: str) -> VoiceIntent | None:
    """Open 'what's on the map / what do you see' → viewport network summary."""
    if "how many" in lower or re.search(r"\bcount\b", lower):
        return None
    # Specific asset / WO questions belong to count/list/work-order parsers.
    if re.search(
        r"\b(?:poles?|transformers?|nodes?|feeders?|work\s*orders?|tickets?)\b",
        lower,
    ):
        return None
    # Keep "what am I looking at" as inspect_node (selected / nearest asset).
    if re.search(r"what am i looking at", lower):
        return None

    patterns = (
        r"what do you see(?:\s+on\s+the\s+map)?",
        r"what can you see(?:\s+on\s+the\s+map)?",
        r"what(?:'s| is|s) on the map",
        r"what(?:'s| is|s) in (?:this |the |my )?(?:map )?view",
        r"what(?:'s| is|s) visible(?:\s+(?:here|on (?:the |this )?map|in (?:the |this )?view))?",
        r"what(?:'s| is|s) in (?:the |this )?visible area",
        r"describe (?:the |this |my )?(?:map(?:\s+view)?|view|current view|visible area)",
        r"describe what you see",
        r"summarize (?:the |this |my )?(?:map(?:\s+view)?|view|current view)",
        r"what(?:'s| is) in (?:the |this )?current map view",
    )
    if not any(re.search(p, lower, flags=re.I) for p in patterns):
        return None
    return VoiceIntent(
        kind="network_summary",
        tier="master",
        use_viewport=True,
        viewport_explicit=True,
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
    # "what would be affected if this node went out"
    if re.search(
        r"\b(?:would be affected|affected if|outage at|went out|goes out|if .+ (?:fails|trips|opens))\b",
        lower,
    ):
        return VoiceIntent(kind="trace_downstream_path")
    return None


def _parse_trace_connection_path_intent(lower: str) -> VoiceIntent | None:
    if re.search(r"\b(?:downstream|impact|affected)\b", lower):
        return None
    # "what connects to it / this node"
    if re.search(r"\bwhat connects to\b", lower):
        return VoiceIntent(kind="trace_connection_path")
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
    if not re.search(r"\b(?:pan|go|fly|zoom|show|take me|open|navigate|nearest|closest)\b", lower):
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
        or re.search(
            r"\b(?:nearest|closest|nearby)\s+work\s*orders?\b",
            lower,
        )
        or re.search(
            r"\b(?:show|open|pan|go|fly)\s+(?:me\s+)?(?:the\s+)?(?:nearest|closest|nearby)\s+work\s*orders?\b",
            lower,
        )
    )
    if not targets_work_order:
        return None
    viewport_explicit = _is_viewport_scope(lower) or bool(
        re.search(r"\b(?:on the map|in view|here|on screen|the map|nearest|closest)\b", lower)
    )
    return VoiceIntent(
        kind="pan_work_order",
        use_viewport=True,
        viewport_explicit=viewport_explicit,
    )


def _parse_inspect_node_intent(lower: str) -> VoiceIntent | None:
    node_words = r"\b(?:node|asset|pole|transformer|substation|bsp)\b"
    connects_to = bool(re.search(r"\bwhat connects to\b", lower))
    if not re.search(node_words, lower) and "looking at" not in lower and not connects_to:
        return None

    # Connection-path questions are handled by trace_connection_path.
    if connects_to:
        return None

    viewport_explicit = _is_viewport_scope(lower)
    on_map = bool(re.search(r"\b(?:in view|on screen|on the map|visible|here|this|selected)\b", lower))

    asks_about = bool(
        re.search(
            r"(?:tell me about|what is|what's|describe|info on|information about|"
            r"what am i looking at|what do i see|details on|about the|"
            r"what kva|what(?:'s| is) the (?:kva|rating))",
            lower,
        )
        or re.search(rf"(?:this|the|selected)\s+{node_words}", lower)
        or re.search(rf"{node_words}\s+(?:in view|on screen|here|selected|in the view)", lower)
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
    from agents.voice_normalize import normalize_transcript

    raw = (text or "").strip()
    if not raw:
        return None
    raw, _ = normalize_transcript(raw)
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

    count_intent = _count_intent_from_text(lower, context=context)
    if count_intent:
        return count_intent

    # Topology before inspect — "downstream from this node" must not become inspect_node.
    trace_downstream_intent = _parse_trace_downstream_path_intent(lower)
    if trace_downstream_intent:
        return trace_downstream_intent

    trace_connection_intent = _parse_trace_connection_path_intent(lower)
    if trace_connection_intent:
        return trace_connection_intent

    trace_feeder_intent = _parse_trace_feeder_intent(raw, lower)
    if trace_feeder_intent:
        return trace_feeder_intent

    # Inspect singular node before list_assets so "node in view" is not stolen.
    inspect_node_intent = _parse_inspect_node_intent(lower)
    if inspect_node_intent:
        return inspect_node_intent

    list_intent = _parse_list_assets_intent(lower, session)
    if list_intent:
        return list_intent

    correction_intent = _parse_asset_correction_intent(lower, session)
    if correction_intent:
        return correction_intent

    network_intent = _network_summary_intent_from_text(lower)
    if network_intent:
        return network_intent

    describe_viewport_intent = _parse_describe_viewport_intent(lower)
    if describe_viewport_intent:
        return describe_viewport_intent

    work_orders_intent = _parse_work_orders_in_view_intent(lower)
    if work_orders_intent:
        return work_orders_intent

    pan_work_order_intent = _parse_pan_work_order_intent(lower)
    if pan_work_order_intent:
        return pan_work_order_intent

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
    if (
        highlight
        and not re.search(r"\bwork\s*orders?\b", lower)
        and _parse_trace_feeder_intent(raw, lower) is None
        # "show me the transformers in X" is list_assets, not territory highlight.
        and not re.match(
            r"^(?:the\s+)?(?:poles?|assets?|transformers?|nodes?)\b",
            (highlight.group("place") or "").strip(),
            flags=re.I,
        )
    ):
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


def _cached_counts(
    conn,
    intent: VoiceIntent,
    bbox: dict[str, float] | None,
    *,
    district: str | None = None,
    region: str | None = None,
) -> dict[str, Any]:
    from agents.spatial_cache import cached_asset_inventory_counts

    use_bbox = bbox is not None and not district and not region
    return cached_asset_inventory_counts(
        conn,
        tier=intent.tier,
        asset_kind=intent.asset_kind,
        district=None if use_bbox else district,
        region=None if use_bbox else region,
        bbox=bbox,
    )


def _format_count_speech(result: dict[str, Any], intent: VoiceIntent, place_label: str) -> str:
    total = int(result.get("pole_total") or result.get("total") or 0)
    if intent.asset_kind == "pole":
        noun = "pole" if total == 1 else "poles"
    elif intent.asset_kind == "pole_11kv":
        noun = "11 kV pole" if total == 1 else "11 kV poles"
    elif intent.asset_kind == "pole_33kv":
        noun = "33 kV pole" if total == 1 else "33 kV poles"
    elif intent.asset_kind == "pole_lv":
        noun = "LV pole" if total == 1 else "LV poles"
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


def _buffer_road_bbox(bbox: dict[str, float], *, buffer_deg: float = 0.0015) -> dict[str, float]:
    """Widen a short OSM road segment bbox for along-road asset counts (~150 m)."""
    return {
        "west": float(bbox["west"]) - buffer_deg,
        "south": float(bbox["south"]) - buffer_deg,
        "east": float(bbox["east"]) + buffer_deg,
        "north": float(bbox["north"]) + buffer_deg,
    }


def _count_place_label(
    intent: VoiceIntent,
    context: dict[str, Any],
    *,
    district: str | None,
    region: str | None,
    bbox: dict[str, float] | None,
) -> str:
    resolved = intent.resolved_place or {}
    matched = resolved.get("matched_as")
    source = str(resolved.get("source") or "")
    if matched and source in ("osm_road", "osm", "alias_exact", "alias"):
        label = str(matched)
        return label.title() if label.islower() else label
    sel_d, sel_r = portal_selected_territory(context)
    raw = (
        intent.district
        or intent.region
        or district
        or region
        or sel_d
        or sel_r
        or ("this map view" if intent.use_viewport and intent.viewport_explicit else None)
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
        elif meta.get("source") == "osm_road":
            territory_bbox = _buffer_road_bbox(territory_bbox)
            resolved_district = None
            resolved_region = None
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
        also_list_assets=intent.also_list_assets,
        highlight_on_map=intent.highlight_on_map,
    ), None


def _format_network_summary_speech(summary: dict[str, Any], place_label: str) -> str:
    structured = summary.get("structured") or {}
    total = int(structured.get("electrical_assets_total") or summary.get("electrical_assets_total") or 0)
    nodes = int(structured.get("nodes_total") or (summary.get("nodes") or {}).get("total") or 0)
    lines = int(structured.get("lines_total") or (summary.get("lines") or {}).get("total") or 0)
    return (
        f"{place_label} has about {total:,} electrical assets: "
        f"{nodes:,} nodes and {lines:,} lines."
    )


def _spatial_query_scope(
    conn,
    intent: VoiceIntent,
    context: dict[str, Any],
) -> tuple[dict[str, float] | None, str | None, str | None]:
    bbox, district, region = portal_count_scope(
        use_viewport=intent.use_viewport,
        territory_bbox=intent.territory_bbox,
        district=intent.district,
        region=intent.region,
        context=context,
        allow_selected_territory=intent.viewport_explicit,
    )
    if intent.use_viewport and not bbox and not district and not region:
        bbox = portal_spatial_bbox(conn, context)
    return bbox, district, region


def _list_assets_page(
    conn,
    intent: VoiceIntent,
    *,
    bbox: dict[str, float] | None,
    district: str | None,
    region: str | None,
    limit: int = 25,
) -> dict[str, Any]:
    from agents import spatial

    return spatial.list_assets_in_territory(
        conn,
        tier=intent.tier,
        asset_kind=intent.asset_kind,
        district=district,
        region=region,
        bbox=bbox,
        limit=limit,
    )


def _list_assets_map_ui(
    page: dict[str, Any],
    *,
    place_label: str,
) -> list[dict[str, Any]]:
    """Highlight listed assets on the map (orange pins) and frame them."""
    from agents.spatial import assets_to_map_highlight_ui

    kind = (page.get("asset_kind_filter") or "asset").replace("_", " ")
    total = int(page.get("total") or 0)
    label = f"{total:,} {kind}s in {place_label}" if total else place_label
    ui = assets_to_map_highlight_ui(page, label=label, tab="map")
    return [ui] if ui else []


def _format_list_assets_speech(
    page: dict[str, Any],
    place_label: str,
    *,
    highlighted: bool = False,
) -> str:
    assets = page.get("assets") or []
    total = int(page.get("total") or 0)
    if total == 0:
        return f"No matching assets in {place_label}."
    names: list[str] = []
    for item in assets[:5]:
        name = (item.get("name") or "").strip() or str(item.get("mrid") or "asset")
        rated = item.get("rated_power_kva")
        if rated is not None:
            names.append(f"{name} ({float(rated):g} kVA)")
        else:
            names.append(name)
    joined = ", ".join(names)
    shown = len(assets)
    if highlighted:
        if total > shown:
            return (
                f"I've highlighted {shown} of {total:,} on the map in {place_label}, "
                f"including {joined}, and others."
            )
        if len(names) == 1:
            return f"I've highlighted 1 asset in {place_label} on the map: {joined}."
        return f"I've highlighted {total:,} assets in {place_label} on the map: {joined}."
    if total > shown:
        base = (
            f"Here are {shown} of {total:,} in {place_label}, including {joined}, and others."
        )
    elif len(names) == 1:
        base = f"There is 1 asset in {place_label}: {joined}."
    else:
        base = f"Here are {total:,} assets in {place_label}: {joined}."
    return f"{base} Want me to highlight them on the map?"


def _spatial_session_patch(
    session_patch: dict[str, Any],
    intent: VoiceIntent,
    bbox: dict[str, float] | None,
) -> dict[str, Any]:
    patch = dict(session_patch)
    patch["last_use_viewport"] = bool(intent.use_viewport and bbox)
    if bbox:
        patch["last_bbox"] = bbox
    return patch


def _is_unresolved_road_place(intent: VoiceIntent) -> bool:
    place = (intent.district or intent.region or "").strip()
    if not place or intent.use_viewport or intent.resolved_place:
        return False
    return bool(
        re.search(
            r"\b(?:road|rd|street|st|avenue|ave|highway|lane|dr|drive|boulevard|blvd)\b",
            place,
            flags=re.I,
        )
    )


def _try_repair_road_intent(
    conn,
    intent: VoiceIntent,
    *,
    original_query: str,
    context: dict[str, Any],
) -> VoiceIntent | None:
    """Salvage garbled road queries via cleanup rules, map context, then LLM."""
    from agents.copilot_query import (
        map_context_city_hint,
        place_query_with_city,
        salvage_place_name,
        try_llm_spatial_intent,
    )

    place = intent.district or intent.region
    city_hint = map_context_city_hint(context)
    candidates: list[str] = []

    salvaged = salvage_place_name(place, original_query)
    if salvaged:
        candidates.append(salvaged)
        if city_hint:
            candidates.append(place_query_with_city(salvaged, city_hint))

    llm = try_llm_spatial_intent(original_query, context=context)
    if llm and str(llm.get("intent") or "").lower() == "count":
        place_name = str(llm.get("place_name") or "").strip()
        llm_city = str(llm.get("city") or "").strip() or city_hint
        if place_name:
            candidates.insert(0, place_name)
            if llm_city:
                candidates.insert(0, place_query_with_city(place_name, llm_city))
        asset_raw = str(llm.get("asset_kind") or "").strip().lower()
        if asset_raw in ("pole", "poles", "transformer", "transformers", "node", "nodes"):
            intent = VoiceIntent(
                kind=intent.kind,
                asset_kind="pole" if asset_raw.startswith("pole") else asset_raw.rstrip("s"),
                tier=intent.tier,
                district=intent.district,
                region=intent.region,
                use_viewport=intent.use_viewport,
                viewport_explicit=intent.viewport_explicit,
                territory_bbox=intent.territory_bbox,
                resolved_place=intent.resolved_place,
                zoom_close=intent.zoom_close,
                zoom_delta=intent.zoom_delta,
                also_list_assets=intent.also_list_assets,
                highlight_on_map=intent.highlight_on_map,
            )

    seen: set[str] = set()
    for cand in candidates:
        key = cand.lower()
        if not cand or key in seen:
            continue
        seen.add(key)
        trial = VoiceIntent(
            kind=intent.kind,
            asset_kind=intent.asset_kind,
            tier=intent.tier,
            district=cand,
            region=None,
            use_viewport=intent.use_viewport,
            viewport_explicit=intent.viewport_explicit,
            territory_bbox=intent.territory_bbox,
            resolved_place=None,
            zoom_close=intent.zoom_close,
            zoom_delta=intent.zoom_delta,
            also_list_assets=intent.also_list_assets,
            highlight_on_map=intent.highlight_on_map,
        )
        repaired, clarify = _apply_resolved_place(conn, trial)
        if clarify or not repaired.resolved_place:
            continue
        return repaired
    return None


def _friendly_road_error_label(place: str | None, original_query: str) -> str:
    from agents.copilot_query import extract_road_name, salvage_place_name

    label = salvage_place_name(place, original_query) or extract_road_name(original_query)
    if label:
        return label.title() if label.islower() else label
    return "that street"


def _territory_map_ui_actions(
    intent: VoiceIntent,
    *,
    bbox: dict[str, float] | None,
) -> list[dict[str, Any]]:
    """Pan/highlight the map for count/list answers so 'show me' is visible."""
    from agents.place_resolve import place_viewport_ui_action

    actions: list[dict[str, Any]] = []
    if intent.resolved_place:
        ui = place_viewport_ui_action(
            intent.resolved_place,
            mode="pan",
            tab="map",
        )
        if ui:
            actions.append(ui)
            return actions
    if bbox and all(bbox.get(k) is not None for k in ("west", "south", "east", "north")):
        actions.append(
            {
                "type": "fit_bounds",
                "tab": "map",
                "bbox": {
                    "west": float(bbox["west"]),
                    "south": float(bbox["south"]),
                    "east": float(bbox["east"]),
                    "north": float(bbox["north"]),
                },
            }
        )
    return actions


def execute_fast_path(
    conn,
    intent: VoiceIntent,
    *,
    context: dict[str, Any],
    request_id: str | None = None,
) -> dict[str, Any] | None:
    from agents.copilot_progress import push_progress, complete_progress

    push_progress(request_id, "Matching your request")
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
        if _is_unresolved_road_place(intent):
            original_query = str(context.get("_copilot_query") or "")
            repaired = _try_repair_road_intent(
                conn,
                intent,
                original_query=original_query,
                context=context,
            )
            if repaired:
                intent = repaired
            else:
                place = _friendly_road_error_label(
                    intent.district or intent.region,
                    original_query,
                )
                asset = intent.asset_kind or "assets"
                if asset == "transformer":
                    asset_phrase = "transformers"
                elif asset in ("pole", "poles"):
                    asset_phrase = "poles"
                else:
                    asset_phrase = asset.replace("_", " ") + "s"
                speak = (
                    f"I couldn't locate {place} on the map. "
                    f"Zoom the map to that street and ask “how many {asset_phrase} in view”, "
                    "or try a nearby district name."
                )
                complete_progress(request_id, "Place not found")
                return {
                    "content": speak,
                    "speak": speak,
                    "ui_actions": ui_actions,
                    "session_patch": session_patch,
                    "fast_path": True,
                    "data": {"error": "road_not_found", "place": place},
                }

        bbox, count_district, count_region = _spatial_query_scope(conn, intent, context)
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
        from agents.spatial import format_asset_inventory_text, format_list_assets_text

        if intent.asset_kind in ("pole", "poles", "pole_11kv", "pole_33kv", "pole_lv", "transformer", "transformers"):
            content = format_asset_inventory_text(
                result,
                place_label=place_label,
                asset_kind=intent.asset_kind,
            )
        else:
            content = speak
        if result.get("cached"):
            content += "\n\n(cached count)"

        if intent.also_list_assets:
            push_progress(request_id, "Listing assets")
            page = _list_assets_page(
                conn,
                intent,
                bbox=bbox,
                district=count_district,
                region=count_region,
                limit=25,
            )
            content = f"{content}\n\n{format_list_assets_text(page, place_label=place_label)}"
            if intent.highlight_on_map:
                ui_actions.extend(_list_assets_map_ui(page, place_label=place_label))
                speak = _format_list_assets_speech(
                    page, place_label, highlighted=True
                )
            else:
                speak = _format_list_assets_speech(
                    page, place_label, highlighted=False
                )
                content = (
                    f"{content}\n\nWant me to highlight them on the map?"
                )
        elif not intent.use_viewport:
            ui_actions.extend(_territory_map_ui_actions(intent, bbox=bbox))

        complete_progress(request_id, "Count ready")
        return {
            "content": content,
            "speak": speak,
            "ui_actions": ui_actions,
            "session_patch": _spatial_session_patch(session_patch, intent, bbox),
            "fast_path": True,
            "data": result,
        }

    if intent.kind == "list_assets":
        bbox, list_district, list_region = _spatial_query_scope(conn, intent, context)
        if not intent.use_viewport and not list_district and not list_region and not bbox:
            return {
                "content": (
                    "I need an area to list assets — try counting poles in view first, "
                    "or ask e.g. “list poles in Nima”."
                ),
                "speak": "I need an area to list assets. Count poles in view first, then ask me to name them.",
                "ui_actions": ui_actions,
                "session_patch": session_patch,
                "fast_path": True,
                "data": {},
            }

        push_progress(request_id, "Listing assets")
        page = _list_assets_page(
            conn,
            intent,
            bbox=bbox,
            district=list_district,
            region=list_region,
            limit=25,
        )
        place_label = _count_place_label(
            intent,
            context,
            district=list_district,
            region=list_region,
            bbox=bbox,
        )
        from agents.spatial import format_list_assets_text

        content = format_list_assets_text(page, place_label=place_label)
        if intent.highlight_on_map:
            ui_actions.extend(_list_assets_map_ui(page, place_label=place_label))
            speak = _format_list_assets_speech(page, place_label, highlighted=True)
        else:
            speak = _format_list_assets_speech(page, place_label, highlighted=False)
            content = f"{content}\n\nWant me to highlight them on the map?"
        if not ui_actions and not intent.use_viewport and intent.highlight_on_map:
            ui_actions.extend(_territory_map_ui_actions(intent, bbox=bbox))
        complete_progress(request_id, "List ready")
        return {
            "content": content,
            "speak": speak,
            "ui_actions": ui_actions,
            "session_patch": _spatial_session_patch(
                {**session_patch, "last_kind": "list_assets"},
                intent,
                bbox,
            ),
            "fast_path": True,
            "data": page,
        }

    if intent.kind == "network_summary":
        from agents import spatial

        push_progress(request_id, "Resolving territory")
        bbox, summary_district, summary_region = _spatial_query_scope(conn, intent, context)
        result = spatial.territory_network_summary(
            conn,
            tier=intent.tier,
            district=summary_district,
            region=summary_region,
            bbox=bbox,
        )
        place_label = _count_place_label(
            intent,
            context,
            district=summary_district,
            region=summary_region,
            bbox=bbox,
        )
        content = result.get("formatted_summary") or _format_network_summary_speech(result, place_label)
        speak = _format_network_summary_speech(result, place_label)
        complete_progress(request_id, "Summary ready")
        return {
            "content": content,
            "speak": speak,
            "ui_actions": ui_actions,
            "session_patch": session_patch,
            "fast_path": True,
            "data": result,
            "structured": result.get("structured"),
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
    request_id: str | None = None,
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
    exec_ctx["_copilot_query"] = message
    if session:
        if session.get("last_mrid"):
            exec_ctx.setdefault("last_mrid", session["last_mrid"])
        if session.get("last_feeder_id"):
            exec_ctx.setdefault("last_feeder_id", session["last_feeder_id"])
    fast = execute_fast_path(conn, intent, context=exec_ctx, request_id=request_id)
    return intent, fast
