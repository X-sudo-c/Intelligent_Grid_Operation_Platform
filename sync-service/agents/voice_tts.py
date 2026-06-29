"""Supertonic TTS client — proxies to local `supertonic serve` HTTP API."""

from __future__ import annotations

import os
from typing import Any

import requests

SUPERTONIC_URL = (os.getenv("SUPERTONIC_URL") or "http://127.0.0.1:7788").rstrip("/")
SUPERTONIC_VOICE = os.getenv("SUPERTONIC_VOICE") or "F1"
SUPERTONIC_LANG = os.getenv("SUPERTONIC_LANG") or "en"
SUPERTONIC_TIMEOUT_SEC = float(os.getenv("SUPERTONIC_TIMEOUT_SEC", "30"))


def status() -> dict[str, Any]:
    available = is_available()
    return {
        "enabled": bool(SUPERTONIC_URL),
        "available": available,
        "url": SUPERTONIC_URL,
        "voice": SUPERTONIC_VOICE,
        "lang": SUPERTONIC_LANG,
    }


def is_available() -> bool:
    if not SUPERTONIC_URL:
        return False
    try:
        resp = requests.get(f"{SUPERTONIC_URL}/docs", timeout=2)
        return resp.status_code == 200
    except requests.RequestException:
        return False


def synthesize_wav(text: str) -> bytes | None:
    """Return WAV bytes or None if Supertonic is unreachable."""
    cleaned = (text or "").strip()
    if not cleaned or not SUPERTONIC_URL:
        return None
    try:
        resp = requests.post(
            f"{SUPERTONIC_URL}/v1/audio/speech",
            json={
                "model": "supertonic-3",
                "input": cleaned,
                "voice": SUPERTONIC_VOICE,
                "lang": SUPERTONIC_LANG,
                "response_format": "wav",
            },
            timeout=SUPERTONIC_TIMEOUT_SEC,
        )
        if resp.status_code != 200:
            return None
        return resp.content
    except requests.RequestException:
        return None
