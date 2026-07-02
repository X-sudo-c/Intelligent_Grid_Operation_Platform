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
        self.assertEqual(st["mode"], "local")
        self.assertIn("available", st)


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

    def test_show_map_to_accra_parses_pan(self):
        from agents.voice_router import parse_intent

        intent = parse_intent("show me the map to Kumasi", session={}, context={})
        self.assertIsNotNone(intent)
        assert intent is not None
        self.assertEqual(intent.kind, "pan")
        self.assertEqual(intent.district, "kumasi")

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
