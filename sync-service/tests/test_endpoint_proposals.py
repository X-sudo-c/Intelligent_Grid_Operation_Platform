"""Tests for GIS endpoint fix proposal staging."""

from __future__ import annotations

import unittest
from unittest.mock import MagicMock, patch
from uuid import UUID


class EndpointProposalTests(unittest.TestCase):
    def test_generate_requires_district(self):
        from endpoint_proposals import generate_endpoint_fix_proposals

        conn = MagicMock()
        with self.assertRaises(ValueError):
            generate_endpoint_fix_proposals(conn, "  ")

    def test_review_requires_valid_status(self):
        from endpoint_proposals import review_endpoint_fix_proposals

        conn = MagicMock()
        with self.assertRaises(ValueError):
            review_endpoint_fix_proposals(conn, [], status="pending")

    def test_list_maps_rows(self):
        from endpoint_proposals import list_endpoint_fix_proposals

        conn = MagicMock()
        pid = UUID("11111111-1111-1111-1111-111111111111")
        batch = UUID("22222222-2222-2222-2222-222222222222")
        cur = conn.cursor.return_value.__enter__.return_value
        cur.fetchone.return_value = (1,)
        cur.fetchall.return_value = [
            (
                pid,
                42,
                "Ga West",
                "oh_conductor_11kv",
                7,
                "unresolved_originating",
                "BAD",
                "GOOD",
                "POLE-A",
                "POLE-B",
                1.2,
                0.8,
                "POLE-A",
                "POLE-B",
                "tier_a",
                "test",
                "pending",
                batch,
                None,
                None,
                None,
                None,
                None,
                None,
                None,
                None,
                None,
                None,
                None,
            )
        ]
        page = list_endpoint_fix_proposals(conn, district="Ga West")
        self.assertEqual(page["total"], 1)
        self.assertEqual(page["proposals"][0]["segment_id"], 42)
        self.assertEqual(page["proposals"][0]["proposed_from"], "POLE-A")

    @patch("endpoint_proposals.UUID", side_effect=UUID)
    def test_apply_calls_sql(self, _uuid):
        from endpoint_proposals import apply_endpoint_fix_proposals

        conn = MagicMock()
        cur = conn.cursor.return_value.__enter__.return_value
        cur.fetchone.return_value = ({"applied": 2},)
        result = apply_endpoint_fix_proposals(
            conn,
            proposal_ids=["11111111-1111-1111-1111-111111111111"],
            operator_id="steward",
        )
        self.assertEqual(result["applied"], 2)
        conn.commit.assert_called_once()


if __name__ == "__main__":
    unittest.main()
