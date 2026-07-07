#!/usr/bin/env python3
"""A/B compare cleanup LLM models on the same endpoint-fix proposals (batch mode)."""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
SYNC_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SYNC_ROOT))

env_path = REPO_ROOT / ".env"
if env_path.is_file():
    for line in env_path.read_text().splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, _, v = line.partition("=")
            os.environ.setdefault(k.strip(), v.strip())


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--district", default="Achimota")
    parser.add_argument("--limit", type=int, default=3)
    parser.add_argument(
        "--models",
        nargs="+",
        default=["deepseek-v4-flash", "deepseek-v4-pro"],
    )
    args = parser.parse_args()

    import psycopg2
    from agents.llm.provider import complete_chat
    from endpoint_proposals import list_endpoint_fix_proposals
    from endpoint_proposals_ai import AI_SCAN_SYSTEM, _extract_json_payload, _proposal_brief

    uri = os.environ.get("SUPABASE_DB_URI")
    if not uri:
        print("SUPABASE_DB_URI not set", file=sys.stderr)
        return 1

    conn = psycopg2.connect(uri)
    page = list_endpoint_fix_proposals(
        conn, district=args.district, status="pending", limit=args.limit
    )
    conn.close()
    proposals = page["proposals"]
    if not proposals:
        print(f"No pending proposals for {args.district!r}")
        return 2

    briefs = [_proposal_brief(p) for p in proposals]
    user_msg = (
        f"District: {args.district}\n"
        f"Review these {len(briefs)} endpoint fix proposals:\n"
        f"{json.dumps(briefs, indent=2)}"
    )
    messages = [
        {"role": "system", "content": AI_SCAN_SYSTEM},
        {"role": "user", "content": user_msg},
    ]

    print(f"A/B batch scan — {args.district}, {len(proposals)} rows\n")
    results: dict[str, dict] = {}
    for model in args.models:
        print(f"--- {model} ---")
        t0 = time.perf_counter()
        try:
            out = complete_chat(messages, profile="cleanup", model=model, max_tokens=4096)
            elapsed = time.perf_counter() - t0
            content = out.get("content") or ""
            payload = _extract_json_payload(content) or {}
            reviews = payload.get("reviews") or []
            results[model] = {
                "elapsed_s": round(elapsed, 2),
                "reviews": reviews,
                "thoughts": payload.get("thoughts") or content[:300],
            }
            print(f"{elapsed:.1f}s | {len(reviews)} reviews")
            print((results[model]["thoughts"] or "")[:280])
            for r in reviews:
                print(
                    f"  seg={r.get('segment_id')} agree={r.get('agree')} "
                    f"conf={r.get('confidence')}: {r.get('rationale')}"
                )
        except Exception as exc:
            print(f"ERROR: {exc}")
            results[model] = {"error": str(exc)}

    if len(args.models) == 2 and all(results.get(m, {}).get("reviews") for m in args.models):
        a, b = args.models
        by_a = {r["segment_id"]: r for r in results[a]["reviews"]}
        by_b = {r["segment_id"]: r for r in results[b]["reviews"]}
        print("\n--- Agreement ---")
        for seg in sorted(by_a):
            ra, rb = by_a[seg], by_b.get(seg, {})
            print(
                f"  seg {seg}: agree {ra.get('agree')} vs {rb.get('agree')} | "
                f"conf {ra.get('confidence')} vs {rb.get('confidence')}"
            )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
