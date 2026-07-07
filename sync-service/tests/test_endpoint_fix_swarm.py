"""Tests for endpoint fix AI swarm claiming and parallel workers."""

from __future__ import annotations

import unittest
from unittest.mock import MagicMock, patch


class EndpointFixSwarmClaimTests(unittest.TestCase):
    def test_release_claims_sql(self):
        from endpoint_proposals import release_ai_scan_claims

        conn = MagicMock()
        cur = conn.cursor.return_value.__enter__.return_value
        cur.rowcount = 2
        released = release_ai_scan_claims(conn, "token-uuid")
        self.assertEqual(released, 2)
        conn.commit.assert_called_once()

    def test_count_pending_excludes_active_claims(self):
        from endpoint_proposals import count_pending_unscanned

        conn = MagicMock()
        cur = conn.cursor.return_value.__enter__.return_value
        cur.fetchone.return_value = (42,)
        count = count_pending_unscanned(conn, "Achimota")
        self.assertEqual(count, 42)
        sql = cur.execute.call_args[0][0]
        self.assertIn("ai_claim_expires_at", sql)

    @patch("endpoint_proposals.uuid.uuid4")
    def test_claim_returns_empty_when_no_rows(self, mock_uuid):
        from endpoint_proposals import claim_proposals_for_ai_scan

        mock_uuid.return_value = MagicMock(hex="abc", __str__=lambda self: "abc")
        conn = MagicMock()
        cur = conn.cursor.return_value.__enter__.return_value
        cur.fetchall.return_value = []
        token, rows = claim_proposals_for_ai_scan(conn, "Achimota", 10)
        self.assertIsNone(token)
        self.assertEqual(rows, [])
        sql = cur.execute.call_args[0][0]
        self.assertIn("FOR UPDATE SKIP LOCKED", sql)


class EndpointFixSwarmRunTests(unittest.TestCase):
    def test_swarm_workers_capped(self):
        from endpoint_fix_ai_runs import SWARM_MAX_INFLIGHT, _swarm_workers_for_pending

        self.assertEqual(_swarm_workers_for_pending(10, 50), 1)
        self.assertEqual(_swarm_workers_for_pending(500, 50), min(SWARM_MAX_INFLIGHT, 10))

    @patch("endpoint_fix_ai_runs.ai_scan_endpoint_fix_proposals")
    @patch("endpoint_fix_ai_runs.count_pending_unscanned")
    @patch("endpoint_fix_ai_runs.get_endpoint_fix_ai_run")
    def test_empty_claim_does_not_fail_run(self, mock_get, mock_count, mock_scan):
        from endpoint_fix_ai_runs import execute_endpoint_fix_ai_batch

        mock_get.side_effect = [
            {
                "id": "run-1",
                "district": "Achimota",
                "status": "running",
                "batch_size": 50,
                "reasoning_depth": "quick",
            },
            {
                "id": "run-1",
                "district": "Achimota",
                "status": "running",
                "remaining_unscanned": 5,
            },
        ]
        mock_count.return_value = 5
        mock_scan.side_effect = ValueError("no_pending_proposals")
        conn = MagicMock()
        result = execute_endpoint_fix_ai_batch(conn, "run-1", requeue_pgmq=False)
        self.assertEqual(result.get("remaining_unscanned"), 5)
        mock_scan.assert_called_once()
        self.assertTrue(mock_scan.call_args.kwargs.get("swarm_claim"))

    @patch("endpoint_fix_ai_runs._maybe_requeue_endpoint_fix_run")
    @patch("endpoint_fix_ai_runs.count_pending_without_ai_review")
    @patch("endpoint_fix_ai_runs.count_pending_unscanned")
    @patch("endpoint_fix_ai_runs.get_endpoint_fix_ai_run")
    def test_claims_in_flight_does_not_requeue_storm(
        self, mock_get, mock_unscanned, mock_unreviewed, mock_requeue
    ):
        from endpoint_fix_ai_runs import execute_endpoint_fix_ai_batch

        mock_get.return_value = {
            "id": "run-1",
            "district": "Achimota",
            "status": "running",
            "batch_size": 10,
            "reasoning_depth": "quick",
        }
        mock_unreviewed.return_value = 10
        mock_unscanned.return_value = 0
        conn = MagicMock()
        execute_endpoint_fix_ai_batch(conn, "run-1", requeue_pgmq=True)
        mock_requeue.assert_not_called()

    @patch("endpoint_fix_ai_runs._maybe_requeue_endpoint_fix_run")
    @patch("endpoint_fix_ai_runs.ai_scan_endpoint_fix_proposals")
    @patch("endpoint_fix_ai_runs.count_pending_without_ai_review")
    @patch("endpoint_fix_ai_runs.count_pending_unscanned")
    @patch("endpoint_fix_ai_runs.get_endpoint_fix_ai_run")
    def test_zero_reviewed_batch_still_requeues_when_work_remains(
        self,
        mock_get,
        mock_unscanned,
        mock_unreviewed,
        mock_scan,
        mock_requeue,
    ):
        from endpoint_fix_ai_runs import execute_endpoint_fix_ai_batch

        mock_get.side_effect = [
            {
                "id": "run-1",
                "district": "Achimota",
                "status": "running",
                "batch_size": 10,
                "reasoning_depth": "quick",
            },
            {
                "id": "run-1",
                "district": "Achimota",
                "status": "running",
                "remaining_unscanned": 10,
            },
        ]
        mock_unscanned.return_value = 10
        mock_unreviewed.side_effect = [10, 10]
        mock_scan.return_value = {"proposals_reviewed": 0, "model": "deepseek-v4-flash"}
        conn = MagicMock()
        result = execute_endpoint_fix_ai_batch(conn, "run-1", requeue_pgmq=True)
        self.assertTrue(result.get("requeue"))
        mock_requeue.assert_called_once()


class PgmqSwarmTests(unittest.TestCase):
    def test_fan_out_enqueues_multiple(self):
        from pgmq_worker import fan_out_endpoint_fix_ai_jobs

        conn = MagicMock()
        with patch("pgmq_worker.enqueue_endpoint_fix_ai_job", side_effect=[1, 2, 3, 4]) as mock_enqueue:
            count = fan_out_endpoint_fix_ai_jobs(conn, "run-id", 4)
        self.assertEqual(count, 4)
        self.assertEqual(mock_enqueue.call_count, 4)


if __name__ == "__main__":
    unittest.main()
