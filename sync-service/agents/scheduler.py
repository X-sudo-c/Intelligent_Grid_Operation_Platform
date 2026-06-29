#!/usr/bin/env python3
"""Nightly validation agent scheduler — invoke from cron or pg_cron."""

from __future__ import annotations

import os
import sys

import psycopg2
from dotenv import load_dotenv

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from agents.models import RunMode, RunType, ValidationRunRequest
from agents.orchestrator import run_agent_validation_cycle


def main() -> int:
    load_dotenv()
    uri = os.getenv("SUPABASE_DB_URI")
    if not uri:
        print("SUPABASE_DB_URI not set", file=sys.stderr)
        return 1
    conn = psycopg2.connect(uri)
    try:
        req = ValidationRunRequest(
            run_type=RunType.FULL_CYCLE,
            mode=RunMode.AGENT,
            operator_id="scheduler",
        )
        result = run_agent_validation_cycle(conn, req)
        conn.commit()
        print(f"Validation run {result['run_id']} completed")
        if result.get("kpi", {}).get("escalation"):
            print("Escalations:", result["kpi"]["escalation"])
        return 0
    except Exception as exc:
        conn.rollback()
        print(f"Scheduler failed: {exc}", file=sys.stderr)
        return 1
    finally:
        conn.close()


if __name__ == "__main__":
    raise SystemExit(main())
