"""QueueManagerAgent — route exceptions to virtual queues."""

from __future__ import annotations

from typing import Any

from agents.audit import log_agent_step
from agents import policy
from agents import repository
from agents import tools


def run_queue_phase(conn, run_id: str, *, limit: int = 200) -> dict[str, Any]:
    items = tools.tool_list_exceptions(conn, limit=limit)
    routed = 0
    for item in items:
        queue = policy.route_queue(
            domain=item.get("domain") or "asset",
            severity=item.get("severity") or "major",
            rule_code=item.get("rule_code") or "",
        )
        if not policy.validate_queue_name(queue):
            queue = "ex_default"
        repository.route_exception_queue(conn, item["id"], queue_name=queue)
        routed += 1
    log_agent_step(
        conn,
        run_id=run_id,
        agent_name="QueueManagerAgent",
        tool_name="route_exception",
        output_summary={"routed": routed},
    )
    return {"routed": routed}
