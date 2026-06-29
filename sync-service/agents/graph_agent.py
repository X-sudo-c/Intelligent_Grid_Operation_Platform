"""GraphAgent — topology batch scan and NetworkX analysis."""

from __future__ import annotations

import uuid
from typing import Any

from agents.audit import log_agent_step
from agents.context import check_run_deadline, is_live_progress
from agents import graph_tools
from agents import repository
from agents import tools
from data_quality import upsert_network_topology_exceptions


def _valid_uuid(value: str) -> bool:
    try:
        uuid.UUID(str(value))
        return True
    except (ValueError, TypeError):
        return False


def run_graph_phase(
    conn,
    run_id: str,
    *,
    clip: dict[str, float] | None = None,
    requested_by: str | None = None,
) -> dict[str, Any]:
    log_agent_step(
        conn,
        run_id=run_id,
        agent_name="GraphAgent",
        tool_name="topology_batch_scan",
        policy_decision="allowed",
    )
    if is_live_progress():
        repository.publish_run_progress(
            run_id,
            current_phase="graph",
            phase_detail="Running topology batch scan…",
        )
    check_run_deadline()
    scan = tools.tool_topology_batch_scan(conn, clip=clip, requested_by=requested_by)
    if is_live_progress():
        repository.publish_run_progress(
            run_id,
            current_phase="graph",
            phase_detail="Analyzing graph loops and islands…",
        )
    check_run_deadline()
    health = tools.tool_topology_health()
    cycles = graph_tools.detect_cycles()
    islands = graph_tools.detect_islands()
    dq_inserted = {"loops": 0, "islands": 0}

    if cycles.get("count", 0) > 0:
        from agents import repository

        repository.insert_validation_result(
            conn,
            run_id=run_id,
            rule_code="TOPO_NETWORK_LOOP",
            record_mrid=None,
            record_type="network",
            outcome="FAIL",
            message=f"{cycles['count']} network loop(s) detected",
            details=cycles,
        )
        loop_nodes: list[str] = []
        for cycle in cycles.get("cycles") or []:
            for node in cycle:
                if _valid_uuid(node) and node not in loop_nodes:
                    loop_nodes.append(node)
        dq_inserted["loops"] = upsert_network_topology_exceptions(
            conn,
            rule_code="TOPO_NETWORK_LOOP",
            node_mrids=loop_nodes,
            message=f"Network loop detected ({cycles['count']} total).",
            details={"cycle_sample": (cycles.get("cycles") or [])[:3], "total_loops": cycles["count"]},
        )

    if islands.get("small_component_count", 0) > 0:
        from agents import repository

        repository.insert_validation_result(
            conn,
            run_id=run_id,
            rule_code="TOPO_ISLAND_COMPONENT",
            record_mrid=None,
            record_type="network",
            outcome="FAIL",
            message=f"{islands['small_component_count']} small island component(s)",
            details=islands,
        )
        island_nodes: list[str] = []
        for component in islands.get("islands") or []:
            for node in component:
                if _valid_uuid(node) and node not in island_nodes:
                    island_nodes.append(node)
        dq_inserted["islands"] = upsert_network_topology_exceptions(
            conn,
            rule_code="TOPO_ISLAND_COMPONENT",
            node_mrids=island_nodes,
            message="Small disconnected island component detected.",
            details={
                "component_sample": (islands.get("islands") or [])[:3],
                "small_component_count": islands.get("small_component_count"),
            },
        )

    log_agent_step(
        conn,
        run_id=run_id,
        agent_name="GraphAgent",
        tool_name="detect_cycles",
        output_summary={
            "cycle_count": cycles.get("count", 0),
            "dq_exceptions_inserted": dq_inserted,
        },
    )
    return {
        "topology_scan": scan,
        "health": health,
        "cycles": cycles,
        "islands": islands,
        "dq_exceptions_inserted": dq_inserted,
    }
