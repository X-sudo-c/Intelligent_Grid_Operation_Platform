"""Tests for endpoint fix AI run Redis progress cache."""

from __future__ import annotations

import unittest
from unittest.mock import patch


class EndpointFixAiRunCacheTests(unittest.TestCase):
    @patch("endpoint_fix_ai_run_cache.set_json", return_value=True)
    @patch("endpoint_fix_ai_run_cache.delete_key")
    def test_cache_run_sets_active_for_running(self, mock_delete, mock_set):
        from endpoint_fix_ai_run_cache import cache_endpoint_fix_ai_run

        run = {
            "id": "run-1",
            "district": "Takoradi",
            "data_tier": "staging",
            "status": "running",
            "total_pending": 100,
            "remaining_unscanned": 50,
            "progress_pct": 50,
        }
        self.assertTrue(cache_endpoint_fix_ai_run(run))
        self.assertGreaterEqual(mock_set.call_count, 2)
        mock_delete.assert_not_called()

    @patch("endpoint_fix_ai_run_cache.set_json", return_value=True)
    @patch("endpoint_fix_ai_run_cache.delete_key")
    def test_cache_run_clears_active_on_complete(self, mock_delete, mock_set):
        from endpoint_fix_ai_run_cache import cache_endpoint_fix_ai_run

        run = {"id": "run-1", "district": "Takoradi", "data_tier": "gis", "status": "completed"}
        cache_endpoint_fix_ai_run(run)
        mock_delete.assert_called_once()

    @patch("endpoint_fix_ai_run_cache.get_json", return_value={"run_id": "run-1"})
    def test_get_cached_active_run_id(self, mock_get):
        from endpoint_fix_ai_run_cache import get_cached_active_run_id

        self.assertEqual(get_cached_active_run_id("Takoradi"), "run-1")


if __name__ == "__main__":
    unittest.main()
