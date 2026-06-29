"""Agent audit logging."""

from __future__ import annotations

import hashlib
import json
import os
from typing import Any

import psycopg2

from agents.context import is_live_progress


def _hash_payload(payload: Any) -> str:
    raw = json.dumps(payload, sort_keys=True, default=str)
    return hashlib.sha256(raw.encode()).hexdigest()[:16]


def _insert_agent_step(
    conn,
    *,
    run_id: str | None,
    agent_name: str,
    tool_name: str | None = None,
    policy_decision: str | None = None,
    input_payload: Any = None,
    output_summary: dict[str, Any] | None = None,
    model_id: str | None = None,
) -> None:
    with conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO public.agent_audit_log
              (run_id, agent_name, tool_name, policy_decision, input_hash, output_summary, model_id)
            VALUES (%s::uuid, %s, %s, %s, %s, %s::jsonb, %s)
            """,
            (
                run_id,
                agent_name,
                tool_name,
                policy_decision,
                _hash_payload(input_payload) if input_payload is not None else None,
                json.dumps(output_summary) if output_summary else None,
                model_id,
            ),
        )


def publish_agent_step(
    *,
    run_id: str,
    agent_name: str,
    tool_name: str | None = None,
    policy_decision: str | None = None,
    input_payload: Any = None,
    output_summary: dict[str, Any] | None = None,
    model_id: str | None = None,
) -> None:
    """Insert audit step on autocommit connection for live progress polling."""
    uri = os.getenv("SUPABASE_DB_URI")
    if not uri:
        return
    conn = psycopg2.connect(uri)
    conn.autocommit = True
    try:
        _insert_agent_step(
            conn,
            run_id=run_id,
            agent_name=agent_name,
            tool_name=tool_name,
            policy_decision=policy_decision,
            input_payload=input_payload,
            output_summary=output_summary,
            model_id=model_id,
        )
    finally:
        conn.close()


def log_agent_step(
    conn,
    *,
    run_id: str | None,
    agent_name: str,
    tool_name: str | None = None,
    policy_decision: str | None = None,
    input_payload: Any = None,
    output_summary: dict[str, Any] | None = None,
    model_id: str | None = None,
) -> None:
    if is_live_progress() and run_id:
        publish_agent_step(
            run_id=run_id,
            agent_name=agent_name,
            tool_name=tool_name,
            policy_decision=policy_decision,
            input_payload=input_payload,
            output_summary=output_summary,
            model_id=model_id,
        )
        return
    _insert_agent_step(
        conn,
        run_id=run_id,
        agent_name=agent_name,
        tool_name=tool_name,
        policy_decision=policy_decision,
        input_payload=input_payload,
        output_summary=output_summary,
        model_id=model_id,
    )
