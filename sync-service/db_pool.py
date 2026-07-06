"""Shared psycopg2 connection pool.

main.py historically opened a fresh TCP + auth connection per request
(~110 call sites). Pooling removes that per-request cost. Call sites keep
their existing `conn = pooled_connect(dsn)` ... `conn.close()` pattern:
close() returns the connection to the pool instead of destroying it.

Safety notes:
- Connections are rolled back before being returned, so open transactions
  and transaction-local GUCs (e.g. giop.lineage_*) never leak between
  requests.
- A cheap `SELECT 1` on checkout replaces connections the server dropped
  while idle.
- If the pool is exhausted (long-running background scans holding
  connections), we fall back to a direct connection rather than erroring.
"""

from __future__ import annotations

import os
import threading

import psycopg2
from psycopg2 import pool as _pgpool

_POOL_MIN = int(os.getenv("PG_POOL_MIN", "1"))
_POOL_MAX = int(os.getenv("PG_POOL_MAX", "16"))

_lock = threading.Lock()
_pools: dict[str, _pgpool.ThreadedConnectionPool] = {}


class _PooledConnection:
    """Proxy that returns the underlying connection to the pool on close()."""

    __slots__ = ("_pool", "_conn", "_returned")

    def __init__(self, pool: _pgpool.ThreadedConnectionPool, conn) -> None:
        self._pool = pool
        self._conn = conn
        self._returned = False

    def close(self) -> None:
        if self._returned:
            return
        self._returned = True
        conn = self._conn
        try:
            if conn.closed:
                self._pool.putconn(conn, close=True)
                return
            conn.rollback()
            self._pool.putconn(conn)
        except Exception:
            try:
                self._pool.putconn(conn, close=True)
            except Exception:
                pass

    @property
    def closed(self):  # mirror psycopg2 semantics for callers that check it
        return 1 if self._returned else self._conn.closed

    def __getattr__(self, name):
        return getattr(self._conn, name)

    # `with conn:` in psycopg2 means commit/rollback (not close) — delegate.
    def __enter__(self):
        return self._conn.__enter__()

    def __exit__(self, exc_type, exc_val, exc_tb):
        return self._conn.__exit__(exc_type, exc_val, exc_tb)


def _get_pool(dsn: str) -> _pgpool.ThreadedConnectionPool:
    pool = _pools.get(dsn)
    if pool is None:
        with _lock:
            pool = _pools.get(dsn)
            if pool is None:
                pool = _pgpool.ThreadedConnectionPool(_POOL_MIN, _POOL_MAX, dsn)
                _pools[dsn] = pool
    return pool


def _checkout(pool: _pgpool.ThreadedConnectionPool):
    conn = pool.getconn()
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT 1")
        conn.rollback()
        return conn
    except Exception:
        # Server dropped this idle connection — discard and take a fresh one.
        try:
            pool.putconn(conn, close=True)
        except Exception:
            pass
        return pool.getconn()


def set_local_statement_timeout(conn, ms: int) -> None:
    """Cap query runtime for the current transaction (milliseconds)."""
    with conn.cursor() as cur:
        cur.execute("SET LOCAL statement_timeout = %s", (str(ms),))


def pooled_connect(dsn: str):
    """Drop-in replacement for psycopg2.connect(dsn) backed by a shared pool."""
    try:
        pool = _get_pool(dsn)
        return _PooledConnection(pool, _checkout(pool))
    except _pgpool.PoolError:
        # Pool exhausted — degrade to a direct connection instead of failing.
        return psycopg2.connect(dsn)


def close_all_pools() -> None:
    with _lock:
        for pool in _pools.values():
            try:
                pool.closeall()
            except Exception:
                pass
        _pools.clear()
