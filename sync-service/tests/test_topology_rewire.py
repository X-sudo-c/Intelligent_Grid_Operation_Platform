"""Tests for geom-preserving master endpoint rewire."""

from __future__ import annotations

import unittest
from unittest.mock import MagicMock

from topology_rewire import rewire_line_endpoints_by_geometry


class TestTopologyRewire(unittest.TestCase):
    def test_invalid_bbox_raises(self):
        conn = MagicMock()
        with self.assertRaises(ValueError):
            rewire_line_endpoints_by_geometry(
                conn, west=0, south=0, east=-1, north=1, dry_run=True
            )
        conn.cursor.assert_not_called()

    def test_calls_sql_and_returns_dict(self):
        conn = MagicMock()
        cur = MagicMock()
        conn.cursor.return_value.__enter__ = MagicMock(return_value=cur)
        conn.cursor.return_value.__exit__ = MagicMock(return_value=False)
        cur.fetchone.return_value = (
            {
                "dry_run": True,
                "stats": {"rewired": 2, "candidates": 10},
                "proposed": [
                    {
                        "segment_mrid": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
                        "old_source": "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
                        "new_source": "cccccccc-cccc-cccc-cccc-cccccccccccc",
                    }
                ],
            },
        )

        result = rewire_line_endpoints_by_geometry(
            conn,
            west=-0.22,
            south=5.58,
            east=-0.17,
            north=5.63,
            tip_tol_m=1.0,
            far_fk_m=50.0,
            dry_run=True,
        )

        self.assertTrue(result["dry_run"])
        self.assertEqual(result["stats"]["rewired"], 2)
        self.assertEqual(len(result["proposed"]), 1)
        sql = cur.execute.call_args[0][0]
        self.assertIn("rewire_line_endpoints_by_geometry", sql)
        params = cur.execute.call_args[0][1]
        self.assertEqual(params[:4], (-0.22, 5.58, -0.17, 5.63))
        self.assertEqual(params[4:], (1.0, 50.0, True))

    def test_apply_passes_dry_run_false(self):
        conn = MagicMock()
        cur = MagicMock()
        conn.cursor.return_value.__enter__ = MagicMock(return_value=cur)
        conn.cursor.return_value.__exit__ = MagicMock(return_value=False)
        cur.fetchone.return_value = ({"dry_run": False, "stats": {"applied_count": 3}},)

        result = rewire_line_endpoints_by_geometry(
            conn,
            west=-0.2,
            south=5.6,
            east=-0.1,
            north=5.7,
            dry_run=False,
        )
        self.assertFalse(result["dry_run"])
        self.assertEqual(cur.execute.call_args[0][1][6], False)

    def test_empty_fetch_returns_empty_dict(self):
        conn = MagicMock()
        cur = MagicMock()
        conn.cursor.return_value.__enter__ = MagicMock(return_value=cur)
        conn.cursor.return_value.__exit__ = MagicMock(return_value=False)
        cur.fetchone.return_value = None
        self.assertEqual(
            rewire_line_endpoints_by_geometry(
                conn, west=0, south=0, east=1, north=1, dry_run=True
            ),
            {},
        )


if __name__ == "__main__":
    unittest.main()
