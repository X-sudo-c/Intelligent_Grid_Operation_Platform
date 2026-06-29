"""Steward assistant chat with ReAct tool-calling loop."""

from __future__ import annotations

import json
from typing import Any

from agents.audit import log_agent_step
from agents.llm.react import run_tool_loop
from agents.models import AgentChatRequest, AgentChatResponse


SYSTEM_PROMPT = """You are the GIOP GIS data quality steward copilot for Ghana ECG/NEDCo.
You help stewards review field captures in **staging** before they are promoted to the national master GIS.

You are **spatially aware**: portal context may include map viewport (bbox, center, zoom),
selected_district, and selected_region. When the user says "here", "this area", or "this district",
use viewport bbox or selected_district/selected_region from context — do not guess.

Use tools to inspect staging queues, asset inventory counts (poles, transformers), territory bounds,
DQ checks, and topology. For counts always call asset_inventory_counts or staging tools before answering.

When the user asks to show, pan, zoom, highlight, or go to a place, call pan_map
(fit_district, highlight_district, fit_bounds, or fly_to) and navigate to the map tab when helpful.
Use highlight_district when they say highlight, show, or emphasize a territory on the map.

Never claim to have promoted assets or moved the map unless tools confirm it.
You cannot approve staging or publish to master — only recommend and navigate.
Be concise. Reference MRIDs, districts, regions, and counts from tool results."""


def _seed_context(conn, request: AgentChatRequest) -> list[dict[str, Any]]:
    parts: list[str] = []
    ctx = request.context or {}
    if ctx:
        parts.append(f"Portal UI context: {json.dumps(ctx, default=str)}")
        viewport = ctx.get("viewport")
        if isinstance(viewport, dict) and viewport.get("west") is not None:
            parts.append(
                "When user says 'here' or 'this view', use asset_inventory_counts with "
                f"west={viewport.get('west')}, south={viewport.get('south')}, "
                f"east={viewport.get('east')}, north={viewport.get('north')}."
            )
        if ctx.get("selected_district"):
            parts.append(
                f"Selected map district: {ctx.get('selected_district')} "
                f"(region: {ctx.get('selected_region') or 'unknown'})."
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
    req = AgentChatRequest(
        message=message,
        exception_id=exception_id,
        mrid=mrid,
        operator_id=operator_id,
        context=context or {},
    )
    messages = _seed_context(conn, req)

    if use_tools:
        result = run_tool_loop(
            conn,
            messages,
            run_id=run_id,
            agent_name="StewardCopilot",
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
    findings: list[str] = []
    actions: list[str] = []
    lower = content.lower()
    ui_actions = result.get("ui_actions") or []
    ctx = request.context or {}

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

    return AgentChatResponse(
        content=content,
        findings=findings or ["Copilot response ready."],
        actions=actions or ["Review map or Operations tab"],
        ui_actions=ui_actions,
        agent={
            "provider": "openai-compatible",
            "model": result.get("model"),
            "tools_used": result.get("tools_used") or [],
            "turns": result.get("turns", 1),
            "auto": bool(result.get("configured")),
        },
    )
