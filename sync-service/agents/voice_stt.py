"""Local speech-to-text for voice copilot (offline — no Google STT)."""

from __future__ import annotations

import os
import tempfile
from pathlib import Path
from typing import Any

VOICE_STT_MODEL = os.getenv("VOICE_STT_MODEL", "base")
VOICE_STT_DEVICE = os.getenv("VOICE_STT_DEVICE", "cpu")
VOICE_STT_COMPUTE_TYPE = os.getenv("VOICE_STT_COMPUTE_TYPE", "int8")
VOICE_STT_LANGUAGE = os.getenv("VOICE_STT_LANGUAGE", "en")

_model: Any = None
_model_load_error: str | None = None


def is_available() -> bool:
    try:
        import faster_whisper  # noqa: F401

        return True
    except ImportError:
        return False


def status() -> dict[str, Any]:
    return {
        "mode": "local",
        "available": is_available(),
        "model": VOICE_STT_MODEL,
        "device": VOICE_STT_DEVICE,
        "language": VOICE_STT_LANGUAGE,
        "load_error": _model_load_error,
        "hint": (
            None
            if is_available()
            else "Install: pip install faster-whisper (and system ffmpeg)"
        ),
    }


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
            beam_size=1,
            vad_filter=True,
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
