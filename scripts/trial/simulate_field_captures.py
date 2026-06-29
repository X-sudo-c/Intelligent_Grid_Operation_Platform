#!/usr/bin/env python3
"""Simulate multiple field technicians submitting staging captures (good + bad).

Usage:
  python3 scripts/trial/simulate_field_captures.py
  python3 scripts/trial/simulate_field_captures.py --count 30 --run-validation
  SYNC_SERVICE_URL=http://127.0.0.1:5000 python3 scripts/trial/simulate_field_captures.py

Requires sync-service running on SYNC_SERVICE_URL (default http://127.0.0.1:5000).
"""

from __future__ import annotations

import argparse
import json
import os
import random
import sys
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Any

# Accra-ish trial bbox (inside Ghana)
ACCRA_LON = -0.22
ACCRA_LAT = 5.60
SPREAD = 0.04

TECHNICIANS = [
    "trial-tech-alice",
    "trial-tech-bob",
    "trial-tech-carol",
    "trial-tech-dan",
]

ASSET_KINDS = [
    "pole_lv",
    "pole_11kv",
    "pole_33kv",
    "distribution_transformer",
    "connectivity_node",
]


@dataclass
class Scenario:
    name: str
    weight: float
    build: Any  # callable(rng) -> dict


def _post_json(url: str, payload: dict[str, Any]) -> dict[str, Any]:
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=data,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            body = resp.read().decode("utf-8")
            return json.loads(body) if body else {}
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"HTTP {exc.code}: {detail}") from exc


def _get_json(url: str) -> dict[str, Any]:
    with urllib.request.urlopen(url, timeout=60) as resp:
        return json.loads(resp.read().decode("utf-8"))


def _good_capture(rng: random.Random, seq: int) -> dict[str, Any]:
    lon = ACCRA_LON + rng.uniform(-SPREAD, SPREAD)
    lat = ACCRA_LAT + rng.uniform(-SPREAD, SPREAD)
    kind = rng.choice(ASSET_KINDS)
    return {
        "name": f"Trial {kind.replace('_', ' ').title()} {seq}",
        "longitude": round(lon, 6),
        "latitude": round(lat, 6),
        "operating_utility": "ECG_SOUTHERN",
        "asset_kind": kind,
        "boundary_feeder_id": f"FEEDER-TRIAL-{rng.randint(100, 999)}",
        "substation_name": rng.choice(["Kaneshie", "Mallam", "Tema Trial SS", None]),
        "operator_id": rng.choice(TECHNICIANS),
    }


def _outside_ghana(rng: random.Random, seq: int) -> dict[str, Any]:
    payload = _good_capture(rng, seq)
    payload["name"] = f"Trial Outside Ghana {seq}"
    payload["longitude"] = 2.35
    payload["latitude"] = 48.85
    return payload


def _duplicate_cluster(rng: random.Random, seq: int) -> dict[str, Any]:
    payload = _good_capture(rng, seq)
    payload["name"] = f"Trial Duplicate Pole {seq // 3}"
    payload["longitude"] = round(ACCRA_LON + 0.001, 6)
    payload["latitude"] = round(ACCRA_LAT + 0.001, 6)
    return payload


def _no_feeder(rng: random.Random, seq: int) -> dict[str, Any]:
    payload = _good_capture(rng, seq)
    payload["name"] = f"Trial No Feeder {seq}"
    payload.pop("boundary_feeder_id", None)
    return payload


SCENARIOS = [
    Scenario("good", 0.55, _good_capture),
    Scenario("outside_ghana", 0.15, _outside_ghana),
    Scenario("duplicate_cluster", 0.20, _duplicate_cluster),
    Scenario("no_feeder", 0.10, _no_feeder),
]


def pick_scenario(rng: random.Random) -> Scenario:
    r = rng.random()
    acc = 0.0
    for sc in SCENARIOS:
        acc += sc.weight
        if r <= acc:
            return sc
    return SCENARIOS[0]


def main() -> int:
    parser = argparse.ArgumentParser(description="Simulate field staging captures")
    parser.add_argument("--count", type=int, default=20, help="Number of submissions")
    parser.add_argument("--seed", type=int, default=42, help="RNG seed")
    parser.add_argument(
        "--base-url",
        default=os.environ.get("SYNC_SERVICE_URL", "http://127.0.0.1:5000"),
        help="sync-service base URL",
    )
    parser.add_argument(
        "--run-validation",
        action="store_true",
        help="POST /api/v1/validation/run asset_checks on staging after captures",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print payloads only, do not POST",
    )
    args = parser.parse_args()

    rng = random.Random(args.seed)
    base = args.base_url.rstrip("/")
    url = f"{base}/api/v1/field/nodes"

    results: list[dict[str, Any]] = []
    print(f"Submitting {args.count} captures to {url} (seed={args.seed})")

    for i in range(args.count):
        sc = pick_scenario(rng)
        payload = sc.build(rng, i + 1)
        if args.dry_run:
            print(json.dumps({"scenario": sc.name, **payload}, indent=2))
            continue
        try:
            out = _post_json(url, payload)
            mrid = out.get("mrid", "?")
            print(f"  [{i+1:3d}] {sc.name:18s} {payload['operator_id']:16s} -> {mrid}")
            results.append({"scenario": sc.name, "mrid": mrid, "ok": True})
        except RuntimeError as exc:
            print(f"  [{i+1:3d}] {sc.name:18s} FAILED: {exc}")
            results.append({"scenario": sc.name, "ok": False, "error": str(exc)})

    if args.dry_run:
        return 0

    ok = sum(1 for r in results if r.get("ok"))
    print(f"\nDone: {ok}/{args.count} accepted")

    try:
        staging = _get_json(f"{base}/api/v1/assets/staging")
        print(f"Staging queue size: {len(staging.get('assets', []))}")
    except Exception as exc:
        print(f"Could not fetch staging list: {exc}")

    try:
        dq = _get_json(f"{base}/api/v1/dq/exceptions?status=OPEN&limit=50")
        items = dq if isinstance(dq, list) else dq.get("exceptions", dq.get("items", []))
        print(f"Open DQ exceptions (sample): {len(items) if isinstance(items, list) else '?'}")
    except Exception as exc:
        print(f"Could not fetch DQ exceptions: {exc}")

    if args.run_validation:
        print("\nRunning validation cycle (asset_checks, staging)...")
        try:
            out = _post_json(
                f"{base}/api/v1/validation/run?async=false",
                {
                    "run_type": "asset_checks",
                    "tier": "staging",
                    "operator_id": "trial-simulator",
                    "mode": "deterministic",
                },
            )
            print(json.dumps(out, indent=2)[:2000])
        except RuntimeError as exc:
            print(f"Validation run failed: {exc}")
            return 1

    print("\nNext steps:")
    print(f"  curl -s {base}/api/v1/dq/summary | jq .")
    print(f"  Portal → Operations / Data Quality tabs")
    return 0 if ok == args.count else 1


if __name__ == "__main__":
    sys.exit(main())
