"""Postgres → Memgraph sync. Postgres is always the source of truth."""

from __future__ import annotations

import os
import time
from typing import Any, Optional

import psycopg2
from neo4j import GraphDatabase

GRAPH_URI = os.getenv("GRAPH_DB_URI") or os.getenv("MEMGRAPH_URI", "bolt://127.0.0.1:7687")
SUPABASE_DB_URI = os.getenv("SUPABASE_DB_URI")
SYNC_BATCH_SIZE = int(os.getenv("MEMGRAPH_SYNC_BATCH", "2000"))
SYNC_MAX_RETRIES = int(os.getenv("MEMGRAPH_SYNC_RETRIES", "8"))
SYNC_RETRY_DELAY_SEC = float(os.getenv("MEMGRAPH_SYNC_RETRY_DELAY", "3"))


class _DriverHolder:
    """Neo4j driver with reconnect after Memgraph restarts / defunct Bolt sessions."""

    def __init__(self, driver: GraphDatabase.driver | None = None) -> None:
        self._driver = driver
        self._own = driver is None

    def get(self) -> GraphDatabase.driver:
        if self._driver is None:
            self._driver = GraphDatabase.driver(GRAPH_URI, auth=None)
            self._own = True
        return self._driver

    def reconnect(self) -> GraphDatabase.driver:
        if self._own and self._driver is not None:
            try:
                self._driver.close()
            except Exception:
                pass
        self._driver = GraphDatabase.driver(GRAPH_URI, auth=None)
        self._own = True
        return self._driver

    def close(self) -> None:
        if self._own and self._driver is not None:
            self._driver.close()
            self._driver = None


def _pg_connect():
    if not SUPABASE_DB_URI:
        raise RuntimeError("SUPABASE_DB_URI not configured")
    return psycopg2.connect(SUPABASE_DB_URI)


def memgraph_totals(driver: GraphDatabase.driver) -> tuple[int, int]:
    with driver.session() as session:
        node_count = session.run("MATCH (c:ConnectivityNode) RETURN count(c) AS n").single()["n"]
        edge_count = session.run(
            "MATCH ()-[r:AC_LINE_SEGMENT]->() RETURN count(r) AS n"
        ).single()["n"]
    return int(node_count), int(edge_count)


def graph_parity_report(driver: GraphDatabase.driver | None = None) -> dict[str, Any]:
    """Compare Postgres master topology counts with Memgraph (read-only)."""
    own_driver = driver is None
    if own_driver:
        driver = GraphDatabase.driver(GRAPH_URI, auth=None)

    nodes, edges = fetch_topology_from_postgres()
    pg_nodes, pg_edges = len(nodes), len(edges)

    try:
        mg_nodes, mg_edges = memgraph_totals(driver)
    finally:
        if own_driver:
            driver.close()

    node_delta = mg_nodes - pg_nodes
    edge_delta = mg_edges - pg_edges
    in_sync = node_delta == 0 and edge_delta == 0

    if in_sync:
        status = "pass"
        hint = None
    elif mg_nodes == 0 and mg_edges == 0 and (pg_nodes > 0 or pg_edges > 0):
        status = "fail"
        hint = "Memgraph empty — run Sync Memgraph or .venv/bin/python memgraph/bootstrap.py"
    elif pg_nodes == 0:
        status = "warn"
        hint = "Postgres has no topology — import GPKG and promote first"
    else:
        status = "warn"
        hint = (
            "Postgres and Memgraph counts differ — run Sync Memgraph after bulk promote "
            "(promote_topology disables webhooks)"
        )

    return {
        "status": status,
        "in_sync": in_sync,
        "postgres_nodes": pg_nodes,
        "postgres_edges": pg_edges,
        "memgraph_nodes": mg_nodes,
        "memgraph_edges": mg_edges,
        "node_delta": node_delta,
        "edge_delta": edge_delta,
        "hint": hint,
    }


def fetch_topology_from_postgres() -> tuple[list[tuple[str, str]], list[tuple[str, str, str, str, str, bool]]]:
    conn = _pg_connect()
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT cn.mrid::text, io.name
                FROM connectivity_nodes cn
                JOIN identified_objects io ON cn.mrid = io.mrid
                """
            )
            nodes = cur.fetchall()
            cur.execute(
                """
                SELECT
                  als.mrid::text,
                  als.source_node_id::text,
                  als.target_node_id::text,
                  ce.phases,
                  ce.nominal_voltage::text,
                  als.direction_downstream
                FROM ac_line_segments als
                JOIN conducting_equipment ce ON als.mrid = ce.mrid
                """
            )
            edges = cur.fetchall()
        return nodes, edges
    finally:
        conn.close()


def _is_transient_memgraph_error(exc: BaseException) -> bool:
    msg = str(exc).lower()
    return any(
        token in msg
        for token in (
            "defunct connection",
            "database shutdown",
            "transient",
            "connection reset",
            "broken pipe",
            "timeout",
            "service unavailable",
        )
    )


def _run_write(holder: _DriverHolder, query: str, **params) -> None:
    """Execute one Memgraph write in its own session/transaction with retries."""
    last_exc: BaseException | None = None
    for attempt in range(SYNC_MAX_RETRIES):
        try:
            with holder.get().session() as session:
                result = session.run(query, **params)
                result.consume()
            return
        except Exception as exc:
            last_exc = exc
            if attempt + 1 >= SYNC_MAX_RETRIES or not _is_transient_memgraph_error(exc):
                raise
            delay = SYNC_RETRY_DELAY_SEC * (attempt + 1)
            print(
                f"  Memgraph write retry {attempt + 1}/{SYNC_MAX_RETRIES} "
                f"after {delay:.0f}s ({exc})",
                flush=True,
            )
            holder.reconnect()
            time.sleep(delay)
    if last_exc:
        raise last_exc


def _ensure_memgraph_indexes(holder: _DriverHolder) -> None:
    for label, prop in (("ConnectivityNode", "mrid"), ("AC_LINE_SEGMENT", "mrid")):
        try:
            _run_write(holder, f"CREATE INDEX ON :{label}({prop})")
        except Exception as exc:
            if "already exists" not in str(exc).lower():
                print(f"  index :{label}({prop}) skipped: {exc}", flush=True)


def _log_progress(phase: str, done: int, total: int, offset: int) -> None:
    if total <= SYNC_BATCH_SIZE or offset % (SYNC_BATCH_SIZE * 5) == 0 or done == total:
        print(f"  {phase} {done}/{total}", flush=True)


def _upsert_nodes(holder: _DriverHolder, nodes: list[tuple[str, str]], sync_epoch: int) -> None:
    total = len(nodes)
    for offset in range(0, total, SYNC_BATCH_SIZE):
        batch = [
            {"mrid": mrid, "name": name}
            for mrid, name in nodes[offset : offset + SYNC_BATCH_SIZE]
        ]
        _run_write(
            holder,
            """
            UNWIND $batch AS row
            MERGE (c:ConnectivityNode {mrid: row.mrid})
            SET c.name = row.name, c.sync_epoch = $sync_epoch
            """,
            batch=batch,
            sync_epoch=sync_epoch,
        )
        _log_progress("nodes", min(offset + len(batch), total), total, offset)


def _upsert_edges(
    holder: _DriverHolder,
    edges: list[tuple[str, str, str, str, str, bool]],
    sync_epoch: int,
) -> None:
    total = len(edges)
    for offset in range(0, total, SYNC_BATCH_SIZE):
        batch = [
            {
                "mrid": mrid,
                "source_mrid": source_id,
                "target_mrid": target_id,
                "phases": phases,
                "voltage": voltage,
                "direction": direction,
            }
            for mrid, source_id, target_id, phases, voltage, direction in edges[
                offset : offset + SYNC_BATCH_SIZE
            ]
        ]
        _run_write(
            holder,
            """
            UNWIND $batch AS row
            MATCH (src:ConnectivityNode {mrid: row.source_mrid})
            MATCH (tgt:ConnectivityNode {mrid: row.target_mrid})
            MERGE (src)-[r:AC_LINE_SEGMENT {mrid: row.mrid}]->(tgt)
            SET r.phases = row.phases,
                r.voltage = row.voltage,
                r.direction_downstream = row.direction,
                r.sync_epoch = $sync_epoch
            """,
            batch=batch,
            sync_epoch=sync_epoch,
        )
        _log_progress("edges", min(offset + len(batch), total), total, offset)


def _delete_in_batches(
    holder: _DriverHolder,
    query: str,
    *,
    label: str,
    sync_epoch: int | None = None,
) -> int:
    removed = 0
    while True:
        params: dict[str, Any] = {"batch_size": SYNC_BATCH_SIZE}
        if sync_epoch is not None:
            params["sync_epoch"] = sync_epoch
        try:
            with holder.get().session() as session:
                result = session.run(query, **params)
                summary = result.consume()
                deleted = summary.counters.nodes_deleted + summary.counters.relationships_deleted
        except Exception as exc:
            if not _is_transient_memgraph_error(exc):
                raise
            holder.reconnect()
            time.sleep(SYNC_RETRY_DELAY_SEC)
            continue
        if deleted == 0:
            break
        removed += deleted
        print(f"  removed {removed} stale {label}...", flush=True)
    return removed


def _remove_stale_edges(holder: _DriverHolder, sync_epoch: int, *, has_edges: bool) -> int:
    if not has_edges:
        return _delete_in_batches(
            holder,
            """
            MATCH ()-[r:AC_LINE_SEGMENT]->()
            WITH r LIMIT $batch_size
            DELETE r
            """,
            label="edges",
        )
    return _delete_in_batches(
        holder,
        """
        MATCH ()-[r:AC_LINE_SEGMENT]->()
        WHERE r.sync_epoch IS NULL OR r.sync_epoch <> $sync_epoch
        WITH r LIMIT $batch_size
        DELETE r
        """,
        label="edges",
        sync_epoch=sync_epoch,
    )


def _remove_stale_nodes(holder: _DriverHolder, sync_epoch: int, *, has_nodes: bool) -> int:
    if not has_nodes:
        return _delete_in_batches(
            holder,
            """
            MATCH (c:ConnectivityNode)
            WITH c LIMIT $batch_size
            DETACH DELETE c
            """,
            label="nodes",
        )
    return _delete_in_batches(
        holder,
        """
        MATCH (c:ConnectivityNode)
        WHERE c.sync_epoch IS NULL OR c.sync_epoch <> $sync_epoch
        WITH c LIMIT $batch_size
        DETACH DELETE c
        """,
        label="nodes",
        sync_epoch=sync_epoch,
    )


def reconcile_memgraph(driver: GraphDatabase.driver | None = None) -> dict[str, Any]:
    """Upsert all Postgres rows and remove Memgraph nodes/edges not in Postgres."""
    from redis_cache import lock

    with lock("graph-reconcile") as token:
        if token is None:
            return {
                "status": "skipped",
                "reason": "reconcile already in progress",
                "nodes_synced": 0,
                "edges_synced": 0,
                "orphan_nodes_removed": 0,
                "orphan_edges_removed": 0,
            }

        return _reconcile_memgraph_locked(driver)


def _reconcile_memgraph_locked(driver: GraphDatabase.driver | None = None) -> dict[str, Any]:
    from redis_cache import invalidate_topology_cache

    holder = _DriverHolder(driver)
    own_driver = driver is None

    nodes, edges = fetch_topology_from_postgres()
    sync_epoch = int(time.time())
    if nodes or edges:
        print(
            f"Syncing {len(nodes)} nodes and {len(edges)} edges to Memgraph "
            f"(batch size {SYNC_BATCH_SIZE})...",
            flush=True,
        )

    removed_nodes = 0
    removed_edges = 0

    try:
        _ensure_memgraph_indexes(holder)
        _upsert_nodes(holder, nodes, sync_epoch)
        _upsert_edges(holder, edges, sync_epoch)

        print("  cleaning stale edges...", flush=True)
        removed_edges = _remove_stale_edges(holder, sync_epoch, has_edges=bool(edges))

        print("  cleaning stale nodes...", flush=True)
        removed_nodes = _remove_stale_nodes(holder, sync_epoch, has_nodes=bool(nodes))
    finally:
        if own_driver:
            holder.close()

    invalidate_topology_cache()
    return {
        "nodes_synced": len(nodes),
        "edges_synced": len(edges),
        "orphan_nodes_removed": removed_nodes,
        "orphan_edges_removed": removed_edges,
    }


def apply_webhook_event(
    driver: GraphDatabase.driver,
    table: str,
    action: str,
    record: Optional[dict[str, Any]],
    old_record: Optional[dict[str, Any]],
    lookup_node_name,
    lookup_equipment,
) -> None:
    """Apply a single INSERT/UPDATE/DELETE, then reconcile so Postgres remains authoritative."""
    rec = record if action in ("INSERT", "UPDATE") else old_record
    if not rec or "mrid" not in rec:
        reconcile_memgraph(driver)
        return

    mrid = str(rec["mrid"])

    with driver.session() as session:
        if table == "connectivity_nodes":
            if action in ("INSERT", "UPDATE"):
                name = rec.get("name") or lookup_node_name(mrid) or mrid
                session.run(
                    "MERGE (c:ConnectivityNode {mrid: $mrid}) SET c.name = $name",
                    mrid=mrid,
                    name=name,
                )
            elif action == "DELETE":
                session.run(
                    "MATCH (c:ConnectivityNode {mrid: $mrid}) DETACH DELETE c",
                    mrid=mrid,
                )

        elif table == "ac_line_segments":
            if action in ("INSERT", "UPDATE"):
                phases = rec.get("phases")
                voltage = rec.get("nominal_voltage")
                if not phases or not voltage:
                    db_phases, db_voltage = lookup_equipment(mrid)
                    phases = phases or db_phases
                    voltage = voltage or db_voltage
                session.run(
                    """
                    MATCH (s:ConnectivityNode {mrid: $source_id})
                    MATCH (t:ConnectivityNode {mrid: $target_id})
                    MERGE (s)-[r:AC_LINE_SEGMENT {mrid: $mrid}]->(t)
                    SET r.direction_downstream = $direction,
                        r.phases = $phases,
                        r.voltage = $voltage
                    """,
                    mrid=mrid,
                    source_id=str(rec["source_node_id"]),
                    target_id=str(rec["target_node_id"]),
                    direction=rec.get("direction_downstream", True),
                    phases=phases,
                    voltage=voltage,
                )
            elif action == "DELETE":
                session.run(
                    "MATCH ()-[r:AC_LINE_SEGMENT {mrid: $mrid}]->() DELETE r",
                    mrid=mrid,
                )
    # Incremental MERGE/DELETE above is enough; full reconcile on every webhook
    # reloads ~900k rows and can crash Memgraph during bulk bootstrap.
