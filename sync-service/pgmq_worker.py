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
from typing import Any, Callable

logger = logging.getLogger(__name__)

PGMQ_CONSUMER_ENABLED = os.getenv("PGMQ_CONSUMER_ENABLED", "1").strip().lower() in (
    "1",
    "true",
    "yes",
)
PGMQ_POLL_INTERVAL_SEC = float(os.getenv("PGMQ_POLL_INTERVAL_SEC", "2"))
PGMQ_VISIBILITY_TIMEOUT_SEC = int(os.getenv("PGMQ_VISIBILITY_TIMEOUT_SEC", "7200"))

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


def _poll_once(conn_factory: Callable[[], Any]) -> int:
    handled = 0
    for queue_name, handler in _QUEUE_HANDLERS.items():
        conn = conn_factory()
        try:
            messages = _read_messages(conn, queue_name)
            for item in messages:
                msg_id = item["msg_id"]
                try:
                    handler(conn, item["message"])
                    conn.commit()
                    _ack_message(conn, msg_id)
                    conn.commit()
                    handled += 1
                except Exception:
                    conn.rollback()
                    logger.exception(
                        "pgmq handler failed queue=%s msg_id=%s payload=%s",
                        queue_name,
                        msg_id,
                        item.get("message"),
                    )
        finally:
            conn.close()
    return handled


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


def bootstrap_handlers() -> None:
    register_queue_handler("topology_dq_jobs", _handle_topology_dq_job)
    if os.getenv("PGMQ_HANDLE_GIS_JOBS", "").strip().lower() in ("1", "true", "yes"):
        register_queue_handler("gis_import_jobs", _handle_gis_import_job)
        register_queue_handler("gis_export_jobs", _handle_gis_export_job)
