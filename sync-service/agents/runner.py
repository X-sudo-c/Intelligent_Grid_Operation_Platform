"""Background validation run executor."""

from __future__ import annotations

import os
import time
from typing import Any

import psycopg2

from agents.context import (
    ValidationRunTimeout,
    clear_run_context,
    is_live_progress,
    set_live_progress,
    set_run_deadline,
)
from agents.models import RunMode, RunType, ValidationRunRequest
from agents.orchestrator import run_agent_validation_cycle, run_validation_cycle

DEFAULT_VALIDATION_RUN_TIMEOUT_SEC = 7200


def execute_validation_background(payload: dict[str, Any]) -> None:
    """Run validation cycle in a worker thread; commits or marks failed."""
    uri = os.getenv("SUPABASE_DB_URI")
    if not uri:
        return
    run_id = payload["run_id"]
    timeout_sec = int(os.getenv("VALIDATION_RUN_TIMEOUT_SEC", str(DEFAULT_VALIDATION_RUN_TIMEOUT_SEC)))
    req = ValidationRunRequest(
        run_type=RunType(payload["run_type"]),
        mode=RunMode(payload["mode"]),
        mrid=payload.get("mrid"),
        tier=payload.get("tier") or "master",
        operator_id=payload.get("operator_id"),
        clip=payload.get("clip"),
    )
    agent_mode = req.mode == RunMode.AGENT
    set_live_progress(True)
    set_run_deadline(time.monotonic() + timeout_sec, run_id=run_id)
    conn = psycopg2.connect(uri)
    try:
        if agent_mode:
            run_agent_validation_cycle(conn, req, run_id=run_id)
        else:
            run_validation_cycle(conn, req, run_id=run_id)
        try:
            conn.commit()
        except psycopg2.InterfaceError:
            pass
        try:
            from redis_cache import invalidate_ops_cache, invalidate_topology_cache

            invalidate_ops_cache()
            invalidate_topology_cache()
        except Exception:
            pass
    except ValidationRunTimeout as exc:
        conn.rollback()
        from agents import repository

        msg = f"Validation run timed out after {timeout_sec}s"
        fail_meta = {"current_phase": "failed", "completed_phases": []}
        repository.publish_validation_run_complete(
            run_id,
            status="failed",
            error_message=msg,
            metadata=fail_meta,
        )
        raise ValidationRunTimeout(run_id=run_id, timeout_sec=timeout_sec) from exc
    except Exception as exc:
        conn.rollback()
        from agents import repository

        if not is_live_progress():
            conn2 = psycopg2.connect(uri)
            try:
                repository.complete_validation_run(
                    conn2, run_id, status="failed", error_message=str(exc)
                )
                conn2.commit()
            finally:
                conn2.close()
        raise
    finally:
        clear_run_context()
        conn.close()
