"""Local speech-to-text for voice copilot (offline — no Google STT)."""

from __future__ import annotations

import os
import tempfile
from pathlib import Path
from typing import Any

from agents.voice_normalize import build_initial_prompt

VOICE_STT_MODEL = os.getenv("VOICE_STT_MODEL", "small")
VOICE_STT_DEVICE = os.getenv("VOICE_STT_DEVICE", "cpu")
VOICE_STT_COMPUTE_TYPE = os.getenv("VOICE_STT_COMPUTE_TYPE", "int8")
VOICE_STT_LANGUAGE = os.getenv("VOICE_STT_LANGUAGE", "en")
VOICE_STT_BEAM_SIZE = max(1, int(os.getenv("VOICE_STT_BEAM_SIZE", "8")))
VOICE_STT_PATIENCE = max(0.0, float(os.getenv("VOICE_STT_PATIENCE", "1.2")))
VOICE_STT_INITIAL_PROMPT = os.getenv("VOICE_STT_INITIAL_PROMPT", "").strip()

_model: Any = None
_model_load_error: str | None = None
_boundary_prompt_loaded = False


def is_available() -> bool:
    try:
        import faster_whisper  # noqa: F401

        return True
    except ImportError:
        return False


def _initial_prompt() -> str:
    if VOICE_STT_INITIAL_PROMPT:
        return VOICE_STT_INITIAL_PROMPT
    return build_initial_prompt()


def status() -> dict[str, Any]:
    prompt = _initial_prompt()
    return {
        "mode": "local",
        "available": is_available(),
        "model": VOICE_STT_MODEL,
        "device": VOICE_STT_DEVICE,
        "language": VOICE_STT_LANGUAGE,
        "beam_size": VOICE_STT_BEAM_SIZE,
        "patience": VOICE_STT_PATIENCE,
        "initial_prompt_chars": len(prompt),
        "initial_prompt_preview": prompt[:120] + ("…" if len(prompt) > 120 else ""),
        "load_error": _model_load_error,
        "hint": (
            None
            if is_available()
            else "Install: pip install faster-whisper (and system ffmpeg)"
        ),
    }


def warm_boundary_prompt(conn) -> None:
    """Load district/region names once to enrich Whisper initial_prompt."""
    global _boundary_prompt_loaded
    if _boundary_prompt_loaded or VOICE_STT_INITIAL_PROMPT:
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
        # Non-fatal — static prompt still applies.
        _boundary_prompt_loaded = True


def _get_model():
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


def warm_model() -> None:
    """Preload the Whisper model so the first voice command isn't multi-second."""
    if not is_available():
        return
    try:
        _get_model()
    except Exception:
        # Recorded in _model_load_error; surfaced via status().
        pass


def transcribe_audio(data: bytes, *, content_type: str | None = None) -> str:
    """Transcribe recorded audio bytes (webm/wav/ogg) to text."""
    if not data:
        raise ValueError("Empty audio")
    suffix = ".webm"
    if content_type:
        low = content_type.lower()
        if "wav" in low:
            suffix = ".wav"
        elif "ogg" in low:
            suffix = ".ogg"
        elif "mp4" in low or "m4a" in low:
            suffix = ".m4a"

    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        tmp.write(data)
        path = tmp.name

    try:
        model = _get_model()
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
