"""District-scale background AI scan for endpoint fix proposals."""

from __future__ import annotations

import logging
import math
import os
import uuid
from typing import Any

from agents.llm.provider import cleanup_llm_configured
from endpoint_proposal_tier import normalize_data_tier
from endpoint_proposals import (
    count_pending_unscanned,
    count_pending_without_ai_review,
)
from endpoint_proposals_ai import (
    AI_SCAN_MAX_LIMIT,
    ai_scan_endpoint_fix_proposals,
)

logger = logging.getLogger(__name__)

DEFAULT_DISTRICT_BATCH_SIZE = max(
    10, min(AI_SCAN_MAX_LIMIT, int(os.getenv("GIOP_ENDPOINT_AI_DISTRICT_BATCH_SIZE", "25")))
)
SWARM_MAX_INFLIGHT = max(1, min(32, int(os.getenv("GIOP_AI_SWARM_MAX_INFLIGHT", "4"))))


class EndpointFixAiRunInProgressError(Exception):
    def __init__(self, run_id: str) -> None:
        super().__init__(f"endpoint_fix_ai_run_in_progress:{run_id}")
        self.run_id = run_id


def find_active_endpoint_fix_ai_run(
    conn, district: str, *, data_tier: str = "gis"
) -> dict[str, Any] | None:
    district = (district or "").strip()
    tier = normalize_data_tier(data_tier)
    from endpoint_fix_ai_run_cache import get_cached_active_run_id, get_cached_endpoint_fix_ai_run

    cached_id = get_cached_active_run_id(district, tier)
    if cached_id:
        cached = get_cached_endpoint_fix_ai_run(cached_id)
        if (
            cached
            and cached.get("status") == "running"
            and cached.get("district") == district
            and (cached.get("data_tier") or "gis") == tier
        ):
            return cached
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT id::text, district, status, reasoning_depth, batch_size,
                   total_pending, rows_reviewed, batches_completed,
                   last_model, error_message, created_at, completed_at, updated_at,
                   swarm_workers, data_tier
            FROM gis.endpoint_fix_ai_runs
            WHERE district = %s AND data_tier = %s AND status = 'running'
            ORDER BY created_at DESC
            LIMIT 1
            """,
            (district, tier),
        )
        row = cur.fetchone()
    if not row:
        return None
    return _row_to_run(row)


def create_endpoint_fix_ai_run(
    conn,
    district: str,
    *,
    data_tier: str = "gis",
    batch_size: int = DEFAULT_DISTRICT_BATCH_SIZE,
    reasoning_depth: str = "quick",
    requested_by: str | None = None,
) -> dict[str, Any]:
    district = (district or "").strip()
    tier = normalize_data_tier(data_tier)
    if not district:
        raise ValueError("district is required")
    if batch_size < 1 or batch_size > AI_SCAN_MAX_LIMIT:
        raise ValueError(f"batch_size must be between 1 and {AI_SCAN_MAX_LIMIT}")
    if reasoning_depth not in ("quick", "deep"):
        raise ValueError("reasoning_depth must be quick or deep")
    if not cleanup_llm_configured():
        raise ValueError("llm_not_configured")

    active = find_active_endpoint_fix_ai_run(conn, district, data_tier=tier)
    if active:
        raise EndpointFixAiRunInProgressError(active["id"])

    pending = count_pending_without_ai_review(conn, district, data_tier=tier)
    if pending == 0:
        raise ValueError("no_unscanned_proposals")

    effective_depth = reasoning_depth
    if reasoning_depth == "deep":
        logger.warning(
            "District endpoint AI scan coerces deep -> quick (swarm uses tiered batch only)"
        )
        effective_depth = "quick"

    swarm_workers = _swarm_workers_for_pending(pending, batch_size)

    run_id = str(uuid.uuid4())
    with conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO gis.endpoint_fix_ai_runs (
              id, district, data_tier, status, reasoning_depth, batch_size,
              total_pending, requested_by, swarm_workers
            ) VALUES (%s::uuid, %s, %s, 'running', %s, %s, %s, %s, %s)
            """,
            (
                run_id,
                district,
                tier,
                effective_depth,
                batch_size,
                pending,
                requested_by,
                swarm_workers,
            ),
        )
    conn.commit()
    run = get_endpoint_fix_ai_run(conn, run_id, use_cache=False)
    if run:
        from endpoint_fix_ai_run_cache import cache_endpoint_fix_ai_run

        cache_endpoint_fix_ai_run(run)
    return run or {"id": run_id}


def _attach_progress(run: dict[str, Any], remaining: int) -> dict[str, Any]:
    total = max(int(run.get("total_pending") or 0), 1)
    run = dict(run)
    run["remaining_unscanned"] = remaining
    run["progress_pct"] = min(100, int(round(100 * (total - remaining) / total)))
    return run


def _fetch_run_row(conn, run_id: str) -> dict[str, Any] | None:
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT id::text, district, status, reasoning_depth, batch_size,
                   total_pending, rows_reviewed, batches_completed,
                   last_model, error_message, created_at, completed_at, updated_at,
                   swarm_workers, data_tier
            FROM gis.endpoint_fix_ai_runs
            WHERE id = %s::uuid
            """,
            (run_id,),
        )
        row = cur.fetchone()
    if not row:
        return None
    return _row_to_run(row)


def get_endpoint_fix_ai_run(
    conn,
    run_id: str,
    *,
    use_cache: bool = True,
    remaining_override: int | None = None,
) -> dict[str, Any] | None:
    if use_cache and remaining_override is None:
        from endpoint_fix_ai_run_cache import get_cached_endpoint_fix_ai_run

        cached = get_cached_endpoint_fix_ai_run(run_id)
        if cached is not None:
            return cached

    run = _fetch_run_row(conn, run_id)
    if not run:
        return None
    remaining = (
        remaining_override
        if remaining_override is not None
        else count_pending_without_ai_review(
            conn, run["district"], data_tier=run.get("data_tier") or "gis"
        )
    )
    out = _attach_progress(run, remaining)
    if use_cache:
        from endpoint_fix_ai_run_cache import cache_endpoint_fix_ai_run

        cache_endpoint_fix_ai_run(out)
    return out


def execute_endpoint_fix_ai_batch(
    conn, run_id: str, *, requeue_pgmq: bool = True
) -> dict[str, Any]:
    """Process one claimed batch for a district run; re-enqueue if work remains."""
    run = get_endpoint_fix_ai_run(conn, run_id, use_cache=True)
    if not run:
        raise ValueError("run_not_found")
    if run["status"] != "running":
        return run

    district = run["district"]
    tier = run.get("data_tier") or "gis"
    remaining_unreviewed = count_pending_without_ai_review(conn, district, data_tier=tier)
    if remaining_unreviewed == 0:
        _finalize_run(conn, run_id, status="completed")
        return get_endpoint_fix_ai_run(conn, run_id, remaining_override=0) or {}

    if count_pending_unscanned(conn, district, data_tier=tier) == 0:
        # Other swarm workers hold active claims — do not finalize the run.
        return get_endpoint_fix_ai_run(conn, run_id, use_cache=True) or {}

    batch_size = int(run["batch_size"])
    reviewed = 0
    result: dict[str, Any] = {}
    try:
        result = ai_scan_endpoint_fix_proposals(
            conn,
            district,
            data_tier=tier,
            limit=batch_size,
            swarm_claim=True,
            mode="tiered",
            reasoning_depth=run["reasoning_depth"],
        )
        reviewed = int(result.get("proposals_reviewed") or 0)
    except ValueError as exc:
        if str(exc) != "no_pending_proposals":
            raise
        if count_pending_without_ai_review(conn, district, data_tier=tier) == 0:
            _finalize_run(conn, run_id, status="completed")
        return get_endpoint_fix_ai_run(conn, run_id, use_cache=True) or {}
    except Exception as exc:
        _finalize_run(conn, run_id, status="failed", error_message=str(exc)[:500])
        raise

    remaining_after = count_pending_without_ai_review(conn, district, data_tier=tier)
    with conn.cursor() as cur:
        cur.execute(
            """
            UPDATE gis.endpoint_fix_ai_runs
            SET rows_reviewed = rows_reviewed + %s,
                batches_completed = batches_completed + 1,
                last_model = %s,
                updated_at = now(),
                status = CASE WHEN %s = 0 THEN 'completed' ELSE status END,
                completed_at = CASE WHEN %s = 0 THEN now() ELSE completed_at END
            WHERE id = %s::uuid
            """,
            (
                reviewed,
                result.get("model"),
                remaining_after,
                remaining_after,
                run_id,
            ),
        )
    conn.commit()

    out = get_endpoint_fix_ai_run(
        conn, run_id, use_cache=False, remaining_override=remaining_after
    ) or {}
    from endpoint_fix_ai_run_cache import cache_endpoint_fix_ai_run

    cache_endpoint_fix_ai_run(out)
    if remaining_after > 0 and out.get("status") == "running":
        if _maybe_requeue_endpoint_fix_run(conn, run_id, requeue_pgmq=requeue_pgmq):
            out["requeue"] = True
    return out


def _maybe_requeue_endpoint_fix_run(
    conn, run_id: str, *, requeue_pgmq: bool
) -> bool:
    """Enqueue a pgmq sweeper when work remains and no message is already queued."""
    if not requeue_pgmq:
        return False
    from pgmq_worker import count_endpoint_fix_ai_jobs_for_run, enqueue_endpoint_fix_ai_job

    if count_endpoint_fix_ai_jobs_for_run(conn, run_id) > 0:
        return False
    msg_id = enqueue_endpoint_fix_ai_job(conn, run_id)
    if msg_id is not None:
        conn.commit()
        return True
    return False


def _swarm_workers_for_pending(pending: int, batch_size: int) -> int:
    batches = max(1, math.ceil(pending / max(batch_size, 1)))
    return min(SWARM_MAX_INFLIGHT, batches)


def _finalize_run(
    conn,
    run_id: str,
    *,
    status: str,
    error_message: str | None = None,
) -> None:
    with conn.cursor() as cur:
        cur.execute(
            """
            UPDATE gis.endpoint_fix_ai_runs
            SET status = %s,
                error_message = %s,
                completed_at = now(),
                updated_at = now()
            WHERE id = %s::uuid
            """,
            (status, error_message, run_id),
        )
    conn.commit()
    row = _fetch_run_row(conn, run_id)
    if not row:
        return
    remaining = 0 if status == "completed" else count_pending_without_ai_review(
        conn, row["district"], data_tier=row.get("data_tier") or "gis"
    )
    finalized = _attach_progress(row, remaining)
    if error_message:
        finalized["error_message"] = error_message
    finalized["status"] = status
    from endpoint_fix_ai_run_cache import cache_endpoint_fix_ai_run

    cache_endpoint_fix_ai_run(finalized)


def _row_to_run(row: tuple) -> dict[str, Any]:
    return {
        "id": row[0],
        "district": row[1],
        "status": row[2],
        "reasoning_depth": row[3],
        "batch_size": row[4],
        "total_pending": row[5],
        "rows_reviewed": row[6],
        "batches_completed": row[7],
        "last_model": row[8],
        "error_message": row[9],
        "created_at": row[10].isoformat() if row[10] else None,
        "completed_at": row[11].isoformat() if row[11] else None,
        "updated_at": row[12].isoformat() if row[12] else None,
        "swarm_workers": row[13] if len(row) > 13 else SWARM_MAX_INFLIGHT,
        "data_tier": row[14] if len(row) > 14 else "gis",
    }
