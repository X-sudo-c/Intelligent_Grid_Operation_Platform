"""Tests for geometry-based GIS steward cleanup."""

import unittest
from unittest.mock import MagicMock, patch

from geometry_cleanup import (
    GEOM_CLEANUP_PLAN_TYPE,
    execute_geom_cleanup_proposal,
    preview_geom_snap_candidate,
    propose_district_geom_cleanup,
    scan_district_geom_cleanup,
)


class GeometryCleanupTests(unittest.TestCase):
    def test_preview_segment_not_found(self):
        conn = MagicMock()
        cur = MagicMock()
        conn.cursor.return_value.__enter__ = MagicMock(return_value=cur)
        conn.cursor.return_value.__exit__ = MagicMock(return_value=False)
        cur.fetchone.return_value = None

        with self.assertRaises(ValueError) as ctx:
            preview_geom_snap_candidate(conn, 999)
        self.assertEqual(str(ctx.exception), "segment_not_found")

    def test_scan_requires_district(self):
        conn = MagicMock()
        with self.assertRaises(ValueError):
            scan_district_geom_cleanup(conn, "")

    @patch("geometry_cleanup.unpromoted_segments_summary")
    def test_scan_returns_tier_counts(self, mock_summary):
        mock_summary.return_value = {"total_unpromoted": 100}
        conn = MagicMock()
        cur = MagicMock()
        conn.cursor.return_value.__enter__ = MagicMock(return_value=cur)
        conn.cursor.return_value.__exit__ = MagicMock(return_value=False)
        cur.fetchall.side_effect = [
            [("tier_a", 10), ("tier_b", 5), ("tier_c", 85)],
            [],
        ]

        result = scan_district_geom_cleanup(conn, "Mpraeso")
        self.assertEqual(result["district"], "Mpraeso")
        self.assertEqual(result["tiers"]["tier_a_auto"], 10)
        self.assertEqual(result["tiers"]["tier_b_assisted"], 5)
        self.assertEqual(result["tiers"]["tier_c_manual"], 85)
        self.assertEqual(result["sample_candidates"], [])

    @patch("geometry_cleanup.scan_district_geom_cleanup")
    def test_propose_raises_when_no_tier_a(self, mock_scan):
        mock_scan.return_value = {
            "tiers": {"tier_a_auto": 0, "tier_b_assisted": 1, "tier_c_manual": 9},
            "unpromoted_summary": {},
        }
        conn = MagicMock()
        with self.assertRaises(ValueError) as ctx:
            propose_district_geom_cleanup(conn, "EmptyDistrict")
        self.assertEqual(str(ctx.exception), "no_tier_a_candidates")

    @patch("geometry_cleanup.repository.create_approval_request", return_value="approval-1")
    @patch("geometry_cleanup.repository.insert_cleanup_action", return_value="cleanup-1")
    @patch("geometry_cleanup.log_agent_step")
    @patch("geometry_cleanup.scan_district_geom_cleanup")
    def test_propose_creates_cleanup_and_approval(
        self,
        mock_scan,
        _mock_log,
        mock_insert,
        _mock_approval,
    ):
        mock_scan.return_value = {
            "tiers": {"tier_a_auto": 42, "tier_b_assisted": 3, "tier_c_manual": 1},
            "unpromoted_summary": {"total_unpromoted": 46},
        }
        conn = MagicMock()

        result = propose_district_geom_cleanup(conn, "Mpraeso", run_id="run-1")
        self.assertEqual(result["cleanup_id"], "cleanup-1")
        self.assertEqual(result["approval_id"], "approval-1")
        self.assertEqual(result["plan"]["type"], GEOM_CLEANUP_PLAN_TYPE)
        self.assertEqual(result["plan"]["district"], "Mpraeso")
        mock_insert.assert_called_once()
        conn.commit.assert_called()

    @patch("geometry_cleanup.repository.update_cleanup_status")
    @patch("geometry_cleanup.repository.get_cleanup_action")
    def test_execute_runs_district_pipeline(self, mock_get, _mock_update):
        mock_get.return_value = {
            "status": "approved",
            "plan": {
                "type": GEOM_CLEANUP_PLAN_TYPE,
                "district": "Mpraeso",
                "tolerance_m": 5.0,
            },
        }
        conn = MagicMock()
        cur = MagicMock()
        conn.cursor.return_value.__enter__ = MagicMock(return_value=cur)
        conn.cursor.return_value.__exit__ = MagicMock(return_value=False)
        cur.fetchone.side_effect = [
            ({"segments_updated": 3},),
            ({"segments_snapped": 2},),
            ({"promoted": 1},),
            ({"total_unpromoted": 40},),
            ({"refreshed": True},),
        ]

        result = execute_geom_cleanup_proposal(conn, "cleanup-1", operator_id="steward")
        self.assertEqual(result["status"], "executed")
        self.assertEqual(result["district"], "Mpraeso")
        self.assertEqual(result["infer"]["segments_updated"], 3)
        self.assertEqual(cur.execute.call_count, 5)
        conn.commit.assert_called_once()

    @patch("geometry_cleanup.repository.get_cleanup_action")
    def test_execute_rejects_wrong_plan_type(self, mock_get):
        mock_get.return_value = {
            "status": "approved",
            "plan": {"type": "other_plan"},
        }
        conn = MagicMock()
        with self.assertRaises(ValueError) as ctx:
            execute_geom_cleanup_proposal(conn, "cleanup-1")
        self.assertEqual(str(ctx.exception), "not_a_geom_cleanup_plan")


if __name__ == "__main__":
    unittest.main()
