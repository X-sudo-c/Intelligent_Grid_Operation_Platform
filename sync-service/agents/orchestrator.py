"""Deterministic validation orchestrator pipeline."""

from __future__ import annotations

import json
from typing import Any

from agents import cleanup_agent
from agents import graph_agent
from agents import kpi
from agents import queue_manager
from agents import repository
from agents import validator
from agents.audit import log_agent_step
from agents.context import check_run_deadline, is_live_progress
from agents.models import RunMode, RunType, ValidationRunRequest

ORCHESTRATOR_SYSTEM = """You are the GIOP OrchestratorAgent supervising a GIS data quality validation cycle.
Use tools to inspect KPI breaches, open exceptions, topology health, and propose cleanup plans.
Summarize findings for stewards: what failed, severity, recommended next actions, and whether approval is needed.
Do not claim fixes were executed — only propose and explain."""

# Rules with actionable automated or assisted cleanup plans (exclude noisy batch-only rules).
ACTIONABLE_CLEANUP_RULES = frozenset(
    {
        "ASSET_ORPHAN_NODE",
        "TOPO_DANGLING_LINE_ENDPOINT",
        "TOPO_NETWORK_LOOP",
        "TOPO_ISLAND_COMPONENT",
    }
)

PHASE_ORDER = ["validator", "graph", "queue", "cleanup", "kpi"]


def _progress(
    conn,
    run_id: str,
    phase: str,
    *,
    detail: str | None = None,
    completed: list[str] | None = None,
) -> None:
    check_run_deadline()
    if is_live_progress():
        repository.publish_run_progress(
            run_id,
            current_phase=phase,
            phase_detail=detail,
            completed_phases=completed,
        )
    else:
        repository.update_run_progress(
            conn,
            run_id,
            current_phase=phase,
            phase_detail=detail,
            completed_phases=completed,
        )


def _propose_cleanup_sample(
    conn,
    run_id: str,
    *,
    limit: int = 10,
    domain: str | None = None,
) -> list[dict[str, Any]]:
    from agents import tools

    items = tools.tool_list_exceptions(conn, domain=domain, limit=limit * 4)
    filtered = [
        exc
        for exc in items
        if (exc.get("rule_code") or "") in ACTIONABLE_CLEANUP_RULES
    ][:limit]
    proposals: list[dict[str, Any]] = []
    for exc in filtered:
        try:
            from agents import proposal_agent

            proposals.append(
                proposal_agent.generate_topology_proposal(
                    conn, exc["id"], run_id=run_id, proposed_by="OrchestratorAgent"
                )
            )
        except Exception as exc_err:
            proposals.append({"exception_id": exc["id"], "error": str(exc_err)})
    return proposals


def run_validation_cycle(
    conn,
    request: ValidationRunRequest,
    *,
    run_id: str | None = None,
) -> dict[str, Any]:
    completed: list[str] = []
    if run_id:
        _progress(conn, run_id, "starting", detail="Validation cycle initiated")
    else:
        run_id = repository.create_validation_run(
            conn,
            run_type=request.run_type.value,
            mode=request.mode.value,
            requested_by=request.operator_id,
            metadata={"current_phase": "starting", "completed_phases": []},
        )

    log_agent_step(
        conn,
        run_id=run_id,
        agent_name="OrchestratorAgent",
        tool_name="start_run",
        policy_decision="allowed",
        input_payload=request.model_dump(),
    )

    phases: dict[str, Any] = {}
    topology_run_id = None

    try:
        if request.run_type in (RunType.FULL_CYCLE, RunType.ASSET_CHECKS, RunType.REVALIDATION):
            _progress(conn, run_id, "validator", detail="Running SQL rules and batch checks")
            phases["validator"] = validator.run_validator_phase(
                conn,
                run_id,
                mrid=request.mrid,
                tier=request.tier,
            )
            completed.append("validator")
            _progress(conn, run_id, "validator", detail="Validator phase complete", completed=completed)

        if request.run_type in (RunType.FULL_CYCLE, RunType.TOPOLOGY_MASTER):
            _progress(conn, run_id, "graph", detail="Topology batch scan and NetworkX analysis")
            graph_result = graph_agent.run_graph_phase(
                conn,
                run_id,
                clip=request.clip,
                requested_by=request.operator_id,
            )
            phases["graph"] = graph_result
            topology_run_id = (graph_result.get("topology_scan") or {}).get("run_id")
            completed.append("graph")
            _progress(conn, run_id, "graph", detail="Graph phase complete", completed=completed)

        if request.run_type == RunType.FULL_CYCLE:
            _progress(conn, run_id, "queue", detail="Routing exceptions to virtual queues")
            phases["queue"] = queue_manager.run_queue_phase(conn, run_id)
            completed.append("queue")
            _progress(conn, run_id, "queue", detail="Queue routing complete", completed=completed)

            _progress(conn, run_id, "cleanup", detail="Proposing actionable cleanup samples")
            phases["cleanup_proposals"] = _propose_cleanup_sample(
                conn, run_id, limit=5, domain="topology"
            )
            completed.append("cleanup")
            _progress(conn, run_id, "cleanup", detail="Cleanup proposals complete", completed=completed)

        _progress(conn, run_id, "kpi", detail="Computing KPI snapshot and escalations")
        metrics = kpi.compute_kpis(conn, clip=request.clip)
        kpi_id = repository.insert_kpi_snapshot(conn, run_id, metrics)
        phases["kpi"] = {"snapshot_id": kpi_id, **metrics}
        completed.append("kpi")

        escalations = metrics.get("escalation") or []
        if any(e.get("code") == "COMPLETENESS_BELOW_THRESHOLD" for e in escalations):
            phases["kpi_cleanup"] = _propose_cleanup_sample(conn, run_id, limit=5)
            log_agent_step(
                conn,
                run_id=run_id,
                agent_name="OrchestratorAgent",
                tool_name="kpi_trigger_cleanup",
                policy_decision="allowed",
                output_summary={"proposals": len(phases["kpi_cleanup"])},
            )

        if any(e.get("code") == "CRITICAL_EXCEPTIONS_OPEN" for e in escalations):
            phases["critical_escalation"] = _propose_cleanup_sample(conn, run_id, limit=3)

        _progress(conn, run_id, "kpi", detail="KPI snapshot saved", completed=completed)

        repository.complete_validation_run(
            conn,
            run_id,
            status="completed",
            topology_run_id=topology_run_id,
            metadata={
                "phases": list(phases.keys()),
                "escalation": escalations,
                "completed_phases": completed,
                "current_phase": "completed",
            },
        )
        if is_live_progress():
            conn.commit()
            repository.publish_validation_run_complete(
                run_id,
                status="completed",
                topology_run_id=topology_run_id,
                metadata={
                    "phases": list(phases.keys()),
                    "escalation": escalations,
                    "completed_phases": completed,
                    "current_phase": "completed",
                },
            )
        log_agent_step(
            conn,
            run_id=run_id,
            agent_name="OrchestratorAgent",
            tool_name="complete_run",
            output_summary={"kpi_id": kpi_id, "escalation": escalations},
        )
        return {
            "run_id": run_id,
            "status": "completed",
            "phases": phases,
            "kpi": metrics,
        }
    except Exception as exc:
        fail_meta = {"current_phase": "failed", "completed_phases": completed}
        repository.complete_validation_run(
            conn,
            run_id,
            status="failed",
            error_message=str(exc),
            metadata=fail_meta,
        )
        if is_live_progress():
            conn.commit()
            repository.publish_validation_run_complete(
                run_id,
                status="failed",
                error_message=str(exc),
                metadata=fail_meta,
            )
        raise


def run_agent_validation_cycle(
    conn,
    request: ValidationRunRequest,
    *,
    run_id: str | None = None,
) -> dict[str, Any]:
    """LLM-augmented cycle: deterministic pipeline + ReAct orchestrator analysis."""
    from agents.llm.react import run_tool_loop
    from agents.models import AgentChatResponse

    request.mode = RunMode.AGENT
    result = run_validation_cycle(conn, request, run_id=run_id)
    run_id = result["run_id"]
    kpi_data = result.get("kpi") or {}

    _progress(conn, run_id, "agent_briefing", detail="LLM orchestrator analyzing results")
    escalation_text = ", ".join(
        f"{e.get('code')}: {e.get('message')}" for e in (kpi_data.get("escalation") or [])
    )
    orchestrator_prompt = (
        f"Validation run {run_id} completed.\n"
        f"Topology validity: {kpi_data.get('topology_validity_pct')}%.\n"
        f"Completeness: {kpi_data.get('completeness_pct')}%.\n"
        f"Open exceptions: {kpi_data.get('open_exception_count')}.\n"
        f"Critical: {kpi_data.get('critical_exception_count')}.\n"
        f"Escalations: {escalation_text or 'none'}.\n\n"
        "Use tools to inspect open exceptions and topology health, then provide a steward briefing "
        "with prioritized actions and approval requirements."
    )
    messages = [
        {"role": "system", "content": ORCHESTRATOR_SYSTEM},
        {"role": "user", "content": orchestrator_prompt},
    ]
    react = run_tool_loop(
        conn,
        messages,
        run_id=run_id,
        agent_name="OrchestratorAgent",
    )
    content = react.get("content") or "Validation cycle completed."
    findings: list[str] = []
    actions: list[str] = []
    lower = content.lower()
    if "critical" in lower:
        findings.append("Critical exceptions require steward attention.")
    if react.get("tools_used"):
        actions.append(f"Orchestrator tools: {', '.join(react['tools_used'])}")
    if kpi_data.get("export_blocked"):
        findings.append("Topology export is blocked due to KPI threshold.")

    agent_summary = AgentChatResponse(
        content=content,
        findings=findings,
        actions=actions or ["Review KPI panel and approvals inbox"],
        agent={
            "provider": "openai-compatible",
            "model": react.get("model"),
            "tools_used": react.get("tools_used") or [],
            "turns": react.get("turns", 1),
            "auto": bool(react.get("configured")),
        },
    )
    completed = (result.get("phases") or {}).keys()
    agent_completed = list(completed) + ["agent_briefing", "kpi"]
    agent_meta = {
        "agent_summary": agent_summary.model_dump(),
        "current_phase": "completed",
        "completed_phases": agent_completed,
        "phase_detail": "Agent briefing complete",
    }
    if is_live_progress():
        repository.publish_run_progress(
            run_id,
            current_phase="completed",
            phase_detail="Agent briefing complete",
            completed_phases=agent_completed,
        )
        with conn.cursor() as cur:
            cur.execute(
                """
                UPDATE public.validation_runs
                SET metadata = COALESCE(metadata, '{}'::jsonb) || %s::jsonb
                WHERE id = %s::uuid
                """,
                (json.dumps({"agent_summary": agent_summary.model_dump()}), run_id),
            )
        conn.commit()
        repository.publish_validation_run_complete(
            run_id,
            status="completed",
            metadata=agent_meta,
        )
    else:
        repository.update_run_progress(
            conn,
            run_id,
            current_phase="completed",
            phase_detail="Agent briefing complete",
            completed_phases=agent_completed,
        )
        with conn.cursor() as cur:
            cur.execute(
                """
                UPDATE public.validation_runs
                SET metadata = COALESCE(metadata, '{}'::jsonb) || %s::jsonb
                WHERE id = %s::uuid
                """,
                (
                    json.dumps(
                        {"agent_summary": agent_summary.model_dump(), "current_phase": "completed"}
                    ),
                    run_id,
                ),
            )
    result["agent_summary"] = agent_summary
    return result
