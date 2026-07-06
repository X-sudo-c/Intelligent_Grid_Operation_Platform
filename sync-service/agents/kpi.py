"""KPI calculation and escalation logic."""

from __future__ import annotations

from typing import Any

from agents.repository import count_pending_approvals
from data_quality import summary
from topology_dq import (
    latest_topology_snapshot,
    topology_dq_summary,
    topology_snapshot_pending,
)

TOPOLOGY_VALIDITY_THRESHOLD = 98.0
COMPLETENESS_THRESHOLD = 97.0


def _resolve_topology_summary(
    conn,
    *,
    clip: dict[str, float] | None = None,
    live: bool = False,
) -> dict[str, Any]:
    """Prefer completed scan snapshots at national scale; live counts only when scoped."""
    if live or clip is not None:
        return topology_dq_summary(conn, clip=clip)
    snap = latest_topology_snapshot(conn)
    if snap is not None:
        return snap
    return topology_snapshot_pending(tier="master")


def _auto_fix_success_rate(conn) -> float | None:
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT COUNT(*) FILTER (WHERE status = 'executed'),
                       COUNT(*) FILTER (WHERE status IN ('executed','failed'))
                FROM public.cleanup_actions
                WHERE created_at > NOW() - INTERVAL '30 days'
                """
            )
            executed, attempted = cur.fetchone()
    except Exception:
        return None
    if attempted and attempted > 0:
        return round(100.0 * executed / attempted, 2)
    return None


def compute_kpis(
    conn,
    *,
    clip: dict[str, float] | None = None,
    live_topology: bool = False,
) -> dict[str, Any]:
    dq = summary(conn)
    topo = _resolve_topology_summary(conn, clip=clip, live=live_topology)
    live = topo.get("live") or {}
    approved_nodes = int(live.get("approved_nodes") or 0)
    orphan_nodes = int(live.get("orphan_nodes") or 0)
    connected = max(approved_nodes - orphan_nodes, 0)
    topology_validity_pct = (
        round(100.0 * connected / approved_nodes, 2) if approved_nodes else 100.0
    )

    # Completeness proxy: share of nodes with name + geometry (from open spatial/asset exceptions).
    open_total = dq.get("open_total") or 0
    spatial_open = (dq.get("open_by_domain") or {}).get("spatial", 0)
    asset_open = (dq.get("open_by_domain") or {}).get("asset", 0)
    completeness_deduction = spatial_open + asset_open
    if approved_nodes:
        completeness_pct = round(
            100.0 * max(approved_nodes - completeness_deduction, 0) / approved_nodes, 2
        )
    else:
        completeness_pct = 100.0

    critical_count = (dq.get("open_by_severity") or {}).get("critical", 0)
    pending_approvals = count_pending_approvals(conn)
    export_blocked = bool((topo.get("export_blocked") or {}).get("blocked"))

    escalation: list[dict[str, str]] = []
    if topology_validity_pct < TOPOLOGY_VALIDITY_THRESHOLD:
        escalation.append(
            {
                "code": "TOPOLOGY_BELOW_THRESHOLD",
                "message": f"Topology validity {topology_validity_pct}% < {TOPOLOGY_VALIDITY_THRESHOLD}%",
                "action": "block_export_oms",
            }
        )
    if completeness_pct < COMPLETENESS_THRESHOLD:
        escalation.append(
            {
                "code": "COMPLETENESS_BELOW_THRESHOLD",
                "message": f"Completeness {completeness_pct}% < {COMPLETENESS_THRESHOLD}%",
                "action": "trigger_cleanup_cycle",
            }
        )
    if critical_count > 0:
        escalation.append(
            {
                "code": "CRITICAL_EXCEPTIONS_OPEN",
                "message": f"{critical_count} critical exception(s) open",
                "action": "escalate_stewards",
            }
        )

    auto_fix_rate = _auto_fix_success_rate(conn)

    return {
        "topology_validity_pct": topology_validity_pct,
        "completeness_pct": completeness_pct,
        "critical_exception_count": critical_count,
        "open_exception_count": open_total,
        "auto_fix_success_rate": auto_fix_rate,
        "pending_approval_count": pending_approvals,
        "export_blocked": export_blocked,
        "escalation": escalation,
        "topology_summary": topo,
        "dq_summary": dq,
    }
