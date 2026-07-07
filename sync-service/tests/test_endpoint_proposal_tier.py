"""Tests for endpoint proposal data-tier routing."""

from __future__ import annotations

import unittest


class EndpointProposalTierTests(unittest.TestCase):
    def test_normalize_defaults_to_gis(self):
        from endpoint_proposal_tier import normalize_data_tier

        self.assertEqual(normalize_data_tier(None), "gis")
        self.assertEqual(normalize_data_tier("staging"), "staging")

    def test_normalize_rejects_invalid(self):
        from endpoint_proposal_tier import normalize_data_tier

        with self.assertRaises(ValueError):
            normalize_data_tier("master")

    def test_tier_config_tables(self):
        from endpoint_proposal_tier import tier_config

        self.assertIn("gis.conductor_endpoint_proposals", tier_config("gis")["proposals_table"])
        self.assertIn("staging.line_endpoint_proposals", tier_config("staging")["proposals_table"])


if __name__ == "__main__":
    unittest.main()
