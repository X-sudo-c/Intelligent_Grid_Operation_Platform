"""Tests for spatial territory asset inventory and list tools."""

from __future__ import annotations

import unittest
from unittest.mock import MagicMock

from agents.spatial import (
    LIST_ASSETS_MAX_LIMIT,
    _normalize_kinds,
    format_asset_inventory_text,
    format_network_summary_text,
    list_assets_in_territory,
    network_summary_structured,
)
from agents.voice_router import (
    VoiceIntent,
    _format_count_speech,
    _is_unresolved_road_place,
    parse_intent,
)
from agents.place_resolve import _road_geocode_variants


class SpatialKindTests(unittest.TestCase):
    def test_normalize_11kv_alias(self):
        self.assertEqual(_normalize_kinds("11kv"), ("pole_11kv",))

    def test_normalize_pole_expands(self):
        self.assertEqual(_normalize_kinds("pole"), ("pole_11kv", "pole_33kv", "pole_lv"))


class VoiceVoltagePoleTests(unittest.TestCase):
    def test_parse_11kv_poles_in_district(self):
        intent = parse_intent("how many 11kv poles in Cape Coast", session={}, context={})
        self.assertIsNotNone(intent)
        assert intent is not None
        self.assertEqual(intent.kind, "count")
        self.assertEqual(intent.asset_kind, "pole_11kv")
        self.assertEqual(intent.district, "cape coast")

    def test_parse_poles_in_legon_district(self):
        intent = parse_intent(
            "how many poles are in legon district", session={}, context={}
        )
        self.assertIsNotNone(intent)
        assert intent is not None
        self.assertEqual(intent.kind, "count")
        self.assertEqual(intent.asset_kind, "pole")
        self.assertEqual(intent.district, "legon")

    def test_parse_network_summary_in_district(self):
        intent = parse_intent(
            "electrical assets in akim oda district", session={}, context={}
        )
        self.assertIsNotNone(intent)
        assert intent is not None
        self.assertEqual(intent.kind, "network_summary")
        self.assertEqual(intent.district, "akim oda")

    def test_count_in_view_with_name_them_sets_also_list(self):
        intent = parse_intent(
            "how many poles are in view can you name them",
            session={},
            context={},
        )
        self.assertIsNotNone(intent)
        assert intent is not None
        self.assertEqual(intent.kind, "count")
        self.assertTrue(intent.use_viewport)
        self.assertTrue(intent.also_list_assets)

    def test_list_assets_follow_up(self):
        intent = parse_intent(
            "can you name them",
            session={
                "last_kind": "count",
                "last_asset_kind": "pole",
                "last_use_viewport": True,
                "last_bbox": {"west": 0, "south": 0, "east": 1, "north": 1},
            },
            context={},
        )
        self.assertIsNotNone(intent)
        assert intent is not None
        self.assertEqual(intent.kind, "list_assets")
        self.assertEqual(intent.asset_kind, "pole")
        self.assertTrue(intent.use_viewport)

    def test_format_network_summary_text(self):
        summary = {
            "electrical_assets_total": 20879,
            "nodes": {
                "total": 9926,
                "by_kind": {
                    "pole_33kv": 5270,
                    "pole_11kv": 2413,
                    "pole_lv": 1848,
                    "distribution_transformer": 393,
                    "power_transformer": 2,
                },
            },
            "lines": {
                "total": 10953,
                "by_voltage": {"33000": 5380, "400": 3177, "11000": 2396},
            },
        }
        text = format_network_summary_text(summary, "Akim Oda")
        self.assertIn("Akim Oda", text)
        self.assertIn("20,879", text)
        self.assertIn("33 kV poles", text)
        self.assertNotIn("**", text)
        structured = network_summary_structured(summary, "Akim Oda")
        self.assertEqual(structured["type"], "network_summary")
        self.assertEqual(len(structured["node_rows"]), 5)

    def test_format_11kv_pole_speech(self):
        intent = VoiceIntent(kind="count", asset_kind="pole_11kv")
        msg = _format_count_speech({"total": 42}, intent, "Cape Coast")
        self.assertIn("42", msg)
        self.assertIn("11 kV", msg)

    def test_parse_transformers_along_road(self):
        intent = parse_intent(
            "how many transformers are along adonten SE road",
            session={},
            context={},
        )
        self.assertIsNotNone(intent)
        assert intent is not None
        self.assertEqual(intent.kind, "count")
        self.assertEqual(intent.asset_kind, "transformer")
        self.assertEqual(intent.district, "adonten se road")

    def test_unresolved_road_place_without_resolution(self):
        intent = VoiceIntent(kind="count", asset_kind="transformer", district="adonten se road")
        self.assertTrue(_is_unresolved_road_place(intent))
        resolved = VoiceIntent(
            kind="count",
            asset_kind="transformer",
            district="adonten se road",
            resolved_place={"source": "osm_road", "matched_as": "Adonten S. E. Road"},
        )
        self.assertFalse(_is_unresolved_road_place(resolved))

    def test_asset_correction_intent(self):
        intent = parse_intent(
            "i asked about transformers",
            session={
                "last_kind": "count",
                "last_asset_kind": "pole",
                "last_district": "adonten se road",
            },
            context={},
        )
        self.assertIsNotNone(intent)
        assert intent is not None
        self.assertEqual(intent.kind, "count")
        self.assertEqual(intent.asset_kind, "transformer")
        self.assertEqual(intent.district, "adonten se road")

    def test_format_transformers_not_poles_when_empty_by_kind(self):
        text = format_asset_inventory_text(
            {"total": 0, "by_kind": {}},
            place_label="Along Adonten Se Road",
            asset_kind="transformer",
        )
        self.assertIn("Transformers", text)
        self.assertNotIn("Poles", text)

    def test_road_geocode_variants_expand_abbreviations(self):
        variants = _road_geocode_variants("adonten se road")
        self.assertIn("Adonten S E Road, Kumasi, Ghana", variants)

    def test_parse_poles_along_road_in_city(self):
        intent = parse_intent(
            "how many poles are along the yaa asantewaa road in kumasi",
            session={},
            context={},
        )
        self.assertIsNotNone(intent)
        assert intent is not None
        self.assertEqual(intent.kind, "count")
        self.assertEqual(intent.asset_kind, "pole")
        self.assertEqual(intent.district, "yaa asantewaa road")

    def test_road_geocode_variants_strip_city_qualifier(self):
        variants = _road_geocode_variants("yaa asantewaa road in kumasi")
        self.assertIn("yaa asantewaa road, Kumasi, Ghana", variants)
        self.assertFalse(any(" I N " in v for v in variants))

    def test_parse_transformers_ar_ealong_typo(self):
        intent = parse_intent(
            "how many transformers ar ealong the okomfo anaokye road",
            session={},
            context={},
        )
        self.assertIsNotNone(intent)
        assert intent is not None
        self.assertEqual(intent.asset_kind, "transformer")
        self.assertEqual(intent.district, "okomfo anokye road")

    def test_normalize_ar_ealong_typo(self):
        from agents.voice_normalize import normalize_transcript

        text, meta = normalize_transcript(
            "how many transformers ar ealong the okomfo anaokye road"
        )
        self.assertIn("along", text.lower())
        self.assertNotIn("ealong", text.lower())
        intent = parse_intent(text, session={}, context={})
        assert intent is not None
        self.assertEqual(intent.district, "okomfo anokye road")


class ListAssetsInTerritoryTests(unittest.TestCase):
    _TEST_BBOX = {"west": 0.0, "south": 0.0, "east": 1.0, "north": 1.0}

    def test_requires_territory_scope(self):
        conn = MagicMock()
        with self.assertRaises(ValueError):
            list_assets_in_territory(conn, district=None, region=None, bbox=None)

    def test_list_returns_pagination_metadata(self):
        conn = MagicMock()
        cur = conn.cursor.return_value.__enter__.return_value
        cur.fetchone.side_effect = [(100,),]
        cur.fetchall.return_value = [
            ("mrid-1", "Pole A", "APPROVED", "pole_11kv", "FDR-1"),
        ]
        page = list_assets_in_territory(
            conn,
            district="Takoradi",
            asset_kind="pole_11kv",
            bbox=self._TEST_BBOX,
            limit=25,
        )
        self.assertEqual(page["total"], 100)
        self.assertTrue(page["has_more"])
        self.assertEqual(len(page["assets"]), 1)
        self.assertEqual(page["assets"][0]["asset_kind"], "pole_11kv")

    def test_limit_capped(self):
        conn = MagicMock()
        cur = conn.cursor.return_value.__enter__.return_value
        cur.fetchone.return_value = (0,)
        cur.fetchall.return_value = []
        page = list_assets_in_territory(
            conn,
            district="Takoradi",
            bbox=self._TEST_BBOX,
            limit=500,
        )
        self.assertEqual(page["limit"], LIST_ASSETS_MAX_LIMIT)


if __name__ == "__main__":
    unittest.main()
