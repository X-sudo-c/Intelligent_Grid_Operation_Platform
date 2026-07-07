"""Tests for district endpoint fix AI runs and bulk review."""

from __future__ import annotations

import unittest
from unittest.mock import MagicMock, patch


class EndpointFixBulkReviewTests(unittest.TestCase):
    def test_bulk_requires_district(self):
        from endpoint_proposals import bulk_review_endpoint_fix_proposals

        conn = MagicMock()
        with self.assertRaises(ValueError):
            bulk_review_endpoint_fix_proposals(conn, "  ", filter="tier_a")

    def test_bulk_tier_a_updates(self):
        from endpoint_proposals import bulk_review_endpoint_fix_proposals

        conn = MagicMock()
        cur = conn.cursor.return_value.__enter__.return_value
        cur.fetchall.return_value = [("id-1",)]
        result = bulk_review_endpoint_fix_proposals(conn, "Achimota", filter="tier_a")
        self.assertEqual(result["updated"], 1)
        self.assertEqual(result["filter"], "tier_a")
        conn.commit.assert_called_once()


class EndpointFixAiRunTests(unittest.TestCase):
    @patch("endpoint_fix_ai_runs.find_active_endpoint_fix_ai_run", return_value=None)
    @patch("endpoint_fix_ai_runs.cleanup_llm_configured", return_value=True)
    @patch("endpoint_fix_ai_runs.count_pending_without_ai_review", return_value=0)
    def test_create_requires_unscanned(self, _count, _llm, _active):
        from endpoint_fix_ai_runs import create_endpoint_fix_ai_run

        conn = MagicMock()
        with self.assertRaises(ValueError) as ctx:
            create_endpoint_fix_ai_run(conn, "Achimota")
        self.assertEqual(str(ctx.exception), "no_unscanned_proposals")


if __name__ == "__main__":
    unittest.main()
