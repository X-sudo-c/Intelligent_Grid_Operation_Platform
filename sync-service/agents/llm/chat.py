"""Steward assistant chat with ReAct tool-calling loop."""

from __future__ import annotations

import json
from typing import Any

from agents.audit import log_agent_step
from agents.portal_context import (
    portal_boundary_feeder_id,
    portal_focus_mrid,
    portal_selected_territory,
    portal_spatial_bbox,
    portal_viewport_bbox,
)
from agents.llm.react import run_tool_loop
from agents.models import AgentChatRequest, AgentChatResponse
from agents.voice_router import try_copilot_fast_path


SYSTEM_PROMPT = """You are the GIOP GIS / network operations copilot for Ghana ECG/NEDCo.
You help **field and planning engineers** as well as data stewards: inventory, transformer specs,
feeders, topology, staging review, and map navigation.

Greetings: when the user first opens chat or says hello/hi, reply with a short "Hi" and offer help
with the map, transformers, feeders, and counts.

Audience: engineers. Prefer precise technical answers — MRIDs, feeder IDs, kVA ratings, vector
groups, DT vs PT, validation state, and connectivity — over vague summaries. When a tool returns
rated_power_kva / vector_group / transformer_kind, include those figures. Cite tool results only;
never invent ratings or counts.

**Always ask when unsure.** If the place, asset type, feeder, or intent is ambiguous — or confidence
is low — ask a short clarifying question before calling tools or moving the map. Do not guess.

You are **spatially aware**: portal context always includes a map viewport (bbox, center, zoom) —
even before the user pans. When they say "here", "in view", or "on the map", use that viewport
bbox directly; never ask them to pan or zoom first for clear viewport-scoped requests.

When the user asks what you see on the map, what's on the map, what's in this view, or to
describe/summarize the current map view, call territory_network_summary with the viewport bbox
from context and answer from that inventory. Do not say you cannot see the map — you have the
live viewport bounds and can query assets in that area. "What am I looking at" (singular node)
still uses inspect_node; open scene questions use the viewport summary.

Use tools to inspect staging queues, asset inventory counts (poles, transformers), territory bounds,
list_assets_in_territory (paginated sample when user asks to show/list assets), territory_network_summary
(nodes + lines in an area), work orders in the current map view, DQ checks, topology, and overall health KPIs.
For counts always call asset_inventory_counts or territory_network_summary before answering.
Never call both asset_inventory_counts and territory_network_summary for the same place — use territory_network_summary alone for full electrical summaries.
When a tool returns formatted_summary, repeat that text verbatim without adding duplicate totals.
For "show/list assets in X" (e.g. "show me the transformers in Roman Ridge") call
list_assets_in_territory with asset_kind=transformer (or poles/nodes as asked) and
**show_on_map=false** unless they already said to highlight/pin them on the map. After listing,
ask: "Want me to highlight them on the map?" If they say yes, call list_assets_in_territory again
with the same scope and show_on_map=true (or pass a highlight follow-up). Report total and sample
rows (name, kVA, feeder) only;
When the user says "name them", "list them", "tell me about those", "describe them",
or "what are they called" after a count, call list_assets_in_territory
with the same district/region/viewport bbox — do not inspect the focused node or validation rules.
never claim you returned every asset when has_more is true. For voltage-specific poles use asset_kind
pole_11kv, pole_33kv, or pole_lv. For "all electrical assets in X" use territory_network_summary.
For open work orders on the map or in view call list_work_orders_in_view with the viewport bbox from context.
For "how healthy is the data", DQ scores, or status overviews call kpi_snapshot.
Never fabricate numbers — every count, percentage, rating, or status must come from a tool result.

Engineer follow-ups after a list: if they ask about a named transformer or "the first one", call
inspect_node with that mrid (or without mrid if they selected it on the map) and report kVA,
vector group, feeder, neighbors, and location. For feeder topology use trace_feeder; for outage
impact use trace_downstream_path; for a single hop use trace_connection_path.

When the user names a geographic place (district, region, town, or locality like Pokuase or Gbawe),
call resolve_place first to get the canonical ECG district and bbox. If confidence is low or multiple
candidates are returned, ask the user to confirm before pan_map or counts.

When the user asks to show, pan, zoom, highlight, or go to a place, call pan_map
(fit_district, highlight_district, fit_bounds, or fly_to) and navigate to the map tab when helpful.
For towns and localities (Pokuase, Dome, Gbawe) or when they say zoom into, prefer fly_to at zoom 16–17
or fit_bounds with max_zoom 17 — do not frame the whole ECG district unless they named a district or region.
Use highlight_district when they say highlight, show, or emphasize a territory on the map.
Do NOT use pan_map highlight_district for "show me the transformers in X" — that is list_assets_in_territory.

When the user asks about a specific node/asset ("tell me about this node", "the node in view",
"what am I looking at", "what connects to it", "what kVA is this transformer") call inspect_node
WITHOUT an mrid — it auto-resolves from the selected map asset or the node nearest the map center.
Only pass mrid when the user gives an explicit UUID. Add show_on_map=true if they want to see it
on the map. When inspect_node returns confirmation_needed=true, tell the user you've highlighted
your best guess on the map (amber pin) and ask them to confirm — do not state details as certain
until they agree or pick another node.

When the user asks to trace/show/highlight the connection path, line, or link from a node
(use trace_connection_path with show_on_map=true). Use the selected focus_mrid or the node
they just inspected. Do NOT use trace_feeder for that — trace_feeder is for an entire feeder.

When the user asks what's downstream, what would be affected by an outage at a node, or to
show/highlight the downstream network path, call trace_downstream_path with show_on_map=true.
Use focus_mrid from portal context or the node they just inspected. This is a directed walk
(same as the Outages tab impact estimate) — NOT trace_connection_path (1-hop) or trace_feeder
(whole feeder BFS).

When the user asks what connects to a node / "what connects to it", call trace_connection_path
with show_on_map=true (1-hop neighbors), not inspect_node alone.

When the user asks for the nearest / closest work order, call list_work_orders_in_view with the
viewport bbox and pan/show the nearest result — do not invent a work order.

When the user asks to show, highlight, or trace feeder nodes on the map, call trace_feeder with
show_on_map=true. Use focus_mrid from portal context when they say "this feeder" and boundary_feeder_id
is not explicit. Use feeder_id when they name a feeder code or locality (e.g. Mallam feeder → Mallam).

Never claim to have promoted assets or moved the map unless tools confirm it.
You cannot approve staging or publish to master — only recommend and navigate.
Be concise and technical. Reference MRIDs, feeders, kVA, districts, regions, and counts from tool results."""

def _seed_context(conn, request: AgentChatRequest) -> list[dict[str, Any]]:
    parts: list[str] = []
    ctx = request.context or {}
    if ctx:
        parts.append(f"Portal UI context: {json.dumps(ctx, default=str)}")
        viewport = ctx.get("viewport")
        bbox = portal_viewport_bbox(ctx) if isinstance(viewport, dict) else None
        if bbox is None:
            bbox = portal_spatial_bbox(conn, ctx)
        if bbox:
            parts.append(
                "When user says 'here' or 'this view', use asset_inventory_counts or "
                "territory_network_summary with "
                f"west={bbox['west']}, south={bbox['south']}, "
                f"east={bbox['east']}, north={bbox['north']}. "
                "To list assets in view use list_assets_in_territory with the same bbox. "
                "For 'what do you see on the map', 'what's on the map', or 'describe this view', "
                "call territory_network_summary with that same bbox. "
                "For work orders in view / on the map / here, call list_work_orders_in_view with "
                f"the same west={bbox['west']}, south={bbox['south']}, "
                f"east={bbox['east']}, north={bbox['north']}."
            )
        sel_d, sel_r = portal_selected_territory(ctx)
        if sel_d or sel_r:
            parts.append(
                "When user says 'this area', 'here', or 'this district', "
                f"use asset_inventory_counts or territory_network_summary with "
                f"district={sel_d!r}, region={sel_r!r}. "
                "Use list_assets_in_territory to show a sample of assets in that territory. "
                "Do not mention this territory unless the user asks about counts or staging here."
            )
        focus = portal_focus_mrid(ctx)
        if focus:
            parts.append(
                f"Selected asset MRID: {focus}. When the user says 'this node' or 'this asset', "
                "call inspect_node() with no mrid — selection is used automatically."
            )
        else:
            center = ctx.get("viewport", {}).get("center") if isinstance(ctx.get("viewport"), dict) else None
            if center:
                parts.append(
                    "No asset selected. For 'node in view' / 'what am I looking at', call "
                    "inspect_node() with no mrid — the nearest node to map center is resolved "
                    "automatically."
                )
        feeder = portal_boundary_feeder_id(ctx)
        if feeder:
            parts.append(
                f"Selected asset boundary feeder: {feeder!r} — use trace_feeder(show_on_map=true, "
                f"feeder_id={feeder!r}) when user says 'this feeder'."
            )
        elif focus:
            parts.append(
                "When user says 'this feeder', call trace_feeder with focus_mrid from context."
            )
    if request.exception_id:
        from agents import tools

        exc = tools.tool_get_exception(conn, request.exception_id)
        if exc:
            parts.append(f"Selected exception: {json.dumps(exc, default=str)}")
    if request.mrid:
        from agents import tools

        staging = tools.tool_list_staging_queue(conn, limit=500)
        is_staging = any(a["mrid"] == request.mrid for a in staging)
        tier = "staging" if is_staging else "master"
        check = tools.tool_run_asset_checks(conn, request.mrid, tier)
        parts.append(f"Asset checks ({tier}) for {request.mrid}: {json.dumps(check, default=str)}")
        if is_staging:
            review = tools.tool_review_staging_asset(conn, request.mrid)
            parts.append(f"Staging review: {json.dumps(review, default=str)}")
    seed = "\n".join(parts) if parts else "No pre-selected context."
    return [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": f"Context:\n{seed}\n\nQuestion: {request.message}"},
    ]


def run_steward_chat(
    conn,
    *,
    message: str,
    exception_id: str | None = None,
    mrid: str | None = None,
    operator_id: str | None = None,
    run_id: str | None = None,
    context: dict[str, Any] | None = None,
    use_tools: bool = True,
) -> AgentChatResponse:
    ctx = context or {}
    session: dict[str, Any] = {}
    session_id = ctx.get("voice_session_id")
    if isinstance(session_id, str) and session_id.strip():
        from agents import voice_session

        session = voice_session.load(session_id.strip())

    intent, fast = try_copilot_fast_path(
        conn,
        message,
        context=ctx,
        session=session,
        request_id=str(ctx.get("copilot_request_id") or ""),
    )
    if fast:
        ui_actions = fast.get("ui_actions") or []
        kind = intent.kind if intent else "command"
        actions: list[str] = []
        for ua in ui_actions:
            if ua.get("type") == "highlight_territory":
                actions.append(
                    f"Highlighting {ua.get('label') or ua.get('region') or ua.get('district') or 'territory'} on map"
                )
            elif ua.get("type") == "fit_bounds":
                actions.append("Panning map to area bounds")
            elif ua.get("type") == "navigate":
                actions.append(f"Navigating portal to {ua.get('tab')} tab")
        agent: dict[str, Any] = {"fast_path": True, "voice": False}
        if fast.get("structured"):
            agent["structured"] = fast["structured"]
        return AgentChatResponse(
            content=fast["content"],
            findings=[f"Fast path: {kind}"],
            actions=actions or ["Map command ready"],
            ui_actions=ui_actions,
            agent=agent,
        )

    req = AgentChatRequest(
        message=message,
        exception_id=exception_id,
        mrid=mrid,
        operator_id=operator_id,
        context=context or {},
    )
    messages = _seed_context(conn, req)

    portal_ctx = dict(req.context or {})
    if req.mrid and not portal_ctx.get("focus_mrid"):
        portal_ctx["focus_mrid"] = req.mrid
    if session.get("last_mrid"):
        portal_ctx.setdefault("last_mrid", session["last_mrid"])
        portal_ctx.setdefault("focus_mrid", portal_ctx.get("focus_mrid") or session["last_mrid"])

    if use_tools:
        result = run_tool_loop(
            conn,
            messages,
            run_id=run_id,
            agent_name="StewardCopilot",
            portal_context=portal_ctx,
            progress_request_id=str(portal_ctx.get("copilot_request_id") or ""),
        )
    else:
        from agents.llm.provider import complete_chat, llm_configured

        result = complete_chat(messages)
        result["configured"] = llm_configured()
        result["tools_used"] = []
        result["ui_actions"] = []

    log_agent_step(
        conn,
        run_id=run_id,
        agent_name="StewardCopilot",
        tool_name="chat",
        model_id=result.get("model"),
        output_summary={
            "tools_used": result.get("tools_used"),
            "ui_actions": result.get("ui_actions"),
            "turns": result.get("turns"),
            "configured": result.get("configured"),
        },
    )

    content = result.get("content") or "No response."
    if result.get("formatted_content"):
        content = str(result["formatted_content"])
    findings: list[str] = []
    actions: list[str] = []
    lower = content.lower()
    ui_actions = result.get("ui_actions") or []
    ctx = req.context or {}

    if "staging" in lower or any(
        t in (result.get("tools_used") or []) for t in ("staging_summary", "list_staging_queue")
    ):
        findings.append("Staging field-capture review discussed.")
    if "pole" in lower or "inventory" in (result.get("tools_used") or []):
        findings.append("Asset inventory / pole counts referenced.")
    if "district" in lower or "region" in lower or ctx.get("selected_district"):
        findings.append("Territory-scoped spatial query.")
    if result.get("tools_used"):
        actions.append(f"Tools invoked: {', '.join(result['tools_used'])}")
    for ua in ui_actions:
        if ua.get("type") == "navigate":
            actions.append(f"Navigating portal to {ua.get('tab')} tab")
        elif ua.get("type") == "fit_bounds":
            actions.append(f"Panning map to {ua.get('district') or 'area bounds'}")
        elif ua.get("type") == "highlight_territory":
            actions.append(
                f"Highlighting {ua.get('label') or ua.get('district') or ua.get('region') or 'territory'} on map"
            )
        elif ua.get("type") == "fly_to":
            actions.append("Flying map to coordinates")

    agent_payload: dict[str, Any] = {
        "provider": "openai-compatible",
        "model": result.get("model"),
        "tools_used": result.get("tools_used") or [],
        "turns": result.get("turns", 1),
        "auto": bool(result.get("configured")),
    }
    if result.get("structured"):
        agent_payload["structured"] = result["structured"]
    if portal_ctx.get("copilot_request_id"):
        agent_payload["request_id"] = portal_ctx["copilot_request_id"]

    return AgentChatResponse(
        content=content,
        findings=findings or ["Copilot response ready."],
        actions=actions or ["Review map or Operations tab"],
        ui_actions=ui_actions,
        agent=agent_payload,
    )
