"""LLM eval harness — golden fixtures for steward assistant responses."""

from __future__ import annotations

import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

FIXTURES = [
    {
        "message": "Why is this node an orphan?",
        "exception_id": None,
        "mrid": None,
        "expect_substrings": ["orphan", "line", "segment"],
    },
    {
        "message": "What should I do about a critical exception?",
        "expect_substrings": ["approval", "critical"],
    },
]


def run_harness(conn) -> dict:
    from agents.llm.chat import run_steward_chat

    results = []
    for fix in FIXTURES:
        resp = run_steward_chat(
            conn,
            message=fix["message"],
            exception_id=fix.get("exception_id"),
            mrid=fix.get("mrid"),
        )
        content_lower = resp.content.lower()
        passed = all(s.lower() in content_lower for s in fix.get("expect_substrings", []))
        results.append(
            {
                "fixture": fix["message"][:60],
                "passed": passed,
                "model": resp.agent.get("model"),
            }
        )
    return {"results": results, "passed": sum(1 for r in results if r["passed"]), "total": len(results)}


if __name__ == "__main__":
    import psycopg2
    from dotenv import load_dotenv

    load_dotenv()
    uri = os.getenv("SUPABASE_DB_URI")
    if not uri:
        print(json.dumps({"error": "SUPABASE_DB_URI not set"}))
        raise SystemExit(1)
    c = psycopg2.connect(uri)
    try:
        print(json.dumps(run_harness(c), indent=2))
    finally:
        c.close()
