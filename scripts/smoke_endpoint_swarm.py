#!/usr/bin/env python3
"""Smoke test: parallel endpoint-fix AI swarm (in-process, no pgmq polling)."""

from __future__ import annotations

import os
import sys
import time
import concurrent.futures
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
SYNC = REPO / "sync-service"
sys.path.insert(0, str(SYNC))

env_path = REPO / ".env"
if env_path.is_file():
    for line in env_path.read_text().splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, _, v = line.partition("=")
            os.environ.setdefault(k.strip(), v.strip())


def main() -> int:
    district = os.environ.get("SMOKE_DISTRICT", "Achimota")
    batch_size = int(os.environ.get("SMOKE_BATCH_SIZE", "10"))
    workers = int(os.environ.get("SMOKE_SWARM_WORKERS", "3"))

    from db_pool import pooled_connect
    from endpoint_fix_ai_runs import (
        create_endpoint_fix_ai_run,
        execute_endpoint_fix_ai_batch,
        get_endpoint_fix_ai_run,
    )
    from endpoint_proposals import count_pending_without_ai_review

    uri = os.environ.get("SUPABASE_DB_URI")
    if not uri:
        print("SUPABASE_DB_URI not set", file=sys.stderr)
        return 1

    pending = count_pending_without_ai_review(pooled_connect(uri), district)
    pooled_connect(uri).close()
    print(f"District: {district} | unreviewed={pending} | batch={batch_size} | workers={workers}")
    if pending == 0:
        print("Nothing to scan — reset ai_rationale on some pending rows first.")
        return 2

    conn = pooled_connect(uri)
    try:
        run = create_endpoint_fix_ai_run(
            conn, district, batch_size=batch_size, reasoning_depth="quick"
        )
        run_id = run["id"]
        print(f"Run {run_id} started (swarm_workers={run.get('swarm_workers')})")
    except Exception as exc:
        print(f"Failed to create run: {exc}", file=sys.stderr)
        return 1
    finally:
        conn.close()

    def worker_loop() -> dict:
        bg = pooled_connect(uri)
        try:
            batches = 0
            reviewed = 0
            while True:
                run = get_endpoint_fix_ai_run(bg, run_id) or {}
                if run.get("status") != "running":
                    break
                before = int(run.get("rows_reviewed") or 0)
                try:
                    result = execute_endpoint_fix_ai_batch(bg, run_id, requeue_pgmq=False)
                except Exception as exc:
                    return {"error": str(exc), "batches": batches, "reviewed": reviewed}
                after = int(result.get("rows_reviewed") or before)
                delta = max(0, after - before) if batches == 0 else max(0, after - reviewed)
                reviewed = after
                batches += 1
                if result.get("status") != "running":
                    break
                if int(result.get("remaining_unscanned") or 0) == 0:
                    break
                if delta == 0 and count_pending_without_ai_review(bg, district) > 0:
                    # No claimable rows — another worker has them or all in flight
                    time.sleep(2)
                    if count_pending_without_ai_review(bg, district) == 0:
                        break
                    continue
            return {"batches": batches, "reviewed": reviewed}
        finally:
            bg.close()

    t0 = time.perf_counter()
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:
        results = list(pool.map(lambda _: worker_loop(), range(workers)))
    elapsed = time.perf_counter() - t0

    conn = pooled_connect(uri)
    try:
        final = get_endpoint_fix_ai_run(conn, run_id) or {}
        remaining = count_pending_without_ai_review(conn, district)
    finally:
        conn.close()

    print(f"\nElapsed: {elapsed:.1f}s")
    print(f"Workers: {results}")
    print(
        f"Final: status={final.get('status')} "
        f"reviewed={final.get('rows_reviewed')}/{final.get('total_pending')} "
        f"batches={final.get('batches_completed')} "
        f"remaining={remaining} "
        f"model={final.get('last_model')}"
    )
    ok = final.get("status") == "completed" and remaining == 0
    print("PASS" if ok else "FAIL")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
