"""CleanupAgent — propose and execute remediation plans."""

from __future__ import annotations

from typing import Any

from agents.audit import log_agent_step
from agents import policy
from agents import repository
from agents import tools
from agents.models import CleanupMode, CleanupPlan


def _qgis_steps_for_orphan(name: str | None, mrid: str) -> str:
    label = name or mrid
    return (
        f"1. Open QGIS and load the GIOP network layers.\n"
        f"2. Search for asset '{label}' (MRID {mrid}).\n"
        f"3. Identify the nearest line segment within 50m.\n"
        f"4. Snap line endpoint to the node or create a connecting segment.\n"
        f"5. Save edits and run topology revalidation in the portal."
    )


def _qgis_steps_for_geom_endpoint(name: str | None, mrid: str) -> str:
    label = name or mrid
    return (
        f"1. Open QGIS and load connectivity nodes + ac_line_segments.\n"
        f"2. Locate line '{label}' (MRID {mrid}).\n"
        f"3. Enable snapping to connectivity nodes (≤1 m tolerance).\n"
        f"4. Move line start/end vertices onto the assigned source/target nodes.\n"
        f"5. Save and re-run topology validation in the portal."
    )


def generate_cleanup_plan(conn, exception_id: str) -> CleanupPlan:
    exc = tools.tool_get_exception(conn, exception_id)
    if not exc:
        raise ValueError("Exception not found")
    mrid = exc["record_mrid"]
    rule = exc.get("rule_code") or ""
    if rule in ("ASSET_ORPHAN_NODE", "TOPO_DANGLING_LINE_ENDPOINT"):
        return CleanupPlan(
            mode=CleanupMode.ASSISTED,
            target_mrid=mrid,
            exception_id=exception_id,
            steps=[
                "Run repair_asset_topology_and_attributes dry-run",
                "Review proposed endpoint snaps",
                "Execute repair after steward approval",
            ],
            risk="medium",
            qgis_steps=_qgis_steps_for_orphan(exc.get("asset_name"), mrid),
            rollback_sql=(
                "-- Rollback: restore line endpoints from audit snapshot before repair execution"
            ),
        )
    if rule in ("TOPO_LINE_ENDPOINT_GEOM_MISMATCH", "TOPO_GEOM_DANGLING_ENDPOINT"):
        return CleanupPlan(
            mode=CleanupMode.ASSISTED,
            target_mrid=mrid,
            exception_id=exception_id,
            steps=[
                "Run repair_asset_topology_and_attributes dry-run (snaps geom to nodes)",
                "Review endpoint distance in exception details",
                "Execute repair after steward approval",
            ],
            risk="medium",
            qgis_steps=_qgis_steps_for_geom_endpoint(exc.get("asset_name"), mrid),
            rollback_sql="-- Rollback: restore line geometry from audit snapshot",
        )
    return CleanupPlan(
        mode=CleanupMode.MANUAL,
        target_mrid=mrid,
        exception_id=exception_id,
        steps=["Review exception details", "Correct in QGIS or staging queue"],
        risk="high",
        qgis_steps=_qgis_steps_for_orphan(None, mrid),
    )


def propose_cleanup(
    conn,
    run_id: str | None,
    exception_id: str,
    *,
    operator_id: str | None = None,
) -> dict[str, Any]:
    plan = generate_cleanup_plan(conn, exception_id)
    exc = tools.tool_get_exception(conn, exception_id)
    severity = (exc or {}).get("severity") or "major"
    domain = (exc or {}).get("domain") or "asset"
    rule_code = (exc or {}).get("rule_code") or ""

    decision = policy.evaluate_cleanup(
        mode=plan.mode,
        severity=severity,
        domain=domain,
        rule_code=rule_code,
        autofix_allowed=rule_code in ("ASSET_ORPHAN_NODE",),
        has_rollback=bool(plan.rollback_sql),
    )

    status = "pending_approval" if decision.requires_approval else "proposed"
    cleanup_id = repository.insert_cleanup_action(
        conn,
        exception_id=exception_id,
        run_id=run_id,
        target_mrid=plan.target_mrid,
        mode=plan.mode.value,
        status=status,
        plan=plan.model_dump(),
        rollback_sql=plan.rollback_sql,
        qgis_steps=plan.qgis_steps,
    )

    approval_id = None
    if decision.requires_approval:
        approval_id = repository.create_approval_request(
            conn,
            cleanup_id=cleanup_id,
            exception_id=exception_id,
            rationale=decision.reason,
        )

    log_agent_step(
        conn,
        run_id=run_id,
        agent_name="CleanupAgent",
        tool_name="propose_cleanup",
        policy_decision=decision.reason,
        output_summary={"cleanup_id": cleanup_id, "requires_approval": decision.requires_approval},
    )
    return {
        "cleanup_id": cleanup_id,
        "approval_id": approval_id,
        "plan": plan.model_dump(),
        "policy": decision.model_dump(),
    }


def execute_cleanup(
    conn,
    cleanup_id: str,
    *,
    operator_id: str | None = None,
    force: bool = False,
) -> dict[str, Any]:
    action = repository.get_cleanup_action(conn, cleanup_id)
    if not action:
        raise ValueError("Cleanup action not found")
    if action["status"] not in ("approved", "proposed") and not force:
        raise ValueError(f"Cleanup status {action['status']} does not allow execution")

    target = action["target_mrid"]
    dry_first = tools.tool_repair_topology(conn, target, dry_run=True)
    if not dry_first.get("applied") and not dry_first.get("result"):
        # still attempt if repair returns proposed only
        pass

    try:
        result = tools.tool_repair_topology(conn, target, dry_run=False)
        repository.update_cleanup_status(
            conn, cleanup_id, status="executed", executed_by=operator_id
        )
        log_agent_step(
            conn,
            run_id=action.get("run_id"),
            agent_name="CleanupAgent",
            tool_name="execute_repair",
            policy_decision="executed",
            output_summary={"target_mrid": target},
        )
        if action.get("exception_id"):
            from data_quality import run_asset_checks

            run_asset_checks(conn, target, "master")
        return {"cleanup_id": cleanup_id, "status": "executed", "result": result}
    except Exception as exc:
        repository.update_cleanup_status(
            conn, cleanup_id, status="failed", error_message=str(exc)
        )
        raise
