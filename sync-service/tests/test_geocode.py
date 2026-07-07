"""Tests for map geocode typo fallbacks."""

from __future__ import annotations

import unittest
from unittest.mock import patch

from geocode import _geocode_query_variants, geocode_map_places


class GeocodeVariantTests(unittest.TestCase):
    def test_continenta_variants_include_continental(self):
        variants = _geocode_query_variants("continenta")
        self.assertIn("continenta", variants)
        self.assertIn("continental", variants)

    @patch("geocode.get_json", return_value=None)
    @patch("geocode.set_json")
    @patch("geocode._geocode_map_places_uncached")
    def test_geocode_falls_back_to_variant(self, uncached, _set_json, _get_json):
        uncached.side_effect = [
            [],
            [{"kind": "place", "id": "osm:1", "title": "Continental", "subtitle": "road"}],
        ]
        hits = geocode_map_places("continenta", limit=5)
        self.assertEqual(len(hits), 1)
        self.assertEqual(hits[0]["title"], "Continental")
        self.assertEqual(uncached.call_count, 2)
        second = uncached.call_args_list[1].args[0].lower()
        self.assertIn(second, {"continental", "continenta"})


if __name__ == "__main__":
    unittest.main()
