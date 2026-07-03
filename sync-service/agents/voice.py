"""Voice copilot turn — fast path + steward chat fallback."""

from __future__ import annotations

from typing import Any

from agents import voice_session, voice_stt, voice_tts
from agents.llm.chat import run_steward_chat
from agents.models import AgentChatResponse
from agents.voice_normalize import normalize_transcript
from agents.voice_router import try_copilot_fast_path


def _shorten_for_speech(text: str, max_len: int = 280) -> str:
    cleaned = " ".join((text or "").split())
    if len(cleaned) <= max_len:
        return cleaned
    return cleaned[: max_len - 3].rsplit(" ", 1)[0] + "..."


def run_voice_turn_from_audio(
    conn,
    *,
    data: bytes,
    content_type: str | None = None,
    session_id: str | None = None,
    exception_id: str | None = None,
    mrid: str | None = None,
    operator_id: str | None = None,
    context: dict[str, Any] | None = None,
) -> AgentChatResponse:
    """Transcribe audio then run the voice copilot turn in one server hop."""
    if not data:
        raise ValueError("Empty audio upload")
    voice_stt.warm_boundary_prompt(conn)
    raw_text = voice_stt.transcribe_audio(data, content_type=content_type)
    text, norm_meta = normalize_transcript(text=raw_text)
    if not text.strip():
        raise ValueError("No speech detected — speak closer to the mic and try again")
    result = run_voice_turn(
        conn,
        text=text,
        session_id=session_id,
        exception_id=exception_id,
        mrid=mrid,
        operator_id=operator_id,
        context=context,
    )
    agent = dict(result.agent or {})
    agent["transcript"] = text
    if norm_meta.get("raw"):
        agent["transcript_raw"] = norm_meta["raw"]
    fixes = norm_meta.get("fixes") or []
    if fixes:
        agent["transcript_fixes"] = fixes
    return AgentChatResponse(
        content=result.content,
        findings=result.findings,
        actions=result.actions,
        ui_actions=result.ui_actions,
        agent=agent,
    )


def run_voice_turn(
    conn,
    *,
    text: str,
    session_id: str | None = None,
    exception_id: str | None = None,
    mrid: str | None = None,
    operator_id: str | None = None,
    context: dict[str, Any] | None = None,
) -> AgentChatResponse:
    ctx = context or {}
    sid = session_id or voice_session.new_session_id()
    state = voice_session.load(sid)

    voice_stt.warm_boundary_prompt(conn)
    text, _norm = normalize_transcript(text)

    intent, fast = try_copilot_fast_path(
        conn, text, context=ctx, session=state, normalize=False
    )

    if fast:
        voice_session.merge(sid, fast.get("session_patch") or {})
        return AgentChatResponse(
            content=fast["content"],
            findings=[f"Voice fast path: {intent.kind if intent else 'unknown'}"],
            actions=["Spoken reply ready"],
            ui_actions=fast.get("ui_actions") or [],
            agent={
                "voice": True,
                "fast_path": True,
                "session_id": sid,
                "speak": fast.get("speak") or fast["content"],
                "tts": voice_tts.status(),
            },
        )

    # Slow path — full steward assistant.
    chat = run_steward_chat(
        conn,
        message=text,
        exception_id=exception_id,
        mrid=mrid,
        operator_id=operator_id,
        context=ctx,
    )
    speak = _shorten_for_speech(chat.content)
    agent = dict(chat.agent or {})
    agent.update(
        {
            "voice": True,
            "fast_path": False,
            "session_id": sid,
            "speak": speak,
            "tts": voice_tts.status(),
        }
    )
    return AgentChatResponse(
        content=chat.content,
        findings=chat.findings,
        actions=chat.actions,
        ui_actions=chat.ui_actions,
        agent=agent,
    )
