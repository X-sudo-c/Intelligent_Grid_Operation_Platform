"""ValidatorAgent — asset-level and batch rule execution."""

from __future__ import annotations

from typing import Any

from agents.audit import log_agent_step
from agents.context import check_run_deadline, is_live_progress
from agents import tools
from data_quality import run_batch_validation
from agents import repository


def run_validator_phase(
    conn,
    run_id: str,
    *,
    mrid: str | None = None,
    tier: str = "master",
) -> dict[str, Any]:
    log_agent_step(
        conn,
        run_id=run_id,
        agent_name="ValidatorAgent",
        tool_name="run_asset_checks",
        policy_decision="allowed",
    )
    if is_live_progress():
        repository.publish_run_progress(
            run_id,
            current_phase="validator",
            phase_detail="Running batch SQL validation…",
        )
    check_run_deadline()
    batch = run_batch_validation(conn)
    log_agent_step(
        conn,
        run_id=run_id,
        agent_name="ValidatorAgent",
        tool_name="run_batch_validation",
        output_summary=batch,
    )

    if mrid:
        result = tools.tool_run_asset_checks(conn, mrid, tier)
        for failure in result.get("failures") or []:
            from agents import repository

            repository.insert_validation_result(
                conn,
                run_id=run_id,
                rule_code=failure.get("rule_code"),
                record_mrid=mrid,
                record_type="connectivity_node",
                outcome="FAIL",
                message=failure.get("message"),
            )
        return {
            "checked_assets": 1,
            "failures": result.get("failures") or [],
            "batch": batch,
        }

    # Revalidate open exceptions sample
    open_items = tools.tool_list_exceptions(conn, limit=50)
    rechecked = 0
    failures: list[dict[str, Any]] = []
    for item in open_items[:25]:
        m = item.get("record_mrid")
        if not m or item.get("record_type") not in ("connectivity_node", None, ""):
            continue
        result = tools.tool_run_asset_checks(conn, m, tier)
        rechecked += 1
        failures.extend(result.get("failures") or [])
    return {"checked_assets": rechecked, "failures": failures, "batch": batch}
