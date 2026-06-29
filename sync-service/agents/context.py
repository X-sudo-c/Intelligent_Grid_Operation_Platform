"""Thread-local context for live validation run progress."""

from __future__ import annotations

import threading
import time

_ctx = threading.local()


class ValidationRunTimeout(Exception):
    """Raised when a validation run exceeds its configured deadline."""

    def __init__(self, run_id: str | None = None, timeout_sec: int | None = None):
        self.run_id = run_id
        self.timeout_sec = timeout_sec
        msg = f"Validation run timed out after {timeout_sec}s" if timeout_sec else "Validation run timed out"
        super().__init__(msg)


def set_live_progress(enabled: bool) -> None:
    _ctx.live_progress = enabled


def is_live_progress() -> bool:
    return bool(getattr(_ctx, "live_progress", False))


def set_run_deadline(deadline_monotonic: float | None, *, run_id: str | None = None) -> None:
    _ctx.deadline = deadline_monotonic
    _ctx.run_id = run_id


def check_run_deadline() -> None:
    deadline = getattr(_ctx, "deadline", None)
    if deadline is not None and time.monotonic() > deadline:
        raise ValidationRunTimeout(
            run_id=getattr(_ctx, "run_id", None),
            timeout_sec=None,
        )


def clear_run_context() -> None:
    for attr in ("live_progress", "deadline", "run_id"):
        if hasattr(_ctx, attr):
            delattr(_ctx, attr)
