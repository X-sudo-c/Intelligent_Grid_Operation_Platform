"""Tests for copilot query sanitization and place salvage."""

from __future__ import annotations

import unittest
from unittest.mock import patch

from agents.copilot_query import (
    extract_road_name,
    salvage_place_name,
    sanitize_copilot_query,
)
from agents.voice_router import parse_intent


class CopilotQuerySanitizeTests(unittest.TestCase):
    def test_ar_ealong_typo(self):
        out = sanitize_copilot_query(
            "how many transformers ar ealong the okomfo anaokye road"
        )
        self.assertIn("along", out.lower())
        self.assertNotIn("ealong", out.lower())

    def test_extract_road_from_garbled_query(self):
        road = extract_road_name(
            "how many transformers ar ealong the okomfo anaokye road"
        )
        self.assertEqual(road, "okomfo anokye road")

    def test_salvage_garbled_place(self):
        place = salvage_place_name(
            "ar ealong the okomfo anaokye road",
            "how many transformers ar ealong the okomfo anaokye road",
        )
        self.assertEqual(place, "okomfo anokye road")

    def test_parse_after_sanitize_in_parse_intent(self):
        intent = parse_intent(
            "how many transformers ar ealong the okomfo anaokye road",
            session={},
            context={},
        )
        self.assertIsNotNone(intent)
        assert intent is not None
        self.assertEqual(intent.district, "okomfo anokye road")


class CopilotQueryRepairTests(unittest.TestCase):
    def test_repair_road_intent_salvage(self):
        from agents.voice_router import VoiceIntent, _try_repair_road_intent

        intent = VoiceIntent(
            kind="count",
            asset_kind="transformer",
            district="ar ealong the okomfo anaokye road",
        )
        meta = {
            "matched_as": "Okomfo Anokye Road",
            "source": "osm_road",
            "bbox": {
                "west": -1.63,
                "south": 6.69,
                "east": -1.62,
                "north": 6.70,
            },
            "district": "Danyame",
            "region": "Ashanti",
            "confidence": 0.9,
        }

        def fake_resolve(conn, place):
            if "okomfo" in (place or "").lower():
                return "Danyame", "Ashanti", meta
            return None, None, None

        with patch("agents.voice_router._resolve_voice_place", side_effect=fake_resolve):
            repaired = _try_repair_road_intent(
                None,
                intent,
                original_query="how many transformers ar ealong the okomfo anaokye road",
                context={"viewport": {"center": {"lat": 6.7, "lon": -1.62}}},
            )
        self.assertIsNotNone(repaired)
        assert repaired is not None
        self.assertIsNotNone(repaired.resolved_place)


if __name__ == "__main__":
    unittest.main()
