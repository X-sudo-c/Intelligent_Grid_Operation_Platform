"""Topology change proposals — AI dry-run, human review, publish to master."""

from __future__ import annotations

from typing import Any

from agents.audit import log_agent_step
from agents import cleanup_agent
from agents import repository
from agents import tools

TOPOLOGY_RULES = frozenset(
    {
        "ASSET_ORPHAN_NODE",
        "TOPO_DANGLING_LINE_ENDPOINT",
        "TOPO_LINE_ENDPOINT_GEOM_MISMATCH",
        "TOPO_GEOM_DANGLING_ENDPOINT",
        "TOPO_LINE_CROSSING_WITHOUT_NODE",
        "TOPO_NETWORK_LOOP",
        "TOPO_ISLAND_COMPONENT",
    }
)


def _summarize_dry_run(dry_run: dict[str, Any]) -> dict[str, Any]:
    """Extract steward-facing summary from repair dry-run JSON."""
    proposed = dry_run.get("proposed") or dry_run.get("result", {}).get("proposed") or []
    applied = dry_run.get("applied") or dry_run.get("result", {}).get("applied") or []
    skipped = dry_run.get("skipped") or dry_run.get("result", {}).get("skipped") or []
    if isinstance(proposed, dict):
        proposed = [proposed]
    if isinstance(applied, dict):
        applied = [applied]
    return {
        "proposed_changes": len(proposed) if isinstance(proposed, list) else 0,
        "would_apply": len(applied) if isinstance(applied, list) else 0,
        "skipped": len(skipped) if isinstance(skipped, list) else 0,
        "proposed_preview": (proposed[:5] if isinstance(proposed, list) else proposed),
        "dry_run": dry_run.get("dry_run", True),
    }


def _build_rationale(exc: dict[str, Any], summary: dict[str, Any], *, proposed_by: str) -> str:
    rule = exc.get("rule_code") or "unknown"
    mrid = exc.get("record_mrid") or "?"
    changes = summary.get("proposed_changes", 0)
    return (
        f"{proposed_by} proposed topology repair for {rule} on MRID {mrid[:8]}… "
        f"({changes} segment change(s) in dry-run). Review before publishing to master."
    )


def generate_topology_proposal(
    conn,
    exception_id: str,
    *,
    run_id: str | None = None,
    operator_id: str | None = None,
    proposed_by: str = "CleanupAgent",
) -> dict[str, Any]:
    """Run dry-run repair, store proposal, queue for human approval (no master write)."""
    exc = tools.tool_get_exception(conn, exception_id)
    if not exc:
        raise ValueError("Exception not found")

    proposal_result = cleanup_agent.propose_cleanup(
        conn, run_id, exception_id, operator_id=operator_id
    )
    cleanup_id = proposal_result["cleanup_id"]
    approval_id = proposal_result.get("approval_id")
    target_mrid = (proposal_result.get("plan") or {}).get("target_mrid") or exc.get("record_mrid")
    rule_code = exc.get("rule_code") or ""

    dry_run: dict[str, Any] = {}
    summary: dict[str, Any] = {"proposed_changes": 0, "note": "Manual QGIS remediation"}
    if target_mrid and rule_code in TOPOLOGY_RULES:
        try:
            dry_run = tools.tool_repair_topology(conn, target_mrid, dry_run=True)
            summary = _summarize_dry_run(dry_run if isinstance(dry_run, dict) else {"result": dry_run})
        except Exception as exc_err:
            summary = {"error": str(exc_err), "proposed_changes": 0}

    rationale = _build_rationale(exc, summary, proposed_by=proposed_by)
    if approval_id:
        with conn.cursor() as cur:
            cur.execute(
                """
                UPDATE public.approval_requests
                SET rationale = %s
                WHERE id = %s::uuid
                """,
                (rationale, approval_id),
            )

    proposal_id = repository.insert_topology_proposal(
        conn,
        exception_id=exception_id,
        cleanup_id=cleanup_id,
        approval_id=approval_id,
        target_mrid=target_mrid,
        rule_code=rule_code,
        proposed_by=proposed_by,
        ai_rationale=rationale,
        dry_run_result=dry_run,
        change_summary=summary,
    )

    log_agent_step(
        conn,
        run_id=run_id,
        agent_name=proposed_by,
        tool_name="generate_topology_proposal",
        policy_decision="pending_review",
        output_summary={
            "proposal_id": proposal_id,
            "cleanup_id": cleanup_id,
            "approval_id": approval_id,
            "change_summary": summary,
        },
    )

    return {
        **proposal_result,
        "proposal_id": proposal_id,
        "target_mrid": target_mrid,
        "rule_code": rule_code,
        "proposed_by": proposed_by,
        "ai_rationale": rationale,
        "dry_run_result": dry_run,
        "change_summary": summary,
        "status": "proposed",
        "next_step": "Human review → Approve → Publish to master",
    }


def publish_proposal_to_master(
    conn,
    proposal_id: str,
    *,
    operator_id: str | None = None,
) -> dict[str, Any]:
    """Execute approved proposal on master (after steward approval)."""
    proposal = repository.get_topology_proposal(conn, proposal_id)
    if not proposal:
        raise ValueError("Proposal not found")
    if proposal["status"] == "published":
        return {"proposal_id": proposal_id, "status": "published", "already": True}
    if proposal["status"] not in ("approved", "proposed"):
        raise ValueError(f"Proposal status {proposal['status']} cannot be published")

    cleanup_id = proposal.get("cleanup_id")
    if not cleanup_id:
        raise ValueError("Proposal has no linked cleanup action")

    cleanup = repository.get_cleanup_action(conn, cleanup_id)
    if cleanup and cleanup["status"] not in ("approved", "proposed", "pending_approval"):
        if cleanup["status"] == "executed":
            repository.update_topology_proposal_status(
                conn, proposal_id, status="published", published_by=operator_id
            )
            return {"proposal_id": proposal_id, "status": "published", "already_executed": True}
        raise ValueError(f"Cleanup status {cleanup['status']} does not allow publish")

    if cleanup and cleanup["status"] in ("proposed", "pending_approval"):
        repository.update_cleanup_status(conn, cleanup_id, status="approved")

    try:
        exec_result = cleanup_agent.execute_cleanup(
            conn, cleanup_id, operator_id=operator_id, force=True
        )
        repository.update_topology_proposal_status(
            conn,
            proposal_id,
            status="published",
            published_by=operator_id,
            publish_result=exec_result,
        )
        log_agent_step(
            conn,
            run_id=cleanup.get("run_id") if cleanup else None,
            agent_name="ProposalAgent",
            tool_name="publish_to_master",
            policy_decision="published",
            output_summary={"proposal_id": proposal_id, "cleanup_id": cleanup_id},
        )
        return {
            "proposal_id": proposal_id,
            "status": "published",
            "cleanup_id": cleanup_id,
            "execution": exec_result,
        }
    except Exception as exc:
        repository.update_topology_proposal_status(
            conn,
            proposal_id,
            status="failed",
            error_message=str(exc),
        )
        raise


def on_approval_decision(
    conn,
    approval_id: str,
    *,
    approved: bool,
) -> None:
    """Sync proposal status when steward approves or rejects."""
    proposal = repository.get_topology_proposal_by_approval(conn, approval_id)
    if not proposal:
        return
    repository.update_topology_proposal_status(
        conn,
        proposal["id"],
        status="approved" if approved else "rejected",
    )
