"""Database repository for validation agent engine."""

from __future__ import annotations

import json
import os
from typing import Any

import psycopg2


def create_validation_run(
    conn,
    *,
    run_type: str,
    mode: str = "deterministic",
    requested_by: str | None = None,
    metadata: dict[str, Any] | None = None,
) -> str:
    with conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO public.validation_runs (run_type, status, mode, requested_by, metadata)
            VALUES (%s::validation_run_type, 'running', %s, %s, %s::jsonb)
            RETURNING id::text
            """,
            (run_type, mode, requested_by, json.dumps(metadata or {})),
        )
        return cur.fetchone()[0]


def _db_uri() -> str | None:
    return os.getenv("SUPABASE_DB_URI")


def _run_progress_patch(
    *,
    current_phase: str,
    phase_detail: str | None = None,
    completed_phases: list[str] | None = None,
) -> dict[str, Any]:
    patch: dict[str, Any] = {"current_phase": current_phase}
    if phase_detail is not None:
        patch["phase_detail"] = phase_detail
    if completed_phases is not None:
        patch["completed_phases"] = completed_phases
    return patch


def update_run_progress(
    conn,
    run_id: str,
    *,
    current_phase: str,
    phase_detail: str | None = None,
    completed_phases: list[str] | None = None,
) -> None:
    patch = _run_progress_patch(
        current_phase=current_phase,
        phase_detail=phase_detail,
        completed_phases=completed_phases,
    )
    with conn.cursor() as cur:
        cur.execute(
            """
            UPDATE public.validation_runs
            SET metadata = COALESCE(metadata, '{}'::jsonb) || %s::jsonb
            WHERE id = %s::uuid
            """,
            (json.dumps(patch), run_id),
        )


def publish_run_progress(
    run_id: str,
    *,
    current_phase: str,
    phase_detail: str | None = None,
    completed_phases: list[str] | None = None,
) -> None:
    """Write progress on an autocommit connection so pollers see updates immediately."""
    uri = _db_uri()
    if not uri:
        return
    patch = _run_progress_patch(
        current_phase=current_phase,
        phase_detail=phase_detail,
        completed_phases=completed_phases,
    )
    conn = psycopg2.connect(uri)
    conn.autocommit = True
    try:
        update_run_progress(conn, run_id, **patch)
    finally:
        conn.close()


def publish_validation_run_complete(
    run_id: str,
    *,
    status: str = "completed",
    error_message: str | None = None,
    topology_run_id: str | None = None,
    metadata: dict[str, Any] | None = None,
) -> None:
    """Mark a run terminal on an autocommit connection (visible to progress pollers)."""
    uri = _db_uri()
    if not uri:
        return
    conn = psycopg2.connect(uri)
    conn.autocommit = True
    try:
        complete_validation_run(
            conn,
            run_id,
            status=status,
            error_message=error_message,
            topology_run_id=topology_run_id,
            metadata=metadata,
        )
    finally:
        conn.close()


def list_audit_steps(conn, run_id: str, *, limit: int = 40) -> list[dict[str, Any]]:
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT agent_name, tool_name, policy_decision, output_summary, created_at
            FROM public.agent_audit_log
            WHERE run_id = %s::uuid
            ORDER BY created_at ASC
            LIMIT %s
            """,
            (run_id, limit),
        )
        rows = cur.fetchall()
    return [
        {
            "agent_name": r[0],
            "tool_name": r[1],
            "policy_decision": r[2],
            "output_summary": r[3],
            "created_at": r[4].isoformat() if r[4] else None,
        }
        for r in rows
    ]


def get_run_progress(conn, run_id: str) -> dict[str, Any] | None:
    run = get_validation_run(conn, run_id)
    if not run:
        return None
    meta = run.get("metadata") or {}
    steps = list_audit_steps(conn, run_id)
    progress: dict[str, Any] = {
        "run_id": run_id,
        "status": run["status"],
        "mode": run.get("mode"),
        "run_type": run.get("run_type"),
        "started_at": run.get("started_at"),
        "completed_at": run.get("completed_at"),
        "error_message": run.get("error_message"),
        "current_phase": meta.get("current_phase"),
        "phase_detail": meta.get("phase_detail"),
        "completed_phases": meta.get("completed_phases") or [],
        "steps": steps,
        "agent_summary": meta.get("agent_summary"),
    }
    if run["status"] == "completed":
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT topology_validity_pct, completeness_pct, critical_exception_count,
                       open_exception_count, pending_approval_count, export_blocked, escalation
                FROM public.kpi_snapshot
                WHERE run_id = %s::uuid
                ORDER BY created_at DESC LIMIT 1
                """,
                (run_id,),
            )
            row = cur.fetchone()
        if row:
            progress["kpi"] = {
                "topology_validity_pct": row[0],
                "completeness_pct": row[1],
                "critical_exception_count": row[2],
                "open_exception_count": row[3],
                "pending_approval_count": row[4],
                "export_blocked": row[5],
                "escalation": row[6],
            }
    return progress


def complete_validation_run(
    conn,
    run_id: str,
    *,
    status: str = "completed",
    error_message: str | None = None,
    topology_run_id: str | None = None,
    metadata: dict[str, Any] | None = None,
) -> None:
    with conn.cursor() as cur:
        cur.execute(
            """
            UPDATE public.validation_runs
            SET status = %s::validation_run_status,
                completed_at = NOW(),
                error_message = COALESCE(%s, error_message),
                topology_run_id = COALESCE(%s::uuid, topology_run_id),
                metadata = COALESCE(metadata, '{}'::jsonb) || COALESCE(%s::jsonb, '{}'::jsonb)
            WHERE id = %s::uuid
            """,
            (status, error_message, topology_run_id, json.dumps(metadata) if metadata else None, run_id),
        )


def get_validation_run(conn, run_id: str) -> dict[str, Any] | None:
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT id::text, run_type::text, status::text, mode, requested_by,
                   topology_run_id::text, error_message, started_at, completed_at, metadata
            FROM public.validation_runs WHERE id = %s::uuid
            """,
            (run_id,),
        )
        row = cur.fetchone()
    if not row:
        return None
    return {
        "id": row[0],
        "run_type": row[1],
        "status": row[2],
        "mode": row[3],
        "requested_by": row[4],
        "topology_run_id": row[5],
        "error_message": row[6],
        "started_at": row[7].isoformat() if row[7] else None,
        "completed_at": row[8].isoformat() if row[8] else None,
        "metadata": row[9],
    }


def list_validation_runs(conn, *, limit: int = 20) -> list[dict[str, Any]]:
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT id::text, run_type::text, status::text, mode, requested_by,
                   started_at, completed_at
            FROM public.validation_runs
            ORDER BY started_at DESC
            LIMIT %s
            """,
            (limit,),
        )
        rows = cur.fetchall()
    return [
        {
            "id": r[0],
            "run_type": r[1],
            "status": r[2],
            "mode": r[3],
            "requested_by": r[4],
            "started_at": r[5].isoformat() if r[5] else None,
            "completed_at": r[6].isoformat() if r[6] else None,
        }
        for r in rows
    ]


def insert_validation_result(
    conn,
    *,
    run_id: str,
    rule_code: str | None,
    record_mrid: str | None,
    record_type: str | None,
    outcome: str,
    message: str | None = None,
    details: dict[str, Any] | None = None,
) -> None:
    with conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO public.validation_results
              (run_id, rule_code, record_mrid, record_type, outcome, message, details)
            VALUES (%s::uuid, %s, %s::uuid, %s, %s, %s, %s::jsonb)
            """,
            (run_id, rule_code, record_mrid, record_type, outcome, message, json.dumps(details) if details else None),
        )


def insert_cleanup_action(
    conn,
    *,
    exception_id: str | None,
    run_id: str | None,
    target_mrid: str,
    mode: str,
    status: str,
    plan: dict[str, Any],
    rollback_sql: str | None = None,
    qgis_steps: str | None = None,
) -> str:
    with conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO public.cleanup_actions
              (exception_id, run_id, target_mrid, mode, status, plan, rollback_sql, qgis_steps)
            VALUES (%s::uuid, %s::uuid, %s::uuid, %s::cleanup_mode, %s::cleanup_status,
                    %s::jsonb, %s, %s)
            RETURNING id::text
            """,
            (exception_id, run_id, target_mrid, mode, status, json.dumps(plan), rollback_sql, qgis_steps),
        )
        return cur.fetchone()[0]


def get_cleanup_action(conn, cleanup_id: str) -> dict[str, Any] | None:
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT id::text, exception_id::text, run_id::text, target_mrid::text,
                   mode::text, status::text, plan, rollback_sql, qgis_steps,
                   executed_by, error_message, created_at, executed_at
            FROM public.cleanup_actions WHERE id = %s::uuid
            """,
            (cleanup_id,),
        )
        row = cur.fetchone()
    if not row:
        return None
    return {
        "id": row[0],
        "exception_id": row[1],
        "run_id": row[2],
        "target_mrid": row[3],
        "mode": row[4],
        "status": row[5],
        "plan": row[6],
        "rollback_sql": row[7],
        "qgis_steps": row[8],
        "executed_by": row[9],
        "error_message": row[10],
        "created_at": row[11].isoformat() if row[11] else None,
        "executed_at": row[12].isoformat() if row[12] else None,
    }


def update_cleanup_status(
    conn,
    cleanup_id: str,
    *,
    status: str,
    executed_by: str | None = None,
    error_message: str | None = None,
) -> None:
    with conn.cursor() as cur:
        cur.execute(
            """
            UPDATE public.cleanup_actions
            SET status = %s::cleanup_status,
                executed_by = COALESCE(%s, executed_by),
                error_message = COALESCE(%s, error_message),
                executed_at = CASE WHEN %s = 'executed' THEN NOW() ELSE executed_at END
            WHERE id = %s::uuid
            """,
            (status, executed_by, error_message, status, cleanup_id),
        )


def create_approval_request(
    conn,
    *,
    cleanup_id: str | None,
    exception_id: str | None,
    rationale: str | None = None,
) -> str:
    with conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO public.approval_requests (cleanup_id, exception_id, rationale)
            VALUES (%s::uuid, %s::uuid, %s)
            RETURNING id::text
            """,
            (cleanup_id, exception_id, rationale),
        )
        return cur.fetchone()[0]


def list_pending_approvals(conn, *, limit: int = 50) -> list[dict[str, Any]]:
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT a.id::text, a.cleanup_id::text, a.exception_id::text, a.rationale,
                   a.created_at,
                   c.mode::text, c.plan, c.target_mrid::text, c.rollback_sql, c.qgis_steps,
                   e.rule_code, e.severity::text, e.error_message,
                   p.id::text, p.change_summary, p.dry_run_result, p.proposed_by, p.status::text
            FROM public.approval_requests a
            LEFT JOIN public.cleanup_actions c ON c.id = a.cleanup_id
            LEFT JOIN public.data_quality_exceptions e ON e.id = a.exception_id
            LEFT JOIN public.topology_change_proposals p ON p.approval_id = a.id
            WHERE a.status = 'pending'
            ORDER BY a.created_at DESC
            LIMIT %s
            """,
            (limit,),
        )
        rows = cur.fetchall()
    return [
        {
            "id": r[0],
            "cleanup_id": r[1],
            "exception_id": r[2],
            "rationale": r[3],
            "created_at": r[4].isoformat() if r[4] else None,
            "cleanup_mode": r[5],
            "plan": r[6],
            "target_mrid": r[7],
            "rollback_sql": r[8],
            "qgis_steps": r[9],
            "rule_code": r[10],
            "severity": r[11],
            "error_message": r[12],
            "proposal_id": r[13],
            "change_summary": r[14],
            "dry_run_result": r[15],
            "proposed_by": r[16],
            "proposal_status": r[17],
        }
        for r in rows
    ]


def decide_approval(
    conn,
    approval_id: str,
    *,
    approved: bool,
    decided_by: str | None = None,
    note: str | None = None,
) -> dict[str, Any]:
    status = "approved" if approved else "rejected"
    with conn.cursor() as cur:
        cur.execute(
            """
            UPDATE public.approval_requests
            SET status = %s::approval_status,
                decided_by = %s,
                decision_note = %s,
                decided_at = NOW()
            WHERE id = %s::uuid AND status = 'pending'
            RETURNING cleanup_id::text, exception_id::text
            """,
            (status, decided_by, note, approval_id),
        )
        row = cur.fetchone()
        if not row:
            raise ValueError("Approval not found or already decided")
        cleanup_id, exception_id = row
        if cleanup_id:
            cleanup_status = "approved" if approved else "rejected"
            cur.execute(
                """
                UPDATE public.cleanup_actions
                SET status = %s::cleanup_status
                WHERE id = %s::uuid
                """,
                (cleanup_status, cleanup_id),
            )
    return {"id": approval_id, "status": status, "cleanup_id": cleanup_id, "exception_id": exception_id}


def insert_kpi_snapshot(conn, run_id: str, metrics: dict[str, Any]) -> str:
    with conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO public.kpi_snapshot
              (run_id, topology_validity_pct, completeness_pct, critical_exception_count,
               open_exception_count, auto_fix_success_rate, pending_approval_count,
               export_blocked, escalation)
            VALUES (%s::uuid, %s, %s, %s, %s, %s, %s, %s, %s::jsonb)
            RETURNING id::text
            """,
            (
                run_id,
                metrics.get("topology_validity_pct"),
                metrics.get("completeness_pct"),
                metrics.get("critical_exception_count", 0),
                metrics.get("open_exception_count", 0),
                metrics.get("auto_fix_success_rate"),
                metrics.get("pending_approval_count", 0),
                metrics.get("export_blocked", False),
                json.dumps(metrics.get("escalation", [])),
            ),
        )
        return cur.fetchone()[0]


def latest_kpi_snapshot(conn) -> dict[str, Any] | None:
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT id::text, run_id::text, topology_validity_pct, completeness_pct,
                   critical_exception_count, open_exception_count, auto_fix_success_rate,
                   pending_approval_count, export_blocked, escalation, created_at
            FROM public.kpi_snapshot
            ORDER BY created_at DESC
            LIMIT 1
            """
        )
        row = cur.fetchone()
    if not row:
        return None
    return {
        "id": row[0],
        "run_id": row[1],
        "topology_validity_pct": row[2],
        "completeness_pct": row[3],
        "critical_exception_count": row[4],
        "open_exception_count": row[5],
        "auto_fix_success_rate": row[6],
        "pending_approval_count": row[7],
        "export_blocked": row[8],
        "escalation": row[9],
        "created_at": row[10].isoformat() if row[10] else None,
    }


def route_exception_queue(
    conn,
    exception_id: str,
    *,
    queue_name: str,
    sla_hours: int = 72,
) -> None:
    with conn.cursor() as cur:
        cur.execute(
            """
            UPDATE public.data_quality_exceptions
            SET queue_name = %s,
                sla_due_at = NOW() + (%s || ' hours')::interval
            WHERE id = %s::uuid
            """,
            (queue_name, sla_hours, exception_id),
        )


def count_pending_approvals(conn) -> int:
    with conn.cursor() as cur:
        cur.execute(
            "SELECT COUNT(*) FROM public.approval_requests WHERE status = 'pending'"
        )
        return int(cur.fetchone()[0])


def insert_topology_proposal(
    conn,
    *,
    exception_id: str | None,
    cleanup_id: str,
    approval_id: str | None,
    target_mrid: str,
    rule_code: str | None,
    proposed_by: str,
    ai_rationale: str | None,
    dry_run_result: dict[str, Any],
    change_summary: dict[str, Any],
) -> str:
    with conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO public.topology_change_proposals
              (exception_id, cleanup_id, approval_id, target_mrid, rule_code,
               proposed_by, ai_rationale, dry_run_result, change_summary)
            VALUES (%s::uuid, %s::uuid, %s::uuid, %s::uuid, %s, %s, %s, %s::jsonb, %s::jsonb)
            RETURNING id::text
            """,
            (
                exception_id,
                cleanup_id,
                approval_id,
                target_mrid,
                rule_code,
                proposed_by,
                ai_rationale,
                json.dumps(dry_run_result),
                json.dumps(change_summary),
            ),
        )
        return cur.fetchone()[0]


def _topology_proposal_row(row) -> dict[str, Any]:
    return {
        "id": row[0],
        "exception_id": row[1],
        "cleanup_id": row[2],
        "approval_id": row[3],
        "target_mrid": row[4],
        "rule_code": row[5],
        "proposed_by": row[6],
        "ai_rationale": row[7],
        "dry_run_result": row[8],
        "change_summary": row[9],
        "status": row[10],
        "published_by": row[11],
        "published_at": row[12].isoformat() if row[12] else None,
        "error_message": row[13],
        "created_at": row[14].isoformat() if row[14] else None,
        "updated_at": row[15].isoformat() if row[15] else None,
    }


def get_topology_proposal(conn, proposal_id: str) -> dict[str, Any] | None:
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT id::text, exception_id::text, cleanup_id::text, approval_id::text,
                   target_mrid::text, rule_code, proposed_by, ai_rationale,
                   dry_run_result, change_summary, status::text,
                   published_by, published_at, error_message, created_at, updated_at
            FROM public.topology_change_proposals
            WHERE id = %s::uuid
            """,
            (proposal_id,),
        )
        row = cur.fetchone()
    return _topology_proposal_row(row) if row else None


def get_topology_proposal_by_approval(conn, approval_id: str) -> dict[str, Any] | None:
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT id::text, exception_id::text, cleanup_id::text, approval_id::text,
                   target_mrid::text, rule_code, proposed_by, ai_rationale,
                   dry_run_result, change_summary, status::text,
                   published_by, published_at, error_message, created_at, updated_at
            FROM public.topology_change_proposals
            WHERE approval_id = %s::uuid
            ORDER BY created_at DESC
            LIMIT 1
            """,
            (approval_id,),
        )
        row = cur.fetchone()
    return _topology_proposal_row(row) if row else None


def update_topology_proposal_status(
    conn,
    proposal_id: str,
    *,
    status: str,
    published_by: str | None = None,
    error_message: str | None = None,
    publish_result: dict[str, Any] | None = None,
) -> None:
    with conn.cursor() as cur:
        if status == "published":
            cur.execute(
                """
                UPDATE public.topology_change_proposals
                SET status = %s::topology_proposal_status,
                    published_by = %s,
                    published_at = NOW(),
                    updated_at = NOW(),
                    change_summary = CASE
                      WHEN %s::jsonb IS NOT NULL
                      THEN change_summary || jsonb_build_object('publish_result', %s::jsonb)
                      ELSE change_summary
                    END
                WHERE id = %s::uuid
                """,
                (
                    status,
                    published_by,
                    json.dumps(publish_result) if publish_result else None,
                    json.dumps(publish_result) if publish_result else None,
                    proposal_id,
                ),
            )
        else:
            cur.execute(
                """
                UPDATE public.topology_change_proposals
                SET status = %s::topology_proposal_status,
                    error_message = COALESCE(%s, error_message),
                    updated_at = NOW()
                WHERE id = %s::uuid
                """,
                (status, error_message, proposal_id),
            )


def list_approved_proposals(conn, *, limit: int = 50) -> list[dict[str, Any]]:
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT p.id::text, p.exception_id::text, p.cleanup_id::text, p.approval_id::text,
                   p.target_mrid::text, p.rule_code, p.proposed_by, p.ai_rationale,
                   p.dry_run_result, p.change_summary, p.status::text,
                   p.published_by, p.published_at, p.error_message, p.created_at, p.updated_at,
                   e.severity::text, e.error_message AS exception_message
            FROM public.topology_change_proposals p
            LEFT JOIN public.data_quality_exceptions e ON e.id = p.exception_id
            WHERE p.status = 'approved'
            ORDER BY p.updated_at DESC
            LIMIT %s
            """,
            (limit,),
        )
        rows = cur.fetchall()
    return [
        {
            **_topology_proposal_row(r[:16]),
            "severity": r[16],
            "exception_message": r[17],
        }
        for r in rows
    ]
