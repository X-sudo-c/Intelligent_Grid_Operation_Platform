"""Unit tests for DQ → Operations handoff."""

from __future__ import annotations

import os
import sys
import unittest
from unittest.mock import MagicMock, patch

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from data_quality import release_staging_to_operations


class ReleaseToOperationsTests(unittest.TestCase):
    def _conn_with_validation(self, validation: str):
        conn = MagicMock()
        cur = MagicMock()
        conn.cursor.return_value.__enter__ = MagicMock(return_value=cur)
        conn.cursor.return_value.__exit__ = MagicMock(return_value=False)
        cur.fetchone.side_effect = [
            (validation,),
            ("mrid-1", "Pole A", "STAGED"),
        ]
        return conn, cur

    @patch("data_quality.log_lineage")
    @patch("data_quality.count_blocking_open", return_value=[])
    @patch("data_quality.run_asset_checks")
    def test_release_pending_field_to_staged(self, _checks, _blocking, _lineage):
        conn, cur = self._conn_with_validation("PENDING_FIELD")
        result = release_staging_to_operations(
            conn, "mrid-1", operator="steward-1", run_checks=True
        )
        self.assertTrue(result["released"])
        self.assertEqual(result["validation"], "STAGED")
        self.assertEqual(result["previous_validation"], "PENDING_FIELD")
        cur.execute.assert_called()
        _lineage.assert_called_once()

    @patch("data_quality.count_blocking_open", return_value=[{"rule_code": "X"}])
    @patch("data_quality.run_asset_checks")
    def test_release_blocked_by_open_exceptions(self, _checks, _blocking):
        conn, _cur = self._conn_with_validation("PENDING_FIELD")
        with self.assertRaises(ValueError) as ctx:
            release_staging_to_operations(conn, "mrid-1", run_checks=False)
        self.assertIn("blocking", str(ctx.exception).lower())

    @patch("data_quality.count_blocking_open", return_value=[])
    @patch("data_quality.run_asset_checks")
    def test_release_rejects_already_staged(self, _checks, _blocking):
        conn, _cur = self._conn_with_validation("STAGED")
        with self.assertRaises(ValueError) as ctx:
            release_staging_to_operations(conn, "mrid-1", run_checks=False)
        self.assertIn("Data Quality queue", str(ctx.exception))


if __name__ == "__main__":
    unittest.main()
