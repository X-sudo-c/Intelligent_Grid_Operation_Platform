"""Tests for spatial agent Redis cache keys."""

from __future__ import annotations

import unittest

from redis_cache import spatial_inventory_key, spatial_list_key


class SpatialCacheKeyTests(unittest.TestCase):
    def test_inventory_key_stable_for_same_scope(self):
        a = spatial_inventory_key(
            tier="master",
            asset_kind="pole",
            district="Achimota",
            region="Greater Accra",
        )
        b = spatial_inventory_key(
            tier="master",
            asset_kind="pole",
            district="Achimota",
            region="Greater Accra",
        )
        self.assertEqual(a, b)
        self.assertIn("spatial:inventory", a)

    def test_list_key_includes_pagination(self):
        key = spatial_list_key(
            tier="master",
            asset_kind="transformer",
            district="Kumasi",
            region="Ashanti",
            limit=25,
            offset=50,
            include_geom=False,
            west=-1.6,
            south=6.6,
            east=-1.5,
            north=6.7,
        )
        self.assertIn(":25:50:0:", key)


if __name__ == "__main__":
    unittest.main()
