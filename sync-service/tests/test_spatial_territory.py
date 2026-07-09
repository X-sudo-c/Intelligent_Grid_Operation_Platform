"""Tests for spatial territory asset inventory and list tools."""

from __future__ import annotations

import unittest
from unittest.mock import MagicMock, patch

from agents.spatial import (
    LIST_ASSETS_MAX_LIMIT,
    _finalize_inventory_result,
    _mv_territory_filters,
    _normalize_kinds,
    asset_inventory_counts,
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

    def test_count_romanridge_and_show_transformers_strips_place(self):
        intent = parse_intent(
            "how many transformers are in romanridge and show me the transformers",
            session={},
            context={},
        )
        self.assertIsNotNone(intent)
        assert intent is not None
        self.assertEqual(intent.kind, "count")
        self.assertEqual(intent.asset_kind, "transformer")
        self.assertEqual(intent.district, "roman ridge")
        self.assertTrue(intent.also_list_assets)

    def test_show_me_transformers_in_place_is_list_not_highlight(self):
        intent = parse_intent(
            "show me the transformers in Roman Ridge",
            session={},
            context={},
        )
        self.assertIsNotNone(intent)
        assert intent is not None
        self.assertEqual(intent.kind, "list_assets")
        self.assertEqual(intent.asset_kind, "transformer")
        self.assertEqual(intent.district, "roman ridge")
        self.assertFalse(intent.highlight_on_map)

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
        self.assertFalse(intent.highlight_on_map)

    def test_highlight_them_on_map_confirm(self):
        session = {
            "last_kind": "list_assets",
            "last_asset_kind": "transformer",
            "last_district": "roman ridge",
            "last_use_viewport": False,
        }
        for phrase in (
            "yes",
            "yes, highlight them",
            "highlight them on the map",
        ):
            intent = parse_intent(phrase, session=session, context={})
            self.assertIsNotNone(intent, phrase)
            assert intent is not None
            self.assertEqual(intent.kind, "list_assets")
            self.assertTrue(intent.highlight_on_map, phrase)

    def test_show_and_highlight_on_map_sets_flag(self):
        intent = parse_intent(
            "show me the transformers in Roman Ridge and highlight them on the map",
            session={},
            context={},
        )
        self.assertIsNotNone(intent)
        assert intent is not None
        self.assertEqual(intent.kind, "list_assets")
        self.assertTrue(intent.highlight_on_map)

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
        # mrid, name, validation, kind, feeder, lon, lat, xfmr_kind, kva, vector, substation, geom
        cur.fetchall.return_value = [
            (
                "mrid-1",
                "Pole A",
                "APPROVED",
                "pole_11kv",
                "FDR-1",
                -0.2,
                5.6,
                None,
                None,
                None,
                None,
                None,
            ),
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
        self.assertEqual(page["assets"][0]["lon"], -0.2)
        self.assertEqual(page["assets"][0]["lat"], 5.6)

    def test_assets_to_map_highlight_ui(self):
        from agents.spatial import assets_to_map_highlight_ui

        page = {
            "asset_kind_filter": "transformer",
            "total": 2,
            "assets": [
                {
                    "mrid": "a",
                    "name": "T1",
                    "lon": -0.2,
                    "lat": 5.6,
                    "rated_power_kva": 500,
                    "transformer_kind": "distribution",
                },
                {"mrid": "b", "name": "T2", "location": {"lon": -0.21, "lat": 5.61}},
            ],
        }
        ui = assets_to_map_highlight_ui(page, label="2 transformers")
        self.assertIsNotNone(ui)
        assert ui is not None
        self.assertEqual(ui["type"], "highlight_feeder")
        self.assertEqual(len(ui["geojson"]["nodes"]["features"]), 2)
        self.assertIn("bbox", ui)

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


class DistrictAssetCountsMvTests(unittest.TestCase):
    def test_mv_territory_filters_require_scope(self):
        sql, params = _mv_territory_filters(district="Achimota", region=None)
        self.assertIn("district ILIKE", sql)
        self.assertEqual(params, ["%Achimota%"])

    def test_finalize_pole_total_from_mv(self):
        result = _finalize_inventory_result(
            tier="master",
            asset_kind="pole",
            kinds=("pole_11kv", "pole_33kv", "pole_lv"),
            by_kind={"pole_11kv": 10, "pole_33kv": 5},
            total=15,
            district="Achimota",
            region="Greater Accra",
            bbox=None,
            source="district_asset_counts_mv",
        )
        self.assertEqual(result["pole_total"], 15)
        self.assertEqual(result["count_source"], "district_asset_counts_mv")

    def test_asset_inventory_prefers_mv_for_district_scope(self):
        conn = MagicMock()
        mv_payload = {
            "tier": "master",
            "total": 42,
            "by_kind": {"pole_11kv": 42},
            "district": "Achimota",
            "region": None,
            "bbox": None,
            "count_source": "district_asset_counts_mv",
        }
        with (
            patch("agents.spatial._district_asset_counts_mv_ready", return_value=True),
            patch(
                "agents.spatial._asset_inventory_counts_from_mv",
                return_value=mv_payload,
            ) as mv,
            patch("agents.spatial._prefetch_territory_bbox", return_value=None),
        ):
            out = asset_inventory_counts(conn, tier="master", district="Achimota")
        self.assertEqual(out["total"], 42)
        mv.assert_called_once()

    def test_asset_inventory_skips_mv_for_bbox_scope(self):
        conn = MagicMock()
        bbox = {
            "west": -0.3,
            "south": 5.6,
            "east": -0.2,
            "north": 5.7,
        }
        with (
            patch("agents.spatial._asset_inventory_counts_from_mv") as mv,
            patch("agents.spatial._prefetch_territory_bbox", return_value=bbox),
            patch("db_pool.set_local_statement_timeout"),
            patch("agents.spatial._node_inventory_scope") as scope,
        ):
            scope.return_value = (
                "public.identified_objects",
                "public.connectivity_nodes",
                "io.validation = 'APPROVED'",
                "kind_expr",
                "",
            )
            cur = conn.cursor.return_value.__enter__.return_value
            cur.fetchall.return_value = []
            cur.fetchone.return_value = (0,)
            asset_inventory_counts(
                conn,
                tier="master",
                district="Achimota",
                bbox=bbox,
            )
        mv.assert_not_called()


if __name__ == "__main__":
    unittest.main()
