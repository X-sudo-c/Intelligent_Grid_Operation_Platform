"""Tests for master topology batch scan progress and single-flight guard."""

import unittest
from unittest.mock import MagicMock, patch

from topology_dq import (
    TOPOLOGY_ORPHAN_INSERT_CAP,
    TopologyScanInProgressError,
    create_topology_batch_run,
    estimate_topology_scan_seconds,
    refresh_connected_node_mrids,
    topology_scan_progress_pct,
    _eta_seconds_remaining,
    _orphan_insert_limit,
)


class TopologyScanProgressTests(unittest.TestCase):
    def test_progress_pct_empty(self):
        self.assertEqual(topology_scan_progress_pct([]), 0)

    def test_progress_pct_partial(self):
        pct = topology_scan_progress_pct(["auto_clear", "orphans"])
        self.assertGreater(pct, 0)
        self.assertLess(pct, 100)

    def test_progress_pct_complete_phases(self):
        phases = [
            "auto_clear",
            "orphans",
            "dangling",
            "endpoints",
            "geometric",
            "snapshot",
        ]
        self.assertEqual(topology_scan_progress_pct(phases), 99)

    def test_estimate_defaults_without_history(self):
        conn = MagicMock()
        cur = MagicMock()
        conn.cursor.return_value.__enter__ = MagicMock(return_value=cur)
        conn.cursor.return_value.__exit__ = MagicMock(return_value=False)
        cur.fetchall.return_value = []
        self.assertEqual(estimate_topology_scan_seconds(conn, default=300), 300)

    def test_eta_zero_when_past_estimate(self):
        with patch("topology_dq._elapsed_seconds_since", return_value=5000):
            self.assertEqual(
                _eta_seconds_remaining(
                    estimate_seconds=420,
                    started_at="2026-01-01T00:00:00+00:00",
                    status="running",
                ),
                0,
            )

    def test_eta_none_when_not_running(self):
        self.assertIsNone(
            _eta_seconds_remaining(
                estimate_seconds=420,
                started_at="2026-01-01T00:00:00+00:00",
                status="completed",
            )
        )

    def test_create_run_rejects_when_active(self):
        conn = MagicMock()
        with patch("topology_dq.find_active_topology_batch_run") as mock_active:
            mock_active.return_value = {"run_id": "abc-123", "status": "running"}
            with self.assertRaises(TopologyScanInProgressError) as ctx:
                create_topology_batch_run(conn)
            self.assertEqual(ctx.exception.run_id, "abc-123")

    def test_refresh_connected_node_mrids(self):
        conn = MagicMock()
        cur = MagicMock()
        conn.cursor.return_value.__enter__ = MagicMock(return_value=cur)
        conn.cursor.return_value.__exit__ = MagicMock(return_value=False)
        cur.fetchone.return_value = ({"connected_nodes": 248612, "duration_ms": 1200},)
        result = refresh_connected_node_mrids(conn)
        self.assertEqual(result["connected_nodes"], 248612)
        cur.execute.assert_called_once_with(
            "SELECT public.refresh_connected_node_mrids(%s)",
            (21600,),
        )

    def test_orphan_insert_limit_national(self):
        self.assertEqual(_orphan_insert_limit(None), TOPOLOGY_ORPHAN_INSERT_CAP)
        ghana = {"west": -3.5, "south": 4.5, "east": 1.5, "north": 8.5}
        self.assertEqual(_orphan_insert_limit(ghana), TOPOLOGY_ORPHAN_INSERT_CAP)

    def test_orphan_insert_limit_district_uncapped(self):
        district = {"west": -0.5, "south": 5.5, "east": 0.0, "north": 6.0}
        self.assertIsNone(_orphan_insert_limit(district))


if __name__ == "__main__":
    unittest.main()
