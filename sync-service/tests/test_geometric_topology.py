"""Tests for ArcGIS-style geometric topology checks."""

import unittest
from unittest.mock import MagicMock

from geometric_topology import (
    TOPO_ENDPOINT_TOLERANCE_M,
    _tier_scope,
    auto_clear_geometric_topology,
    bulk_upsert_geometric_topology,
    geometric_topology_live_counts,
)


class GeometricTopologyTests(unittest.TestCase):
    def test_default_tolerance_matches_repair_sql(self):
        self.assertEqual(TOPO_ENDPOINT_TOLERANCE_M, 1.0)

    def test_tier_scope_master(self):
        scope = _tier_scope("master")
        self.assertIn("public.ac_line_segments", scope["als"])
        self.assertIn("APPROVED", scope["line_active"])

    def test_tier_scope_staging(self):
        scope = _tier_scope("staging")
        self.assertIn("staging.ac_line_segments", scope["als"])
        self.assertIn("REJECTED", scope["line_active"])

    def test_live_counts_master(self):
        conn = MagicMock()
        cur = MagicMock()
        conn.cursor.return_value.__enter__ = MagicMock(return_value=cur)
        conn.cursor.return_value.__exit__ = MagicMock(return_value=False)
        cur.fetchone.side_effect = [(3,), (2,), (0,)]

        counts = geometric_topology_live_counts(conn, tier="master")
        self.assertEqual(counts["geom_endpoint_mismatch"], 3)
        self.assertEqual(counts["geom_dangling_endpoints"], 2)
        self.assertEqual(counts["line_crossings_without_node"], 0)
        self.assertEqual(cur.execute.call_count, 2)

    def test_live_counts_with_clip_runs_crossing_query(self):
        conn = MagicMock()
        cur = MagicMock()
        conn.cursor.return_value.__enter__ = MagicMock(return_value=cur)
        conn.cursor.return_value.__exit__ = MagicMock(return_value=False)
        cur.fetchone.side_effect = [(0,), (0,), (1,)]

        clip = {"west": -1.0, "south": 5.0, "east": 0.0, "north": 6.0}
        counts = geometric_topology_live_counts(conn, clip=clip, tier="master")
        self.assertEqual(counts["line_crossings_without_node"], 1)
        self.assertEqual(cur.execute.call_count, 3)

    def test_bulk_upsert_skips_crossing_without_clip(self):
        conn = MagicMock()
        cur = MagicMock()
        conn.cursor.return_value.__enter__ = MagicMock(return_value=cur)
        conn.cursor.return_value.__exit__ = MagicMock(return_value=False)
        cur.rowcount = 0
        cur.fetchone.side_effect = [(0,), (0,), (0,)]

        result = bulk_upsert_geometric_topology(conn, clip=None, tier="master")
        self.assertEqual(result["crossing_inserted"], 0)
        self.assertIn("live", result)
        self.assertGreaterEqual(cur.execute.call_count, 2)

    def test_auto_clear_returns_rowcount_sum(self):
        conn = MagicMock()
        cur = MagicMock()
        conn.cursor.return_value.__enter__ = MagicMock(return_value=cur)
        conn.cursor.return_value.__exit__ = MagicMock(return_value=False)
        cur.rowcount = 4

        cleared = auto_clear_geometric_topology(conn, clip=None, tier="master")
        self.assertEqual(cleared, 8)
        self.assertEqual(cur.execute.call_count, 2)


if __name__ == "__main__":
    unittest.main()
