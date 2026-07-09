"""Tests for map autocomplete fuzzy matching and ranking."""

from __future__ import annotations

import unittest
from unittest.mock import MagicMock, patch

from map_autocomplete import (
    _match_score,
    autocomplete_places,
    build_autocomplete_index,
)


class MapAutocompleteMatchTests(unittest.TestCase):
    def test_continenta_matches_continental(self):
        item = {
            "title": "Continental Plaza",
            "_norm": "continental plaza",
            "_tokens": ["continental", "plaza"],
        }
        score = _match_score(item, "continenta")
        self.assertIsNotNone(score)
        assert score is not None
        self.assertLess(score, 8.0)

    def test_prefix_outranks_fuzzy(self):
        prefix_item = {
            "title": "Continental",
            "_norm": "continental",
            "_tokens": ["continental"],
        }
        fuzzy_item = {
            "title": "Continentil Plaza",
            "_norm": "continentil plaza",
            "_tokens": ["continentil", "plaza"],
        }
        prefix = _match_score(prefix_item, "continental")
        fuzzy = _match_score(fuzzy_item, "continenta")
        self.assertIsNotNone(fuzzy)
        self.assertIsNotNone(prefix)
        assert fuzzy is not None and prefix is not None
        self.assertLess(prefix, fuzzy)

    def test_autocomplete_places_uses_index(self):
        index = [
            {
                "kind": "place",
                "id": "alias:Continental Plaza",
                "title": "Continental Plaza",
                "subtitle": "Locality",
                "place_type": "alias",
                "source": "osm_poi",
                "longitude": -0.194,
                "latitude": 5.616,
                "bbox": {
                    "west": -0.2,
                    "south": 5.61,
                    "east": -0.19,
                    "north": 5.62,
                },
                "_norm": "continental plaza",
                "_tokens": ["continental", "plaza"],
            }
        ]
        with (
            patch("map_autocomplete.map_places_table_ready", return_value=False),
            patch("map_autocomplete.get_autocomplete_index", return_value=index),
        ):
            hits = autocomplete_places(MagicMock(), query="continenta", limit=5)
        self.assertEqual(len(hits), 1)
        self.assertEqual(hits[0]["title"], "Continental Plaza")


class MapAutocompleteBuildTests(unittest.TestCase):
    def test_build_prefers_aliases(self):
        conn = MagicMock()
        with (
            patch(
                "map_autocomplete._load_districts",
                return_value=[
                    {
                        "kind": "place",
                        "id": "district:X",
                        "title": "Continental",
                        "subtitle": "District",
                        "place_type": "district",
                        "source": "district",
                        "longitude": 0.0,
                        "latitude": 0.0,
                        "bbox": None,
                        "_norm": "continental",
                        "_tokens": ["continental"],
                    }
                ],
            ),
            patch(
                "map_autocomplete._load_aliases",
                return_value=[
                    {
                        "kind": "place",
                        "id": "alias:Continental",
                        "title": "Continental",
                        "subtitle": "Locality",
                        "place_type": "alias",
                        "source": "osm_poi",
                        "longitude": -0.19,
                        "latitude": 5.61,
                        "bbox": None,
                        "_norm": "continental",
                        "_tokens": ["continental"],
                    }
                ],
            ),
        ):
            merged = build_autocomplete_index(conn)
        self.assertEqual(len(merged), 1)
        self.assertEqual(merged[0]["id"], "alias:Continental")


if __name__ == "__main__":
    unittest.main()
