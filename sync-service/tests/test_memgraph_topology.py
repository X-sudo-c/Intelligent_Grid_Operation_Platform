"""Tests for Memgraph topology read path."""

import unittest
from unittest.mock import MagicMock, patch

from memgraph_topology import (
    build_trace_payload_memgraph,
    collect_downstream_mrids,
    count_meter_customer_impact,
    fetch_subgraph,
    memgraph_trace_ready,
)


class MemgraphTopologyTests(unittest.TestCase):
    def test_memgraph_trace_ready_threshold(self):
        driver = MagicMock()
        with patch("memgraph_topology.memgraph_totals", return_value=(1000, 50)):
            self.assertFalse(memgraph_trace_ready(driver))
        with patch("memgraph_topology.memgraph_totals", return_value=(1000, 500)):
            self.assertTrue(memgraph_trace_ready(driver))

    def test_collect_downstream_mrids(self):
        driver = MagicMock()
        session = MagicMock()
        driver.session.return_value.__enter__ = MagicMock(return_value=session)
        driver.session.return_value.__exit__ = MagicMock(return_value=False)
        session.run.return_value = iter(
            [{"mrid": "b"}, {"mrid": "c"}],
        )
        mrids, truncated = collect_downstream_mrids(
            driver, "a", max_hops=5, max_nodes=100
        )
        self.assertEqual(mrids, {"a", "b", "c"})
        self.assertFalse(truncated)

    def test_fetch_subgraph_returns_edges(self):
        driver = MagicMock()
        session = MagicMock()
        driver.session.return_value.__enter__ = MagicMock(return_value=session)
        driver.session.return_value.__exit__ = MagicMock(return_value=False)
        session.run.side_effect = [
            iter(
                [
                    {
                        "mrid": "line-1",
                        "source": "a",
                        "target": "b",
                        "phases": "ABC",
                        "voltage": "MV_11KV",
                    }
                ]
            ),
            iter([{"mrid": "a", "name": "Node A"}, {"mrid": "b", "name": "Node B"}]),
        ]
        nodes, edges, connected = fetch_subgraph(driver, {"a", "b"}, max_edges=10)
        self.assertEqual(len(edges), 1)
        self.assertEqual(edges[0]["source"], "a")
        self.assertEqual(connected, {"a", "b"})
        self.assertEqual(len(nodes), 2)

    def test_build_trace_payload_memgraph(self):
        driver = MagicMock()
        conn = MagicMock()
        cur = MagicMock()
        conn.cursor.return_value.__enter__ = MagicMock(return_value=cur)
        conn.cursor.return_value.__exit__ = MagicMock(return_value=False)
        cur.fetchall.return_value = [
            ("a", "Node A", "APPROVED", 5.6, -0.2),
            ("b", "Node B", "APPROVED", 5.61, -0.19),
        ]

        with patch(
            "memgraph_topology.collect_downstream_mrids",
            return_value=({"a", "b"}, False),
        ), patch(
            "memgraph_topology.fetch_subgraph",
            return_value=(
                [
                    {"mrid": "a", "name": "Node A", "connected": True},
                    {"mrid": "b", "name": "Node B", "connected": True},
                ],
                [
                    {
                        "mrid": "line-1",
                        "source": "a",
                        "target": "b",
                        "phases": "ABC",
                        "voltage": "MV_11KV",
                    }
                ],
                {"a", "b"},
            ),
        ):
            payload = build_trace_payload_memgraph(
                driver,
                conn,
                "a",
                "traced",
                graph_totals={"nodes": 100, "edges": 50},
            )

        self.assertEqual(payload["backend"], "memgraph")
        self.assertEqual(len(payload["nodes"]), 2)
        self.assertEqual(len(payload["edges"]), 1)
        self.assertTrue(payload["nodes"][0]["connected"])

    def test_count_meter_customer_impact(self):
        conn = MagicMock()
        cur = MagicMock()
        conn.cursor.return_value.__enter__ = MagicMock(return_value=cur)
        conn.cursor.return_value.__exit__ = MagicMock(return_value=False)
        cur.fetchone.side_effect = [(2,), (1,)]
        counts = count_meter_customer_impact(conn, {"a", "b"})
        self.assertEqual(counts["meters_downstream"], 2)
        self.assertEqual(counts["customers_affected"], 1)


if __name__ == "__main__":
    unittest.main()
