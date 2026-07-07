"""Post-STT normalization for Ghana ECG GIS voice commands."""

from __future__ import annotations

import re
from typing import Any

from agents.copilot_query import normalize_road_spelling, sanitize_copilot_query

# Common Whisper mishearings for Ghana place / GIS terms.
_MISHEARING_MAP: dict[str, str] = {
    "a car": "Accra",
    "acar": "Accra",
    "a kra": "Accra",
    "akra": "Accra",
    "a crah": "Accra",
    "acrah": "Accra",
    "acc raw": "Accra",
    "accra.": "Accra",
    "cool massey": "Kumasi",
    "koo massey": "Kumasi",
    "koo masi": "Kumasi",
    "come massey": "Kumasi",
    "tam ale": "Tamale",
    "tama le": "Tamale",
    "te ma": "Tema",
    "tea ma": "Tema",
    "poku ase": "Pokuase",
    "pokuase": "Pokuase",
    "po kuase": "Pokuase",
    "madina": "Madina",
    "ma dina": "Madina",
    "kasoa": "Kasoa",
    "ka soa": "Kasoa",
    "gbawe": "Gbawe",
    "g bawe": "Gbawe",
    "roman ridge": "Roman Ridge",
    "romanridge": "Roman Ridge",
    "roman rich": "Roman Ridge",
    "takoradi": "Takoradi",
    "tako radi": "Takoradi",
    "cape coast": "Cape Coast",
    "sunyani": "Sunyani",
    "ho municipality": "Ho",
}

# Never fuzzy-correct these — they are copilot command tokens, not place names.
_COMMAND_WORDS = frozenset(
    {
        "a",
        "an",
        "the",
        "and",
        "are",
        "at",
        "for",
        "here",
        "how",
        "in",
        "is",
        "many",
        "map",
        "me",
        "of",
        "on",
        "this",
        "to",
        "view",
        "area",
        "count",
        "display",
        "emphasize",
        "elements",
        "feeder",
        "field",
        "fly",
        "go",
        "highlight",
        "number",
        "open",
        "pan",
        "poles",
        "pole",
        "show",
        "staging",
        "transformers",
        "transformer",
        "work",
        "zoom",
        "captures",
        "capture",
        "nodes",
        "node",
        "assets",
        "asset",
        "district",
        "region",
        "order",
        "current",
    }
)

# Static Ghana ECG vocabulary for Whisper initial_prompt (keep under ~220 tokens).
DEFAULT_STT_INITIAL_PROMPT = (
    "Ghana ECG GIS voice commands. Districts and cities: "
    "Accra, Kumasi, Tamale, Tema, Takoradi, Cape Coast, Sunyani, Ho, "
    "Pokuase, Madina, Kasoa, Gbawe, Ablekuma, Ashaiman, Legon, Osu, "
    "Adenta, Teshie, Nungua, La, Spintex, East Legon, Roman Ridge, Kotobabi. "
    "Terms: feeder, district, region, poles, transformers, staging, "
    "work order, trace feeder, show on map, how many assets."
)

_boundary_names_cache: list[str] | None = None


def default_initial_prompt() -> str:
    return DEFAULT_STT_INITIAL_PROMPT


def register_boundary_names(names: list[str]) -> None:
    """Append DB district/region names to the cached prompt vocabulary."""
    global _boundary_names_cache
    cleaned = sorted({n.strip() for n in names if n and n.strip()})
    if not cleaned:
        return
    _boundary_names_cache = cleaned


def build_initial_prompt(extra_names: list[str] | None = None) -> str:
    base = DEFAULT_STT_INITIAL_PROMPT
    extras: list[str] = []
    if _boundary_names_cache:
        extras.extend(_boundary_names_cache[:40])
    if extra_names:
        extras.extend(n.strip() for n in extra_names if n and n.strip())
    if not extras:
        return base
    unique = sorted({n for n in extras if n.lower() not in base.lower()})
    if not unique:
        return base
    return f"{base} Also: {', '.join(unique[:60])}."


def _apply_mishearing_map(text: str) -> tuple[str, list[str]]:
    out = text
    fixes: list[str] = []
    lower = out.lower()
    for wrong, right in sorted(_MISHEARING_MAP.items(), key=lambda kv: -len(kv[0])):
        if wrong not in lower:
            continue
        pattern = re.compile(re.escape(wrong), re.IGNORECASE)
        if not pattern.search(out):
            continue
        out = pattern.sub(right, out)
        fixes.append(f"{wrong!r}→{right!r}")
        lower = out.lower()
    return out, fixes


def _title_case_places(text: str) -> str:
    """Restore canonical casing for known place names."""
    out = text
    for canonical in {
        "Accra",
        "Kumasi",
        "Tamale",
        "Tema",
        "Takoradi",
        "Cape Coast",
        "Sunyani",
        "Pokuase",
        "Madina",
        "Kasoa",
        "Gbawe",
        "Ablekuma",
        "Ashaiman",
        "Ho",
        "Roman Ridge",
    }:
        out = re.sub(rf"\b{re.escape(canonical)}\b", canonical, out, flags=re.IGNORECASE)
    return out


def _levenshtein_leq_one(a: str, b: str) -> bool:
    """True when edit distance is 0 or 1 (insert/delete/substitute)."""
    if a == b:
        return True
    la, lb = len(a), len(b)
    if abs(la - lb) > 1:
        return False
    # Ensure a is the shorter or equal string.
    if la > lb:
        a, b = b, a
        la, lb = lb, la
    i = j = edits = 0
    while i < la and j < lb:
        if a[i] == b[j]:
            i += 1
            j += 1
            continue
        if edits == 1:
            return False
        edits = 1
        if la == lb:
            i += 1
            j += 1
        elif la < lb:
            j += 1
        else:
            i += 1
    return edits + (lb - j) + (la - i) <= 1


def _fuzzy_place_fixes(text: str, names: list[str]) -> tuple[str, list[str]]:
    """
    Correct likely place typos one word at a time.

    Only touches tokens that are not command words. Each original token is
    considered at most once — no chained rewrites across the vocabulary.
    """
    if not names:
        return text, []
    vocab = sorted({n.strip() for n in names if n and len(n.strip()) >= 3})
    if not vocab:
        return text, []

    fixes: list[str] = []
    words = text.split()
    for i, word in enumerate(words):
        bare = re.sub(r"[^\w'-]", "", word)
        w = bare.lower()
        if not w or w in _COMMAND_WORDS or len(w) < 4:
            continue
        if any(w == v.lower() for v in vocab):
            continue
        for candidate in vocab:
            c = candidate.lower()
            if w == c:
                break
            if _levenshtein_leq_one(w, c):
                words[i] = candidate
                fixes.append(f"{bare!r}→{candidate!r}")
                break
    return " ".join(words), fixes


def normalize_transcript(
    text: str,
    *,
    boundary_names: list[str] | None = None,
) -> tuple[str, dict[str, Any]]:
    """Fix common STT errors before voice intent / steward chat."""
    raw = " ".join((text or "").split()).strip()
    if not raw:
        return raw, {"raw": raw, "fixes": []}

    normalized = sanitize_copilot_query(raw)
    if normalized != raw:
        fixes_prefix: list[str] = ["query_sanitized"]
    else:
        fixes_prefix = []
    normalized, fixes = _apply_mishearing_map(normalized)
    fixes = fixes_prefix + fixes
    normalized = _title_case_places(normalized)

    names = boundary_names if boundary_names is not None else _boundary_names_cache
    if names:
        normalized, fuzzy_fixes = _fuzzy_place_fixes(normalized, names)
        fixes.extend(fuzzy_fixes)

    meta: dict[str, Any] = {"raw": raw, "fixes": fixes}
    if fixes:
        meta["normalized"] = True
    return normalized, meta
