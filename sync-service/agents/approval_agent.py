"""ApprovalAgent — steward approval workflow."""

from __future__ import annotations

from agents.audit import log_agent_step
from agents import cleanup_agent
from agents import proposal_agent
from agents import repository


def list_pending(conn, *, limit: int = 50) -> list[dict]:
    return repository.list_pending_approvals(conn, limit=limit)


def approve(
    conn,
    approval_id: str,
    *,
    operator_id: str | None = None,
    note: str | None = None,
    execute: bool = False,
) -> dict:
    result = repository.decide_approval(
        conn, approval_id, approved=True, decided_by=operator_id, note=note
    )
    proposal_agent.on_approval_decision(conn, approval_id, approved=True)
    log_agent_step(
        conn,
        run_id=None,
        agent_name="ApprovalAgent",
        tool_name="approve",
        policy_decision="approved",
        output_summary=result,
    )
    proposal = repository.get_topology_proposal_by_approval(conn, approval_id)
    if proposal:
        result["proposal_id"] = proposal["id"]
        result["next_step"] = "Publish to master when ready"
    if execute and result.get("cleanup_id"):
        exec_result = cleanup_agent.execute_cleanup(
            conn, result["cleanup_id"], operator_id=operator_id, force=True
        )
        result["execution"] = exec_result
    return result


def reject(
    conn,
    approval_id: str,
    *,
    operator_id: str | None = None,
    note: str | None = None,
) -> dict:
    result = repository.decide_approval(
        conn, approval_id, approved=False, decided_by=operator_id, note=note
    )
    proposal_agent.on_approval_decision(conn, approval_id, approved=False)
    log_agent_step(
        conn,
        run_id=None,
        agent_name="ApprovalAgent",
        tool_name="reject",
        policy_decision="rejected",
        output_summary=result,
    )
    return result
