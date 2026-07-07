"""Tests for GIS endpoint fix AI steward scan."""

from __future__ import annotations

import unittest
from unittest.mock import MagicMock, patch


class EndpointProposalAiScanTests(unittest.TestCase):
    def test_requires_district(self):
        from endpoint_proposals_ai import ai_scan_endpoint_fix_proposals

        conn = MagicMock()
        with self.assertRaises(ValueError):
            ai_scan_endpoint_fix_proposals(conn, "  ")

    def test_requires_pending_proposals(self):
        from endpoint_proposals_ai import ai_scan_endpoint_fix_proposals

        conn = MagicMock()
        with patch(
            "endpoint_proposals_ai.list_endpoint_fix_proposals",
            return_value={"proposals": []},
        ):
            with self.assertRaises(ValueError) as ctx:
                ai_scan_endpoint_fix_proposals(conn, "Ga West")
        self.assertEqual(str(ctx.exception), "no_pending_proposals")

    @patch("endpoint_proposals_ai.cleanup_llm_configured", return_value=False)
    @patch("endpoint_proposals_ai.get_llm_profile")
    @patch("endpoint_proposals_ai.list_endpoint_fix_proposals")
    def test_llm_not_configured_stores_failed_scan(
        self, mock_list, mock_profile, _configured
    ):
        from endpoint_proposals_ai import ai_scan_endpoint_fix_proposals

        mock_profile.return_value = MagicMock(configured=False, model="deepseek-v4-pro")
        mock_list.return_value = {
            "proposals": [
                {
                    "id": "11111111-1111-1111-1111-111111111111",
                    "segment_id": 1,
                    "batch_id": "22222222-2222-2222-2222-222222222222",
                    "tier": "tier_a",
                    "proposed_from": "A",
                    "proposed_to": "B",
                }
            ]
        }
        conn = MagicMock()
        cur = conn.cursor.return_value.__enter__.return_value

        result = ai_scan_endpoint_fix_proposals(conn, "Ga West")

        self.assertFalse(result["configured"])
        self.assertIn("not configured", result["thoughts"].lower())
        self.assertTrue(cur.execute.called)

    def test_extract_json_payload(self):
        from endpoint_proposals_ai import _extract_json_payload

        text = 'Here is my review:\n```json\n{"thoughts": "ok", "reviews": []}\n```'
        payload = _extract_json_payload(text)
        self.assertEqual(payload["thoughts"], "ok")

        multi = """Done.
```json
{"thoughts": "all good", "reviews": [{"proposal_id": "a", "agree": true}, {"proposal_id": "b", "agree": false}]}
```"""
        payload2 = _extract_json_payload(multi)
        self.assertEqual(len(payload2["reviews"]), 2)

    def test_partition_tiered(self):
        from endpoint_proposals_ai import _partition_for_tiered_scan

        proposals = [
            {"id": "a", "tier": "tier_a", "start_dist_m": 1.0, "end_dist_m": 2.0},
            {"id": "b", "tier": "tier_b", "start_dist_m": 0.0, "end_dist_m": 9.0},
        ]
        auto, llm = _partition_for_tiered_scan(proposals)
        self.assertEqual(len(auto), 1)
        self.assertEqual(len(llm), 1)
        self.assertEqual(auto[0]["id"], "a")

    def test_mode_requires_valid_value(self):
        from endpoint_proposals_ai import ai_scan_endpoint_fix_proposals

        conn = MagicMock()
        with patch(
            "endpoint_proposals_ai.list_endpoint_fix_proposals",
            return_value={"proposals": [{"id": "x", "batch_id": "y", "tier": "tier_b"}]},
        ):
            with self.assertRaises(ValueError):
                ai_scan_endpoint_fix_proposals(conn, "Ga West", mode="invalid")

    def test_reasoning_depth_requires_valid_value(self):
        from endpoint_proposals_ai import ai_scan_endpoint_fix_proposals

        conn = MagicMock()
        with patch(
            "endpoint_proposals_ai.list_endpoint_fix_proposals",
            return_value={"proposals": [{"id": "x", "batch_id": "y", "tier": "tier_b"}]},
        ):
            with self.assertRaises(ValueError):
                ai_scan_endpoint_fix_proposals(conn, "Ga West", reasoning_depth="slow")


if __name__ == "__main__":
    unittest.main()
