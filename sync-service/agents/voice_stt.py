"""Speech-to-text for voice copilot — OpenAI API (low latency; no local Whisper by default)."""

from __future__ import annotations

import os
import tempfile
from pathlib import Path
from typing import Any

import requests

from agents.voice_normalize import build_initial_prompt

VOICE_STT_PROVIDER = os.getenv("VOICE_STT_PROVIDER", "openai").strip().lower()
VOICE_STT_MODEL = os.getenv("VOICE_STT_MODEL", "gpt-4o-mini-transcribe")
VOICE_STT_DEVICE = os.getenv("VOICE_STT_DEVICE", "cpu")
VOICE_STT_COMPUTE_TYPE = os.getenv("VOICE_STT_COMPUTE_TYPE", "int8")
VOICE_STT_LANGUAGE = os.getenv("VOICE_STT_LANGUAGE", "en")
VOICE_STT_BEAM_SIZE = max(1, int(os.getenv("VOICE_STT_BEAM_SIZE", "8")))
VOICE_STT_PATIENCE = max(0.0, float(os.getenv("VOICE_STT_PATIENCE", "1.2")))
VOICE_STT_INITIAL_PROMPT = os.getenv("VOICE_STT_INITIAL_PROMPT", "").strip()
VOICE_STT_BASE_URL = (
    os.getenv("VOICE_STT_BASE_URL") or os.getenv("GIOP_LLM_BASE_URL") or "https://api.openai.com/v1"
).rstrip("/")
VOICE_STT_TIMEOUT_SEC = max(5, int(os.getenv("VOICE_STT_TIMEOUT_SEC", "30")))

_model: Any = None
_model_load_error: str | None = None
_boundary_prompt_loaded = False


def _api_key() -> str:
    return (
        os.getenv("VOICE_STT_API_KEY")
        or os.getenv("GIOP_LLM_API_KEY")
        or os.getenv("OPENAI_API_KEY")
        or ""
    ).strip()


def active_provider() -> str:
    """Resolved STT backend: openai | local."""
    if VOICE_STT_PROVIDER == "openai":
        return "openai"
    if VOICE_STT_PROVIDER == "local":
        return "local"
    # auto — prefer OpenAI when a key is configured (much faster than CPU Whisper).
    if _api_key():
        return "openai"
    return "local"


def _local_whisper_imported() -> bool:
    try:
        import faster_whisper  # noqa: F401

        return True
    except ImportError:
        return False


def is_available() -> bool:
    if active_provider() == "openai":
        return bool(_api_key())
    return _local_whisper_imported()


def _initial_prompt() -> str:
    if VOICE_STT_INITIAL_PROMPT:
        return VOICE_STT_INITIAL_PROMPT
    return build_initial_prompt()


def status() -> dict[str, Any]:
    provider = active_provider()
    prompt = _initial_prompt()
    base: dict[str, Any] = {
        "provider": provider,
        "available": is_available(),
        "model": VOICE_STT_MODEL,
        "language": VOICE_STT_LANGUAGE,
        "initial_prompt_chars": len(prompt),
        "initial_prompt_preview": prompt[:120] + ("…" if len(prompt) > 120 else ""),
    }
    if provider == "openai":
        base.update(
            {
                "mode": "openai",
                "base_url": VOICE_STT_BASE_URL,
                "hint": None if is_available() else "Set GIOP_LLM_API_KEY or VOICE_STT_API_KEY",
            }
        )
        return base
    base.update(
        {
            "mode": "local",
            "device": VOICE_STT_DEVICE,
            "beam_size": VOICE_STT_BEAM_SIZE,
            "patience": VOICE_STT_PATIENCE,
            "load_error": _model_load_error,
            "hint": (
                None
                if _local_whisper_imported()
                else "Install: pip install faster-whisper (and system ffmpeg)"
            ),
        }
    )
    return base


def warm_boundary_prompt(conn) -> None:
    """Load district/region names once to enrich Whisper initial_prompt."""
    global _boundary_prompt_loaded
    if _boundary_prompt_loaded or VOICE_STT_INITIAL_PROMPT:
        return
    if active_provider() == "openai":
        _boundary_prompt_loaded = True
        return
    try:
        from agents.voice_normalize import register_boundary_names

        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT DISTINCT district FROM gis.ecg_admin_boundaries
                WHERE district IS NOT NULL AND district <> ''
                UNION
                SELECT DISTINCT region FROM gis.ecg_admin_boundaries
                WHERE region IS NOT NULL AND region <> ''
                ORDER BY 1
                LIMIT 120
                """
            )
            names = [row[0] for row in cur.fetchall() if row and row[0]]
        register_boundary_names(names)
        _boundary_prompt_loaded = True
    except Exception:
        _boundary_prompt_loaded = True


def _suffix_for_content_type(content_type: str | None) -> str:
    if not content_type:
        return ".webm"
    low = content_type.lower()
    if "wav" in low:
        return ".wav"
    if "ogg" in low:
        return ".ogg"
    if "mp4" in low or "m4a" in low:
        return ".m4a"
    return ".webm"


def _mime_for_suffix(suffix: str) -> str:
    if suffix == ".wav":
        return "audio/wav"
    if suffix == ".ogg":
        return "audio/ogg"
    if suffix == ".m4a":
        return "audio/mp4"
    return "audio/webm"


def _transcribe_openai(data: bytes, *, content_type: str | None = None) -> str:
    api_key = _api_key()
    if not api_key:
        raise RuntimeError("OpenAI STT not configured — set GIOP_LLM_API_KEY or VOICE_STT_API_KEY")

    suffix = _suffix_for_content_type(content_type)
    mime = content_type or _mime_for_suffix(suffix)
    prompt = _initial_prompt()
    form_data: dict[str, str] = {
        "model": VOICE_STT_MODEL,
        "response_format": "json",
    }
    if VOICE_STT_LANGUAGE:
        form_data["language"] = VOICE_STT_LANGUAGE
    if prompt:
        form_data["prompt"] = prompt[:900]

    resp = requests.post(
        f"{VOICE_STT_BASE_URL}/audio/transcriptions",
        headers={"Authorization": f"Bearer {api_key}"},
        files={"file": (f"audio{suffix}", data, mime)},
        data=form_data,
        timeout=VOICE_STT_TIMEOUT_SEC,
    )
    if resp.status_code >= 400:
        detail = resp.text[:500]
        try:
            err = resp.json().get("error") or {}
            detail = err.get("message") or detail
        except Exception:
            pass
        raise RuntimeError(f"OpenAI transcription failed: {detail}")

    payload = resp.json()
    text = str(payload.get("text") or "").strip()
    if not text:
        raise ValueError("No speech detected — speak closer to the mic and try again")
    return text


def _get_local_model():
    global _model, _model_load_error
    if _model is not None:
        return _model
    if _model_load_error:
        raise RuntimeError(_model_load_error)
    try:
        from faster_whisper import WhisperModel
    except ImportError as exc:
        _model_load_error = (
            "faster-whisper not installed — run: pip install faster-whisper"
        )
        raise RuntimeError(_model_load_error) from exc
    try:
        _model = WhisperModel(
            VOICE_STT_MODEL,
            device=VOICE_STT_DEVICE,
            compute_type=VOICE_STT_COMPUTE_TYPE,
        )
        return _model
    except Exception as exc:
        _model_load_error = str(exc)
        raise


def _transcribe_local(data: bytes, *, content_type: str | None = None) -> str:
    suffix = _suffix_for_content_type(content_type)
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        tmp.write(data)
        path = tmp.name

    try:
        model = _get_local_model()
        segments, _info = model.transcribe(
            path,
            language=VOICE_STT_LANGUAGE or None,
            beam_size=VOICE_STT_BEAM_SIZE,
            patience=VOICE_STT_PATIENCE,
            vad_filter=True,
            initial_prompt=_initial_prompt() or None,
            condition_on_previous_text=False,
        )
        parts = [seg.text.strip() for seg in segments if seg.text.strip()]
        text = " ".join(parts).strip()
        if not text:
            raise ValueError("No speech detected — speak closer to the mic and try again")
        return text
    finally:
        try:
            Path(path).unlink(missing_ok=True)
        except OSError:
            pass


def warm_model() -> None:
    """Preload local Whisper — no-op for OpenAI STT."""
    if active_provider() != "local" or not _local_whisper_imported():
        return
    try:
        _get_local_model()
    except Exception:
        pass


def transcribe_audio(data: bytes, *, content_type: str | None = None) -> str:
    """Transcribe recorded audio bytes (webm/wav/ogg) to text."""
    if not data:
        raise ValueError("Empty audio")
    if active_provider() == "openai":
        return _transcribe_openai(data, content_type=content_type)
    return _transcribe_local(data, content_type=content_type)
