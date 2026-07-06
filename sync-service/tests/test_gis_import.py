"""Tests for GIS import snap + unpromoted segment queue."""

import unittest
from unittest.mock import MagicMock

from gis_import import (
    TOPO_ENDPOINT_TOLERANCE_M,
    UNPROMOTED_REASONS,
    endpoint_diagnostics_summary,
    list_unpromoted_segments,
    snap_conductor_endpoints,
    unpromoted_segment_geojson,
    unpromoted_segments_summary,
)


class GisImportTests(unittest.TestCase):
    def test_default_tolerance_matches_geometric_topology(self):
        self.assertEqual(TOPO_ENDPOINT_TOLERANCE_M, 1.0)

    def test_unpromoted_reasons_exclude_already_promoted(self):
        self.assertNotIn("already_promoted", UNPROMOTED_REASONS)
        self.assertIn("customer_equipment_end", UNPROMOTED_REASONS)

    def test_snap_conductor_endpoints_commits(self):
        conn = MagicMock()
        cur = MagicMock()
        conn.cursor.return_value.__enter__ = MagicMock(return_value=cur)
        conn.cursor.return_value.__exit__ = MagicMock(return_value=False)
        cur.fetchone.side_effect = [
            (
                {
                    "segments_snapped": 12,
                    "segments_already_aligned": 400,
                    "segments_unresolved": 8,
                    "tolerance_m": 1.0,
                },
            ),
            ({"total_unpromoted": 8},),
        ]

        result = snap_conductor_endpoints(conn)
        self.assertEqual(result["segments_snapped"], 12)
        conn.commit.assert_called_once()
        self.assertEqual(cur.execute.call_count, 2)

    def test_list_unpromoted_segments_invalid_reason(self):
        conn = MagicMock()
        with self.assertRaises(ValueError):
            list_unpromoted_segments(conn, reason="not_a_reason")

    def test_list_unpromoted_segments_uses_cached_total(self):
        conn = MagicMock()
        cur = MagicMock()
        conn.cursor.return_value.__enter__ = MagicMock(return_value=cur)
        conn.cursor.return_value.__exit__ = MagicMock(return_value=False)
        cur.fetchone.return_value = (
            None,
            1903018,
            1081519,
            821501,
            {"unresolved_end": 533785},
        )
        cur.fetchall.return_value = []

        payload = list_unpromoted_segments(conn, limit=25, offset=0)
        self.assertEqual(payload["total"], 821501)
        sql_calls = [call[0][0] for call in cur.execute.call_args_list]
        self.assertEqual(len(sql_calls), 2)
        self.assertTrue(all("COUNT(*)" not in sql for sql in sql_calls))

    def test_list_unpromoted_segments_pagination(self):
        conn = MagicMock()
        cur = MagicMock()
        conn.cursor.return_value.__enter__ = MagicMock(return_value=cur)
        conn.cursor.return_value.__exit__ = MagicMock(return_value=False)
        cur.fetchone.return_value = (2,)
        cur.fetchall.return_value = [
            (
                1,
                "oh_conductor_11kv",
                10,
                "MV_11KV",
                "C1",
                "Tema",
                None,
                "A",
                "B",
                120.0,
                -0.1,
                5.6,
                "00000000-0000-4000-8000-000000000001",
                "unresolved_end",
            ),
        ]

        payload = list_unpromoted_segments(conn, district="Tema", limit=1, offset=0)
        self.assertEqual(payload["total"], 2)
        self.assertEqual(payload["count"], 1)
        self.assertEqual(payload["segments"][0]["reason"], "unresolved_end")
        self.assertEqual(cur.execute.call_count, 2)
        self.assertIn("conductor_import_status", cur.execute.call_args_list[0][0][0])

    def test_unpromoted_summary(self):
        conn = MagicMock()
        cur = MagicMock()
        conn.cursor.return_value.__enter__ = MagicMock(return_value=cur)
        conn.cursor.return_value.__exit__ = MagicMock(return_value=False)
        cur.fetchone.return_value = (
            None,
            1903018,
            1081519,
            821501,
            {
                "unresolved_end": 262785,
                "customer_equipment_end": 271000,
                "missing_endpoints": 62125,
            },
        )

        summary = unpromoted_segments_summary(conn)
        self.assertEqual(summary["total_unpromoted"], 821501)
        self.assertEqual(summary["by_reason"]["unresolved_end"], 262785)
        self.assertEqual(summary["customer_equipment_unpromoted"], 271000)
        self.assertEqual(summary["actionable_unpromoted"], 550501)
        self.assertEqual(summary["source"], "cached")

    def test_unpromoted_segment_geojson_builds_highlight(self):
        conn = MagicMock()
        cur = MagicMock()
        conn.cursor.return_value.__enter__ = MagicMock(return_value=cur)
        conn.cursor.return_value.__exit__ = MagicMock(return_value=False)
        cur.fetchone.return_value = (
            42,
            "oh_conductor_11kv",
            "Ablekuma",
            "P107/b23/5",
            "P107/b23/6",
            "unresolved_end",
            {"type": "LineString", "coordinates": [[-0.2, 5.6], [-0.19, 5.61]]},
            -0.2,
            5.6,
            -0.19,
            5.61,
            True,
            False,
            -0.2,
            5.6,
            -0.19,
            5.61,
        )

        payload = unpromoted_segment_geojson(conn, 42)
        self.assertEqual(payload["segment_id"], 42)
        self.assertEqual(payload["geojson"]["line"]["features"][0]["geometry"]["type"], "LineString")
        self.assertEqual(len(payload["geojson"]["endpoints"]["features"]), 2)
        self.assertEqual(payload["geojson"]["endpoints"]["features"][1]["properties"]["resolved"], False)
        self.assertIsNotNone(payload["bbox"])

    def test_unpromoted_segment_geojson_not_found(self):
        conn = MagicMock()
        cur = MagicMock()
        conn.cursor.return_value.__enter__ = MagicMock(return_value=cur)
        conn.cursor.return_value.__exit__ = MagicMock(return_value=False)
        cur.fetchone.return_value = None

        with self.assertRaises(ValueError):
            unpromoted_segment_geojson(conn, 999)

    def test_endpoint_diagnostics_summary(self):
        conn = MagicMock()
        cur = MagicMock()
        conn.cursor.return_value.__enter__ = MagicMock(return_value=cur)
        conn.cursor.return_value.__exit__ = MagicMock(return_value=False)
        cur.fetchone.return_value = (
            {
                "unpromoted_segments": 821519,
                "originating": {"pole_id_unmatched": 197155},
                "end": {"customer_equipment": 150000, "pole_id_unmatched": 383785},
                "endpoint_alias_rows": 94,
            },
        )

        payload = endpoint_diagnostics_summary(conn, district="Ablekuma")
        self.assertEqual(payload["unpromoted_segments"], 821519)
        self.assertEqual(payload["end"]["customer_equipment"], 150000)
        cur.execute.assert_called_once()
        self.assertIn("endpoint_diagnostics_summary", cur.execute.call_args[0][0])


if __name__ == "__main__":
    unittest.main()
