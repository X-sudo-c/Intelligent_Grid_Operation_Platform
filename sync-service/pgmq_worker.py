"""Postgres message queue (pgmq) consumer for durable background jobs.

Supabase Queues uses pgmq under the hood. Job metadata lives in Postgres tables
(``gis_transfer_jobs``, ``data_quality_batch_runs``); pgmq holds lightweight
work items so scans survive sync-service restarts.

Queues (migration 00031 / 00074):
  - gis_import_jobs   — reference / boundary imports
  - gis_export_jobs   — CIM / DXF / GIS exports
  - topology_dq_jobs  — master topology batch scans
"""

from __future__ import annotations

import json
import logging
import os
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Any, Callable

logger = logging.getLogger(__name__)

PGMQ_CONSUMER_ENABLED = os.getenv("PGMQ_CONSUMER_ENABLED", "1").strip().lower() in (
    "1",
    "true",
    "yes",
)
PGMQ_POLL_INTERVAL_SEC = float(os.getenv("PGMQ_POLL_INTERVAL_SEC", "2"))
PGMQ_VISIBILITY_TIMEOUT_SEC = int(os.getenv("PGMQ_VISIBILITY_TIMEOUT_SEC", "7200"))
SWARM_MAX_INFLIGHT = max(1, min(32, int(os.getenv("GIOP_AI_SWARM_MAX_INFLIGHT", "4"))))
PARALLEL_QUEUES = frozenset({"endpoint_fix_ai_jobs"})

Handler = Callable[[Any, dict[str, Any]], None]

_QUEUE_HANDLERS: dict[str, Handler] = {}


def register_queue_handler(queue_name: str, handler: Handler) -> None:
    _QUEUE_HANDLERS[queue_name] = handler


def enqueue_topology_dq_job(conn, run_id: str) -> int | None:
    """Send a topology scan run id to pgmq after the batch row is committed."""
    with conn.cursor() as cur:
        cur.execute("SELECT public.enqueue_topology_dq_job(%s::uuid)", (run_id,))
        row = cur.fetchone()
    return int(row[0]) if row and row[0] is not None else None


def enqueue_endpoint_fix_ai_job(conn, run_id: str) -> int | None:
    with conn.cursor() as cur:
        cur.execute("SELECT public.enqueue_endpoint_fix_ai_job(%s::uuid)", (run_id,))
        row = cur.fetchone()
    return int(row[0]) if row and row[0] is not None else None


def count_endpoint_fix_ai_jobs_for_run(conn, run_id: str) -> int:
    """In-flight pgmq messages for a district run (visible + waiting)."""
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT count(*)::bigint
            FROM pgmq.q_endpoint_fix_ai_jobs
            WHERE message->>'run_id' = %s
            """,
            (run_id,),
        )
        return int(cur.fetchone()[0])


def fan_out_endpoint_fix_ai_jobs(conn, run_id: str, workers: int) -> int:
    """Enqueue multiple pgmq messages so parallel consumers can claim distinct rows."""
    enqueued = 0
    for _ in range(max(1, workers)):
        if enqueue_endpoint_fix_ai_job(conn, run_id) is not None:
            enqueued += 1
    return enqueued


def _read_messages(conn, queue_name: str, *, qty: int = 1) -> list[dict[str, Any]]:
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT msg_id, read_ct, enqueued_at, vt, message
            FROM pgmq.read(%s, %s, %s)
            """,
            (queue_name, PGMQ_VISIBILITY_TIMEOUT_SEC, qty),
        )
        rows = cur.fetchall()
    out: list[dict[str, Any]] = []
    for msg_id, read_ct, enqueued_at, vt, message in rows:
        if isinstance(message, str):
            message = json.loads(message)
        out.append(
            {
                "msg_id": int(msg_id),
                "read_ct": int(read_ct),
                "enqueued_at": enqueued_at,
                "vt": vt,
                "message": message or {},
            }
        )
    return out


def _ack_message(conn, queue_name: str, msg_id: int) -> None:
    with conn.cursor() as cur:
        cur.execute("SELECT pgmq.delete(%s, %s)", (queue_name, msg_id))


def _process_queue_message(
    conn_factory: Callable[[], Any],
    queue_name: str,
    handler: Handler,
    item: dict[str, Any],
) -> bool:
    conn = conn_factory()
    try:
        handler(conn, item["message"])
        conn.commit()
        ack_conn = conn_factory()
        try:
            _ack_message(ack_conn, queue_name, item["msg_id"])
            ack_conn.commit()
        finally:
            ack_conn.close()
        return True
    except Exception:
        conn.rollback()
        logger.exception(
            "pgmq handler failed queue=%s msg_id=%s payload=%s",
            queue_name,
            item.get("msg_id"),
            item.get("message"),
        )
        return False
    finally:
        conn.close()


def _poll_once(conn_factory: Callable[[], Any]) -> int:
    handled = 0
    for queue_name, handler in _QUEUE_HANDLERS.items():
        qty = SWARM_MAX_INFLIGHT if queue_name in PARALLEL_QUEUES else 1
        conn = conn_factory()
        try:
            messages = _read_messages(conn, queue_name, qty=qty)
        finally:
            conn.close()
        if not messages:
            continue
        if queue_name in PARALLEL_QUEUES and len(messages) > 1:
            max_workers = min(qty, len(messages))
            with ThreadPoolExecutor(max_workers=max_workers) as pool:
                futures = [
                    pool.submit(
                        _process_queue_message,
                        conn_factory,
                        queue_name,
                        handler,
                        item,
                    )
                    for item in messages
                ]
                for future in as_completed(futures):
                    if future.result():
                        handled += 1
        else:
            for item in messages:
                if _process_queue_message(conn_factory, queue_name, handler, item):
                    handled += 1
    sweep_stalled_endpoint_fix_ai_jobs(conn_factory)
    return handled


def sweep_stalled_endpoint_fix_ai_jobs(conn_factory: Callable[[], Any]) -> int:
    """Enqueue one sweeper per stalled run that has no pending pgmq message."""
    conn = conn_factory()
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT r.id::text
                FROM gis.endpoint_fix_ai_runs r
                WHERE r.status = 'running'
                  AND EXISTS (
                    SELECT 1
                    FROM gis.conductor_endpoint_proposals p
                    WHERE p.district = r.district
                      AND p.status = 'pending'
                      AND p.ai_rationale IS NULL
                  )
                """
            )
            run_ids = [row[0] for row in cur.fetchall()]
        enqueued = 0
        for run_id in run_ids:
            if count_endpoint_fix_ai_jobs_for_run(conn, run_id) > 0:
                continue
            if enqueue_endpoint_fix_ai_job(conn, run_id) is not None:
                enqueued += 1
        if enqueued:
            conn.commit()
            logger.info(
                "endpoint fix AI sweep enqueued %s job(s) for stalled run(s)",
                enqueued,
            )
        return enqueued
    except Exception:
        conn.rollback()
        logger.exception("endpoint fix AI sweep failed")
        return 0
    finally:
        conn.close()


class PgmqWorker:
    """Background thread that polls pgmq queues."""

    def __init__(self, conn_factory: Callable[[], Any]) -> None:
        self._conn_factory = conn_factory
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(
            target=self._run,
            name="pgmq-worker",
            daemon=True,
        )
        self._thread.start()
        logger.info("pgmq worker started (queues=%s)", list(_QUEUE_HANDLERS))

    def stop(self, timeout: float = 5.0) -> None:
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=timeout)

    def _run(self) -> None:
        while not self._stop.is_set():
            try:
                _poll_once(self._conn_factory)
            except Exception:
                logger.exception("pgmq poll loop error")
            self._stop.wait(PGMQ_POLL_INTERVAL_SEC)


_worker: PgmqWorker | None = None


def start_pgmq_worker(conn_factory: Callable[[], Any]) -> PgmqWorker | None:
    global _worker
    if not PGMQ_CONSUMER_ENABLED or not _QUEUE_HANDLERS:
        return None
    _worker = PgmqWorker(conn_factory)
    _worker.start()
    return _worker


def stop_pgmq_worker() -> None:
    global _worker
    if _worker:
        _worker.stop()
        _worker = None


def _handle_topology_dq_job(conn, message: dict[str, Any]) -> None:
    from redis_cache import invalidate_ops_cache, invalidate_topology_cache
    from topology_dq import execute_topology_batch_scan

    run_id = message.get("run_id")
    if not run_id:
        raise ValueError("topology_dq_jobs message missing run_id")

    execute_topology_batch_scan(conn, run_id)
    invalidate_ops_cache()
    invalidate_topology_cache()


def _handle_gis_import_job(conn, message: dict[str, Any]) -> None:
    from reference_import import process_boundary_import_job

    job_id = message.get("job_id")
    if not job_id:
        raise ValueError("gis_import_jobs message missing job_id")
    process_boundary_import_job(conn, job_id)


def _handle_gis_export_job(conn, message: dict[str, Any]) -> None:
    from cim_export import get_job
    from export_dispatch import process_job

    job_id = message.get("job_id")
    if not job_id:
        raise ValueError("gis_export_jobs message missing job_id")
    job = get_job(conn, job_id)
    if not job:
        raise ValueError(f"export job not found: {job_id}")
    process_job(conn, job_id, job["format"])


def _handle_endpoint_fix_ai_job(conn, message: dict[str, Any]) -> None:
    from endpoint_fix_ai_runs import execute_endpoint_fix_ai_batch

    run_id = message.get("run_id")
    if not run_id:
        raise ValueError("endpoint_fix_ai_jobs message missing run_id")

    execute_endpoint_fix_ai_batch(conn, run_id)


def bootstrap_handlers() -> None:
    # Register endpoint-fix before topology — long-running topology scans must not
    # block steward AI scan batches on the same poll thread.
    register_queue_handler("endpoint_fix_ai_jobs", _handle_endpoint_fix_ai_job)
    register_queue_handler("topology_dq_jobs", _handle_topology_dq_job)
    if os.getenv("PGMQ_HANDLE_GIS_JOBS", "").strip().lower() in ("1", "true", "yes"):
        register_queue_handler("gis_import_jobs", _handle_gis_import_job)
        register_queue_handler("gis_export_jobs", _handle_gis_export_job)
