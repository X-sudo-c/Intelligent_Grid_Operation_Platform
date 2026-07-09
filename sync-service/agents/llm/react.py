"""ReAct tool-calling loop for steward and orchestrator agents."""

from __future__ import annotations

import json
import os
import uuid
from typing import Any, Callable

from agents import graph_tools
from agents import proposal_agent
from agents import spatial_tools
from agents import tools
from agents.audit import log_agent_step
from agents.cleanup_agent import generate_cleanup_plan
from agents.llm.provider import LlmProfileName, complete_chat, get_llm_profile

MAX_TOOL_TURNS = get_llm_profile("copilot").max_tool_turns

PORTAL_TABS = frozenset(
    {
        "operations",
        "map",
        "topology",
        "combined",
        "data-quality",
        "exports",
        "migration",
        "ocr",
        "insights",
        "schematic",
        "dlq",
        "audit",
        "cases",
        "tickets",
        "work-orders",
        "outages",
        "reports",
    }
)


def _tool_schemas() -> list[dict[str, Any]]:
    return [
        {
            "type": "function",
            "function": {
                "name": "list_exceptions",
                "description": "List open data quality exceptions, optionally filtered by domain or severity.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "domain": {"type": "string", "description": "Rule domain e.g. topology, spatial, customer"},
                        "severity": {"type": "string", "description": "critical, major, minor, warning"},
                        "limit": {"type": "integer", "default": 20},
                    },
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "get_exception",
                "description": "Fetch one exception by UUID id.",
                "parameters": {
                    "type": "object",
                    "properties": {"exception_id": {"type": "string"}},
                    "required": ["exception_id"],
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "run_asset_checks",
                "description": "Run all enabled DQ rules for a connectivity node MRID.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "mrid": {"type": "string"},
                        "tier": {"type": "string", "enum": ["master", "staging"], "default": "master"},
                    },
                    "required": ["mrid"],
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "inspect_node",
                "description": (
                    "Describe ONE connectivity node (grid node): name, lifecycle/validation, "
                    "feeder, location, district, connections. For transformers also returns "
                    "rated_power_kva, vector_group, transformer_kind, manufacturer, model, serial, "
                    "and year when present in CIM. Call WITHOUT mrid when the user says 'this node', "
                    "'the node in view', or 'what am I looking at' — it auto-resolves from the "
                    "selected map asset or the node nearest map center. Only pass mrid when the "
                    "user gives a specific UUID. When confirmation_needed is true, the map shows "
                    "an amber highlight — ask the user to confirm. Use show_on_map=true to fly to "
                    "and highlight the node."
                ),
                "parameters": {
                    "type": "object",
                    "properties": {
                        "mrid": {
                            "type": "string",
                            "description": "Optional UUID. Omit for 'this node' / 'node in view'.",
                        },
                        "tier": {
                            "type": "string",
                            "enum": ["master", "staging"],
                            "default": "master",
                        },
                        "show_on_map": {
                            "type": "boolean",
                            "description": "Fly the map camera to the node",
                            "default": False,
                        },
                    },
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "list_work_orders_in_view",
                "description": (
                    "List open work orders visible in the current map viewport (bbox). "
                    "Use when the user asks about work orders here, in view, on the map, "
                    "or in the current area. Pass west/south/east/north from portal viewport "
                    "context. Returns reference, summary, status, priority, assignee, and location."
                ),
                "parameters": {
                    "type": "object",
                    "properties": {
                        "west": {"type": "number", "description": "Map bbox west longitude"},
                        "south": {"type": "number", "description": "Map bbox south latitude"},
                        "east": {"type": "number", "description": "Map bbox east longitude"},
                        "north": {"type": "number", "description": "Map bbox north latitude"},
                        "status": {
                            "type": "string",
                            "description": "Optional status filter e.g. DISPATCHED, IN_PROGRESS",
                        },
                        "open_only": {
                            "type": "boolean",
                            "description": "Exclude completed/cancelled (default true)",
                            "default": True,
                        },
                        "limit": {"type": "integer", "default": 50},
                    },
                    "required": ["west", "south", "east", "north"],
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "dq_summary",
                "description": "Summary counts of open exceptions by severity and domain.",
                "parameters": {"type": "object", "properties": {}},
            },
        },
        {
            "type": "function",
            "function": {
                "name": "list_rules",
                "description": "List configured data quality rules.",
                "parameters": {"type": "object", "properties": {}},
            },
        },
        {
            "type": "function",
            "function": {
                "name": "topology_health",
                "description": "NetworkX topology health report (components, orphans, graph size).",
                "parameters": {"type": "object", "properties": {}},
            },
        },
        {
            "type": "function",
            "function": {
                "name": "topology_dq_summary",
                "description": "Live topology DQ metrics from Postgres.",
                "parameters": {"type": "object", "properties": {}},
            },
        },
        {
            "type": "function",
            "function": {
                "name": "detect_cycles",
                "description": "Detect network loops using NetworkX cycle basis.",
                "parameters": {"type": "object", "properties": {}},
            },
        },
        {
            "type": "function",
            "function": {
                "name": "detect_islands",
                "description": "Detect small disconnected island components in the network graph.",
                "parameters": {"type": "object", "properties": {}},
            },
        },
        {
            "type": "function",
            "function": {
                "name": "trace_connection_path",
                "description": (
                    "Highlight the line segments directly connected to one node "
                    "(1-hop neighbors). Use when the user asks to trace/show the "
                    "connection path, line, or link from the selected node or the "
                    "node they just inspected — NOT for whole-feeder traces."
                ),
                "parameters": {
                    "type": "object",
                    "properties": {
                        "mrid": {
                            "type": "string",
                            "description": "Optional node UUID. Omit to use selection or last inspected node.",
                        },
                        "show_on_map": {
                            "type": "boolean",
                            "default": True,
                        },
                    },
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "trace_downstream_path",
                "description": (
                    "Directed downstream network walk from a seed node — all nodes and lines "
                    "reachable downstream on the feeder graph (same as outage impact estimate). "
                    "Use when the user asks what's downstream, what would be affected, or to "
                    "show/highlight/map the downstream path from the selected or named node. "
                    "NOT for 1-hop neighbors (trace_connection_path) or whole-feeder BFS (trace_feeder)."
                ),
                "parameters": {
                    "type": "object",
                    "properties": {
                        "mrid": {
                            "type": "string",
                            "description": "Optional seed node UUID. Omit to use selection or last inspected node.",
                        },
                        "show_on_map": {
                            "type": "boolean",
                            "default": True,
                        },
                        "max_nodes": {
                            "type": "integer",
                            "default": 5000,
                            "description": "Cap on nodes returned (max 20000).",
                        },
                    },
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "trace_feeder",
                "description": (
                    "Trace ALL reachable nodes on a boundary feeder (BFS). "
                    "Use show_on_map=true when the user asks to show, highlight, or display "
                    "feeder nodes on the map. Pass focus_mrid when they say 'this feeder' "
                    "and portal context includes a selected asset. "
                    "Do NOT use for 'trace the connection path' from one node — use trace_connection_path."
                ),
                "parameters": {
                    "type": "object",
                    "properties": {
                        "feeder_id": {
                            "type": "string",
                            "description": "boundary_feeder_id or spoken name e.g. FEEDER-ECG-MALLAM-04 or Mallam",
                        },
                        "focus_mrid": {
                            "type": "string",
                            "description": "Selected asset MRID — resolves feeder when feeder_id omitted",
                        },
                        "show_on_map": {
                            "type": "boolean",
                            "description": "Emit highlight_feeder map overlay + fit bounds",
                            "default": False,
                        },
                        "max_hops": {"type": "integer", "default": 500},
                    },
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "propose_cleanup",
                "description": "Generate a read-only cleanup plan for an exception (does not execute or mutate).",
                "parameters": {
                    "type": "object",
                    "properties": {"exception_id": {"type": "string"}},
                    "required": ["exception_id"],
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "propose_topology_edit",
                "description": (
                    "Generate a topology repair proposal with dry-run preview. "
                    "Queues for human approval; does not write to master."
                ),
                "parameters": {
                    "type": "object",
                    "properties": {"exception_id": {"type": "string"}},
                    "required": ["exception_id"],
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "staging_summary",
                "description": "Counts of field captures in staging by validation state.",
                "parameters": {"type": "object", "properties": {}},
            },
        },
        {
            "type": "function",
            "function": {
                "name": "staging_territory_counts",
                "description": (
                    "Staging asset counts grouped by ECG region or district "
                    "(field captures awaiting review)."
                ),
                "parameters": {
                    "type": "object",
                    "properties": {
                        "group_by": {
                            "type": "string",
                            "enum": ["region", "district"],
                            "default": "district",
                        },
                        "region": {"type": "string", "description": "Filter to one region name"},
                        "limit": {"type": "integer", "default": 30},
                    },
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "list_staging_queue",
                "description": "List pending field captures in staging, optionally filtered by territory.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "validation": {
                            "type": "string",
                            "description": "PENDING_FIELD, STAGED, IN_CONFLICT",
                        },
                        "region": {"type": "string"},
                        "district": {"type": "string"},
                        "submitted_by": {"type": "string"},
                        "limit": {"type": "integer", "default": 25},
                    },
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "review_staging_asset",
                "description": (
                    "Run staging DQ checks and return promote recommendation "
                    "(does not approve or write master)."
                ),
                "parameters": {
                    "type": "object",
                    "properties": {"mrid": {"type": "string"}},
                    "required": ["mrid"],
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "navigate_portal",
                "description": (
                    "Request the steward portal to switch tab and optionally focus an asset. "
                    "Use when directing the user to Operations, Map, Exports, etc."
                ),
                "parameters": {
                    "type": "object",
                    "properties": {
                        "tab": {
                            "type": "string",
                            "description": "Portal tab id e.g. operations, map, exports, data-quality",
                        },
                        "focus_mrid": {"type": "string"},
                        "region": {"type": "string", "description": "Hint for map filter context"},
                        "district": {"type": "string"},
                    },
                    "required": ["tab"],
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "resolve_place",
                "description": (
                    "Resolve a Ghana locality or district name (e.g. Pokuase, Gbawe, Accra, "
                    "Ashanti region) to ECG district, region, bbox, and centroid. "
                    "Always call this before pan_map or asset_inventory_counts when the user "
                    "names a place that may be a town or informal locality, not only an ECG district."
                ),
                "parameters": {
                    "type": "object",
                    "properties": {
                        "query": {
                            "type": "string",
                            "description": "Place name spoken or typed by the user",
                        },
                    },
                    "required": ["query"],
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "resolve_territory",
                "description": (
                    "Resolve ECG district or region name to map bbox and centroid "
                    "(from gis.ecg_admin_boundaries)."
                ),
                "parameters": {
                    "type": "object",
                    "properties": {
                        "district": {"type": "string"},
                        "region": {"type": "string"},
                    },
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "asset_inventory_counts",
                "description": (
                    "Count point assets on master or staging by kind "
                    "(pole, pole_11kv, pole_33kv, pole_lv, transformer, connectivity_node), "
                    "filtered by district, region, or map bbox. Use for 'how many 11kV poles in X'."
                ),
                "parameters": {
                    "type": "object",
                    "properties": {
                        "tier": {"type": "string", "enum": ["master", "staging"], "default": "master"},
                        "asset_kind": {
                            "type": "string",
                            "description": (
                                "pole, pole_11kv, pole_33kv, pole_lv, transformer, "
                                "distribution_transformer, connectivity_node, etc."
                            ),
                        },
                        "district": {"type": "string"},
                        "region": {"type": "string"},
                        "west": {"type": "number"},
                        "south": {"type": "number"},
                        "east": {"type": "number"},
                        "north": {"type": "number"},
                    },
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "list_assets_in_territory",
                "description": (
                    "List a paginated sample of point assets in a district, region, or bbox. "
                    "Always returns total count plus up to limit rows (default 25, max 100). "
                    "Each row includes lon/lat; transformers also include rated_power_kva, "
                    "vector_group, and transformer_kind when known. "
                    "By default show_on_map=false — list first, then ask if they want "
                    "highlights; set show_on_map=true only when they confirm or already "
                    "asked to highlight/pin on the map. "
                    "Use when the user asks to show, list, name, or highlight assets (e.g. transformers) in an area. "
                    "Never claim you listed every row when has_more is true."
                ),
                "parameters": {
                    "type": "object",
                    "properties": {
                        "tier": {"type": "string", "enum": ["master", "staging"], "default": "master"},
                        "asset_kind": {
                            "type": "string",
                            "description": "Same kinds as asset_inventory_counts.",
                        },
                        "district": {"type": "string"},
                        "region": {"type": "string"},
                        "west": {"type": "number"},
                        "south": {"type": "number"},
                        "east": {"type": "number"},
                        "north": {"type": "number"},
                        "limit": {"type": "integer", "description": "Max rows (default 25, max 100)."},
                        "offset": {"type": "integer", "description": "Pagination offset."},
                        "include_geom": {
                            "type": "boolean",
                            "description": "Include full GeoJSON geometry (heavier; lon/lat already returned).",
                        },
                        "show_on_map": {
                            "type": "boolean",
                            "description": (
                                "Highlight listed assets on the map. Default false — ask first "
                                "unless the user already requested a highlight."
                            ),
                            "default": False,
                        },
                    },
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "territory_network_summary",
                "description": (
                    "Summary of all electrical assets in a territory: connectivity nodes by kind "
                    "plus ac_line_segments by nominal voltage. Use for 'all electrical assets in X' "
                    "or combined node+line counts."
                ),
                "parameters": {
                    "type": "object",
                    "properties": {
                        "tier": {"type": "string", "enum": ["master", "staging"], "default": "master"},
                        "district": {"type": "string"},
                        "region": {"type": "string"},
                        "west": {"type": "number"},
                        "south": {"type": "number"},
                        "east": {"type": "number"},
                        "north": {"type": "number"},
                    },
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "pan_map",
                "description": (
                    "Move the steward map camera: fly to point, fit district bounds, highlight district, "
                    "or fit bbox. For towns/localities use fly_to (zoom 16–17) or fit_bounds with tight bbox. "
                    "Use fit_district only for whole districts/regions. Returns a UI action."
                ),
                "parameters": {
                    "type": "object",
                    "properties": {
                        "action": {
                            "type": "string",
                            "enum": ["fit_district", "highlight_district", "fit_bounds", "fly_to"],
                        },
                        "district": {"type": "string"},
                        "region": {"type": "string"},
                        "place": {
                            "type": "string",
                            "description": (
                                "Town or locality (e.g. Pokuase, Gbawe) — auto-resolved to ECG district"
                            ),
                        },
                        "lon": {"type": "number"},
                        "lat": {"type": "number"},
                        "zoom": {"type": "number"},
                        "west": {"type": "number"},
                        "south": {"type": "number"},
                        "east": {"type": "number"},
                        "north": {"type": "number"},
                        "tab": {
                            "type": "string",
                            "description": "Portal tab to show map on (default map)",
                        },
                    },
                    "required": ["action"],
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "queue_cim_export",
                "description": (
                    "Queue a CIM JSON export job for reviewed master data (Ghana clip by default). "
                    "Does not export staging directly."
                ),
                "parameters": {
                    "type": "object",
                    "properties": {
                        "operator_id": {"type": "string"},
                        "exclude_dq_blocked": {"type": "boolean", "default": True},
                    },
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "repair_topology_dry_run",
                "description": "Dry-run topology repair for a target MRID (no mutation).",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "target_mrid": {"type": "string"},
                        "radius_meters": {"type": "number", "default": 50},
                    },
                    "required": ["target_mrid"],
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "preview_geom_snap_candidate",
                "description": (
                    "Preview geometry-based endpoint cleanup for one unpromoted GIS conductor segment: "
                    "text IDs, nearest poles, distances, and Tier A/B/C classification."
                ),
                "parameters": {
                    "type": "object",
                    "properties": {
                        "segment_id": {"type": "integer"},
                        "tolerance_m": {"type": "number", "default": 5.0},
                        "assisted_m": {"type": "number", "default": 15.0},
                    },
                    "required": ["segment_id"],
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "scan_district_geom_cleanup",
                "description": (
                    "Scan unpromoted GIS conductor segments in an ECG district and classify them "
                    "by geometry-distance cleanup tier (Tier A auto, Tier B assisted, Tier C manual)."
                ),
                "parameters": {
                    "type": "object",
                    "properties": {
                        "district": {"type": "string"},
                        "tolerance_m": {"type": "number", "default": 5.0},
                        "assisted_m": {"type": "number", "default": 15.0},
                        "sample_limit": {"type": "integer", "default": 5},
                    },
                    "required": ["district"],
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "propose_district_geom_cleanup",
                "description": (
                    "Propose a district-wide GIS geometry cleanup plan (infer IDs → snap → promote). "
                    "Queues for steward approval; does not mutate data."
                ),
                "parameters": {
                    "type": "object",
                    "properties": {
                        "district": {"type": "string"},
                        "tolerance_m": {"type": "number", "default": 5.0},
                        "assisted_m": {"type": "number", "default": 15.0},
                    },
                    "required": ["district"],
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "generate_endpoint_fix_proposals",
                "description": (
                    "Scan unpromoted GIS conductors in a district and queue steward-reviewed "
                    "from/to pole ID proposals from geometry (nearest pole). No DB writes until apply."
                ),
                "parameters": {
                    "type": "object",
                    "properties": {
                        "district": {"type": "string"},
                        "tolerance_m": {"type": "number", "default": 5.0},
                        "assisted_m": {"type": "number", "default": 15.0},
                        "limit": {"type": "integer", "default": 5000},
                        "include_tier_b": {"type": "boolean", "default": True},
                        "replace_pending": {"type": "boolean", "default": False},
                    },
                    "required": ["district"],
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "list_endpoint_fix_proposals",
                "description": "List pending/approved GIS endpoint fix proposals for steward review.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "district": {"type": "string"},
                        "status": {"type": "string", "default": "pending"},
                        "tier": {"type": "string"},
                        "limit": {"type": "integer", "default": 25},
                    },
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "apply_endpoint_fix_proposals",
                "description": (
                    "Apply approved endpoint fix proposals — writes from/to IDs on gis.conductor_segments. "
                    "Does not promote to master."
                ),
                "parameters": {
                    "type": "object",
                    "properties": {
                        "district": {"type": "string"},
                        "proposal_ids": {
                            "type": "array",
                            "items": {"type": "string"},
                        },
                        "operator_id": {"type": "string"},
                    },
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "ai_scan_endpoint_fix_proposals",
                "description": (
                    "Run cleanup LLM steward review on pending endpoint fix proposals. "
                    "Returns AI thoughts, transcript, and per-row rationale (no DB writes except AI metadata)."
                ),
                "parameters": {
                    "type": "object",
                    "properties": {
                        "district": {"type": "string"},
                        "batch_id": {"type": "string"},
                        "limit": {"type": "integer", "default": 10},
                        "mode": {
                            "type": "string",
                            "enum": ["agent", "batch", "tiered"],
                            "default": "tiered",
                        },
                        "reasoning_depth": {
                            "type": "string",
                            "enum": ["quick", "deep"],
                            "default": "quick",
                        },
                    },
                    "required": ["district"],
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "execute_geom_cleanup_proposal",
                "description": (
                    "Execute an approved district geometry cleanup proposal. "
                    "Runs Tier A infer, snap, and district-scoped promote."
                ),
                "parameters": {
                    "type": "object",
                    "properties": {
                        "cleanup_id": {"type": "string"},
                        "force": {"type": "boolean", "default": False},
                    },
                    "required": ["cleanup_id"],
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "kpi_snapshot",
                "description": (
                    "Overall data quality health KPIs: topology validity %, completeness %, "
                    "open critical exceptions, pending approvals, export-blocked status. "
                    "Use for 'how healthy is the data', 'what's our DQ score', or status overviews."
                ),
                "parameters": {"type": "object", "properties": {}},
            },
        },
        {
            "type": "function",
            "function": {
                "name": "topology_batch_scan",
                "description": (
                    "Run a topology DQ batch scan over master data and return fresh metrics. "
                    "Heavier than topology_dq_summary — only use when the user explicitly asks "
                    "to re-scan or refresh topology checks."
                ),
                "parameters": {"type": "object", "properties": {}},
            },
        },
    ]


def tool_names() -> list[str]:
    """Names of every tool the steward copilot can call (for status/introspection)."""
    return [s["function"]["name"] for s in _tool_schemas()]


def _execute_tool(
    conn,
    name: str,
    arguments: dict[str, Any],
    *,
    run_id: str | None = None,
    agent_name: str = "StewardAssistant",
    portal_context: dict[str, Any] | None = None,
) -> Any:
    if name == "list_exceptions":
        return tools.tool_list_exceptions(
            conn,
            domain=arguments.get("domain"),
            severity=arguments.get("severity"),
            limit=int(arguments.get("limit") or 20),
        )
    if name == "get_exception":
        return tools.tool_get_exception(conn, arguments["exception_id"])
    if name == "run_asset_checks":
        return tools.tool_run_asset_checks(
            conn, arguments["mrid"], arguments.get("tier") or "master"
        )
    if name == "inspect_node":
        return tools.tool_inspect_node(
            conn,
            arguments.get("mrid"),
            context=portal_context,
            tier=arguments.get("tier") or "master",
            show_on_map=bool(arguments.get("show_on_map", False)),
        )
    if name == "list_work_orders_in_view":
        return tools.tool_list_work_orders_in_view(
            conn,
            west=float(arguments["west"]),
            south=float(arguments["south"]),
            east=float(arguments["east"]),
            north=float(arguments["north"]),
            status=arguments.get("status"),
            open_only=bool(arguments.get("open_only", True)),
            limit=int(arguments.get("limit") or 50),
        )
    if name == "dq_summary":
        return tools.tool_dq_summary(conn)
    if name == "list_rules":
        return tools.tool_list_rules(conn)
    if name == "topology_health":
        return tools.tool_topology_health()
    if name == "topology_dq_summary":
        return tools.tool_topology_dq_summary(conn)
    if name == "detect_cycles":
        return graph_tools.detect_cycles()
    if name == "detect_islands":
        return graph_tools.detect_islands()
    if name == "trace_connection_path":
        portal_ctx = dict(portal_context or {})
        if arguments.get("mrid"):
            portal_ctx["focus_mrid"] = arguments["mrid"]
        elif portal_ctx.get("last_mrid"):
            portal_ctx.setdefault("focus_mrid", portal_ctx["last_mrid"])
        return graph_tools.trace_connection_path(
            conn,
            mrid=arguments.get("mrid"),
            context=portal_ctx,
            show_on_map=bool(arguments.get("show_on_map", True)),
        )
    if name == "trace_downstream_path":
        portal_ctx = dict(portal_context or {})
        if arguments.get("mrid"):
            portal_ctx["focus_mrid"] = arguments["mrid"]
        elif portal_ctx.get("last_mrid"):
            portal_ctx.setdefault("focus_mrid", portal_ctx["last_mrid"])
        return graph_tools.trace_downstream_path(
            conn,
            mrid=arguments.get("mrid"),
            context=portal_ctx,
            max_nodes=int(arguments.get("max_nodes") or 5000),
            show_on_map=bool(arguments.get("show_on_map", True)),
        )
    if name == "trace_feeder":
        feeder_arg = (arguments.get("feeder_id") or "").strip() or None
        focus_mrid = arguments.get("focus_mrid")
        if feeder_arg and not focus_mrid:
            resolved = graph_tools.resolve_feeder_query(conn, feeder_arg)
            if resolved.get("feeder_id"):
                feeder_arg = str(resolved["feeder_id"])
            elif resolved.get("candidates") and not resolved.get("feeder_id"):
                return resolved
        return graph_tools.trace_feeder(
            feeder_arg,
            conn=conn,
            focus_mrid=focus_mrid,
            show_on_map=bool(arguments.get("show_on_map", False)),
            max_hops=int(arguments.get("max_hops") or 500),
        )
    if name == "propose_cleanup":
        plan = generate_cleanup_plan(conn, arguments["exception_id"])
        return plan.model_dump()
    if name == "propose_topology_edit":
        return proposal_agent.generate_topology_proposal(
            conn,
            arguments["exception_id"],
            run_id=run_id,
            proposed_by=agent_name,
        )
    if name == "repair_topology_dry_run":
        return tools.tool_repair_topology(
            conn,
            arguments["target_mrid"],
            radius_meters=float(arguments.get("radius_meters") or 50),
            dry_run=True,
        )
    if name == "staging_summary":
        return tools.tool_staging_summary(conn)
    if name == "staging_territory_counts":
        return tools.tool_staging_territory_totals(
            conn,
            group_by=arguments.get("group_by") or "district",
            region=arguments.get("region"),
            limit=int(arguments.get("limit") or 30),
        )
    if name == "list_staging_queue":
        return tools.tool_list_staging_queue(
            conn,
            validation=arguments.get("validation"),
            region=arguments.get("region"),
            district=arguments.get("district"),
            submitted_by=arguments.get("submitted_by"),
            limit=int(arguments.get("limit") or 25),
        )
    if name == "review_staging_asset":
        return tools.tool_review_staging_asset(conn, arguments["mrid"])
    if name == "kpi_snapshot":
        from agents import kpi

        return kpi.compute_kpis(conn)
    if name == "preview_geom_snap_candidate":
        from geometry_cleanup import preview_geom_snap_candidate

        return preview_geom_snap_candidate(
            conn,
            int(arguments["segment_id"]),
            tolerance_m=float(arguments.get("tolerance_m") or 5.0),
            assisted_m=float(arguments.get("assisted_m") or 15.0),
        )
    if name == "scan_district_geom_cleanup":
        from geometry_cleanup import scan_district_geom_cleanup

        return scan_district_geom_cleanup(
            conn,
            arguments["district"],
            tolerance_m=float(arguments.get("tolerance_m") or 5.0),
            assisted_m=float(arguments.get("assisted_m") or 15.0),
            sample_limit=int(arguments.get("sample_limit") or 5),
        )
    if name == "propose_district_geom_cleanup":
        from geometry_cleanup import propose_district_geom_cleanup

        return propose_district_geom_cleanup(
            conn,
            arguments["district"],
            tolerance_m=float(arguments.get("tolerance_m") or 5.0),
            assisted_m=float(arguments.get("assisted_m") or 15.0),
            run_id=run_id,
            operator_id=agent_name,
        )
    if name == "execute_geom_cleanup_proposal":
        from geometry_cleanup import execute_geom_cleanup_proposal

        return execute_geom_cleanup_proposal(
            conn,
            arguments["cleanup_id"],
            operator_id=agent_name,
            force=bool(arguments.get("force", False)),
        )
    if name == "generate_endpoint_fix_proposals":
        from endpoint_proposals import generate_endpoint_fix_proposals

        return generate_endpoint_fix_proposals(
            conn,
            arguments["district"],
            tolerance_m=float(arguments.get("tolerance_m") or 5.0),
            assisted_m=float(arguments.get("assisted_m") or 15.0),
            limit=int(arguments.get("limit") or 5000),
            include_tier_b=bool(arguments.get("include_tier_b", True)),
            replace_pending=bool(arguments.get("replace_pending", False)),
        )
    if name == "list_endpoint_fix_proposals":
        from endpoint_proposals import list_endpoint_fix_proposals

        return list_endpoint_fix_proposals(
            conn,
            district=arguments.get("district"),
            status=arguments.get("status") or "pending",
            tier=arguments.get("tier"),
            limit=int(arguments.get("limit") or 25),
        )
    if name == "apply_endpoint_fix_proposals":
        from endpoint_proposals import apply_endpoint_fix_proposals

        return apply_endpoint_fix_proposals(
            conn,
            proposal_ids=arguments.get("proposal_ids"),
            district=arguments.get("district"),
            operator_id=arguments.get("operator_id") or agent_name,
        )
    if name == "ai_scan_endpoint_fix_proposals":
        from endpoint_proposals_ai import ai_scan_endpoint_fix_proposals

        return ai_scan_endpoint_fix_proposals(
            conn,
            arguments["district"],
            batch_id=arguments.get("batch_id"),
            limit=int(arguments.get("limit") or 10),
            mode=str(arguments.get("mode") or "tiered"),
            reasoning_depth=str(arguments.get("reasoning_depth") or "quick"),
        )
    if name == "topology_batch_scan":
        return tools.tool_topology_batch_scan(conn, requested_by=agent_name)
    if name == "resolve_place":
        return spatial_tools.tool_resolve_place(
            conn,
            query=arguments["query"],
            allow_geocode=arguments.get("allow_geocode"),
        )
    if name == "resolve_territory":
        return spatial_tools.tool_resolve_territory(
            conn,
            district=arguments.get("district"),
            region=arguments.get("region"),
        )
    if name == "asset_inventory_counts":
        return spatial_tools.tool_asset_inventory_counts(
            conn,
            tier=arguments.get("tier") or "master",
            asset_kind=arguments.get("asset_kind"),
            district=arguments.get("district"),
            region=arguments.get("region"),
            west=arguments.get("west"),
            south=arguments.get("south"),
            east=arguments.get("east"),
            north=arguments.get("north"),
        )
    if name == "list_assets_in_territory":
        show_on_map = arguments.get("show_on_map")
        if show_on_map is None:
            show_on_map = False
        return spatial_tools.tool_list_assets_in_territory(
            conn,
            tier=arguments.get("tier") or "master",
            asset_kind=arguments.get("asset_kind"),
            district=arguments.get("district"),
            region=arguments.get("region"),
            west=arguments.get("west"),
            south=arguments.get("south"),
            east=arguments.get("east"),
            north=arguments.get("north"),
            limit=int(arguments.get("limit") or 25),
            offset=int(arguments.get("offset") or 0),
            include_geom=bool(arguments.get("include_geom")),
            show_on_map=bool(show_on_map),
        )
    if name == "territory_network_summary":
        return spatial_tools.tool_territory_network_summary(
            conn,
            tier=arguments.get("tier") or "master",
            district=arguments.get("district"),
            region=arguments.get("region"),
            west=arguments.get("west"),
            south=arguments.get("south"),
            east=arguments.get("east"),
            north=arguments.get("north"),
        )
    if name == "pan_map":
        action = (arguments.get("action") or "").strip().lower()
        tab = (arguments.get("tab") or "map").strip().lower()
        if tab not in PORTAL_TABS:
            tab = "map"
        ui: dict[str, Any] = {"type": "navigate", "tab": tab}

        district = arguments.get("district")
        region = arguments.get("region")
        place_query = (arguments.get("place") or "").strip()
        if place_query and not district and not region:
            from agents.place_resolve import place_viewport_ui_action, resolve_place

            try:
                resolved = resolve_place(conn, place_query)
                district = resolved.get("district") or district
                region = resolved.get("region") or region
                arguments = {**arguments, "district": district, "region": region}
                if action in ("fit_district", "highlight_district", "fit_bounds", "fly_to"):
                    local_ui = place_viewport_ui_action(
                        resolved,
                        mode="zoom" if float(arguments.get("zoom") or 0) >= 15 else "pan",
                        tab=tab,
                    )
                    if local_ui and resolved.get("source") in (
                        "osm",
                        "alias_exact",
                        "alias_fuzzy",
                    ):
                        if action == "highlight_district" and district:
                            pass  # fall through to highlight_district below
                        else:
                            return {"ok": True, "resolved": resolved, "ui_action": local_ui}
            except ValueError:
                pass

        if action == "fit_district":
            from agents import spatial

            terr = spatial.resolve_territory(
                conn,
                district=district,
                region=region,
            )
            ui = {
                "type": "fit_bounds",
                "tab": tab,
                "bbox": terr["bbox"],
                "district": terr.get("district"),
                "region": terr.get("region"),
            }
            return {"ok": True, "territory": terr, "ui_action": ui}
        if action == "highlight_district":
            from agents import spatial

            terr = spatial.resolve_territory(
                conn,
                district=district,
                region=region,
            )
            geojson = spatial.territory_geojson(
                conn,
                district=district,
                region=region,
            )
            label = district or region or terr.get("district") or terr.get("region") or "Territory"
            ui = {
                "type": "highlight_territory",
                "tab": tab,
                "bbox": terr["bbox"],
                "district": terr.get("district"),
                "region": terr.get("region"),
                "label": label,
                "geojson": geojson,
            }
            return {"ok": True, "territory": terr, "ui_action": ui}
        if action == "fit_bounds":
            bbox = {
                "west": float(arguments["west"]),
                "south": float(arguments["south"]),
                "east": float(arguments["east"]),
                "north": float(arguments["north"]),
            }
            ui = {"type": "fit_bounds", "tab": tab, "bbox": bbox}
            if arguments.get("max_zoom") is not None:
                ui["max_zoom"] = float(arguments["max_zoom"])
            return {"ok": True, "ui_action": ui}
        if action == "fly_to":
            ui = {
                "type": "fly_to",
                "tab": tab,
                "center": {
                    "lon": float(arguments["lon"]),
                    "lat": float(arguments["lat"]),
                },
                "zoom": float(arguments.get("zoom") or 16.5),
            }
            return {"ok": True, "ui_action": ui}
        return {"error": f"Unknown pan_map action {action!r}"}
    if name == "navigate_portal":
        tab = (arguments.get("tab") or "").strip().lower()
        if tab not in PORTAL_TABS:
            return {"error": f"Unknown tab {tab!r}", "valid_tabs": sorted(PORTAL_TABS)}
        action: dict[str, Any] = {"type": "navigate", "tab": tab}
        if arguments.get("focus_mrid"):
            action["focus_mrid"] = arguments["focus_mrid"]
        if arguments.get("region"):
            action["region"] = arguments["region"]
        if arguments.get("district"):
            action["district"] = arguments["district"]
        return {"ok": True, "ui_action": action}
    if name == "queue_cim_export":
        from cim_export import create_export_job

        clip = {"west": -3.5, "south": 4.5, "east": 1.5, "north": 8.5}
        job = create_export_job(
            conn,
            layers=["connectivity_nodes", "line_segments"],
            clip=clip,
            exclude_dq_blocked=bool(arguments.get("exclude_dq_blocked", True)),
            requested_by=arguments.get("operator_id") or agent_name,
        )
        return {
            "job": job,
            "ui_action": {"type": "navigate", "tab": "exports"},
            "note": "Export job queued; open Exports tab to download when complete.",
        }
    return {"error": f"Unknown tool: {name}"}


def run_tool_loop(
    conn,
    messages: list[dict[str, Any]],
    *,
    run_id: str | None = None,
    agent_name: str = "StewardAssistant",
    max_turns: int | None = None,
    tool_filter: Callable[[str], bool] | None = None,
    portal_context: dict[str, Any] | None = None,
    llm_profile: LlmProfileName = "copilot",
    model: str | None = None,
    progress_request_id: str | None = None,
) -> dict[str, Any]:
    """Multi-turn OpenAI-compatible tool loop until final assistant message."""
    from agents.copilot_progress import push_progress, tool_progress

    cfg = get_llm_profile(llm_profile)
    if max_turns is None:
        max_turns = cfg.max_tool_turns

    schemas = _tool_schemas()
    if tool_filter:
        schemas = [s for s in schemas if tool_filter(s["function"]["name"])]

    tools_used: list[str] = []
    ui_actions: list[dict[str, Any]] = []
    model = model or cfg.model
    last_content = ""
    turn = 0
    had_tool_calls = False
    last_formatted_content: str | None = None
    last_structured: dict[str, Any] | None = None

    push_progress(progress_request_id, "Planning next steps")

    for turn in range(max_turns):
        push_progress(progress_request_id, "Thinking")
        result = complete_chat(
            messages,
            tools=schemas if schemas else None,
            model=model,
            profile=llm_profile,
        )
        model = result.get("model") or model
        raw = result.get("raw") or {}
        tool_calls = raw.get("tool_calls") or []

        if not tool_calls:
            last_content = result.get("content") or last_content
            break

        had_tool_calls = True

        assistant_msg: dict[str, Any] = {
            "role": "assistant",
            "content": raw.get("content"),
            "tool_calls": tool_calls,
        }
        messages.append(assistant_msg)

        for tc in tool_calls:
            fn = tc.get("function") or {}
            tool_name = fn.get("name") or ""
            tools_used.append(tool_name)
            tool_progress(progress_request_id, tool_name)
            try:
                args = json.loads(fn.get("arguments") or "{}")
            except json.JSONDecodeError:
                args = {}

            try:
                output = _execute_tool(
                    conn,
                    tool_name,
                    args,
                    run_id=run_id,
                    agent_name=agent_name,
                    portal_context=portal_context,
                )
            except Exception as exc:
                # Broken tool call must not 500 the whole chat — feed the error
                # back to the LLM so it can retry or ask the user.
                try:
                    conn.rollback()
                except Exception:
                    pass
                output = {"error": f"{type(exc).__name__}: {exc}"}
            if isinstance(output, dict) and output.get("ui_action"):
                ui_actions.append(output["ui_action"])
            if isinstance(output, dict) and output.get("formatted_summary"):
                last_formatted_content = str(output["formatted_summary"])
            if isinstance(output, dict) and output.get("structured"):
                last_structured = output["structured"]
            log_agent_step(
                conn,
                run_id=run_id,
                agent_name=agent_name,
                tool_name=tool_name,
                policy_decision="allowed",
                input_payload=args,
                output_summary={"turn": turn, "tool": tool_name},
            )
            messages.append(
                {
                    "role": "tool",
                    "tool_call_id": tc.get("id") or str(uuid.uuid4()),
                    "content": json.dumps(output, default=str)[:8000],
                }
            )
    else:
        last_content = (
            last_content
            or "Tool loop reached maximum turns. Summarize findings from tool outputs above."
        )

    return {
        "content": last_content,
        "formatted_content": last_formatted_content,
        "structured": last_structured,
        "model": model,
        "tools_used": tools_used,
        "ui_actions": ui_actions,
        "configured": cfg.configured,
        "llm_profile": llm_profile,
        "turns": turn + 1 if had_tool_calls else 1,
        "transcript": _messages_to_transcript(messages),
    }


def _messages_to_transcript(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Human-readable trace of assistant reasoning + tool calls for steward UI."""
    out: list[dict[str, Any]] = []
    for msg in messages:
        role = msg.get("role")
        if role == "system":
            continue
        if role == "assistant":
            entry: dict[str, Any] = {"role": "assistant"}
            content = (msg.get("content") or "").strip()
            if content:
                entry["content"] = content
            tool_calls = msg.get("tool_calls") or []
            if tool_calls:
                entry["tool_calls"] = [
                    {
                        "name": (tc.get("function") or {}).get("name"),
                        "arguments": (tc.get("function") or {}).get("arguments"),
                    }
                    for tc in tool_calls
                ]
            if content or tool_calls:
                out.append(entry)
        elif role == "tool":
            snippet = (msg.get("content") or "")[:2000]
            out.append({"role": "tool", "content": snippet})
        elif role == "user":
            content = (msg.get("content") or "").strip()
            if content:
                out.append({"role": "user", "content": content[:4000]})
    return out
