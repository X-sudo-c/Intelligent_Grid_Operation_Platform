"""Unit tests for multi-agent validation engine."""

from __future__ import annotations

import json
import os
import sys
import unittest
from unittest.mock import MagicMock, patch

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from agents.models import CleanupMode
from agents import policy
from agents import graph_tools


class PolicyTests(unittest.TestCase):
    def test_critical_requires_approval(self):
        d = policy.evaluate_cleanup(
            mode=CleanupMode.AUTO_FIX,
            severity="critical",
            domain="topology",
            rule_code="ASSET_ORPHAN_NODE",
            autofix_allowed=True,
            has_rollback=True,
        )
        self.assertTrue(d.requires_approval)

    def test_low_risk_autofix_allowed(self):
        d = policy.evaluate_cleanup(
            mode=CleanupMode.AUTO_FIX,
            severity="minor",
            domain="spatial",
            rule_code="ASSET_GEOM_IN_GHANA",
            autofix_allowed=True,
            has_rollback=True,
        )
        self.assertTrue(d.allowed)

    def test_customer_domain_requires_approval(self):
        d = policy.evaluate_cleanup(
            mode=CleanupMode.AUTO_FIX,
            severity="minor",
            domain="customer",
            rule_code="CUSTOMER_NAME_REQUIRED",
            autofix_allowed=True,
            has_rollback=True,
        )
        self.assertTrue(d.requires_approval)

    def test_route_queue_critical(self):
        self.assertEqual(
            policy.route_queue(domain="topology", severity="critical", rule_code="X"),
            "ex_critical_blocker",
        )

    def test_route_queue_topology(self):
        self.assertEqual(
            policy.route_queue(domain="topology", severity="major", rule_code="ASSET_ORPHAN_NODE"),
            "ex_gis_topology",
        )


class KpiTests(unittest.TestCase):
    def test_compute_kpis_mock(self):
        from agents import kpi

        conn = MagicMock()
        with patch("agents.kpi.summary") as mock_summary, patch(
            "agents.kpi.topology_dq_summary"
        ) as mock_topo, patch("agents.kpi.export_topology_blocked") as mock_gate, patch(
            "agents.kpi.count_pending_approvals", return_value=0
        ):
            mock_summary.return_value = {
                "open_total": 5,
                "open_by_severity": {"critical": 1},
                "open_by_domain": {"spatial": 2, "asset": 1},
            }
            mock_topo.return_value = {
                "live": {"approved_nodes": 100, "orphan_nodes": 5},
            }
            mock_gate.return_value = {"blocked": False}
            conn.cursor.return_value.__enter__.return_value.fetchone.return_value = (0, 0)
            metrics = kpi.compute_kpis(conn)
        self.assertEqual(metrics["topology_validity_pct"], 95.0)
        self.assertTrue(any(e["code"] == "TOPOLOGY_BELOW_THRESHOLD" for e in metrics["escalation"]))


class GraphToolsTests(unittest.TestCase):
    def test_detect_cycles_skipped_when_large(self):
        with patch("topology_graph.load_master_digraph") as mock_load:
            import networkx as nx

            g = nx.DiGraph()
            for i in range(80000):
                g.add_node(str(i))
            mock_load.return_value = g
            result = graph_tools.detect_cycles(max_nodes=75000)
        self.assertTrue(result.get("skipped"))


class RuleEvaluatorTests(unittest.TestCase):
    def test_transformer_capacity_fail(self):
        from data_quality import _r_transformer_capacity

        status, msg, _ = _r_transformer_capacity(
            {"is_transformer": True, "transformer_capacity": None, "has_equipment": False}
        )
        self.assertEqual(status, "FAIL")

    def test_in_service_boundary_pass(self):
        from data_quality import _r_in_service_boundary

        status, _, _ = _r_in_service_boundary({"geom_present": True, "in_ecg_region": True})
        self.assertEqual(status, "PASS")

    def test_timeliness_fail(self):
        from data_quality import _r_timeliness, STALE_ASSET_DAYS

        status, _, details = _r_timeliness(
            {"tier": "master", "days_since_update": STALE_ASSET_DAYS + 10}
        )
        self.assertEqual(status, "FAIL")
        self.assertIsNotNone(details)


class ReactLoopTests(unittest.TestCase):
    def test_run_tool_loop_no_llm_executes_tools(self):
        from agents.llm.react import run_tool_loop

        conn = MagicMock()
        with patch("agents.llm.react.complete_chat") as mock_chat, patch(
            "agents.llm.react._execute_tool", return_value={"open_total": 3}
        ) as mock_exec, patch("agents.llm.react.log_agent_step"):
            mock_chat.side_effect = [
                {
                    "content": "",
                    "model": "test",
                    "tools_used": ["dq_summary"],
                    "raw": {
                        "tool_calls": [
                            {
                                "id": "call_1",
                                "function": {"name": "dq_summary", "arguments": "{}"},
                            }
                        ]
                    },
                },
                {
                    "content": "3 open exceptions found.",
                    "model": "test",
                    "tools_used": [],
                    "raw": {"content": "3 open exceptions found."},
                },
            ]
            result = run_tool_loop(
                conn,
                [{"role": "user", "content": "summarize dq"}],
                max_turns=4,
            )
        mock_exec.assert_called_once()
        self.assertIn("dq_summary", result["tools_used"])
        self.assertIn("3 open", result["content"])


class OrchestratorMockTests(unittest.TestCase):
    def test_validation_run_request_model(self):
        from agents.models import ValidationRunRequest, RunType

        req = ValidationRunRequest(run_type=RunType.FULL_CYCLE)
        self.assertEqual(req.tier, "master")


class UpsertNetworkExceptionTests(unittest.TestCase):
    def test_upsert_network_skips_invalid_uuid(self):
        from data_quality import upsert_network_topology_exceptions

        conn = MagicMock()
        conn.cursor.return_value.__enter__.return_value.fetchone.return_value = None
        with patch("data_quality.upsert_record_exception", return_value=False) as mock_upsert:
            count = upsert_network_topology_exceptions(
                conn,
                rule_code="TOPO_NETWORK_LOOP",
                node_mrids=["not-a-uuid", "also-bad"],
                message="loop",
            )
        mock_upsert.assert_not_called()
        self.assertEqual(count, 0)


class LiveProgressTests(unittest.TestCase):
    def test_log_agent_step_publishes_when_live(self):
        from agents.audit import log_agent_step
        from agents.context import clear_run_context, set_live_progress

        conn = MagicMock()
        set_live_progress(True)
        try:
            with patch("agents.audit.publish_agent_step") as mock_publish:
                log_agent_step(
                    conn,
                    run_id="00000000-0000-0000-0000-000000000001",
                    agent_name="ValidatorAgent",
                    tool_name="test",
                )
            mock_publish.assert_called_once()
            conn.cursor.assert_not_called()
        finally:
            clear_run_context()

    def test_progress_uses_publish_when_live(self):
        from agents import orchestrator
        from agents.context import clear_run_context, set_live_progress

        set_live_progress(True)
        conn = MagicMock()
        try:
            with patch("agents.orchestrator.repository.publish_run_progress") as mock_pub, patch(
                "agents.orchestrator.repository.update_run_progress"
            ) as mock_upd, patch("agents.orchestrator.check_run_deadline"):
                orchestrator._progress(conn, "run-1", "validator", detail="test")
            mock_pub.assert_called_once()
            mock_upd.assert_not_called()
        finally:
            clear_run_context()

    def test_run_deadline_raises_timeout(self):
        from agents.context import (
            ValidationRunTimeout,
            clear_run_context,
            set_run_deadline,
            check_run_deadline,
        )

        set_run_deadline(0.0, run_id="run-1")
        try:
            with self.assertRaises(ValidationRunTimeout):
                check_run_deadline()
        finally:
            clear_run_context()


class SpatialTests(unittest.TestCase):
    def test_normalize_pole_kinds(self):
        from agents.spatial import _normalize_kinds, POLE_KINDS

        self.assertEqual(_normalize_kinds("pole"), POLE_KINDS)
        self.assertEqual(_normalize_kinds("Poles"), POLE_KINDS)

    def test_territory_where_requires_input(self):
        from agents.spatial import _territory_where_clause

        with self.assertRaises(ValueError):
            _territory_where_clause(district=None, region=None)

    def test_territory_where_district_pattern(self):
        from agents.spatial import _territory_where_clause

        where, params = _territory_where_clause(district="Accra", region=None)
        self.assertIn("ILIKE", where)
        self.assertEqual(params, ["%Accra%"])

    def test_highlight_district_ui_action(self):
        from agents.llm import react

        conn = MagicMock()
        cur = MagicMock()
        conn.cursor.return_value.__enter__ = MagicMock(return_value=cur)
        conn.cursor.return_value.__exit__ = MagicMock(return_value=False)
        cur.fetchone.side_effect = [
            ("Accra Metro", "Greater Accra", 2, -0.2, 5.6, -0.3, 5.5, -0.1, 5.7),
            (
                {
                    "type": "FeatureCollection",
                    "features": [{"type": "Feature", "properties": {}, "geometry": {}}],
                },
            ),
        ]
        result = react._execute_tool(
            conn,
            "pan_map",
            {"action": "highlight_district", "district": "Accra"},
        )
        self.assertTrue(result.get("ok"))
        ui = result.get("ui_action") or {}
        self.assertEqual(ui.get("type"), "highlight_territory")
        self.assertEqual(ui.get("district"), "Accra Metro")
        self.assertIn("geojson", ui)


class VoiceSttTests(unittest.TestCase):
    def test_stt_status(self):
        from agents import voice_stt

        st = voice_stt.status()
        self.assertIn(st["mode"], ("openai", "local"))
        self.assertIn("available", st)
        self.assertIn("provider", st)

    def test_auto_provider_prefers_openai_with_key(self):
        from agents import voice_stt

        with patch.dict(
            os.environ,
            {
                "VOICE_STT_PROVIDER": "auto",
                "GIOP_LLM_API_KEY": "sk-test",
                "VOICE_STT_API_KEY": "",
                "OPENAI_API_KEY": "",
            },
            clear=False,
        ):
            self.assertEqual(voice_stt.active_provider(), "openai")

    def test_run_voice_turn_from_audio(self):
        from agents.voice import run_voice_turn_from_audio
        from unittest.mock import MagicMock, patch

        conn = MagicMock()
        with patch("agents.voice.voice_stt.transcribe_audio", return_value="zoom into Dome"):
            with patch("agents.voice.try_copilot_fast_path") as fast:
                fast.return_value = (
                    MagicMock(kind="fly_to"),
                    {
                        "content": "Flying to Dome.",
                        "speak": "Flying to Dome.",
                        "ui_actions": [{"type": "fly_to", "lat": 1.0, "lng": -0.1}],
                        "session_patch": {},
                    },
                )
                result = run_voice_turn_from_audio(
                    conn,
                    data=b"fake-audio",
                    content_type="audio/webm",
                )
        self.assertEqual(result.agent.get("transcript"), "zoom into Dome")
        self.assertTrue(result.agent.get("fast_path"))
        self.assertEqual(result.content, "Flying to Dome.")

class VoiceRouterTests(unittest.TestCase):
    def test_normalize_akra_to_accra(self):
        from agents.voice_normalize import normalize_transcript

        text, meta = normalize_transcript("how many staging elements are in Akra")
        self.assertIn("Accra", text)
        self.assertNotIn("Akra", text)
        self.assertTrue(meta.get("fixes"))

    def test_highlight_accra_survives_boundary_warmup(self):
        from agents import voice_stt
        from agents.voice_normalize import normalize_transcript
        from agents.voice_router import parse_intent
        from agents.voice import run_voice_turn
        from unittest.mock import MagicMock

        conn = MagicMock()
        cur = MagicMock()
        conn.cursor.return_value.__enter__ = MagicMock(return_value=cur)
        conn.cursor.return_value.__exit__ = MagicMock(return_value=False)
        cur.fetchall.return_value = [("Accra",), ("Koforidua",), ("Agona",), ("Bortianor",)]
        voice_stt.warm_boundary_prompt(conn)

        text, _ = normalize_transcript("highlight accra on the map")
        self.assertIn("Accra", text)
        self.assertNotIn("Koforidua", text)
        intent = parse_intent(text, session={}, context={})
        self.assertIsNotNone(intent)
        assert intent is not None
        self.assertEqual(intent.kind, "highlight")

    def test_parse_count_staging_elements_in_place(self):
        from agents.voice_normalize import normalize_transcript
        from agents.voice_router import parse_intent

        text, _ = normalize_transcript("how many staging elements are in Akra")
        intent = parse_intent(text, session={}, context={})
        self.assertIsNotNone(intent)
        assert intent is not None
        self.assertEqual(intent.kind, "count")
        self.assertEqual(intent.tier, "staging")
        self.assertEqual(intent.district, "accra")
        self.assertFalse(intent.use_viewport)

    def test_portal_nested_viewport_bbox(self):
        from agents.portal_context import portal_viewport_bbox

        bbox = portal_viewport_bbox(
            {
                "viewport": {
                    "bbox": {
                        "west": -0.3,
                        "south": 5.5,
                        "east": -0.1,
                        "north": 5.7,
                    },
                    "zoom": 12,
                    "center": {"lon": -0.2, "lat": 5.6},
                }
            }
        )
        self.assertEqual(bbox, {"west": -0.3, "south": 5.5, "east": -0.1, "north": 5.7})

    def test_count_this_area_uses_selected_territory(self):
        from agents.voice_router import execute_fast_path, parse_intent

        conn = MagicMock()
        cur = MagicMock()
        conn.cursor.return_value.__enter__ = MagicMock(return_value=cur)
        conn.cursor.return_value.__exit__ = MagicMock(return_value=False)
        cur.fetchall.return_value = [("connectivity_node", 4)]
        cur.fetchone.return_value = (4,)

        intent = parse_intent(
            "how many staging elements are in this area",
            session={},
            context={},
        )
        self.assertIsNotNone(intent)
        assert intent is not None
        self.assertEqual(intent.kind, "count")
        self.assertEqual(intent.tier, "staging")
        self.assertTrue(intent.use_viewport)

        result = execute_fast_path(
            conn,
            intent,
            context={"selected_region": "Accra"},
        )
        self.assertIsNotNone(result)
        assert result is not None
        self.assertIn("4", result["content"])
        self.assertIn("Accra", result["content"])

    def test_parse_count_poles_in_viewport_with_question_mark(self):
        from agents.voice_router import parse_intent

        for text in (
            "How many poles are in the current map view?",
            "how many poles in this map view",
            "count poles in the visible area",
        ):
            with self.subTest(text=text):
                intent = parse_intent(text, session={}, context={})
                self.assertIsNotNone(intent, text)
                assert intent is not None
                self.assertEqual(intent.kind, "count")
                self.assertEqual(intent.asset_kind, "pole")
                self.assertTrue(intent.use_viewport)

    def test_count_viewport_uses_portal_bbox(self):
        from agents.voice_router import execute_fast_path, parse_intent

        conn = MagicMock()
        cur = MagicMock()
        conn.cursor.return_value.__enter__ = MagicMock(return_value=cur)
        conn.cursor.return_value.__exit__ = MagicMock(return_value=False)
        cur.fetchall.return_value = [("pole_11kv", 12), ("pole_33kv", 3)]
        cur.fetchone.return_value = (15,)

        intent = parse_intent(
            "How many poles are in the current map view?",
            session={},
            context={},
        )
        self.assertIsNotNone(intent)
        assert intent is not None
        self.assertTrue(intent.use_viewport)

        result = execute_fast_path(
            conn,
            intent,
            context={
                "viewport": {
                    "bbox": {
                        "west": -0.895,
                        "south": 5.283,
                        "east": 0.433,
                        "north": 6.123,
                    }
                }
            },
        )
        self.assertIsNotNone(result)
        assert result is not None
        self.assertTrue(result.get("fast_path"))
        self.assertIn("15", result["content"])
        self.assertIn("this area", result["content"].lower())

    def test_my_view_parses_as_viewport_count(self):
        from agents.voice_router import parse_intent

        for text in (
            "how many staging captures are in my view",
            "how many staging captures are in my view?",
            "count staging captures in my area",
        ):
            with self.subTest(text=text):
                intent = parse_intent(text, session={}, context={})
                self.assertIsNotNone(intent)
                assert intent is not None
                self.assertEqual(intent.kind, "count")
                self.assertEqual(intent.tier, "staging")
                self.assertTrue(intent.use_viewport)
                self.assertIsNone(intent.district)

    def test_staging_count_speech_includes_distinct_locations(self):
        from agents.voice_router import VoiceIntent, _format_count_speech

        intent = VoiceIntent(kind="count", tier="staging")
        msg = _format_count_speech(
            {"total": 12, "distinct_locations": 5},
            intent,
            "this area",
        )
        self.assertIn("12", msg)
        self.assertIn("5", msg)
        self.assertIn("locations", msg)

    def test_parse_count_staging_assets_in_viewport(self):
        from agents.voice_router import parse_intent

        intent = parse_intent(
            "how many staging assets are in the current map view?",
            session={},
            context={},
        )
        self.assertIsNotNone(intent)
        assert intent is not None
        self.assertEqual(intent.kind, "count")
        self.assertEqual(intent.tier, "staging")
        self.assertTrue(intent.use_viewport)

    def test_parse_count_poles_in_district(self):
        from agents.voice_router import parse_intent

        intent = parse_intent(
            "how many poles in Accra",
            session={},
            context={},
        )
        self.assertIsNotNone(intent)
        assert intent is not None
        self.assertEqual(intent.kind, "count")
        self.assertEqual(intent.asset_kind, "pole")
        self.assertEqual(intent.district, "accra")

    def test_parse_work_orders_in_view(self):
        from agents.voice_router import parse_intent

        for text in (
            "what work orders are in view",
            "current work orders on the map",
            "open work orders here",
        ):
            with self.subTest(text=text):
                intent = parse_intent(text, session={}, context={})
                self.assertIsNotNone(intent)
                assert intent is not None
                self.assertEqual(intent.kind, "work_orders_in_view")
                self.assertTrue(intent.use_viewport)

    def test_parse_work_orders_in_place(self):
        from agents.voice_router import parse_intent

        for text in (
            "what work orders are in accra",
            "tell me about the current work order nodes in accra",
            "show open work orders in Accra",
        ):
            with self.subTest(text=text):
                intent = parse_intent(text, session={}, context={})
                self.assertIsNotNone(intent, msg=text)
                assert intent is not None
                self.assertEqual(intent.kind, "work_orders_in_view", msg=text)
                self.assertEqual(intent.district, "accra", msg=text)
                self.assertFalse(intent.use_viewport, msg=text)

    def test_parse_pan_to_work_order_node(self):
        from agents.voice_router import parse_intent

        intent = parse_intent("pan to the work order node", session={}, context={})
        self.assertIsNotNone(intent)
        assert intent is not None
        self.assertEqual(intent.kind, "pan_work_order")

    def test_metro_zoom_uses_fit_bounds_not_fly_to(self):
        from agents.place_resolve import place_viewport_ui_action

        resolved = {
            "source": "metro_region",
            "matched_as": "Accra",
            "center": {"lon": -0.2, "lat": 5.6},
            "bbox": {"west": -0.5, "south": 5.3, "east": 0.1, "north": 5.9},
        }
        ui = place_viewport_ui_action(resolved, mode="zoom", tab="map")
        self.assertIsNotNone(ui)
        assert ui is not None
        self.assertEqual(ui["type"], "fit_bounds")
        self.assertEqual(ui.get("max_zoom"), 14.5)

    def test_osm_locality_pan_centers_with_fly_to(self):
        from agents.place_resolve import place_viewport_ui_action

        resolved = {
            "source": "osm",
            "matched_as": "Roman Ridge",
            "center": {"lon": -0.185, "lat": 5.612},
            "bbox": {"west": -0.5, "south": 5.3, "east": 0.1, "north": 5.9},
        }
        ui = place_viewport_ui_action(resolved, mode="pan", tab="map")
        self.assertIsNotNone(ui)
        assert ui is not None
        self.assertEqual(ui["type"], "fly_to")
        self.assertAlmostEqual(float(ui["center"]["lon"]), -0.185)
        self.assertAlmostEqual(float(ui["center"]["lat"]), 5.612)

    def test_parse_take_me_to_locality(self):
        from agents.voice_router import parse_intent

        intent = parse_intent("take me to roman ridge", session={}, context={})
        self.assertIsNotNone(intent)
        assert intent is not None
        self.assertEqual(intent.kind, "pan")
        self.assertEqual(intent.district, "roman ridge")

    def test_alias_exact_pins_locality_center(self):
        from agents.place_resolve import _lookup_alias_exact

        conn = MagicMock()
        cur = MagicMock()
        conn.cursor.return_value.__enter__ = MagicMock(return_value=cur)
        conn.cursor.return_value.__exit__ = MagicMock(return_value=False)
        cur.fetchone.return_value = ("Roman Ridge", None, None, -0.1949429, 5.6041482)
        cur.fetchone.side_effect = [
            ("Roman Ridge", None, None, -0.1949429, 5.6041482),
            ("Ayawaso West", "Greater Accra", -0.20, 5.60, -0.21, 5.59, -0.18, 5.61),
        ]

        hit = _lookup_alias_exact(conn, "Roman Ridge")
        self.assertIsNotNone(hit)
        assert hit is not None
        self.assertEqual(hit["source"], "alias_exact")
        self.assertAlmostEqual(float(hit["center"]["lon"]), -0.1949429, places=4)
        self.assertAlmostEqual(float(hit["center"]["lat"]), 5.6041482, places=4)

    def test_pick_osm_hit_prefers_name_match(self):
        from agents.place_resolve import _pick_osm_hit

        hits = [
            {"title": "Kotobabi", "longitude": -0.204, "latitude": 5.599},
            {"title": "Roman Ridge", "longitude": -0.195, "latitude": 5.604},
        ]
        best = _pick_osm_hit("roman ridge", hits)
        self.assertIsNotNone(best)
        assert best is not None
        self.assertEqual(best["title"], "Roman Ridge")

    def test_format_work_orders_speech_empty(self):
        from agents.voice_router import _format_work_orders_speech

        speak = _format_work_orders_speech({"count": 0, "work_orders": []})
        self.assertIn("no open work orders", speak.lower())

    def test_parse_inspect_node_in_view(self):
        from agents.voice_router import parse_intent

        for text in (
            "tell me about the node in view",
            "what is this node",
            "what am I looking at",
            "describe the node on screen",
        ):
            with self.subTest(text=text):
                intent = parse_intent(text, session={}, context={})
                self.assertIsNotNone(intent)
                assert intent is not None
                self.assertEqual(intent.kind, "inspect_node")

    def test_node_pick_uncertain(self):
        from agents.portal_context import _node_pick_uncertain

        self.assertTrue(
            _node_pick_uncertain(distance_m=50, zoom=12, runner_up_distance_m=60)
        )
        self.assertTrue(
            _node_pick_uncertain(distance_m=50, zoom=15, runner_up_distance_m=55)
        )
        self.assertTrue(
            _node_pick_uncertain(distance_m=200, zoom=16, runner_up_distance_m=None)
        )
        self.assertFalse(
            _node_pick_uncertain(distance_m=40, zoom=16, runner_up_distance_m=100)
        )

    def test_format_inspect_node_speech_confirmation(self):
        from agents.voice_router import _format_inspect_node_speech

        speak = _format_inspect_node_speech(
            {
                "name": "Pokuaa BSP",
                "validation": "VALID",
                "degree": 2,
                "confirmation_needed": True,
            }
        )
        self.assertIn("highlighted", speak.lower())
        self.assertIn("pokuaa bsp", speak.lower())
        self.assertIn("is this the node", speak.lower())

    def test_parse_highlight(self):
        from agents.voice_router import parse_intent

        intent = parse_intent("highlight Greater Accra on the map", session={}, context={})
        self.assertIsNotNone(intent)
        assert intent is not None
        self.assertEqual(intent.kind, "highlight")

    def test_show_me_accra_parses_accra_not_me_accra(self):
        from agents.voice_router import parse_intent

        for text in ("show me accra", "Show me Accra", "show me Accra on the map"):
            with self.subTest(text=text):
                intent = parse_intent(text, session={}, context={})
                self.assertIsNotNone(intent)
                assert intent is not None
                self.assertEqual(intent.kind, "highlight")
                self.assertEqual(intent.district, "accra")
                self.assertIsNone(intent.region)

    def test_parse_trace_connection_path(self):
        from agents.voice_router import parse_intent

        intent = parse_intent("can you trace the connection path?", session={}, context={})
        self.assertIsNotNone(intent)
        assert intent is not None
        self.assertEqual(intent.kind, "trace_connection_path")

    def test_parse_trace_feeder_explicit(self):
        from agents.voice_router import parse_intent

        intent = parse_intent("show nodes on feeder FEEDER-ACC-01", session={}, context={})
        self.assertIsNotNone(intent)
        assert intent is not None
        self.assertEqual(intent.kind, "trace_feeder")
        self.assertEqual(intent.feeder_id, "FEEDER-ACC-01")

    def test_parse_trace_this_feeder(self):
        from agents.voice_router import parse_intent

        intent = parse_intent("highlight this feeder on the map", session={}, context={})
        self.assertIsNotNone(intent)
        assert intent is not None
        self.assertEqual(intent.kind, "trace_feeder")
        self.assertIsNone(intent.feeder_id)

    def test_parse_trace_named_mallam_feeder(self):
        from agents.voice_router import parse_intent

        for text in (
            "show connections on the mallam feeder",
            "connection of the mallam feeder",
            "trace the mallam feeder",
            "highlight mallam feeder on the map",
        ):
            with self.subTest(text=text):
                intent = parse_intent(text, session={}, context={})
                self.assertIsNotNone(intent, msg=text)
                assert intent is not None
                self.assertEqual(intent.kind, "trace_feeder", msg=text)
                self.assertEqual(intent.feeder_id, "mallam", msg=text)

    def test_resolve_feeder_query_mallam(self):
        from agents.graph_tools import resolve_feeder_query

        conn = MagicMock()
        cur = MagicMock()
        conn.cursor.return_value.__enter__ = MagicMock(return_value=cur)
        conn.cursor.return_value.__exit__ = MagicMock(return_value=False)
        cur.fetchall.return_value = [
            ("FEEDER-ECG-MALLAM-04", 12, "Mallam Secondary Distribution Node"),
        ]

        resolved = resolve_feeder_query(conn, "mallam")
        self.assertEqual(resolved["feeder_id"], "FEEDER-ECG-MALLAM-04")

    def test_trace_feeder_bbox_from_geojson(self):
        from agents.graph_tools import _bbox_from_geojson

        bbox = _bbox_from_geojson(
            {
                "type": "FeatureCollection",
                "features": [
                    {
                        "type": "Feature",
                        "properties": {},
                        "geometry": {"type": "Point", "coordinates": [-0.2, 5.6]},
                    }
                ],
            }
        )
        self.assertIsNotNone(bbox)
        assert bbox is not None
        self.assertLess(bbox["west"], -0.2)
        self.assertGreater(bbox["east"], -0.2)

    def test_show_map_to_accra_parses_pan(self):
        from agents.voice_router import parse_intent

        intent = parse_intent("show me the map to Kumasi", session={}, context={})
        self.assertIsNotNone(intent)
        assert intent is not None
        self.assertEqual(intent.kind, "pan")
        self.assertEqual(intent.district, "kumasi")

    def test_zoom_in_without_place_parses_zoom_map(self):
        from agents.voice_router import parse_intent

        intent = parse_intent("zoom in", session={}, context={})
        self.assertIsNotNone(intent)
        assert intent is not None
        self.assertEqual(intent.kind, "zoom_map")
        self.assertGreater(float(intent.zoom_delta), 0.0)

    def test_zoom_in_a_bit_parses_smaller_zoom_delta(self):
        from agents.voice_router import parse_intent

        little = parse_intent("zoom in a bit", session={}, context={})
        normal = parse_intent("zoom in", session={}, context={})
        self.assertIsNotNone(little)
        self.assertIsNotNone(normal)
        assert little is not None
        assert normal is not None
        self.assertEqual(little.kind, "zoom_map")
        self.assertLess(float(little.zoom_delta), float(normal.zoom_delta))

    def test_zoom_in_more_parses_larger_zoom_delta(self):
        from agents.voice_router import parse_intent

        more = parse_intent("zoom in more", session={}, context={})
        normal = parse_intent("zoom in", session={}, context={})
        self.assertIsNotNone(more)
        self.assertIsNotNone(normal)
        assert more is not None
        assert normal is not None
        self.assertEqual(more.kind, "zoom_map")
        self.assertGreater(float(more.zoom_delta), float(normal.zoom_delta))

    def test_execute_fast_path_zoom_in_uses_current_center(self):
        from agents.voice_router import execute_fast_path, parse_intent

        intent = parse_intent("zoom in", session={}, context={})
        self.assertIsNotNone(intent)
        assert intent is not None

        result = execute_fast_path(
            MagicMock(),
            intent,
            context={"viewport": {"zoom": 12, "center": {"lon": -0.2, "lat": 5.6}}},
        )
        self.assertIsNotNone(result)
        assert result is not None
        self.assertTrue(result.get("fast_path"))
        self.assertEqual(result["ui_actions"][0]["type"], "fly_to")
        self.assertGreater(float(result["ui_actions"][0]["zoom"]), 12.0)

    def test_execute_fast_path_zoom_in_more_moves_further_than_a_bit(self):
        from agents.voice_router import execute_fast_path, parse_intent

        more = parse_intent("zoom in more", session={}, context={})
        little = parse_intent("zoom in a bit", session={}, context={})
        self.assertIsNotNone(more)
        self.assertIsNotNone(little)
        assert more is not None
        assert little is not None

        base_ctx = {"viewport": {"zoom": 12, "center": {"lon": -0.2, "lat": 5.6}}}
        more_result = execute_fast_path(MagicMock(), more, context=base_ctx)
        little_result = execute_fast_path(MagicMock(), little, context=base_ctx)
        self.assertIsNotNone(more_result)
        self.assertIsNotNone(little_result)
        assert more_result is not None
        assert little_result is not None
        self.assertGreater(float(more_result["ui_actions"][0]["zoom"]),
            float(little_result["ui_actions"][0]["zoom"]),
        )

    def test_zoom_out_without_place_parses_zoom_map(self):
        from agents.voice_router import parse_intent

        intent = parse_intent("zoom out", session={}, context={})
        self.assertIsNotNone(intent)
        assert intent is not None
        self.assertEqual(intent.kind, "zoom_map")
        self.assertLess(float(intent.zoom_delta), 0.0)

    def test_zoom_out_paraphrases_parse_zoom_map(self):
        from agents.voice_router import parse_intent

        for phrase in (
            "can you zoom out",
            "zoom the map out",
            "zoom out please",
            "please zoom out on the map",
        ):
            with self.subTest(phrase=phrase):
                intent = parse_intent(phrase, session={}, context={})
                self.assertIsNotNone(intent, msg=phrase)
                assert intent is not None
                self.assertEqual(intent.kind, "zoom_map", msg=phrase)
                self.assertLess(float(intent.zoom_delta), 0.0, msg=phrase)

    def test_zoom_out_a_bit_more_uses_larger_step(self):
        from agents.voice_router import parse_intent

        little = parse_intent("zoom out a bit", session={}, context={})
        more = parse_intent("zoom out a bit more", session={}, context={})
        self.assertIsNotNone(little)
        self.assertIsNotNone(more)
        assert little is not None
        assert more is not None
        self.assertGreater(abs(float(more.zoom_delta)), abs(float(little.zoom_delta)))

    def test_execute_fast_path_zoom_out_uses_current_center(self):
        from agents.voice_router import execute_fast_path, parse_intent

        intent = parse_intent("zoom out", session={}, context={})
        self.assertIsNotNone(intent)
        assert intent is not None

        result = execute_fast_path(
            MagicMock(),
            intent,
            context={"viewport": {"zoom": 12, "center": {"lon": -0.2, "lat": 5.6}}},
        )
        self.assertIsNotNone(result)
        assert result is not None
        self.assertTrue(result.get("fast_path"))
        self.assertEqual(result["ui_actions"][0]["type"], "fly_to")
        self.assertLess(float(result["ui_actions"][0]["zoom"]), 12.0)

    def test_follow_up_and_in(self):
        from agents.voice_router import parse_intent

        intent = parse_intent(
            "and in Kumasi",
            session={"last_kind": "count", "last_asset_kind": "pole", "last_tier": "master"},
            context={},
        )
        self.assertIsNotNone(intent)
        assert intent is not None
        self.assertEqual(intent.district, "kumasi")
        self.assertEqual(intent.asset_kind, "pole")

    def test_bare_in_place_not_follow_up(self):
        from agents.voice_router import parse_intent

        intent = parse_intent(
            "in Kaneshie",
            session={"last_kind": "count", "last_tier": "staging"},
            context={},
        )
        self.assertIsNone(intent)

    def test_count_scope_skips_selected_district_by_default(self):
        from agents.portal_context import portal_count_scope

        bbox, district, region = portal_count_scope(
            use_viewport=True,
            territory_bbox=None,
            district=None,
            region=None,
            context={"selected_district": "Kaneshie", "selected_region": "Accra West"},
            allow_selected_territory=False,
        )
        self.assertIsNone(bbox)
        self.assertIsNone(district)
        self.assertIsNone(region)

        _bbox, district2, region2 = portal_count_scope(
            use_viewport=True,
            territory_bbox=None,
            district=None,
            region=None,
            context={"selected_district": "Kaneshie", "selected_region": "Accra West"},
            allow_selected_territory=True,
        )
        self.assertEqual(district2, "Kaneshie")
        self.assertEqual(region2, "Accra West")

    def test_echo_count_template_skips_fast_path(self):
        from agents.voice_router import try_copilot_fast_path

        conn = MagicMock()
        intent, fast = try_copilot_fast_path(
            conn,
            "About 0 staging captures in Kaneshie.",
            context={"selected_district": "Kaneshie"},
            session={"last_kind": "count", "last_tier": "staging"},
        )
        self.assertIsNone(intent)
        self.assertIsNone(fast)


class StewardChatTests(unittest.TestCase):
    def test_typed_highlight_accra_skips_llm(self):
        from unittest.mock import patch

        from agents.llm.chat import run_steward_chat

        conn = MagicMock()
        fast = {
            "content": "Highlighting Accra on the map.",
            "ui_actions": [
                {
                    "type": "highlight_territory",
                    "label": "Accra",
                    "district": None,
                    "region": "Accra",
                    "bbox": {"west": -0.5, "south": 5.5, "east": 0.0, "north": 6.0},
                }
            ],
        }
        with patch("agents.llm.chat.try_copilot_fast_path", return_value=(MagicMock(kind="highlight"), fast)):
            resp = run_steward_chat(conn, message="highlight accra on the map", context={})
        self.assertTrue(resp.agent.get("fast_path"))
        self.assertIn("Highlighting Accra", resp.content)
        self.assertEqual(resp.ui_actions[0]["type"], "highlight_territory")


class StagingReviewTests(unittest.TestCase):
    def test_staging_summary_mock(self):
        from agents import staging_review

        conn = MagicMock()
        cur = MagicMock()
        conn.cursor.return_value.__enter__ = MagicMock(return_value=cur)
        conn.cursor.return_value.__exit__ = MagicMock(return_value=False)
        cur.fetchall.side_effect = [
            [("PENDING_FIELD", 5), ("STAGED", 2)],
            [(7,)],
            [(0,)],
            [(3,)],
        ]
        cur.fetchone.side_effect = [(7,), (0,), (3,)]
        # Re-setup - staging_summary does fetchall once then fetchone 3 times
        cur.fetchall.return_value = [("PENDING_FIELD", 5), ("STAGED", 2)]
        cur.fetchone.side_effect = [(7,), (0,), (3,)]
        result = staging_review.staging_summary(conn)
        self.assertEqual(result["pending_total"], 7)


class ApprovalAgentTests(unittest.TestCase):
    def test_approve_does_not_execute_by_default(self):
        from agents import approval_agent

        conn = MagicMock()
        with patch("agents.approval_agent.repository.decide_approval") as mock_decide, patch(
            "agents.approval_agent.proposal_agent.on_approval_decision"
        ), patch("agents.approval_agent.repository.get_topology_proposal_by_approval", return_value=None), patch(
            "agents.approval_agent.cleanup_agent.execute_cleanup"
        ) as mock_exec, patch("agents.approval_agent.log_agent_step"):
            mock_decide.return_value = {"id": "a1", "cleanup_id": "c1", "status": "approved"}
            approval_agent.approve(conn, "a1")
        mock_exec.assert_not_called()


class ProviderTests(unittest.TestCase):
    def test_workspace_header_when_configured(self):
        from agents.llm import provider

        with patch.dict(
            os.environ,
            {
                "GIOP_LLM_API_KEY": "test-key",
                "GIOP_LLM_WORKSPACE_ID": "ws-test123",
                "GIOP_LLM_BASE_URL": "https://example.com/v1",
            },
            clear=False,
        ), patch("agents.llm.provider.requests.post") as mock_post:
            mock_resp = MagicMock()
            mock_resp.status_code = 200
            mock_resp.json.return_value = {
                "choices": [{"message": {"content": "ok"}}],
                "model": "qwen-plus",
            }
            mock_post.return_value = mock_resp
            provider.complete_chat([{"role": "user", "content": "hi"}])
        headers = mock_post.call_args.kwargs["headers"]
        self.assertEqual(headers.get("X-DashScope-Workspace"), "ws-test123")


if __name__ == "__main__":
    unittest.main()
