"""Tests for in-process APM metrics."""

from __future__ import annotations

import unittest

from metrics import normalize_route, record_request, snapshot


class MetricsRouteTests(unittest.TestCase):
    def setUp(self) -> None:
        import metrics as metrics_mod

        metrics_mod._latencies_ms.clear()
        metrics_mod._route_latencies.clear()
        metrics_mod._error_count = 0
        metrics_mod._request_count = 0

    def test_normalize_route_collapses_uuid(self):
        route = normalize_route(
            "GET",
            "/api/v1/assets/3fa85f64-5717-4562-b3fc-2c963f66afa6",
        )
        self.assertEqual(route, "GET /api/v1/assets/:id")

    def test_snapshot_splits_copilot_and_map(self):
        record_request(50, route="GET /api/v1/map/autocomplete")
        record_request(80, route="GET /api/v1/map/autocomplete")
        record_request(6000, route="POST /api/v1/portal/ai/chat")
        record_request(20, route="GET /api/v1/health/metrics")

        snap = snapshot()
        self.assertLess(snap["latency_p95_map_ms"], 200)
        self.assertGreater(snap["latency_p95_copilot_ms"], 1000)
        self.assertGreater(len(snap["slowest_routes"]), 0)
        self.assertEqual(snap["slowest_routes"][0]["route"], "POST /api/v1/portal/ai/chat")


if __name__ == "__main__":
    unittest.main()
