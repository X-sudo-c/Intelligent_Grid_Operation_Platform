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
                "pole_11kv",
                "pole_11kv",
                "pole_11kv",
                "pole_11kv",
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
        self.assertTrue(page["proposals"][0]["topology_ready"])
        self.assertFalse(page["proposals"][0]["topology_aligned"])

    def test_topology_field_enrichment(self):
        from endpoint_proposals import _enrich_proposal_topology_fields

        aligned = {"start_dist_m": 0.5, "end_dist_m": 0.8}
        _enrich_proposal_topology_fields(aligned)
        self.assertTrue(aligned["topology_aligned"])
        self.assertTrue(aligned["topology_ready"])
        self.assertEqual(aligned["max_gap_m"], 0.8)

        snap_ok = {"start_dist_m": 5.8, "end_dist_m": 12.6}
        _enrich_proposal_topology_fields(snap_ok)
        self.assertFalse(snap_ok["topology_aligned"])
        self.assertTrue(snap_ok["topology_ready"])

        reject = {"start_dist_m": 200.0, "end_dist_m": 3.0}
        _enrich_proposal_topology_fields(reject)
        self.assertFalse(reject["topology_ready"])

        noop = {
            "current_from": "P107/b23/5",
            "proposed_from": "P107/b23/5",
            "current_to": "P107/b23/6",
            "proposed_to": "P107/b23/6",
            "start_dist_m": None,
            "end_dist_m": None,
        }
        _enrich_proposal_topology_fields(noop)
        self.assertTrue(noop["topology_aligned"])
        self.assertTrue(noop["topology_noop"])

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

    def test_map_preview_point_and_link_labels(self):
        from endpoint_proposals import _gap_link_needed, _link_feature, _point_feature

        current = _point_feature(
            role="start",
            lon=-0.2,
            lat=5.6,
            node_id="BAD",
            resolved=False,
        )
        self.assertEqual(current["properties"]["map_label"], "FROM: BAD")
        self.assertEqual(current["properties"]["end_role"], "from")

        proposed = _point_feature(
            role="end",
            lon=-0.21,
            lat=5.61,
            node_id="POLE-B",
            resolved=True,
            proposed=True,
            asset_kind="pole_11kv",
        )
        self.assertIn("TO →", proposed["properties"]["map_label"])
        self.assertIn("POLE-B", proposed["properties"]["map_label"])

        link = _link_feature(
            role="start",
            from_lon=-0.2,
            from_lat=5.6,
            to_lon=-0.201,
            to_lat=5.601,
            asset_id="POLE-A",
            asset_kind="pole_11kv",
            dist_m=9.6,
        )
        self.assertEqual(link["properties"]["dist_label"], "9.6 m")
        self.assertEqual(link["properties"]["end_role"], "from")

    def test_gap_link_skips_noop_end(self):
        from endpoint_proposals import MAX_SNAP_MOVE_M, _gap_link_needed

        self.assertFalse(
            _gap_link_needed(
                current="P1",
                proposed="P1",
                live_dist_m=0.4,
                stored_dist_m=0.4,
            )
        )
        self.assertTrue(
            _gap_link_needed(
                current="start",
                proposed="26989",
                live_dist_m=2.8,
                stored_dist_m=2.8,
            )
        )
        self.assertFalse(
            _gap_link_needed(
                current="P1",
                proposed="P1",
                live_dist_m=0.02,
                stored_dist_m=None,
            )
        )
        self.assertFalse(
            _gap_link_needed(
                current="start",
                proposed="26989",
                live_dist_m=1724.4,
                stored_dist_m=2.7,
            )
        )
        self.assertFalse(
            _gap_link_needed(
                current="start",
                proposed="26989",
                live_dist_m=MAX_SNAP_MOVE_M + 1,
                stored_dist_m=2.7,
            )
        )

    def test_as_linestring_geom_flattens_multilinestring(self):
        from endpoint_proposals import _as_linestring_geom

        multi = {
            "type": "MultiLineString",
            "coordinates": [
                [[-0.1, 5.0], [-0.11, 5.01]],
                [[-0.2, 5.0], [-0.21, 5.01], [-0.22, 5.02]],
            ],
        }
        out = _as_linestring_geom(multi)
        self.assertEqual(out["type"], "LineString")
        self.assertEqual(len(out["coordinates"]), 3)

        plain = {"type": "LineString", "coordinates": [[0, 0], [1, 1]]}
        self.assertEqual(_as_linestring_geom(plain), plain)
        self.assertIsNone(_as_linestring_geom({"type": "Point", "coordinates": [0, 0]}))


if __name__ == "__main__":
    unittest.main()
