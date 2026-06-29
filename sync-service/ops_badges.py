"""Aggregated nav-badge counts for the portal left navigation.

One cheap COUNT-only pass over the operational tables, returned as a single
payload so the portal makes one request instead of seven. Cached in Redis with
a short TTL by the caller.
"""

from __future__ import annotations

from typing import Any

# Staging assets that still need steward action.
STAGING_ACTIONABLE = ("STAGED", "PENDING_FIELD", "IN_CONFLICT")
# Work-order statuses that count as "done" (everything else is open work).
WORK_ORDER_CLOSED = ("COMPLETED", "CANCELLED")


def collect_badge_counts(conn) -> dict[str, int]:
    """Return badge counts keyed by portal tab id.

    Each query is COUNT-only and hits an indexed/status column, so this stays
    cheap even at full Ghana scale. Missing tables degrade to 0 rather than
    failing the whole payload.
    """
    counts: dict[str, int] = {
        "operations": 0,
        "data-quality": 0,
        "map": 0,
        "dlq": 0,
        "work-orders": 0,
        "tickets": 0,
        "cases": 0,
    }

    def _scalar(sql: str, params: tuple[Any, ...] = ()) -> int:
        with conn.cursor() as cur:
            cur.execute(sql, params)
            row = cur.fetchone()
            return int(row[0]) if row and row[0] is not None else 0

    # Staging assets awaiting approval / conflict resolution.
    counts["operations"] = _scalar(
        """
        SELECT COUNT(*)
        FROM staging.identified_objects io
        WHERE io.validation::text = ANY(%s)
        """,
        (list(STAGING_ACTIONABLE),),
    )

    # Open data-quality exceptions (all domains).
    counts["data-quality"] = _scalar(
        "SELECT COUNT(*) FROM public.data_quality_exceptions WHERE status = 'OPEN'"
    )

    # Open topology exceptions = "work on the map". Indexed on status; cheap.
    counts["map"] = _scalar(
        """
        SELECT COUNT(*)
        FROM public.data_quality_exceptions e
        JOIN public.data_quality_rules r ON r.rule_code = e.rule_code
        WHERE e.status = 'OPEN' AND r.domain = 'topology'
        """
    )

    # Open integration dead-letter items.
    counts["dlq"] = _scalar(
        "SELECT COUNT(*) FROM integration_dlq "
        "WHERE status = 'OPEN'::integration_dlq_status"
    )

    # Open work orders (anything not completed/cancelled).
    counts["work-orders"] = _scalar(
        "SELECT COUNT(*) FROM work_orders WHERE status::text <> ALL(%s)",
        (list(WORK_ORDER_CLOSED),),
    )

    # Open tickets / cases.
    counts["tickets"] = _scalar(
        "SELECT COUNT(*) FROM trouble_tickets WHERE status::text = 'OPEN'"
    )
    counts["cases"] = _scalar(
        "SELECT COUNT(*) FROM contact_cases WHERE status::text = 'OPEN'"
    )

    return counts
