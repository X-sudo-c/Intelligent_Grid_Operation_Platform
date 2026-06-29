#!/usr/bin/env python3
"""Full reconcile: Postgres connectivity topology → Memgraph (removes orphans)."""

import sys
from pathlib import Path

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / ".env")

sys.path.insert(0, str(ROOT / "sync-service"))
from graph_sync import reconcile_memgraph  # noqa: E402


def _driver_hint(exc: BaseException) -> str | None:
    msg = str(exc).lower()
    if "database shutdown" in msg or "defunct connection" in msg:
        venv_python = ROOT / ".venv" / "bin" / "python"
        py = venv_python if venv_python.is_file() else "python3"
        return (
            "Memgraph closed the connection (often OOM or restart during bulk sync). "
            f"Restart memgraph, then: MEMGRAPH_SYNC_BATCH=1000 {py} memgraph/bootstrap.py "
            "(~900k nodes takes 30–60+ min). Use MEMGRAPH_URI=bolt://127.0.0.1:7687."
        )
    return None


def main():
    try:
        stats = reconcile_memgraph()
        print(
            "Reconciled Memgraph from Postgres: "
            f"{stats['nodes_synced']} nodes, {stats['edges_synced']} edges "
            f"(removed {stats['orphan_nodes_removed']} orphan nodes, "
            f"{stats['orphan_edges_removed']} orphan edges)"
        )
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        hint = _driver_hint(exc)
        if hint:
            print(f"Hint: {hint}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
