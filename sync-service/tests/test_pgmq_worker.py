"""Tests for pgmq worker helpers."""

import unittest
from unittest.mock import MagicMock, patch

from pgmq_worker import bootstrap_handlers


class PgmqWorkerTests(unittest.TestCase):
    def test_bootstrap_registers_topology_queue(self):
        from pgmq_worker import _QUEUE_HANDLERS

        _QUEUE_HANDLERS.clear()
        bootstrap_handlers()
        self.assertIn("topology_dq_jobs", _QUEUE_HANDLERS)

    def test_enqueue_topology_dq_job(self):
        from pgmq_worker import enqueue_topology_dq_job

        conn = MagicMock()
        cur = MagicMock()
        conn.cursor.return_value.__enter__ = MagicMock(return_value=cur)
        conn.cursor.return_value.__exit__ = MagicMock(return_value=False)
        cur.fetchone.return_value = (42,)

        msg_id = enqueue_topology_dq_job(conn, "00000000-0000-4000-8000-000000000001")
        self.assertEqual(msg_id, 42)
        cur.execute.assert_called_once()

    def test_sweep_skips_when_run_already_queued(self):
        from pgmq_worker import sweep_stalled_endpoint_fix_ai_jobs

        conn = MagicMock()
        cur = conn.cursor.return_value.__enter__.return_value
        cur.fetchall.return_value = [("run-a",)]
        with patch("pgmq_worker.count_endpoint_fix_ai_jobs_for_run", return_value=2):
            count = sweep_stalled_endpoint_fix_ai_jobs(lambda: conn)
        self.assertEqual(count, 0)

    @patch("pgmq_worker.enqueue_endpoint_fix_ai_job", return_value=99)
    def test_sweep_enqueues_for_stalled_running_runs(self, mock_enqueue):
        from pgmq_worker import sweep_stalled_endpoint_fix_ai_jobs

        conn = MagicMock()
        cur = conn.cursor.return_value.__enter__.return_value
        cur.fetchall.return_value = [("run-a",), ("run-b",)]

        def factory():
            return conn

        with patch("pgmq_worker.count_endpoint_fix_ai_jobs_for_run", return_value=0):
            count = sweep_stalled_endpoint_fix_ai_jobs(factory)
        self.assertEqual(count, 2)
        self.assertEqual(mock_enqueue.call_count, 2)
        conn.commit.assert_called_once()


if __name__ == "__main__":
    unittest.main()
