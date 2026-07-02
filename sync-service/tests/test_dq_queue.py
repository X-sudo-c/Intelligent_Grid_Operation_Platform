"""Unit tests for DQ staging queue listing."""

from __future__ import annotations

import os
import sys
import unittest
from unittest.mock import MagicMock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from data_quality import DQ_STAGING_QUEUE, _dq_queue_asset_filters


class DqQueueFilterTests(unittest.TestCase):
    def test_default_filters_dq_staging_validations(self):
        filters, params, nested_where, nested_params = _dq_queue_asset_filters()
        self.assertIn("io.validation::text = ANY(%s)", filters[0])
        self.assertEqual(params[0], list(DQ_STAGING_QUEUE))
        self.assertIn("e.status = 'OPEN'", nested_where)

    def test_clear_status_excludes_open_exceptions(self):
        filters, params, _, _ = _dq_queue_asset_filters(exception_status="CLEAR")
        self.assertTrue(any("NOT EXISTS" in f for f in filters))
        self.assertEqual(params[0], list(DQ_STAGING_QUEUE))

    def test_open_status_requires_matching_exception(self):
        filters, params, _, _ = _dq_queue_asset_filters(exception_status="OPEN")
        self.assertTrue(any("EXISTS" in f for f in filters))
        self.assertIn("OPEN", params)

    def test_duplicates_only_adds_colocation_or_near_rule_filter(self):
        filters, _, _, _ = _dq_queue_asset_filters(duplicates_only=True)
        joined = "\n".join(filters)
        self.assertIn("ASSET_DUPLICATE_NEAR", joined)
        self.assertIn("cn2.geom = cn.geom", joined)


if __name__ == "__main__":
    unittest.main()
