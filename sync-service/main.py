"""GIOP unified sync gateway — graph webhooks, telemetry, and network trace."""

import asyncio
import json
import logging
import os
import secrets
import threading
import time
import urllib.error
import urllib.request
from datetime import datetime
from pathlib import Path
from typing import Any, Literal, Optional

import psycopg2
from dotenv import load_dotenv
from fastapi import BackgroundTasks, FastAPI, File, HTTPException, Query, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response
from neo4j import GraphDatabase
from pydantic import BaseModel, ConfigDict, Field

from db_pool import close_all_pools, pooled_connect
from dlq import list_dlq, mark_retrying, patch_dlq
from field_capture import (
    distinct_feeders,
    distinct_substations,
    ensure_upload_dir,
    list_staging_spans,
    nearby_assets,
    save_field_photo,
    snap_placement_point,
    submit_field_span,
    technician_hex_allowed,
)
from field_ops import (
    fetch_staging_validation,
    list_active_technicians,
    list_technician_submissions,
    upsert_technician_position,
)
from field_notifications import (
    dispatch_rejection_push,
    list_technician_notifications,
    mark_notification_delivered,
    mark_notification_read,
    notify_asset_rejected,
    register_device_token,
)
from energy_accounting import compute_balance
from integrations.sap.sync_customers import (
    sap_integration_status,
    sync_customers_from_sap,
    upsert_customer_from_payload,
)
from graph_sync import apply_webhook_event, graph_parity_report, reconcile_memgraph
from redis_cache import (
    OPS_CACHE_TTL_SEC,
    RULES_CACHE_TTL_SEC,
    SCHEMATIC_CACHE_TTL_SEC,
    CIM_PREVIEW_TTL_SEC,
    asset_detail_key,
    assets_master_key,
    assets_staging_key,
    bulk_connections_key,
    cached_json,
    cim_preview_key,
    claim_idempotency,
    conflicts_key,
    dq_exceptions_key,
    dq_queue_key,
    dq_rules_key,
    dq_summary_key,
    exports_list_key,
    get_idempotent_response,
    get_json,
    graph_chunk_key,
    graph_parity_key,
    h3_assignments_geojson_key,
    h3_cells_key,
    h3_coverage_key,
    h3_grid_key,
    idempotency_key,
    invalidate_after_promote,
    invalidate_after_staging_write,
    invalidate_h3_cache,
    invalidate_ops_cache,
    invalidate_topology_cache,
    lock,
    map_nodes_key,
    nav_badges_key,
    node_connections_key,
    repair_lock_key,
    schematic_key,
    topology_dq_summary_key,
    set_json,
    status as redis_status,
    store_idempotent_response,
    topology_gaps_key,
    topology_health_key,
    topology_impact_key,
    trace_key,
    webhook_dedup_key,
)
from topology_analysis import (
    downstream_impact_payload,
    topology_gaps_payload,
    topology_health_report,
)
from lineage import (
    fetch_asset_updated_at,
    fetch_lineage,
    insert_conflict_proposal,
    list_open_conflicts,
    log_dlq_event,
    log_lineage,
    resolve_conflict,
    search_lineage,
    set_lineage_context,
)
from data_quality import (
    OPS_STAGING_QUEUE,
    count_blocking_open,
    count_exceptions,
    count_dq_queue,
    list_dq_queue,
    list_exceptions as dq_list_exceptions,
    list_rules as dq_list_rules,
    release_staging_to_operations,
    resolve_exception as dq_resolve_exception,
    run_asset_checks,
    summary as dq_summary,
)
from topology_dq import (
    create_topology_batch_run,
    execute_topology_batch_scan,
    latest_staging_topology_live,
    latest_topology_snapshot,
    list_batch_runs as topology_dq_list_runs,
    topology_dq_summary,
)
from map_nodes import fetch_nodes_near_location
import h3_index as h3x
from h3_service import (
    assignments_geojson,
    batch_upsert_assignments,
    bbox_grid_geojson,
    cell_at_point,
    delete_assignments,
    fetch_coverage,
    fetch_nodes_in_cells,
    list_assignments,
    upsert_assignment,
)
from node_connections import fetch_bulk_node_connections, fetch_node_connections
from schematic import generate_svg
from contact_cases import (
    convert_case_to_ticket,
    convert_case_to_work_order,
    create_case,
    get_case,
    list_cases,
    patch_case,
)
from outages import create_outage, get_outage, list_outages, patch_outage, restore_outage
from regulatory import compute_metrics, generate_report, list_reports
from trouble_tickets import create_ticket, get_ticket, link_ticket, list_tickets, patch_ticket
from cim_export import (
    DEFAULT_LAYERS,
    build_cim_payload,
    create_export_job,
    get_job as get_export_job,
    list_jobs as list_export_jobs,
    validate_export_scope,
)
from dxf_export import (
    build_dxf_payload,
    create_dxf_export_job,
)
from export_dispatch import (
    LINEAGE_ACTIONS,
    SUPPORTED_FORMATS,
    download_filename,
    process_job as process_export_by_format,
    read_job_bytes as read_export_bytes_by_format,
)
from gpkg_export import create_gpkg_export_job
from kml_export import create_kml_export_job
from shapefile_export import create_shapefile_export_job
from csv_export import create_csv_export_job
from cim_xml_export import create_cim_rdf_export_job, create_cim_xml_export_job
from integration_export import create_mdms_export_job, create_sap_export_job
from reference_import import (
    create_boundary_import_job,
    create_reference_import_from_inspect,
    get_job as get_import_job,
    list_import_jobs,
    list_reference_layers,
    process_boundary_import_job,
    save_import_upload,
)
from reference_inspect import (
    inspect_uploaded,
    layer_preview_geojson,
    save_inspect_upload,
    suggest_boundary_fields,
)
from reference_render import (
    build_map_config,
    refresh_all_render_policies,
    reference_layer_geojson,
)
from work_orders import create_work_order, get_work_order, list_work_orders, patch_work_order
from map_search import SEARCH_KINDS, list_places_index, search_map
from geocode import geocode_map_places
from migration_engine import (
    list_failed as list_migration_failed,
    list_runs as list_migration_runs,
    parse_dxf,
    parse_geopackage,
    run_migration,
)
from metrics import record_request, snapshot as metrics_snapshot
from ops_badges import collect_badge_counts
from agents.models import RunMode, RunType, ValidationRunRequest
from agents.orchestrator import run_agent_validation_cycle, run_validation_cycle
from agents import approval_agent, cleanup_agent, kpi, proposal_agent, repository

from pathlib import Path

load_dotenv()
load_dotenv(Path(__file__).resolve().parent.parent / ".env")

GRAPH_URI = os.getenv("GRAPH_DB_URI") or os.getenv("MEMGRAPH_URI", "bolt://localhost:7687")
SUPABASE_DB_URI = os.getenv("SUPABASE_DB_URI")
TIMESCALE_URI = os.getenv("TIMESCALE_URI")
OCR_SERVICE_URL = os.getenv("OCR_SERVICE_URL", "http://127.0.0.1:5002")

# Interactive trace bounds — national graph must never be walked on a click.
TRACE_MAX_HOPS = int(os.getenv("TRACE_MAX_HOPS", "10"))
TRACE_MAX_NODES = int(os.getenv("TRACE_MAX_NODES", "5000"))
TRACE_MAX_EDGES = int(os.getenv("TRACE_MAX_EDGES", "15000"))
TRACE_FULL_NODE_CAP = int(os.getenv("TRACE_FULL_NODE_CAP", "8000"))
TRACE_VIEWPORT_PAD = float(os.getenv("TRACE_VIEWPORT_PAD", "0.08"))

app = FastAPI(title="GIOP Dev Sync Gateway")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

try:
    from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor

    FastAPIInstrumentor.instrument_app(app)
except ImportError:
    pass


def _push_rejection_notification(
    technician_id: str | None,
    title: str,
    body: str,
    payload: dict[str, Any],
) -> None:
    if not technician_id or not SUPABASE_DB_URI:
        return
    try:
        conn = pooled_connect(SUPABASE_DB_URI)
        try:
            dispatch_rejection_push(
                conn,
                technician_id=technician_id,
                title=title,
                body=body,
                payload=payload,
            )
        finally:
            conn.close()
    except Exception:
        pass


@app.middleware("http")
async def metrics_middleware(request: Request, call_next):
    start = time.perf_counter()
    is_error = False
    try:
        response = await call_next(request)
        is_error = response.status_code >= 500
        return response
    except Exception:
        is_error = True
        raise
    finally:
        duration_ms = (time.perf_counter() - start) * 1000
        record_request(duration_ms, is_error=is_error)

graph_driver = GraphDatabase.driver(
    GRAPH_URI,
    auth=None,
    connection_acquisition_timeout=float(os.getenv("MEMGRAPH_CONNECT_TIMEOUT", "10")),
)

TraceScope = Literal["traced", "full"]


_graph_totals_cache: tuple[float, int, int] | None = None
_GRAPH_TOTALS_TTL_SEC = 30.0


def _pg_graph_totals(conn) -> tuple[int, int]:
    # Totals are display metadata on trace payloads — a COUNT(*) pair per
    # trace request is wasted work, so serve slightly-stale cached counts.
    global _graph_totals_cache
    cached = _graph_totals_cache
    now = time.monotonic()
    if cached is not None and now - cached[0] < _GRAPH_TOTALS_TTL_SEC:
        return cached[1], cached[2]
    with conn.cursor() as cur:
        cur.execute("SELECT COUNT(*) FROM public.connectivity_nodes")
        node_count = int(cur.fetchone()[0])
        cur.execute("SELECT COUNT(*) FROM public.ac_line_segments")
        edge_count = int(cur.fetchone()[0])
    _graph_totals_cache = (now, node_count, edge_count)
    return node_count, edge_count


def _collect_traced_mrids_pg(
    conn,
    start_mrid: str,
    *,
    max_hops: int,
    max_nodes: int,
) -> tuple[set[str], bool]:
    """Downstream walk in PostGIS — bounded by hops and node cap."""
    with conn.cursor() as cur:
        cur.execute(
            """
            WITH RECURSIVE walk AS (
              SELECT %s::uuid AS mrid, 0 AS depth
              UNION ALL
              SELECT als.target_node_id, w.depth + 1
              FROM walk w
              JOIN public.ac_line_segments als ON als.source_node_id = w.mrid
              WHERE w.depth < %s
            ),
            reached AS (
              SELECT DISTINCT mrid FROM walk
            )
            SELECT mrid::text FROM reached
            LIMIT %s
            """,
            (start_mrid, max_hops, max_nodes),
        )
        mrids = {row[0] for row in cur.fetchall()}
    return mrids, len(mrids) >= max_nodes


def _build_trace_payload_postgres(
    conn,
    start_mrid: str,
    scope: TraceScope,
    *,
    max_hops: int | None = None,
    max_nodes: int | None = None,
) -> dict[str, Any]:
    """Interactive trace from PostGIS — never scans the full national graph."""
    hop_cap = max(1, min(max_hops or TRACE_MAX_HOPS, 20))
    node_cap = max(100, min(max_nodes or TRACE_MAX_NODES, 20000))
    edge_cap = max(100, min(TRACE_MAX_EDGES, 50000))

    traced_mrids, trace_truncated = _collect_traced_mrids_pg(
        conn, start_mrid, max_hops=hop_cap, max_nodes=node_cap
    )
    total_nodes, total_edges = _pg_graph_totals(conn)
    graph_totals = {"nodes": total_nodes, "edges": total_edges}

    if scope == "full" and total_nodes > TRACE_FULL_NODE_CAP:
        return _trace_viewport_fallback(
            start_mrid,
            scope,
            traced_mrids,
            graph_totals,
            max_nodes=node_cap,
            truncated=trace_truncated,
        )

    if scope == "full":
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT cn.mrid::text
                FROM public.connectivity_nodes cn
                ORDER BY cn.mrid
                LIMIT %s
                """,
                (node_cap,),
            )
            included_mrids = {row[0] for row in cur.fetchall()}
        if len(included_mrids) >= node_cap:
            trace_truncated = True
    else:
        included_mrids = set(traced_mrids)
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT
                  als.mrid::text,
                  als.source_node_id::text,
                  als.target_node_id::text,
                  coalesce(ce.phases, 'ABC'),
                  coalesce(ce.nominal_voltage::text, 'MV_11KV')
                FROM public.ac_line_segments als
                JOIN public.conducting_equipment ce ON ce.mrid = als.mrid
                WHERE als.source_node_id = ANY(%s::uuid[])
                   OR als.target_node_id = ANY(%s::uuid[])
                LIMIT %s
                """,
                (list(included_mrids), list(included_mrids), edge_cap),
            )
            expand_rows = cur.fetchall()
        if len(expand_rows) >= edge_cap:
            trace_truncated = True
        for row in expand_rows:
            included_mrids.add(row[1])
            included_mrids.add(row[2])

    edges_truncated = False
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT
              als.mrid::text,
              als.source_node_id::text,
              als.target_node_id::text,
              coalesce(ce.phases, 'ABC'),
              coalesce(ce.nominal_voltage::text, 'MV_11KV')
            FROM public.ac_line_segments als
            JOIN public.conducting_equipment ce ON ce.mrid = als.mrid
            WHERE als.source_node_id = ANY(%s::uuid[])
              AND als.target_node_id = ANY(%s::uuid[])
            LIMIT %s
            """,
            (list(included_mrids), list(included_mrids), edge_cap),
        )
        edge_rows = cur.fetchall()
    if len(edge_rows) >= edge_cap:
        edges_truncated = True
        trace_truncated = True

    connected_mrids: set[str] = set()
    for row in edge_rows:
        connected_mrids.add(row[1])
        connected_mrids.add(row[2])

    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT cn.mrid::text, io.name, io.validation::text
            FROM public.connectivity_nodes cn
            JOIN public.identified_objects io ON io.mrid = cn.mrid
            WHERE cn.mrid = ANY(%s::uuid[])
            """,
            (list(included_mrids),),
        )
        node_rows = cur.fetchall()

    nodes = [
        {
            "mrid": mrid,
            "name": name or mrid,
            "type": ["ConnectivityNode"],
            "connected": mrid in connected_mrids,
            "traced": mrid in traced_mrids,
            "validation": validation,
        }
        for mrid, name, validation in node_rows
    ]
    edges = [
        {
            "mrid": row[0],
            "source": row[1],
            "target": row[2],
            "phases": row[3],
            "voltage": row[4],
        }
        for row in edge_rows
    ]

    bounds = {
        "max_hops": hop_cap,
        "max_nodes": node_cap,
        "max_edges": edge_cap,
        "truncated": trace_truncated,
        "mode": "traced" if scope == "traced" else "full_bounded",
    }
    if edges_truncated:
        bounds["edges_truncated"] = True

    return {
        "nodes": nodes,
        "edges": edges,
        "start_mrid": start_mrid,
        "scope": scope,
        "graph_totals": graph_totals,
        "bounds": bounds,
    }


def _fetch_start_lonlat(conn, start_mrid: str) -> tuple[float, float] | None:
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT ST_X(cn.geom), ST_Y(cn.geom)
            FROM connectivity_nodes cn
            WHERE cn.mrid = %s::uuid
            """,
            (start_mrid,),
        )
        row = cur.fetchone()
    if not row or row[0] is None or row[1] is None:
        return None
    return float(row[0]), float(row[1])


def _chunk_to_trace_payload(
    chunk: dict[str, Any],
    *,
    start_mrid: str,
    scope: TraceScope,
    traced_mrids: set[str],
    graph_totals: dict[str, int],
    bounds: dict[str, Any],
) -> dict[str, Any]:
    nodes = [
        {
            "mrid": n["mrid"],
            "name": n.get("name") or n["mrid"],
            "type": ["ConnectivityNode"],
            "connected": n.get("connected", True),
            "traced": n["mrid"] in traced_mrids,
            "validation": n.get("validation"),
        }
        for n in chunk.get("nodes") or []
    ]
    edges = [
        {
            "mrid": e["mrid"],
            "source": e["source"],
            "target": e["target"],
            "phases": e.get("phases"),
            "voltage": e.get("voltage"),
            **(
                {"coordinates": e["coordinates"]}
                if e.get("coordinates")
                else {}
            ),
        }
        for e in chunk.get("edges") or []
    ]
    return {
        "nodes": nodes,
        "edges": edges,
        "start_mrid": start_mrid,
        "scope": scope,
        "graph_totals": graph_totals,
        "bounds": bounds,
        "bbox": chunk.get("bbox"),
    }


def _trace_viewport_fallback(
    start_mrid: str,
    scope: TraceScope,
    traced_mrids: set[str],
    graph_totals: dict[str, int],
    *,
    max_nodes: int,
    truncated: bool,
) -> dict[str, Any]:
    conn = _pg_connect()
    if not conn:
        raise HTTPException(status_code=500, detail="SUPABASE_DB_URI not configured")
    try:
        lonlat = _fetch_start_lonlat(conn, start_mrid)
        if lonlat is None:
            raise HTTPException(
                status_code=404,
                detail=f"Start node has no geometry (start_mrid={start_mrid})",
            )
        lon, lat = lonlat
        pad = TRACE_VIEWPORT_PAD
        chunk = _fetch_graph_chunk_from_postgres(
            lon - pad,
            lat - pad,
            lon + pad,
            lat + pad,
            max_nodes,
            traced_mrids,
            min(max_nodes * 2, TRACE_MAX_EDGES),
        )
    finally:
        conn.close()

    bounds = {
        "max_hops": TRACE_MAX_HOPS,
        "max_nodes": max_nodes,
        "max_edges": TRACE_MAX_EDGES,
        "truncated": truncated or chunk.get("truncated", False),
        "mode": "viewport_fallback",
    }
    if chunk.get("edges_truncated"):
        bounds["edges_truncated"] = True
    return _chunk_to_trace_payload(
        chunk,
        start_mrid=start_mrid,
        scope=scope,
        traced_mrids=traced_mrids,
        graph_totals=graph_totals,
        bounds=bounds,
    )


def _trace_payload_blocking(
    start_mrid: str,
    scope: TraceScope,
    *,
    max_hops: int | None = None,
    max_nodes: int | None = None,
) -> dict[str, Any]:
    conn = _pg_connect()
    if not conn:
        raise HTTPException(status_code=500, detail="SUPABASE_DB_URI not configured")
    try:
        return _build_trace_payload_postgres(
            conn,
            start_mrid,
            scope,
            max_hops=max_hops,
            max_nodes=max_nodes,
        )
    finally:
        conn.close()


def _graph_chunk_traced_mrids_blocking(
    start_mrid: str,
    *,
    max_hops: int | None = None,
    max_nodes: int | None = None,
) -> set[str]:
    conn = _pg_connect()
    if not conn:
        return {start_mrid}
    try:
        hop_cap = max(1, min(max_hops or TRACE_MAX_HOPS, 20))
        node_cap = max(100, min(max_nodes or TRACE_MAX_NODES, 20000))
        traced, _ = _collect_traced_mrids_pg(
            conn, start_mrid, max_hops=hop_cap, max_nodes=node_cap
        )
        return traced
    finally:
        conn.close()


def _fetch_graph_chunk_from_postgres(
    west: float,
    south: float,
    east: float,
    north: float,
    limit: int,
    traced_mrids: set[str] | None = None,
    edge_limit: int = 5000,
) -> dict[str, Any]:
    conn = _pg_connect()
    if not conn:
        raise HTTPException(status_code=500, detail="SUPABASE_DB_URI not configured")

    traced_mrids = traced_mrids or set()
    envelope = (west, south, east, north)
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT
                  cn.mrid::text,
                  io.name,
                  ST_X(cn.geom) AS lon,
                  ST_Y(cn.geom) AS lat,
                  io.validation
                FROM connectivity_nodes cn
                JOIN identified_objects io ON io.mrid = cn.mrid
                WHERE cn.geom && ST_MakeEnvelope(%s, %s, %s, %s, 4326)
                ORDER BY cn.mrid
                LIMIT %s
                """,
                (*envelope, limit),
            )
            node_rows = cur.fetchall()

            span = max(east - west, north - south)
            simplify_tol = max(0.00003, span / 600.0)

            cur.execute(
                """
                SELECT
                  als.mrid::text,
                  als.source_node_id::text,
                  als.target_node_id::text,
                  coalesce(ce.phases, 'ABC'),
                  coalesce(ce.nominal_voltage::text, 'MV_11KV'),
                  ST_X(src.geom) AS src_lon,
                  ST_Y(src.geom) AS src_lat,
                  ST_X(tgt.geom) AS tgt_lon,
                  ST_Y(tgt.geom) AS tgt_lat,
                  ST_AsGeoJSON(ST_SimplifyPreserveTopology(als.geom, %s))::json AS geom_json
                FROM ac_line_segments als
                JOIN conducting_equipment ce ON als.mrid = ce.mrid
                JOIN connectivity_nodes src ON src.mrid = als.source_node_id
                JOIN connectivity_nodes tgt ON tgt.mrid = als.target_node_id
                WHERE als.geom && ST_MakeEnvelope(%s, %s, %s, %s, 4326)
                ORDER BY als.mrid
                LIMIT %s
                """,
                (simplify_tol, *envelope, edge_limit + 1),
            )
            edge_rows = cur.fetchall()
            edges_truncated = len(edge_rows) > edge_limit
            if edges_truncated:
                edge_rows = edge_rows[:edge_limit]

            if not node_rows and not edge_rows:
                return {
                    "nodes": [],
                    "edges": [],
                    "bbox": {"west": west, "south": south, "east": east, "north": north},
                    "truncated": False,
                    "edges_truncated": False,
                    "limit": limit,
                    "edge_limit": edge_limit,
                }

            connected_mrids: set[str] = set()
            for row in edge_rows:
                connected_mrids.add(row[1])
                connected_mrids.add(row[2])

            def _edge_coordinates(geom_json: Any) -> list[list[float]] | None:
                if not geom_json:
                    return None
                if isinstance(geom_json, str):
                    geom_json = json.loads(geom_json)
                if geom_json.get("type") != "LineString":
                    return None
                coords = geom_json.get("coordinates")
                if not isinstance(coords, list) or len(coords) < 2:
                    return None
                return coords

            nodes = [
                {
                    "mrid": mrid,
                    "name": name or mrid,
                    "lon": float(lon),
                    "lat": float(lat),
                    "validation": validation,
                    "connected": mrid in connected_mrids,
                    "traced": mrid in traced_mrids,
                }
                for mrid, name, lon, lat, validation in node_rows
            ]
            edges = []
            for row in edge_rows:
                (
                    mrid,
                    source,
                    target,
                    phases,
                    voltage,
                    src_lon,
                    src_lat,
                    tgt_lon,
                    tgt_lat,
                    geom_json,
                ) = row
                coords = _edge_coordinates(geom_json)
                edge: dict[str, Any] = {
                    "mrid": mrid,
                    "source": source,
                    "target": target,
                    "phases": phases,
                    "voltage": voltage,
                    "source_lon": float(src_lon),
                    "source_lat": float(src_lat),
                    "target_lon": float(tgt_lon),
                    "target_lat": float(tgt_lat),
                }
                if coords:
                    edge["coordinates"] = coords
                edges.append(edge)

            truncated = len(node_rows) >= limit
            return {
                "nodes": nodes,
                "edges": edges,
                "bbox": {"west": west, "south": south, "east": east, "north": north},
                "truncated": truncated,
                "edges_truncated": edges_truncated,
                "limit": limit,
                "edge_limit": edge_limit,
            }
    finally:
        conn.close()


class WebhookPayload(BaseModel):
    model_config = ConfigDict(extra="ignore", populate_by_name=True)

    type: str
    table: str
    record: Optional[dict[str, Any]] = None
    old_record: Optional[dict[str, Any]] = None
    db_schema: Optional[str] = Field(default=None, validation_alias="schema")


class TelemetryPayload(BaseModel):
    meter_mrid: str
    active_energy_kwh: float = Field(gt=0)


GhanaUtility = Literal["ECG_SOUTHERN", "NEDCO_NORTHERN", "GRIDCO_TRANSMISSION"]

FieldAssetKind = Literal[
    "distribution_transformer",
    "power_transformer",
    "pole_11kv",
    "pole_33kv",
    "pole_lv",
    "connectivity_node",
]


class FieldNodePayload(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    longitude: float = Field(ge=-180, le=180)
    latitude: float = Field(ge=-90, le=90)
    operating_utility: GhanaUtility = "ECG_SOUTHERN"
    substation_name: str | None = Field(default=None, max_length=100)
    boundary_feeder_id: str | None = Field(default=None, max_length=50)
    asset_kind: FieldAssetKind = "connectivity_node"
    work_order_id: str | None = Field(default=None, max_length=100)
    photo_url: str | None = Field(default=None, max_length=500)
    h3_index: str | None = Field(default=None, max_length=32)
    enforce_hex_assignment: bool = False
    mrid: str | None = None
    offline_session_started_at: str | None = None
    operator_id: str | None = Field(default=None, max_length=100)
    idempotency_key: str | None = Field(default=None, max_length=128)


class FieldLocationPayload(BaseModel):
    technician_id: str = Field(min_length=1, max_length=100)
    longitude: float = Field(ge=-180, le=180)
    latitude: float = Field(ge=-90, le=90)
    display_name: str | None = Field(default=None, max_length=200)
    accuracy_m: float | None = Field(default=None, ge=0)
    heading_deg: float | None = None
    speed_mps: float | None = Field(default=None, ge=0)
    work_order_id: str | None = Field(default=None, max_length=100)
    session_started_at: str | None = None


class BulkNodeConnectionsPayload(BaseModel):
    mrids: list[str] = Field(min_length=1, max_length=1500)
    limit_per_node: int = Field(default=25, ge=1, le=100)


class FieldSpanPayload(BaseModel):
    source_node_id: str = Field(min_length=1, max_length=50)
    target_node_id: str = Field(min_length=1, max_length=50)
    boundary_feeder_id: str | None = Field(default=None, max_length=50)
    work_order_id: str | None = Field(default=None, max_length=100)
    name: str | None = Field(default=None, max_length=200)
    operator_id: str | None = Field(default=None, max_length=100)


class AssetUpdatePayload(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    offline_session_started_at: str | None = None


class ConflictResolvePayload(BaseModel):
    resolution: Literal["master", "field", "discard"]


class EnergyBalancePayload(BaseModel):
    zone_key: str = Field(min_length=1, max_length=100)
    period_start: datetime
    period_end: datetime
    nominal_injection_kwh: float | None = Field(default=None, ge=0)


class DlqPatchPayload(BaseModel):
    status: Literal["OPEN", "RETRYING", "RESOLVED", "DISCARDED"]
    payload: dict[str, Any] | None = None


class TopologyRepairPayload(BaseModel):
    target_mrid: str
    radius_meters: float = Field(default=50, gt=0, le=5000)
    dry_run: bool = False
    operator_id: str | None = Field(default=None, max_length=100)


class ValidationActionPayload(BaseModel):
    validation: Literal["APPROVED", "IN_CONFLICT", "STAGED", "PENDING_FIELD", "REJECTED"]
    reason: str | None = Field(default=None, max_length=500)
    operator_id: str | None = Field(default=None, max_length=100)
    override_data_quality: bool = False


class DqResolvePayload(BaseModel):
    status: Literal["RESOLVED", "DEFERRED", "QUARANTINED", "REJECTED"]
    note: str | None = Field(default=None, max_length=1000)
    operator_id: str | None = Field(default=None, max_length=100)


class CimExportClip(BaseModel):
    west: float = Field(ge=-180, le=180)
    south: float = Field(ge=-90, le=90)
    east: float = Field(ge=-180, le=180)
    north: float = Field(ge=-90, le=90)


class TopologyDqScanPayload(BaseModel):
    clip: CimExportClip | None = None
    operator_id: str | None = Field(default=None, max_length=100)


class ValidationRunPayload(BaseModel):
    run_type: Literal["full_cycle", "asset_checks", "topology_master", "revalidation"] = "full_cycle"
    mode: Literal["deterministic", "agent"] = "deterministic"
    mrid: str | None = None
    tier: Literal["staging", "master"] = "master"
    operator_id: str | None = Field(default=None, max_length=100)
    clip: CimExportClip | None = None


class PortalAiChatPayload(BaseModel):
    message: str = Field(min_length=1, max_length=4000)
    exception_id: str | None = None
    mrid: str | None = None
    operator_id: str | None = Field(default=None, max_length=100)
    context: dict[str, Any] = Field(default_factory=dict)


class ApprovalDecisionPayload(BaseModel):
    operator_id: str | None = Field(default=None, max_length=100)
    note: str | None = Field(default=None, max_length=1000)
    execute: bool = False


class CleanupExecutePayload(BaseModel):
    operator_id: str | None = Field(default=None, max_length=100)
    force: bool = False


class CimExportPayload(BaseModel):
    layers: list[str] = Field(default_factory=lambda: list(DEFAULT_LAYERS))
    clip: CimExportClip | None = None
    exclude_dq_blocked: bool = True
    requested_by: str | None = Field(default=None, max_length=100)
    operator_id: str | None = Field(default=None, max_length=100)


class DxfExportPayload(BaseModel):
    clip: CimExportClip | None = None
    exclude_dq_blocked: bool = True
    include_nodes: bool = True
    include_lines: bool = True
    requested_by: str | None = Field(default=None, max_length=100)
    operator_id: str | None = Field(default=None, max_length=100)


class GisExportPayload(BaseModel):
    clip: CimExportClip | None = None
    exclude_dq_blocked: bool = True
    include_meters: bool = True
    layers: list[str] = Field(default_factory=lambda: list(DEFAULT_LAYERS))
    requested_by: str | None = Field(default=None, max_length=100)
    operator_id: str | None = Field(default=None, max_length=100)


class AffineParams(BaseModel):
    anchor_lon: float = Field(ge=-180, le=180)
    anchor_lat: float = Field(ge=-90, le=90)
    scale: float = Field(default=1.0)
    rotation_deg: float = Field(default=0.0)
    origin_x: float = Field(default=0.0)
    origin_y: float = Field(default=0.0)


class DxfMigrationPayload(BaseModel):
    dxf_text: str | None = None
    file_path: str | None = None
    source_name: str = Field(default="dxf-import", max_length=200)
    apply_affine: bool = True
    affine: AffineParams | None = None
    default_feeder: str | None = Field(default=None, max_length=100)
    default_utility: str = Field(default="ECG_SOUTHERN", max_length=40)
    requested_by: str | None = Field(default=None, max_length=100)


class GpkgMigrationPayload(BaseModel):
    file_path: str = Field(..., max_length=1024)
    table: str | None = Field(default=None, max_length=200)
    source_name: str = Field(default="geopackage-import", max_length=200)
    apply_affine: bool = False
    affine: AffineParams | None = None
    default_feeder: str | None = Field(default=None, max_length=100)
    default_utility: str = Field(default="ECG_SOUTHERN", max_length=40)
    requested_by: str | None = Field(default=None, max_length=100)


class DeviceTokenPayload(BaseModel):
    technician_id: str = Field(..., min_length=1, max_length=100)
    token: str = Field(..., min_length=8, max_length=512)
    platform: str = Field(default="android", max_length=32)


class EquipmentUpdatePayload(BaseModel):
    nominal_voltage: Literal[
        "LV_230V", "LV_400V", "MV_11KV", "MV_33KV", "HV_161KV", "HV_330KV"
    ]
    operator_id: str | None = Field(default=None, max_length=100)


class InspectionCreatePayload(BaseModel):
    asset_mrid: str
    evidence_photo_url: str | None = None
    nameplate_photo_url: str | None = None
    inspector_notes: str | None = None


class SpotBillPayload(BaseModel):
    account_mrid: str
    meter_mrid: str | None = None
    previous_reading_kwh: float = Field(ge=0)
    current_reading_kwh: float = Field(gt=0)
    tariff_rate_ghs: float = Field(default=1.25, gt=0)
    field_technician: str | None = None
    evidence_photo_url: str | None = None


class H3AssignmentPayload(BaseModel):
    h3_index: str = Field(min_length=1, max_length=32)
    resolution: int = Field(default=9, ge=0, le=15)
    assigned_to: str | None = None
    status: Literal["ASSIGNED", "IN_PROGRESS", "DONE", "BLOCKED"] = "ASSIGNED"
    note: str | None = None


class H3BatchAssignmentPayload(BaseModel):
    h3_indexes: list[str] = Field(min_length=1, max_length=500)
    resolution: int = Field(default=9, ge=0, le=15)
    assigned_to: str = Field(min_length=1, max_length=128)
    status: Literal["ASSIGNED", "IN_PROGRESS", "DONE", "BLOCKED"] = "ASSIGNED"
    note: str | None = None


class H3DeleteAssignmentsPayload(BaseModel):
    h3_indexes: list[str] = Field(min_length=1, max_length=500)


def _pg_connect():
    if not SUPABASE_DB_URI:
        return None
    return pooled_connect(SUPABASE_DB_URI)


def _lookup_node_name(mrid: str) -> Optional[str]:
    conn = _pg_connect()
    if not conn:
        return None
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT name FROM identified_objects WHERE mrid = %s", (mrid,))
            row = cur.fetchone()
            return row[0] if row else None
    finally:
        conn.close()


def _lookup_equipment(mrid: str) -> tuple[str, str]:
    conn = _pg_connect()
    if not conn:
        return "ABC", "MV_11KV"
    try:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT phases, nominal_voltage::text FROM conducting_equipment WHERE mrid = %s",
                (mrid,),
            )
            row = cur.fetchone()
            if row:
                return row[0], row[1]
            return "ABC", "MV_11KV"
    finally:
        conn.close()


def _post_image_to_ocr(image_bytes: bytes, filename: str = "evidence.jpg") -> dict[str, Any]:
    import requests

    response = requests.post(
        f"{OCR_SERVICE_URL}/api/v1/meter/ocr",
        files={"file": (filename, image_bytes, "image/jpeg")},
        timeout=120,
    )
    response.raise_for_status()
    return response.json()


def _validation_status_from_ocr(ocr: dict[str, Any]) -> str:
    if ocr.get("registry_match"):
        return "PASSED"
    if ocr.get("extracted_serial") or ocr.get("extracted_kwh") is not None:
        return "NEEDS_REVIEW"
    return "FAILED"


def _set_inspection_status(inspection_id: str, status: str, notes: str | None = None) -> None:
    conn = _pg_connect()
    if not conn:
        return
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                UPDATE field_inspections
                SET ai_validation_status = %s,
                    inspector_notes = COALESCE(%s, inspector_notes)
                WHERE id = %s::uuid
                """,
                (status, notes, inspection_id),
            )
            conn.commit()
    finally:
        conn.close()


def _validate_inspection_background(inspection_id: str, photo_url: str | None) -> None:
    try:
        if not photo_url:
            _set_inspection_status(inspection_id, "NEEDS_REVIEW", "No evidence photo URL")
            return

        import requests

        if photo_url.startswith("http://") or photo_url.startswith("https://"):
            image_bytes = requests.get(photo_url, timeout=30).content
        elif os.path.isfile(photo_url):
            with open(photo_url, "rb") as handle:
                image_bytes = handle.read()
        else:
            _set_inspection_status(inspection_id, "NEEDS_REVIEW", "Unsupported photo reference")
            return

        ocr = _post_image_to_ocr(image_bytes)
        status = _validation_status_from_ocr(ocr)
        note = f"OCR serial={ocr.get('extracted_serial')} kwh={ocr.get('extracted_kwh')}"
        _set_inspection_status(inspection_id, status, note)
    except Exception as exc:
        _set_inspection_status(inspection_id, "FAILED", str(exc))


def sync_to_graph_store(payload: WebhookPayload) -> None:
    # Master (public) changes only — staging rows must not reach Memgraph until promoted.
    if payload.db_schema and payload.db_schema != "public":
        return
    topology_tables = {"connectivity_nodes", "ac_line_segments", "identified_objects", "conducting_equipment"}
    if payload.table in topology_tables and payload.type:
        invalidate_topology_cache()
    if payload.table in ("connectivity_nodes", "ac_line_segments") and payload.type:
        apply_webhook_event(
            graph_driver,
            payload.table,
            payload.type,
            payload.record,
            payload.old_record,
            _lookup_node_name,
            _lookup_equipment,
        )
    elif payload.table in topology_tables:
        # Metadata tables (names/equipment) — full reconcile refreshes labels.
        reconcile_memgraph(graph_driver)
    # Non-topology tables (work orders, tickets, …) never trigger a national
    # Memgraph reconcile — that was a huge accidental cost per webhook.


@app.post("/webhook/supabase-sync")
async def handle_supabase_sync(
    payload: WebhookPayload,
    background_tasks: BackgroundTasks,
):
    dedup_material = {
        "type": payload.type,
        "table": payload.table,
        "schema": payload.db_schema,
        "record": payload.record,
        "old_record": payload.old_record,
    }
    if not claim_idempotency(webhook_dedup_key(dedup_material)):
        return {"status": "duplicate"}
    background_tasks.add_task(sync_to_graph_store, payload)
    return {"status": "queued"}


@app.get("/api/v1/graph/parity")
async def graph_parity():
    """Read-only Postgres vs Memgraph node/edge counts."""
    try:
        return cached_json(
            graph_parity_key(),
            lambda: graph_parity_report(graph_driver),
            OPS_CACHE_TTL_SEC,
        )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.post("/api/v1/graph/reconcile")
async def graph_reconcile():
    """Force full Postgres → Memgraph reconcile (removes orphan graph nodes/edges)."""
    try:
        stats = reconcile_memgraph(graph_driver)
        return {"status": "reconciled", **stats}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.post("/api/v1/telemetry/submit")
async def log_meter_interval(payload: TelemetryPayload):
    if not TIMESCALE_URI:
        raise HTTPException(status_code=500, detail="TIMESCALE_URI not configured")

    try:
        conn = pooled_connect(TIMESCALE_URI)
        try:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    INSERT INTO public.meter_readings
                      (meter_mrid, reading_timestamp, active_energy_kwh)
                    VALUES (%s, NOW(), %s)
                    """,
                    (payload.meter_mrid, payload.active_energy_kwh),
                )
                conn.commit()
        finally:
            conn.close()
        return {"status": "ingested"}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


def _asset_tier(cur, mrid: str) -> str | None:
    cur.execute("SELECT 1 FROM staging.identified_objects WHERE mrid = %s", (mrid,))
    if cur.fetchone():
        return "staging"
    cur.execute("SELECT 1 FROM public.identified_objects WHERE mrid = %s", (mrid,))
    if cur.fetchone():
        return "master"
    return None


@app.get("/api/v1/assets/staging")
async def list_staging_assets(
    include_rejected: bool = Query(default=False),
    submitted_by: str | None = Query(default=None),
    limit: int = Query(default=5000, ge=1, le=20000),
    queue: Literal["all", "operations", "dq"] = Query(default="all"),
):
    """Staging assets. Use queue=operations for the Operations inbox (STAGED/IN_CONFLICT)."""
    if not SUPABASE_DB_URI:
        raise HTTPException(status_code=500, detail="SUPABASE_DB_URI not configured")
    cache_key = assets_staging_key(include_rejected, submitted_by, limit, queue)

    def _fetch():
        conn = pooled_connect(SUPABASE_DB_URI)
        try:
            filters = []
            params: list[Any] = []
            if not include_rejected:
                filters.append("io.validation <> 'REJECTED'")
            if queue == "operations":
                filters.append("io.validation::text = ANY(%s)")
                params.append(list(OPS_STAGING_QUEUE))
            elif queue == "dq":
                filters.append("io.validation::text = ANY(%s)")
                params.append(["PENDING_FIELD", "IN_CONFLICT"])
            if submitted_by:
                filters.append("io.submitted_by = %s")
                params.append(submitted_by)
            where_clause = f"WHERE {' AND '.join(filters)}" if filters else ""
            with conn.cursor() as cur:
                cur.execute(
                    f"""
                    SELECT
                      cn.mrid::text,
                      io.name,
                      io.validation::text,
                      ST_AsGeoJSON(cn.geom)::json AS geom,
                      cn.boundary_feeder_id,
                      ga.operating_utility::text,
                      ga.substation_name,
                      NULL::text AS nominal_voltage,
                      io.submitted_by,
                      COALESCE(ga.asset_kind, 'connectivity_node') AS asset_kind,
                      io.work_order_id,
                      io.photo_url
                    FROM staging.connectivity_nodes cn
                    JOIN staging.identified_objects io ON cn.mrid = io.mrid
                    LEFT JOIN staging.ghana_grid_assets ga ON cn.mrid = ga.mrid
                    {where_clause}
                    ORDER BY io.updated_at DESC
                    LIMIT %s
                    """,
                    [*params, limit],
                )
                rows = cur.fetchall()
        finally:
            conn.close()
        return {
            "assets": [
                {
                    "mrid": r[0],
                    "name": r[1],
                    "validation": r[2],
                    "geom": r[3],
                    "boundary_feeder_id": r[4],
                    "operating_utility": r[5],
                    "substation_name": r[6],
                    "nominal_voltage": r[7],
                    "submitted_by": r[8],
                    "asset_kind": r[9],
                    "work_order_id": r[10],
                    "photo_url": r[11],
                    "tier": "staging",
                }
                for r in rows
            ]
        }

    try:
        return cached_json(cache_key, _fetch, OPS_CACHE_TTL_SEC)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.post("/api/v1/field/nodes")
async def submit_field_node(payload: FieldNodePayload):
    if not SUPABASE_DB_URI:
        raise HTTPException(status_code=500, detail="SUPABASE_DB_URI not configured")

    if payload.enforce_hex_assignment and payload.operator_id and payload.h3_index:
        conn_check = pooled_connect(SUPABASE_DB_URI)
        try:
            if not technician_hex_allowed(
                conn_check,
                technician_id=payload.operator_id,
                h3_index=payload.h3_index,
            ):
                raise HTTPException(
                    status_code=400,
                    detail="Capture location is outside your assigned work hex",
                )
        finally:
            conn_check.close()

    if payload.idempotency_key:
        ikey = idempotency_key("field-nodes", payload.idempotency_key)
        cached = get_idempotent_response(ikey)
        if cached is not None:
            return cached
        if not claim_idempotency(ikey):
            cached = get_idempotent_response(ikey)
            if cached is not None:
                return cached
            raise HTTPException(status_code=409, detail="Duplicate request in progress")

    proposed = payload.model_dump()
    conn = pooled_connect(SUPABASE_DB_URI)
    try:
        if payload.mrid and payload.offline_session_started_at:
            with conn.cursor() as cur:
                tier = _asset_tier(cur, payload.mrid)
                if tier:
                    server_updated = fetch_asset_updated_at(conn, payload.mrid, tier)
                    session_start = datetime.fromisoformat(
                        payload.offline_session_started_at.replace("Z", "+00:00")
                    )
                    if server_updated and server_updated > session_start:
                        conflict_id = insert_conflict_proposal(
                            conn,
                            asset_mrid=payload.mrid,
                            offline_session_started_at=payload.offline_session_started_at,
                            server_updated_at=server_updated,
                            proposed_payload=proposed,
                        )
                        conn.commit()
                        invalidate_ops_cache()
                        return JSONResponse(
                            status_code=409,
                            content={
                                "detail": "Server record newer than offline session",
                                "conflict_id": conflict_id,
                                "asset_mrid": payload.mrid,
                                "validation": "IN_CONFLICT",
                            },
                        )

        suffix = secrets.token_hex(6)
        mrid = payload.mrid or f"b0000000-0000-0000-0000-{suffix}"
        feeder_id = payload.boundary_feeder_id or f"FEEDER-FIELD-{suffix[:8]}"
        substation = payload.substation_name or payload.name

        with conn.cursor() as cur:
            if payload.mrid:
                tier = _asset_tier(cur, mrid)
                if tier == "staging":
                    validation = fetch_staging_validation(conn, mrid)
                    if validation == "REJECTED":
                        set_lineage_context(conn, skip=True)
                        cur.execute(
                            """
                            UPDATE staging.identified_objects
                            SET name = %s,
                                validation = 'PENDING_FIELD',
                                error_log = NULL,
                                submitted_by = COALESCE(%s, submitted_by),
                                work_order_id = COALESCE(%s, work_order_id),
                                photo_url = COALESCE(%s, photo_url),
                                updated_at = NOW()
                            WHERE mrid = %s
                            """,
                            (
                                payload.name,
                                payload.operator_id,
                                payload.work_order_id,
                                payload.photo_url,
                                mrid,
                            ),
                        )
                        cur.execute(
                            """
                            UPDATE staging.connectivity_nodes
                            SET geom = ST_SetSRID(ST_MakePoint(%s, %s), 4326),
                                boundary_feeder_id = COALESCE(%s, boundary_feeder_id)
                            WHERE mrid = %s
                            """,
                            (
                                payload.longitude,
                                payload.latitude,
                                payload.boundary_feeder_id,
                                mrid,
                            ),
                        )
                        cur.execute(
                            """
                            UPDATE staging.ghana_grid_assets
                            SET operating_utility = %s::ghana_utility_enum,
                                substation_name = COALESCE(%s, substation_name),
                                asset_kind = %s
                            WHERE mrid = %s
                            """,
                            (
                                payload.operating_utility,
                                payload.substation_name or payload.name,
                                payload.asset_kind,
                                mrid,
                            ),
                        )
                        log_lineage(
                            conn,
                            target_mrid=mrid,
                            source_type="FIELD_SYNC",
                            action_type="FIELD_RECAPTURE",
                            operator_id=payload.operator_id,
                            provenance_ref="POST /api/v1/field/nodes",
                            after_state=proposed,
                        )
                        conn.commit()
                        result = {
                            "mrid": mrid,
                            "validation": "PENDING_FIELD",
                            "tier": "staging",
                            "name": payload.name,
                            "longitude": payload.longitude,
                            "latitude": payload.latitude,
                            "boundary_feeder_id": payload.boundary_feeder_id,
                            "asset_kind": payload.asset_kind,
                            "recaptured": True,
                        }
                        if payload.idempotency_key:
                            store_idempotent_response(
                                idempotency_key("field-nodes", payload.idempotency_key),
                                result,
                            )
                        invalidate_after_staging_write()
                        return result
                    raise HTTPException(
                        status_code=400,
                        detail=f"Asset {mrid} already exists; use conflict flow if updating",
                    )
                if tier == "master":
                    raise HTTPException(
                        status_code=400,
                        detail=f"Asset {mrid} already exists in master",
                    )

            set_lineage_context(conn, skip=True)
            cur.execute(
                """
                INSERT INTO staging.identified_objects (
                  mrid, name, lifecycle_state, validation, submitted_by,
                  work_order_id, photo_url
                )
                VALUES (%s, %s, 'IN_SERVICE', 'PENDING_FIELD', %s, %s, %s)
                """,
                (
                    mrid,
                    payload.name,
                    payload.operator_id,
                    payload.work_order_id,
                    payload.photo_url,
                ),
            )
            cur.execute(
                """
                INSERT INTO staging.connectivity_nodes (mrid, boundary_feeder_id, geom)
                VALUES (
                  %s, %s,
                  ST_SetSRID(ST_MakePoint(%s, %s), 4326)
                )
                """,
                (mrid, feeder_id, payload.longitude, payload.latitude),
            )
            cur.execute(
                """
                INSERT INTO staging.ghana_grid_assets (
                  mrid, operating_utility, substation_name, asset_kind
                )
                VALUES (%s, %s::ghana_utility_enum, %s, %s)
                """,
                (mrid, payload.operating_utility, substation, payload.asset_kind),
            )
            log_lineage(
                conn,
                target_mrid=mrid,
                source_type="FIELD_SYNC",
                action_type="FIELD_CAPTURE",
                operator_id=payload.operator_id,
                provenance_ref="POST /api/v1/field/nodes",
                after_state=proposed,
            )
            run_asset_checks(conn, mrid, "staging")
            conn.commit()
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    finally:
        conn.close()

    result = {
        "mrid": mrid,
        "validation": "PENDING_FIELD",
        "tier": "staging",
        "name": payload.name,
        "longitude": payload.longitude,
        "latitude": payload.latitude,
        "boundary_feeder_id": feeder_id,
        "asset_kind": payload.asset_kind,
    }
    if payload.idempotency_key:
        store_idempotent_response(
            idempotency_key("field-nodes", payload.idempotency_key),
            result,
        )
    invalidate_after_staging_write()
    return result


@app.get("/api/v1/field/snap-point")
async def get_field_snap_point(
    lat: float = Query(..., ge=-90, le=90),
    lng: float = Query(..., ge=-180, le=180),
    snap_m: float = Query(default=15.0, ge=1, le=100),
):
    if not SUPABASE_DB_URI:
        raise HTTPException(status_code=500, detail="SUPABASE_DB_URI not configured")
    try:
        conn = pooled_connect(SUPABASE_DB_URI)
        try:
            return snap_placement_point(conn, longitude=lng, latitude=lat, snap_m=snap_m)
        finally:
            conn.close()
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.get("/api/v1/field/nearby-check")
async def get_field_nearby_check(
    lat: float = Query(..., ge=-90, le=90),
    lng: float = Query(..., ge=-180, le=180),
    radius_m: float = Query(default=5.0, ge=1, le=50),
    limit: int = Query(default=10, ge=1, le=50),
):
    if not SUPABASE_DB_URI:
        raise HTTPException(status_code=500, detail="SUPABASE_DB_URI not configured")
    try:
        conn = pooled_connect(SUPABASE_DB_URI)
        try:
            hits = nearby_assets(
                conn, longitude=lng, latitude=lat, radius_m=radius_m, limit=limit
            )
        finally:
            conn.close()
        return {"hits": hits, "duplicate_warning": len(hits) > 0}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.get("/api/v1/field/lookup/feeders")
async def get_field_feeder_lookup(
    q: str | None = Query(default=None, max_length=100),
    limit: int = Query(default=50, ge=1, le=200),
):
    if not SUPABASE_DB_URI:
        raise HTTPException(status_code=500, detail="SUPABASE_DB_URI not configured")
    try:
        conn = pooled_connect(SUPABASE_DB_URI)
        try:
            feeders = distinct_feeders(conn, q=q, limit=limit)
        finally:
            conn.close()
        return {"feeders": feeders}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.get("/api/v1/field/lookup/substations")
async def get_field_substation_lookup(
    q: str | None = Query(default=None, max_length=100),
    limit: int = Query(default=50, ge=1, le=200),
):
    if not SUPABASE_DB_URI:
        raise HTTPException(status_code=500, detail="SUPABASE_DB_URI not configured")
    try:
        conn = pooled_connect(SUPABASE_DB_URI)
        try:
            substations = distinct_substations(conn, q=q, limit=limit)
        finally:
            conn.close()
        return {"substations": substations}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.get("/api/v1/assets/staging/spans")
async def list_staging_spans_endpoint(
    submitted_by: str | None = Query(default=None),
):
    if not SUPABASE_DB_URI:
        raise HTTPException(status_code=500, detail="SUPABASE_DB_URI not configured")
    try:
        conn = pooled_connect(SUPABASE_DB_URI)
        try:
            spans = list_staging_spans(conn, submitted_by=submitted_by)
        finally:
            conn.close()
        return {"spans": spans}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.post("/api/v1/field/spans")
async def post_field_span(payload: FieldSpanPayload):
    if not SUPABASE_DB_URI:
        raise HTTPException(status_code=500, detail="SUPABASE_DB_URI not configured")
    try:
        conn = pooled_connect(SUPABASE_DB_URI)
        try:
            result = submit_field_span(
                conn,
                source_node_id=payload.source_node_id,
                target_node_id=payload.target_node_id,
                operator_id=payload.operator_id,
                boundary_feeder_id=payload.boundary_feeder_id,
                work_order_id=payload.work_order_id,
                name=payload.name,
            )
            conn.commit()
        finally:
            conn.close()
        invalidate_after_staging_write()
        return result
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.post("/api/v1/field/photos")
async def upload_field_photo(file: UploadFile = File(...)):
    content = await file.read()
    if not content:
        raise HTTPException(status_code=400, detail="Empty upload")
    if len(content) > 8 * 1024 * 1024:
        raise HTTPException(status_code=400, detail="Photo exceeds 8MB limit")
    suffix = Path(file.filename or "").suffix.lower()
    if suffix not in {".jpg", ".jpeg", ".png", ".webp", ""}:
        raise HTTPException(status_code=400, detail="Unsupported image type")
    if not suffix:
        suffix = ".jpg"
    try:
        url = save_field_photo(content, suffix=suffix)
        return {"photo_url": url}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.get("/api/v1/field/photos/{filename}")
async def get_field_photo(filename: str):
    if ".." in filename or "/" in filename:
        raise HTTPException(status_code=400, detail="Invalid filename")
    path = ensure_upload_dir() / filename
    if not path.is_file():
        raise HTTPException(status_code=404, detail="Photo not found")
    data = path.read_bytes()
    media = "image/jpeg"
    if filename.endswith(".png"):
        media = "image/png"
    elif filename.endswith(".webp"):
        media = "image/webp"
    return Response(content=data, media_type=media)


@app.post("/api/v1/field/location")
async def report_field_location(payload: FieldLocationPayload):
    """Upsert latest GPS position for a field technician."""
    if not SUPABASE_DB_URI:
        raise HTTPException(status_code=500, detail="SUPABASE_DB_URI not configured")
    try:
        conn = pooled_connect(SUPABASE_DB_URI)
        try:
            result = upsert_technician_position(
                conn,
                technician_id=payload.technician_id,
                longitude=payload.longitude,
                latitude=payload.latitude,
                display_name=payload.display_name,
                accuracy_m=payload.accuracy_m,
                heading_deg=payload.heading_deg,
                speed_mps=payload.speed_mps,
                work_order_id=payload.work_order_id,
                session_started_at=payload.session_started_at,
            )
            conn.commit()
        finally:
            conn.close()
        return result
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.get("/api/v1/field/technicians")
async def get_field_technicians(
    stale_minutes: int = Query(default=30, ge=1, le=240),
):
    """Active field technicians with latest positions and submission counts."""
    if not SUPABASE_DB_URI:
        raise HTTPException(status_code=500, detail="SUPABASE_DB_URI not configured")
    try:
        conn = pooled_connect(SUPABASE_DB_URI)
        try:
            technicians = list_active_technicians(conn, stale_minutes=stale_minutes)
        finally:
            conn.close()
        return {"technicians": technicians, "stale_minutes": stale_minutes}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.get("/api/v1/field/technicians/{technician_id}/submissions")
async def get_technician_submissions(
    technician_id: str,
    limit: int = Query(default=100, ge=1, le=500),
):
    """Staging assets submitted by a field technician."""
    if not SUPABASE_DB_URI:
        raise HTTPException(status_code=500, detail="SUPABASE_DB_URI not configured")
    try:
        conn = pooled_connect(SUPABASE_DB_URI)
        try:
            submissions = list_technician_submissions(conn, technician_id, limit=limit)
        finally:
            conn.close()
        return {"technician_id": technician_id, "submissions": submissions}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.post("/api/v1/field/device-tokens")
async def post_field_device_token(payload: DeviceTokenPayload):
    """Register FCM/APNs token for push (optional; polling fallback when unset)."""
    if not SUPABASE_DB_URI:
        raise HTTPException(status_code=500, detail="SUPABASE_DB_URI not configured")
    try:
        conn = pooled_connect(SUPABASE_DB_URI)
        try:
            result = register_device_token(
                conn,
                technician_id=payload.technician_id,
                token=payload.token,
                platform=payload.platform,
            )
            conn.commit()
        finally:
            conn.close()
        return result
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.get("/api/v1/field/notifications")
async def get_field_notifications(
    technician_id: str = Query(..., min_length=1),
    undelivered_only: bool = Query(default=True),
    limit: int = Query(default=50, ge=1, le=200),
):
    """Pending notifications for a field technician (poll from mobile)."""
    if not SUPABASE_DB_URI:
        raise HTTPException(status_code=500, detail="SUPABASE_DB_URI not configured")
    try:
        conn = pooled_connect(SUPABASE_DB_URI)
        try:
            notifications = list_technician_notifications(
                conn,
                technician_id,
                undelivered_only=undelivered_only,
                limit=limit,
            )
        finally:
            conn.close()
        return {"technician_id": technician_id, "notifications": notifications}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.post("/api/v1/field/notifications/{notification_id}/delivered")
async def post_notification_delivered(notification_id: str):
    if not SUPABASE_DB_URI:
        raise HTTPException(status_code=500, detail="SUPABASE_DB_URI not configured")
    try:
        conn = pooled_connect(SUPABASE_DB_URI)
        try:
            result = mark_notification_delivered(conn, notification_id)
            if not result:
                raise HTTPException(status_code=404, detail="Notification not found")
            conn.commit()
        finally:
            conn.close()
        return result
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.post("/api/v1/field/notifications/{notification_id}/read")
async def post_notification_read(
    notification_id: str,
    technician_id: str = Query(..., min_length=1),
):
    if not SUPABASE_DB_URI:
        raise HTTPException(status_code=500, detail="SUPABASE_DB_URI not configured")
    try:
        conn = pooled_connect(SUPABASE_DB_URI)
        try:
            result = mark_notification_read(conn, notification_id, technician_id)
            if not result:
                raise HTTPException(status_code=404, detail="Notification not found")
            conn.commit()
        finally:
            conn.close()
        return result
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.get("/api/v1/map/nodes")
async def get_map_nodes_near(
    lat: float = Query(..., ge=-90, le=90),
    lon: float = Query(..., ge=-180, le=180),
    limit: int = Query(default=500, ge=1, le=1000),
    prefer_wired: bool = Query(default=False),
):
    """Mobile map nodes — same data as Supabase nodes_near_location, via sync-service."""
    if not SUPABASE_DB_URI:
        raise HTTPException(status_code=500, detail="SUPABASE_DB_URI not configured")
    cache_key = map_nodes_key(lat, lon, limit, prefer_wired)
    cached = get_json(cache_key)
    if cached is not None:
        return cached
    try:
        conn = pooled_connect(SUPABASE_DB_URI)
        try:
            rows = await asyncio.to_thread(
                lambda: fetch_nodes_near_location(
                    conn,
                    lat=lat,
                    lon=lon,
                    limit=limit,
                    prefer_wired=prefer_wired,
                )
            )
            result = {"nodes": rows, "count": len(rows)}
            set_json(cache_key, result)
            return result
        finally:
            conn.close()
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


def _require_h3() -> None:
    if not h3x.H3_AVAILABLE:
        raise HTTPException(
            status_code=503,
            detail=(
                "H3 spatial index unavailable: "
                f"{h3x.H3_IMPORT_ERROR or 'h3 not installed'}. "
                "Install with: pip install -r sync-service/requirements.txt"
            ),
        )


@app.get("/api/v1/nodes/by-cells")
async def get_nodes_by_cells(
    cells: str | None = Query(default=None, description="Comma-separated H3 cells"),
    lat: float | None = Query(default=None, ge=-90, le=90),
    lng: float | None = Query(default=None, ge=-180, le=180),
    k: int = Query(default=1, ge=0, le=12),
    res: int = Query(default=h3x.DEFAULT_RES, ge=0, le=15),
    have: str | None = Query(default=None, description="Already-cached cells to skip"),
    limit: int = Query(default=4000, ge=1, le=20000),
    include_staging: bool = Query(default=True),
):
    """Stream master (+ optional staging) nodes for H3 cells.

    Either pass an explicit `cells` list, or `lat`/`lng` (+ `k`) to derive the
    ring server-side. `have` lists cells the client already cached so only the
    newly entered cells are queried and returned.
    """
    _require_h3()
    if not SUPABASE_DB_URI:
        raise HTTPException(status_code=500, detail="SUPABASE_DB_URI not configured")

    res = h3x.clamp_resolution(res)
    center_cell: str | None = None

    if cells:
        target_cells = [c.strip() for c in cells.split(",") if c.strip()]
    elif lat is not None and lng is not None:
        center_cell, target_cells = h3x.ring_cells(lat, lng, res, k)
    else:
        raise HTTPException(
            status_code=400,
            detail="Provide either `cells` or both `lat` and `lng`.",
        )

    target_cells = [c for c in target_cells if h3x.is_valid_cell(c)]
    if not target_cells:
        raise HTTPException(status_code=400, detail="No valid H3 cells in request.")

    have_set = {c.strip() for c in have.split(",")} if have else set()
    fetch_cells = [c for c in target_cells if c not in have_set]

    nodes: list[dict[str, Any]] = []
    if fetch_cells:
        cache_key = h3_cells_key(fetch_cells, res, limit, include_staging)
        cached = get_json(cache_key)
        if cached is not None:
            nodes = cached.get("nodes", [])
        else:
            conn = pooled_connect(SUPABASE_DB_URI)
            try:
                from h3_service import fetch_map_nodes_in_cells

                nodes = await asyncio.to_thread(
                    lambda: fetch_map_nodes_in_cells(
                        conn,
                        cells=fetch_cells,
                        res=res,
                        limit=limit,
                        include_staging=include_staging,
                    )
                )
                set_json(cache_key, {"nodes": nodes})
            finally:
                conn.close()

    return {
        "resolution": res,
        "center_cell": center_cell,
        "cells": target_cells,
        "fetched_cells": fetch_cells,
        "nodes": nodes,
        "count": len(nodes),
        "include_staging": include_staging,
    }


@app.get("/api/v1/h3/coverage")
async def get_h3_coverage(
    west: float = Query(..., ge=-180, le=180),
    south: float = Query(..., ge=-90, le=90),
    east: float = Query(..., ge=-180, le=180),
    north: float = Query(..., ge=-90, le=90),
    res: int = Query(default=8, ge=0, le=15),
    include_reference: bool = Query(default=True),
):
    """Per-hex rebuild coverage (verified / staged / reference) as GeoJSON."""
    _require_h3()
    if not SUPABASE_DB_URI:
        raise HTTPException(status_code=500, detail="SUPABASE_DB_URI not configured")
    if west >= east or south >= north:
        raise HTTPException(status_code=400, detail="Invalid bbox")

    res = h3x.clamp_resolution(res)
    cache_key = h3_coverage_key(west, south, east, north, res, include_reference)

    def _fetch():
        conn = pooled_connect(SUPABASE_DB_URI)
        try:
            return fetch_coverage(
                conn,
                west=west,
                south=south,
                east=east,
                north=north,
                res=res,
                include_reference=include_reference,
            )
        finally:
            conn.close()

    return await asyncio.to_thread(lambda: cached_json(cache_key, _fetch))


@app.get("/api/v1/h3/assignments")
async def get_h3_assignments(
    assigned_to: str | None = Query(default=None),
    status: str | None = Query(default=None),
):
    if not SUPABASE_DB_URI:
        raise HTTPException(status_code=500, detail="SUPABASE_DB_URI not configured")
    conn = pooled_connect(SUPABASE_DB_URI)
    try:
        items = await asyncio.to_thread(
            lambda: list_assignments(conn, assigned_to=assigned_to, status=status)
        )
        return {"assignments": items, "count": len(items)}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    finally:
        conn.close()


@app.get("/api/v1/h3/status")
async def get_h3_status():
    """Lightweight probe — present only on builds with territory/H3 routes."""
    return {
        "endpoints_ready": True,
        "h3_available": h3x.H3_AVAILABLE,
        "import_error": h3x.H3_IMPORT_ERROR,
        "default_res": h3x.DEFAULT_RES,
    }


@app.get("/api/v1/h3/cell-at")
async def get_h3_cell_at(
    lat: float = Query(..., ge=-90, le=90),
    lng: float = Query(..., ge=-180, le=180),
    res: int = Query(default=h3x.DEFAULT_RES, ge=0, le=15),
):
    """H3 cell for a map click (portal territory picker)."""
    _require_h3()
    res = h3x.clamp_resolution(res)
    return cell_at_point(lat, lng, res)


@app.get("/api/v1/h3/grid/geojson")
async def get_h3_grid_geojson(
    west: float = Query(..., ge=-180, le=180),
    south: float = Query(..., ge=-90, le=90),
    east: float = Query(..., ge=-180, le=180),
    north: float = Query(..., ge=-90, le=90),
    res: int = Query(default=h3x.DEFAULT_RES, ge=0, le=15),
    max_cells: int = Query(default=800, ge=1, le=2000),
):
    """Hex grid covering the viewport bbox (portal territory picker)."""
    _require_h3()
    if west >= east or south >= north:
        raise HTTPException(status_code=400, detail="Invalid bbox")
    res = h3x.clamp_resolution(res)
    cache_key = h3_grid_key(west, south, east, north, res, max_cells)
    return cached_json(
        cache_key,
        lambda: bbox_grid_geojson(west, south, east, north, res, max_cells=max_cells),
    )


@app.get("/api/v1/h3/assignments/geojson")
async def get_h3_assignments_geojson(
    assigned_to: str | None = Query(default=None),
    status: str | None = Query(
        default=None,
        description="Comma-separated statuses (e.g. ASSIGNED,IN_PROGRESS)",
    ),
):
    """Assignment hexagons as GeoJSON so the field app can draw a worker's territory."""
    _require_h3()
    if not SUPABASE_DB_URI:
        raise HTTPException(status_code=500, detail="SUPABASE_DB_URI not configured")
    statuses = [s for s in (status.split(",") if status else []) if s.strip()]
    cache_key = h3_assignments_geojson_key(assigned_to, status)

    def _fetch():
        conn = pooled_connect(SUPABASE_DB_URI)
        try:
            return assignments_geojson(
                conn, assigned_to=assigned_to, statuses=statuses
            )
        finally:
            conn.close()

    try:
        return await asyncio.to_thread(lambda: cached_json(cache_key, _fetch))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.post("/api/v1/h3/assignments/batch")
async def post_h3_assignments_batch(payload: H3BatchAssignmentPayload):
    """Assign multiple hex cells to one technician in one request."""
    _require_h3()
    if not SUPABASE_DB_URI:
        raise HTTPException(status_code=500, detail="SUPABASE_DB_URI not configured")
    conn = pooled_connect(SUPABASE_DB_URI)
    try:
        items = await asyncio.to_thread(
            lambda: batch_upsert_assignments(
                conn,
                h3_indexes=payload.h3_indexes,
                resolution=h3x.clamp_resolution(payload.resolution),
                assigned_to=payload.assigned_to,
                status=payload.status,
                note=payload.note,
            )
        )
        invalidate_h3_cache()
        return {"assignments": items, "count": len(items)}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    finally:
        conn.close()


@app.delete("/api/v1/h3/assignments")
async def delete_h3_assignments(payload: H3DeleteAssignmentsPayload):
    """Unassign hex cells (remove territory rows)."""
    if not SUPABASE_DB_URI:
        raise HTTPException(status_code=500, detail="SUPABASE_DB_URI not configured")
    conn = pooled_connect(SUPABASE_DB_URI)
    try:
        deleted = await asyncio.to_thread(
            lambda: delete_assignments(conn, payload.h3_indexes)
        )
        invalidate_h3_cache()
        return {"deleted": deleted}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    finally:
        conn.close()


@app.post("/api/v1/h3/assignments")
async def post_h3_assignment(payload: H3AssignmentPayload):
    _require_h3()
    if not SUPABASE_DB_URI:
        raise HTTPException(status_code=500, detail="SUPABASE_DB_URI not configured")
    if not h3x.is_valid_cell(payload.h3_index):
        raise HTTPException(status_code=400, detail="Invalid h3_index")
    conn = pooled_connect(SUPABASE_DB_URI)
    try:
        result = await asyncio.to_thread(
            lambda: upsert_assignment(
                conn,
                h3_index=payload.h3_index,
                resolution=payload.resolution,
                assigned_to=payload.assigned_to,
                status=payload.status,
                note=payload.note,
            )
        )
        invalidate_h3_cache()
        return result
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    finally:
        conn.close()


@app.get("/api/v1/nodes/{mrid}/connections")
async def get_node_connections(
    mrid: str,
    limit: int = Query(default=25, ge=1, le=100),
):
    """Indexed adjacency lookup for mobile map (fast alternative to Supabase RPC)."""
    if not SUPABASE_DB_URI:
        raise HTTPException(status_code=500, detail="SUPABASE_DB_URI not configured")
    cache_key = node_connections_key(mrid, limit)
    cached = get_json(cache_key)
    if cached is not None:
        return cached
    try:
        conn = pooled_connect(SUPABASE_DB_URI)
        try:
            result = await asyncio.to_thread(
                lambda: fetch_node_connections(conn, mrid, limit=limit)
            )
            set_json(cache_key, result)
            return result
        finally:
            conn.close()
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.post("/api/v1/nodes/connections/bulk")
async def get_bulk_node_connections(payload: BulkNodeConnectionsPayload):
    """Prefetch adjacency for many nodes (mobile offline topology cache)."""
    if not SUPABASE_DB_URI:
        raise HTTPException(status_code=500, detail="SUPABASE_DB_URI not configured")
    cache_key = bulk_connections_key(payload.mrids, payload.limit_per_node)
    cached = get_json(cache_key)
    if cached is not None:
        return cached
    try:
        conn = pooled_connect(SUPABASE_DB_URI)
        try:
            result = await asyncio.to_thread(
                lambda: fetch_bulk_node_connections(
                    conn,
                    payload.mrids,
                    limit_per_node=payload.limit_per_node,
                )
            )
            set_json(cache_key, result)
            return result
        finally:
            conn.close()
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.post("/api/v1/topology/repair")
async def repair_topology(payload: TopologyRepairPayload, background_tasks: BackgroundTasks):
    if not SUPABASE_DB_URI:
        raise HTTPException(status_code=500, detail="SUPABASE_DB_URI not configured")

    lock_name = repair_lock_key(payload.target_mrid)
    with lock(lock_name) as token:
        if token is None:
            raise HTTPException(
                status_code=409,
                detail=f"Repair already in progress for {payload.target_mrid}",
            )
        try:
            conn = pooled_connect(SUPABASE_DB_URI)
            try:
                with conn.cursor() as cur:
                    tier = _asset_tier(cur, payload.target_mrid)
                    if tier == "staging":
                        cur.execute(
                            """
                            SELECT staging.repair_asset_topology_and_attributes(
                              %s::uuid, %s, %s
                            )
                            """,
                            (payload.target_mrid, payload.radius_meters, payload.dry_run),
                        )
                    elif tier == "master":
                        cur.execute(
                            """
                            SELECT repair_asset_topology_and_attributes(
                              %s::uuid, %s, %s
                            )
                            """,
                            (payload.target_mrid, payload.radius_meters, payload.dry_run),
                        )
                    else:
                        raise HTTPException(
                            status_code=404,
                            detail=f"Asset {payload.target_mrid} not found in staging or master",
                        )
                    result = cur.fetchone()[0]
                    applied = result.get("applied") or []
                    if not payload.dry_run and tier == "master" and applied:
                        run_asset_checks(conn, payload.target_mrid, "master")
                        log_lineage(
                            conn,
                            target_mrid=payload.target_mrid,
                            source_type="REPAIR",
                            action_type="TOPOLOGY_REPAIR",
                            operator_id=payload.operator_id,
                            provenance_ref="POST /api/v1/topology/repair",
                            after_state={"result": result},
                        )
                    elif not payload.dry_run and tier == "staging":
                        if applied:
                            run_asset_checks(conn, payload.target_mrid, "staging")
                        log_lineage(
                            conn,
                            target_mrid=payload.target_mrid,
                            source_type="REPAIR",
                            action_type="TOPOLOGY_REPAIR",
                            operator_id=payload.operator_id,
                            provenance_ref="POST /api/v1/topology/repair",
                            after_state={"result": result},
                        )
                    conn.commit()
            finally:
                conn.close()
        except HTTPException:
            raise
        except Exception as exc:
            msg = str(exc)
            if "repair_asset_topology_and_attributes" in msg and "does not exist" in msg:
                raise HTTPException(
                    status_code=503,
                    detail="Migration 00035 not applied. Run: npx supabase migration up --local",
                ) from exc
            raise HTTPException(status_code=500, detail=msg) from exc

    if not payload.dry_run:
        invalidate_topology_cache()
        background_tasks.add_task(reconcile_memgraph, graph_driver)
    return {
        "status": "preview" if payload.dry_run else "repaired",
        "dry_run": payload.dry_run,
        "result": result,
    }


@app.get("/api/v1/topology/health")
async def topology_health():
    """Master topology quality summary (orphans, components, counts)."""
    cache_key = topology_health_key()
    cached = get_json(cache_key)
    if cached is not None:
        return cached
    try:
        payload = await asyncio.to_thread(topology_health_report)
        set_json(cache_key, payload)
        return payload
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.get("/api/v1/topology/gaps")
async def topology_gaps(
    limit: int = Query(default=2000, ge=1, le=10000),
    west: float | None = Query(default=None, ge=-180, le=180),
    south: float | None = Query(default=None, ge=-90, le=90),
    east: float | None = Query(default=None, ge=-180, le=180),
    north: float | None = Query(default=None, ge=-90, le=90),
):
    """Disconnected connectivity nodes (portal topology_gaps, data stewardship)."""
    if None not in (west, south, east, north) and (west >= east or south >= north):
        raise HTTPException(status_code=400, detail="Invalid bbox")
    cache_key = topology_gaps_key(limit, west, south, east, north)
    cached = get_json(cache_key)
    if cached is not None:
        return cached
    try:
        payload = await asyncio.to_thread(
            topology_gaps_payload,
            limit=limit,
            west=west,
            south=south,
            east=east,
            north=north,
        )
        set_json(cache_key, payload)
        return payload
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.get("/api/v1/topology/impact")
async def topology_impact(
    start_mrid: str = Query(..., min_length=36, max_length=36),
    max_nodes: int = Query(default=5000, ge=1, le=20000),
):
    """Downstream nodes and lines from a fault / outage seed (directed feeder walk)."""
    cache_key = topology_impact_key(start_mrid, max_nodes)
    cached = get_json(cache_key)
    if cached is not None:
        return cached
    try:
        payload = await asyncio.to_thread(
            downstream_impact_payload,
            start_mrid,
            max_nodes=max_nodes,
        )
        if not payload["nodes"]:
            raise HTTPException(status_code=404, detail=f"No nodes found for mrid {start_mrid}")
        set_json(cache_key, payload)
        return payload
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.patch("/api/v1/assets/{mrid}/validation")
async def update_asset_validation(
    mrid: str,
    payload: ValidationActionPayload,
    background_tasks: BackgroundTasks,
):
    if not SUPABASE_DB_URI:
        raise HTTPException(status_code=500, detail="SUPABASE_DB_URI not configured")

    try:
        conn = pooled_connect(SUPABASE_DB_URI)
        try:
            with conn.cursor() as cur:
                tier = _asset_tier(cur, mrid)
                if tier is None:
                    raise HTTPException(status_code=404, detail=f"Asset {mrid} not found")

                if tier == "staging" and payload.validation == "APPROVED":
                    cur.execute(
                        """
                        SELECT validation::text
                        FROM staging.identified_objects
                        WHERE mrid = %s::uuid
                        """,
                        (mrid,),
                    )
                    staging_row = cur.fetchone()
                    if not staging_row:
                        raise HTTPException(status_code=404, detail=f"Asset {mrid} not found")
                    if staging_row[0] != "STAGED":
                        raise HTTPException(
                            status_code=400,
                            detail=(
                                f"Asset {mrid} must be released from Data Quality before "
                                f"promotion (validation={staging_row[0]})"
                            ),
                        )
                    run_asset_checks(conn, mrid, "staging")
                    blocking = count_blocking_open(conn, mrid)
                    if blocking and not payload.override_data_quality:
                        conn.commit()
                        return JSONResponse(
                            status_code=422,
                            content={
                                "detail": "Blocked by open data-quality exceptions",
                                "mrid": mrid,
                                "blocking_exceptions": blocking,
                            },
                        )
                    if payload.operator_id:
                        set_lineage_context(conn, operator_id=payload.operator_id)
                    cur.execute(
                        "SELECT 1 FROM staging.ac_line_segments WHERE mrid = %s::uuid",
                        (mrid,),
                    )
                    is_line = cur.fetchone() is not None
                    if is_line:
                        cur.execute(
                            "SELECT promote_staged_line_segment(%s::uuid)",
                            (mrid,),
                        )
                    else:
                        cur.execute("SELECT promote_staged_asset(%s::uuid)", (mrid,))
                    result = cur.fetchone()[0]
                    conn.commit()
                    invalidate_after_promote()
                    # National reconcile is heavy — never block the approve response.
                    background_tasks.add_task(reconcile_memgraph, graph_driver)
                    return {
                        "mrid": result["mrid"],
                        "validation": result["validation"],
                        "promoted": result.get("promoted", True),
                        "tier": "master",
                    }

                if tier == "staging" and payload.validation == "REJECTED":
                    cur.execute(
                        """
                        SELECT io.name, io.validation::text, io.error_log, io.submitted_by,
                               ST_X(cn.geom) AS lon, ST_Y(cn.geom) AS lat
                        FROM staging.identified_objects io
                        JOIN staging.connectivity_nodes cn ON cn.mrid = io.mrid
                        WHERE io.mrid = %s
                        """,
                        (mrid,),
                    )
                    before = cur.fetchone()
                    if not before:
                        raise HTTPException(status_code=404, detail=f"Asset {mrid} not found")
                    if before[1] not in ("PENDING_FIELD", "STAGED", "IN_CONFLICT"):
                        raise HTTPException(
                            status_code=400,
                            detail=f"Asset {mrid} cannot be rejected (validation={before[1]})",
                        )
                    reason = (payload.reason or "").strip()
                    error_log = before[2] or ""
                    if reason:
                        error_log = f"{error_log}\n[{datetime.utcnow().isoformat()}Z] REJECTED: {reason}".strip()
                    set_lineage_context(conn, skip=True)
                    cur.execute(
                        """
                        UPDATE staging.identified_objects
                        SET validation = 'REJECTED',
                            error_log = %s,
                            updated_at = NOW()
                        WHERE mrid = %s
                        RETURNING mrid, name, validation::text
                        """,
                        (error_log or None, mrid),
                    )
                    row = cur.fetchone()
                    log_lineage(
                        conn,
                        target_mrid=mrid,
                        source_type="FIELD_SYNC",
                        action_type="FIELD_REJECTED",
                        operator_id=payload.operator_id,
                        provenance_ref="PATCH /api/v1/assets/{mrid}/validation",
                        before_state={
                            "name": before[0],
                            "validation": before[1],
                            "longitude": before[4],
                            "latitude": before[5],
                        },
                        after_state={"validation": "REJECTED", "reason": reason or None},
                    )
                    submitted_by = before[3]
                    asset_name = before[0] or row[1]
                    push_payload = {
                        "mrid": mrid,
                        "name": asset_name,
                        "reason": reason or None,
                        "message_type": "ASSET_REJECTED",
                        "latitude": before[5],
                        "longitude": before[4],
                    }
                    push_title = "Asset rejected"
                    push_body = f'"{asset_name or mrid}" was rejected by backoffice.'
                    if reason:
                        push_body = f"{push_body} Reason: {reason}"
                    notify_asset_rejected(
                        conn,
                        mrid=mrid,
                        name=asset_name,
                        submitted_by=submitted_by,
                        reason=reason or None,
                        latitude=before[5],
                        longitude=before[4],
                    )
                    conn.commit()
                    invalidate_after_staging_write()
                    background_tasks.add_task(
                        _push_rejection_notification,
                        submitted_by,
                        push_title,
                        push_body,
                        push_payload,
                    )
                    return {"mrid": row[0], "name": row[1], "validation": row[2], "tier": tier}

                table = "staging.identified_objects" if tier == "staging" else "public.identified_objects"
                cur.execute(
                    f"""
                    UPDATE {table}
                    SET validation = %s::staging_validation_state, updated_at = NOW()
                    WHERE mrid = %s
                    RETURNING mrid, name, validation::text
                    """,
                    (payload.validation, mrid),
                )
                row = cur.fetchone()
                if not row:
                    raise HTTPException(status_code=404, detail=f"Asset {mrid} not found")
                conn.commit()
        finally:
            conn.close()
        return {"mrid": row[0], "name": row[1], "validation": row[2], "tier": tier}
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.patch("/api/v1/assets/{mrid}")
async def update_asset(mrid: str, payload: AssetUpdatePayload):
    if not SUPABASE_DB_URI:
        raise HTTPException(status_code=500, detail="SUPABASE_DB_URI not configured")
    try:
        conn = pooled_connect(SUPABASE_DB_URI)
        try:
            with conn.cursor() as cur:
                tier = _asset_tier(cur, mrid)
                if tier is None:
                    raise HTTPException(status_code=404, detail=f"Asset {mrid} not found")

                if payload.offline_session_started_at:
                    server_updated = fetch_asset_updated_at(conn, mrid, tier)
                    session_start = datetime.fromisoformat(
                        payload.offline_session_started_at.replace("Z", "+00:00")
                    )
                    if server_updated and server_updated > session_start:
                        conflict_id = insert_conflict_proposal(
                            conn,
                            asset_mrid=mrid,
                            offline_session_started_at=payload.offline_session_started_at,
                            server_updated_at=server_updated,
                            proposed_payload=payload.model_dump(),
                        )
                        conn.commit()
                        invalidate_ops_cache()
                        return JSONResponse(
                            status_code=409,
                            content={
                                "detail": "Server record newer than offline session",
                                "conflict_id": conflict_id,
                                "asset_mrid": mrid,
                            },
                        )

                table = "staging.identified_objects" if tier == "staging" else "public.identified_objects"
                set_lineage_context(conn, skip=True)
                cur.execute(f"SELECT row_to_json(t)::jsonb FROM {table} t WHERE mrid = %s", (mrid,))
                before_row = cur.fetchone()
                cur.execute(
                    f"UPDATE {table} SET name = %s, updated_at = NOW() WHERE mrid = %s RETURNING mrid, name",
                    (payload.name, mrid),
                )
                row = cur.fetchone()
                if not row:
                    raise HTTPException(status_code=404, detail=f"Asset {mrid} not found")
                log_lineage(
                    conn,
                    target_mrid=mrid,
                    source_type="MANUAL_EDIT",
                    action_type="NAME_UPDATE",
                    provenance_ref="PATCH /api/v1/assets",
                    before_state=before_row[0] if before_row else None,
                    after_state={"name": payload.name},
                )
                conn.commit()
        finally:
            conn.close()
        return {"mrid": row[0], "name": row[1], "tier": tier}
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.patch("/api/v1/assets/{mrid}/equipment")
async def update_asset_equipment(mrid: str, payload: EquipmentUpdatePayload):
    if not SUPABASE_DB_URI:
        raise HTTPException(status_code=500, detail="SUPABASE_DB_URI not configured")
    try:
        conn = pooled_connect(SUPABASE_DB_URI)
        try:
            with conn.cursor() as cur:
                tier = _asset_tier(cur, mrid)
                if tier is None:
                    raise HTTPException(status_code=404, detail=f"Asset {mrid} not found")
                schema = "staging" if tier == "staging" else "public"
                cur.execute(f"SELECT row_to_json(t)::jsonb FROM {schema}.conducting_equipment t WHERE mrid = %s", (mrid,))
                before_row = cur.fetchone()
                set_lineage_context(
                    conn,
                    source_type="MANUAL_EDIT",
                    operator_id=payload.operator_id,
                    provenance_ref="PATCH /api/v1/assets/{mrid}/equipment",
                )
                cur.execute(
                    f"""
                    UPDATE {schema}.conducting_equipment
                    SET nominal_voltage = %s
                    WHERE mrid = %s
                    RETURNING mrid, nominal_voltage::text
                    """,
                    (payload.nominal_voltage, mrid),
                )
                row = cur.fetchone()
                if not row:
                    raise HTTPException(
                        status_code=404,
                        detail=f"No conducting equipment for asset {mrid}",
                    )
                conn.commit()
        finally:
            conn.close()
        return {"mrid": row[0], "nominal_voltage": row[1], "tier": tier}
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.post("/api/v1/m2c/spot-bill-sync")
async def sync_spot_bill(payload: SpotBillPayload, background_tasks: BackgroundTasks):
    if not SUPABASE_DB_URI:
        raise HTTPException(status_code=500, detail="SUPABASE_DB_URI not configured")

    if payload.current_reading_kwh <= payload.previous_reading_kwh:
        raise HTTPException(status_code=400, detail="current_reading_kwh must exceed previous_reading_kwh")

    try:
        conn = pooled_connect(SUPABASE_DB_URI)
        try:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    INSERT INTO spot_billing_records (
                      account_mrid, meter_mrid, previous_reading_kwh,
                      current_reading_kwh, tariff_rate_ghs, field_technician, evidence_photo_url
                    ) VALUES (%s, %s, %s, %s, %s, %s, %s)
                    RETURNING id, net_consumption_kwh, amount_ghs
                    """,
                    (
                        payload.account_mrid,
                        payload.meter_mrid,
                        payload.previous_reading_kwh,
                        payload.current_reading_kwh,
                        payload.tariff_rate_ghs,
                        payload.field_technician,
                        payload.evidence_photo_url,
                    ),
                )
                bill = cur.fetchone()
                cur.execute(
                    "SELECT balance_ghs FROM customer_accounts WHERE account_mrid = %s",
                    (payload.account_mrid,),
                )
                balance = cur.fetchone()
                inspection_id = None
                if payload.evidence_photo_url and payload.meter_mrid:
                    cur.execute(
                        """
                        INSERT INTO field_inspections (
                          asset_mrid, evidence_photo_url, ai_validation_status
                        ) VALUES (%s::uuid, %s, 'PENDING')
                        RETURNING id::text
                        """,
                        (payload.meter_mrid, payload.evidence_photo_url),
                    )
                    inspection_row = cur.fetchone()
                    inspection_id = inspection_row[0] if inspection_row else None
                conn.commit()
        finally:
            conn.close()

        ai_status = "QUEUED"
        if inspection_id:
            background_tasks.add_task(
                _validate_inspection_background,
                inspection_id,
                payload.evidence_photo_url,
            )
            ai_status = "PENDING"

        return {
            "status": "synced",
            "bill_id": str(bill[0]),
            "net_consumption_kwh": float(bill[1]),
            "amount_ghs": float(bill[2]),
            "account_balance_ghs": float(balance[0]) if balance else None,
            "ai_validation_status": ai_status,
            "inspection_id": inspection_id,
        }
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.post("/api/v1/inspections")
async def create_inspection(payload: InspectionCreatePayload, background_tasks: BackgroundTasks):
    if not SUPABASE_DB_URI:
        raise HTTPException(status_code=500, detail="SUPABASE_DB_URI not configured")
    try:
        conn = pooled_connect(SUPABASE_DB_URI)
        try:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    INSERT INTO field_inspections (
                      asset_mrid, evidence_photo_url, nameplate_photo_url,
                      inspector_notes, ai_validation_status
                    ) VALUES (%s::uuid, %s, %s, %s, 'PENDING')
                    RETURNING id::text, ai_validation_status
                    """,
                    (
                        payload.asset_mrid,
                        payload.evidence_photo_url,
                        payload.nameplate_photo_url,
                        payload.inspector_notes,
                    ),
                )
                row = cur.fetchone()
                conn.commit()
        finally:
            conn.close()
        inspection_id = row[0]
        photo = payload.evidence_photo_url or payload.nameplate_photo_url
        if photo:
            background_tasks.add_task(_validate_inspection_background, inspection_id, photo)
        return {"id": inspection_id, "ai_validation_status": row[1]}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.get("/api/v1/inspections")
async def list_inspections(asset_mrid: str | None = Query(default=None)):
    if not SUPABASE_DB_URI:
        raise HTTPException(status_code=500, detail="SUPABASE_DB_URI not configured")
    try:
        conn = pooled_connect(SUPABASE_DB_URI)
        try:
            with conn.cursor() as cur:
                if asset_mrid:
                    cur.execute(
                        """
                        SELECT id::text, asset_mrid::text, ai_validation_status,
                               evidence_photo_url, inspected_at
                        FROM field_inspections
                        WHERE asset_mrid = %s::uuid
                        ORDER BY inspected_at DESC
                        LIMIT 50
                        """,
                        (asset_mrid,),
                    )
                else:
                    cur.execute(
                        """
                        SELECT id::text, asset_mrid::text, ai_validation_status,
                               evidence_photo_url, inspected_at
                        FROM field_inspections
                        ORDER BY inspected_at DESC
                        LIMIT 100
                        """
                    )
                rows = cur.fetchall()
        finally:
            conn.close()
        return {
            "inspections": [
                {
                    "id": r[0],
                    "asset_mrid": r[1],
                    "ai_validation_status": r[2],
                    "evidence_photo_url": r[3],
                    "inspected_at": r[4].isoformat() if r[4] else None,
                }
                for r in rows
            ]
        }
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.post("/api/v1/inspections/{inspection_id}/validate")
async def validate_inspection(inspection_id: str, background_tasks: BackgroundTasks):
    if not SUPABASE_DB_URI:
        raise HTTPException(status_code=500, detail="SUPABASE_DB_URI not configured")
    try:
        conn = pooled_connect(SUPABASE_DB_URI)
        try:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    SELECT evidence_photo_url, nameplate_photo_url
                    FROM field_inspections WHERE id = %s::uuid
                    """,
                    (inspection_id,),
                )
                row = cur.fetchone()
                if not row:
                    raise HTTPException(status_code=404, detail="Inspection not found")
                cur.execute(
                    "UPDATE field_inspections SET ai_validation_status = 'PENDING' WHERE id = %s::uuid",
                    (inspection_id,),
                )
                conn.commit()
        finally:
            conn.close()
        photo = row[0] or row[1]
        background_tasks.add_task(_validate_inspection_background, inspection_id, photo)
        return {"id": inspection_id, "ai_validation_status": "PENDING"}
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.get("/api/v1/assets/master")
async def list_master_assets_bbox(
    west: float = Query(..., ge=-180, le=180),
    south: float = Query(..., ge=-90, le=90),
    east: float = Query(..., ge=-180, le=180),
    north: float = Query(..., ge=-90, le=90),
    limit: int = Query(default=500, ge=1, le=5000),
):
    if west >= east or south >= north:
        raise HTTPException(status_code=400, detail="Invalid bbox")
    if not SUPABASE_DB_URI:
        raise HTTPException(status_code=500, detail="SUPABASE_DB_URI not configured")
    cache_key = assets_master_key(west, south, east, north, limit)

    def _fetch():
        conn = pooled_connect(SUPABASE_DB_URI)
        try:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    SELECT cn.mrid::text, io.name, io.validation::text,
                           ST_AsGeoJSON(cn.geom)::json
                    FROM public.connectivity_nodes cn
                    JOIN public.identified_objects io ON cn.mrid = io.mrid
                    WHERE cn.geom && ST_MakeEnvelope(%s, %s, %s, %s, 4326)
                    ORDER BY io.name
                    LIMIT %s
                    """,
                    (west, south, east, north, limit),
                )
                rows = cur.fetchall()
        finally:
            conn.close()
        return {
            "assets": [
                {"mrid": r[0], "name": r[1], "validation": r[2], "geom": r[3]}
                for r in rows
            ]
        }

    try:
        return cached_json(cache_key, _fetch)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.get("/api/v1/map/geocode")
async def api_map_geocode(
    q: str = Query(..., min_length=2, max_length=120),
    limit: int = Query(default=6, ge=1, le=10),
):
    """OSM place names (towns, suburbs) not in ECG district boundaries — e.g. Gbawe."""
    try:
        return {"query": q, "results": geocode_map_places(q, limit=limit)}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.get("/api/v1/map/places-index")
async def api_map_places_index():
    """District/region centroids and bboxes — fetched once; map search runs client-side."""
    if not SUPABASE_DB_URI:
        raise HTTPException(status_code=500, detail="SUPABASE_DB_URI not configured")
    cache_key = "map:places-index:v1"

    def _fetch():
        conn = pooled_connect(SUPABASE_DB_URI)
        try:
            return {"places": list_places_index(conn)}
        finally:
            conn.close()

    try:
        return cached_json(cache_key, _fetch, ttl_sec=3600)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.get("/api/v1/map/search")
async def api_map_search(
    q: str = Query(..., min_length=2, max_length=120),
    limit: int = Query(default=12, ge=1, le=30),
    kind: str | None = Query(default=None, description="Comma-separated: asset,place,work_order,crew"),
):
    """Spotlight search for map navigation — assets, districts, work orders, crews."""
    if not SUPABASE_DB_URI:
        raise HTTPException(status_code=500, detail="SUPABASE_DB_URI not configured")
    kinds: set[str] | None = None
    if kind:
        parsed = {k.strip() for k in kind.split(",") if k.strip()}
        invalid = parsed - SEARCH_KINDS
        if invalid:
            raise HTTPException(status_code=400, detail=f"Invalid kind: {', '.join(sorted(invalid))}")
        kinds = parsed or None
    try:
        conn = pooled_connect(SUPABASE_DB_URI)
        try:
            results = search_map(conn, query=q, limit=limit, kinds=kinds)
        finally:
            conn.close()
        return {"query": q, "results": results}
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.get("/api/v1/assets/{mrid}")
async def get_asset_detail(mrid: str):
    """Single connectivity node — master or staging — for map identify and focus."""
    if not SUPABASE_DB_URI:
        raise HTTPException(status_code=500, detail="SUPABASE_DB_URI not configured")
    cache_key = asset_detail_key(mrid)
    cached = get_json(cache_key)
    if cached is not None:
        return cached
    try:
        conn = pooled_connect(SUPABASE_DB_URI)
        try:
            with conn.cursor() as cur:
                tier = _asset_tier(cur, mrid)
                if tier is None:
                    raise HTTPException(status_code=404, detail=f"Asset {mrid} not found")
                if tier == "staging":
                    cur.execute(
                        """
                        SELECT cn.mrid::text, io.name, io.validation::text,
                               ST_X(cn.geom) AS longitude, ST_Y(cn.geom) AS latitude,
                               cn.boundary_feeder_id,
                               NULL::text AS nominal_voltage
                        FROM staging.connectivity_nodes cn
                        JOIN staging.identified_objects io ON io.mrid = cn.mrid
                        WHERE cn.mrid = %s::uuid
                        """,
                        (mrid,),
                    )
                else:
                    cur.execute(
                        """
                        SELECT cn.mrid::text, io.name, io.validation::text,
                               ST_X(cn.geom) AS longitude, ST_Y(cn.geom) AS latitude,
                               cn.boundary_feeder_id,
                               ce.nominal_voltage::text
                        FROM public.connectivity_nodes cn
                        JOIN public.identified_objects io ON io.mrid = cn.mrid
                        LEFT JOIN public.conducting_equipment ce ON ce.mrid = cn.mrid
                        WHERE cn.mrid = %s::uuid
                        """,
                        (mrid,),
                    )
                row = cur.fetchone()
                if not row:
                    raise HTTPException(status_code=404, detail=f"Asset {mrid} not found")
        finally:
            conn.close()
        result = {
            "mrid": row[0],
            "name": row[1],
            "validation": row[2],
            "longitude": float(row[3]) if row[3] is not None else None,
            "latitude": float(row[4]) if row[4] is not None else None,
            "boundary_feeder_id": row[5],
            "nominal_voltage": row[6],
            "tier": tier,
        }
        set_json(cache_key, result)
        return result
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.get("/api/v1/trace")
async def execute_trace(
    start_mrid: str | None = Query(default=None),
    scope: TraceScope = Query(default="traced"),
    max_hops: int = Query(default=TRACE_MAX_HOPS, ge=1, le=20),
    max_nodes: int = Query(default=TRACE_MAX_NODES, ge=100, le=20000),
):
    """Bounded network trace from a seed node.

    Never walks the full national graph: results are capped by hop/node/edge
    limits. ``scope=full`` on large networks automatically falls back to a
    viewport-bounded PostGIS chunk around the seed.
    """
    if not start_mrid:
        raise HTTPException(status_code=400, detail="start_mrid query parameter is required")

    cache_key = trace_key(start_mrid, scope, max_hops, max_nodes)
    cached = get_json(cache_key)
    if cached is not None:
        return cached

    try:
        payload = await asyncio.to_thread(
            _trace_payload_blocking,
            start_mrid,
            scope,
            max_hops=max_hops,
            max_nodes=max_nodes,
        )

        if not payload["nodes"]:
            raise HTTPException(
                status_code=404,
                detail=f"No connectivity nodes in graph (start_mrid={start_mrid})",
            )

        set_json(cache_key, payload)
        return payload
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.get("/api/v1/graph/chunk")
async def graph_chunk(
    west: float = Query(..., ge=-180, le=180),
    south: float = Query(..., ge=-90, le=90),
    east: float = Query(..., ge=-180, le=180),
    north: float = Query(..., ge=-90, le=90),
    limit: int = Query(default=2000, ge=1, le=5000),
    edge_limit: int = Query(default=5000, ge=1, le=10000),
    start_mrid: str | None = Query(default=None),
):
    if west >= east or south >= north:
        raise HTTPException(status_code=400, detail="Invalid bbox: west < east and south < north required")

    cache_key = graph_chunk_key(west, south, east, north, limit, edge_limit, start_mrid)
    cached = get_json(cache_key)
    if cached is not None:
        return cached

    traced_mrids: set[str] = set()
    if start_mrid:
        try:
            traced_mrids = await asyncio.to_thread(_graph_chunk_traced_mrids_blocking, start_mrid)
        except Exception as exc:
            raise HTTPException(status_code=500, detail=str(exc)) from exc

    try:
        payload = await asyncio.to_thread(
            _fetch_graph_chunk_from_postgres,
            west,
            south,
            east,
            north,
            limit,
            traced_mrids,
            edge_limit,
        )
        set_json(cache_key, payload)
        return payload
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.get("/api/v1/lineage")
async def get_lineage(
    asset_mrid: str = Query(...),
    limit: int = Query(default=50, ge=1, le=200),
):
    if not SUPABASE_DB_URI:
        raise HTTPException(status_code=500, detail="SUPABASE_DB_URI not configured")
    try:
        conn = pooled_connect(SUPABASE_DB_URI)
        try:
            events = fetch_lineage(conn, asset_mrid, limit)
        finally:
            conn.close()
        return {"asset_mrid": asset_mrid, "events": events}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.get("/api/v1/lineage/search")
async def search_lineage_endpoint(
    asset_mrid: str | None = Query(default=None),
    source_type: str | None = Query(default=None),
    action_type: str | None = Query(default=None),
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0, le=5000),
):
    if not SUPABASE_DB_URI:
        raise HTTPException(status_code=500, detail="SUPABASE_DB_URI not configured")
    try:
        conn = pooled_connect(SUPABASE_DB_URI)
        try:
            events = search_lineage(
                conn,
                asset_mrid=asset_mrid,
                source_type=source_type,
                action_type=action_type,
                limit=limit,
                offset=offset,
            )
        finally:
            conn.close()
        return {"events": events, "count": len(events)}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.get("/api/v1/dq/rules")
async def get_dq_rules():
    if not SUPABASE_DB_URI:
        raise HTTPException(status_code=500, detail="SUPABASE_DB_URI not configured")

    def _fetch():
        conn = pooled_connect(SUPABASE_DB_URI)
        try:
            return {"rules": dq_list_rules(conn)}
        finally:
            conn.close()

    try:
        return cached_json(dq_rules_key(), _fetch, RULES_CACHE_TTL_SEC)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.get("/api/v1/dq/summary")
async def get_dq_summary(
    tier: Literal["master", "staging", "all"] = Query(default="all"),
):
    if not SUPABASE_DB_URI:
        raise HTTPException(status_code=500, detail="SUPABASE_DB_URI not configured")

    def _fetch():
        conn = pooled_connect(SUPABASE_DB_URI)
        try:
            return dq_summary(conn, tier=None if tier == "all" else tier)
        finally:
            conn.close()

    try:
        return cached_json(dq_summary_key(tier), _fetch, OPS_CACHE_TTL_SEC)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.get("/api/v1/dq/exceptions")
async def get_dq_exceptions(
    status: str | None = Query(default="OPEN"),
    severity: str | None = Query(default=None),
    domain: str | None = Query(default=None),
    record_mrid: str | None = Query(default=None),
    queue: Literal["dq", "operations", "all"] = Query(default="dq"),
    limit: int = Query(default=50, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
):
    if not SUPABASE_DB_URI:
        raise HTTPException(status_code=500, detail="SUPABASE_DB_URI not configured")
    cache_key = dq_exceptions_key(status, severity, domain, record_mrid, limit, queue, offset)

    def _fetch():
        conn = pooled_connect(SUPABASE_DB_URI)
        try:
            status_val = None if status in (None, "ALL") else status
            queue_val = None if queue == "all" else queue
            total = count_exceptions(
                conn,
                status=status_val,
                severity=severity,
                domain=domain,
                record_mrid=record_mrid,
                queue=queue_val,
            )
            items = dq_list_exceptions(
                conn,
                status=status_val,
                severity=severity,
                domain=domain,
                record_mrid=record_mrid,
                queue=queue_val,
                limit=limit,
                offset=offset,
            )
            return {
                "exceptions": items,
                "count": len(items),
                "total": total,
                "offset": offset,
                "limit": limit,
            }
        finally:
            conn.close()

    try:
        return cached_json(cache_key, _fetch, OPS_CACHE_TTL_SEC)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.get("/api/v1/dq/queue")
async def get_dq_queue(
    validation: Literal["PENDING_FIELD", "IN_CONFLICT"] | None = Query(default=None),
    exception_status: str | None = Query(default="ALL", alias="status"),
    severity: str | None = Query(default=None),
    domain: str | None = Query(default=None),
    duplicates_only: bool = Query(default=False),
    limit: int = Query(default=50, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
):
    """Staging captures in the DQ inbox (PENDING_FIELD / IN_CONFLICT), with nested exceptions."""
    if not SUPABASE_DB_URI:
        raise HTTPException(status_code=500, detail="SUPABASE_DB_URI not configured")
    status_val = None if exception_status in (None, "ALL") else exception_status
    cache_key = dq_queue_key(
        validation, status_val, severity, domain, limit, offset, duplicates_only,
    )

    def _fetch():
        conn = pooled_connect(SUPABASE_DB_URI)
        try:
            total = count_dq_queue(
                conn,
                validation=validation,
                exception_status=status_val,
                severity=severity,
                domain=domain,
                duplicates_only=duplicates_only,
            )
            items = list_dq_queue(
                conn,
                validation=validation,
                exception_status=status_val,
                severity=severity,
                domain=domain,
                duplicates_only=duplicates_only,
                limit=limit,
                offset=offset,
            )
            return {
                "items": items,
                "count": len(items),
                "total": total,
                "offset": offset,
                "limit": limit,
            }
        finally:
            conn.close()

    try:
        return cached_json(cache_key, _fetch, OPS_CACHE_TTL_SEC)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.post("/api/v1/dq/run")
async def run_dq_checks(mrid: str = Query(...), tier: str = Query(default="staging")):
    if not SUPABASE_DB_URI:
        raise HTTPException(status_code=500, detail="SUPABASE_DB_URI not configured")
    if tier not in ("staging", "master"):
        raise HTTPException(status_code=400, detail="tier must be staging or master")
    conn = pooled_connect(SUPABASE_DB_URI)
    try:
        result = run_asset_checks(conn, mrid, tier)
        conn.commit()
        invalidate_ops_cache()
        return result
    except Exception as exc:
        conn.rollback()
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    finally:
        conn.close()


@app.get("/api/v1/dq/topology/summary")
async def get_topology_dq_summary(
    west: float | None = Query(default=None),
    south: float | None = Query(default=None),
    east: float | None = Query(default=None),
    north: float | None = Query(default=None),
    mode: Literal["snapshot", "live"] = Query(default="snapshot"),
    tier: Literal["master", "staging"] = Query(default="master"),
):
    """Topology DQ summary for master or staging.

    Master ``mode=snapshot`` serves the last batch scan (fast). Staging is always
    computed live from field-capture tables.
    """
    if not SUPABASE_DB_URI:
        raise HTTPException(status_code=500, detail="SUPABASE_DB_URI not configured")
    clip = None
    if None not in (west, south, east, north):
        if west >= east or south >= north:
            raise HTTPException(status_code=400, detail="Invalid bbox")
        clip = {"west": west, "south": south, "east": east, "north": north}

    def _live():
        conn = pooled_connect(SUPABASE_DB_URI)
        try:
            return topology_dq_summary(conn, clip=clip, tier=tier)
        finally:
            conn.close()

    def _snapshot_or_live():
        conn = pooled_connect(SUPABASE_DB_URI)
        try:
            if tier == "staging":
                return latest_staging_topology_live(conn, clip=clip)
            snap = latest_topology_snapshot(conn)
            if snap is not None:
                return snap
            return topology_dq_summary(conn, clip=clip, tier="master")
        finally:
            conn.close()

    try:
        if mode == "live":
            return await asyncio.to_thread(_live)
        return await asyncio.to_thread(
            lambda: cached_json(
                topology_dq_summary_key(tier, mode),
                _snapshot_or_live,
                OPS_CACHE_TTL_SEC,
            )
        )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.get("/api/v1/ops/badges")
async def get_nav_badges():
    """Aggregated left-nav badge counts in a single cached call."""
    if not SUPABASE_DB_URI:
        raise HTTPException(status_code=500, detail="SUPABASE_DB_URI not configured")

    def _fetch():
        conn = pooled_connect(SUPABASE_DB_URI)
        try:
            return {"badges": collect_badge_counts(conn)}
        finally:
            conn.close()

    try:
        return await asyncio.to_thread(
            lambda: cached_json(nav_badges_key(), _fetch, OPS_CACHE_TTL_SEC)
        )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.post("/api/v1/dq/topology/scan")
async def run_topology_dq_scan(payload: TopologyDqScanPayload, background_tasks: BackgroundTasks):
    if not SUPABASE_DB_URI:
        raise HTTPException(status_code=500, detail="SUPABASE_DB_URI not configured")
    clip = payload.clip.model_dump() if payload.clip else None
    conn = pooled_connect(SUPABASE_DB_URI)
    try:
        run_id = create_topology_batch_run(
            conn,
            clip=clip,
            requested_by=payload.operator_id,
        )
        conn.commit()
    except Exception as exc:
        conn.rollback()
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    finally:
        conn.close()

    def _execute() -> None:
        if not SUPABASE_DB_URI:
            return
        bg = pooled_connect(SUPABASE_DB_URI)
        try:
            execute_topology_batch_scan(
                bg,
                run_id,
                clip=clip,
                requested_by=payload.operator_id,
            )
            bg.commit()
            invalidate_ops_cache()
            invalidate_topology_cache()
        except Exception:
            # Scan already marked the run failed and committed; log for ops.
            logging.getLogger(__name__).exception("Topology DQ scan %s failed", run_id)
        finally:
            bg.close()

    background_tasks.add_task(_execute)
    return {"run_id": run_id, "status": "running", "message": "Topology scan queued"}


@app.get("/api/v1/dq/topology/runs")
async def list_topology_dq_runs(limit: int = Query(default=20, ge=1, le=100)):
    if not SUPABASE_DB_URI:
        raise HTTPException(status_code=500, detail="SUPABASE_DB_URI not configured")
    conn = pooled_connect(SUPABASE_DB_URI)
    try:
        return {"runs": topology_dq_list_runs(conn, limit=limit)}
    finally:
        conn.close()


class DqReleasePayload(BaseModel):
    operator_id: str | None = None
    run_checks: bool = True


@app.post("/api/v1/dq/assets/{mrid}/release-to-operations")
async def post_release_staging_to_operations(mrid: str, payload: DqReleasePayload | None = None):
    """Release a DQ-cleared staging asset to the Operations inbox (validation → STAGED)."""
    if not SUPABASE_DB_URI:
        raise HTTPException(status_code=500, detail="SUPABASE_DB_URI not configured")
    body = payload or DqReleasePayload()
    conn = pooled_connect(SUPABASE_DB_URI)
    try:
        result = release_staging_to_operations(
            conn,
            mrid,
            operator=body.operator_id,
            run_checks=body.run_checks,
        )
        conn.commit()
        invalidate_after_staging_write()
        return result
    except ValueError as exc:
        conn.rollback()
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except Exception as exc:
        conn.rollback()
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    finally:
        conn.close()


@app.patch("/api/v1/dq/exceptions/{exception_id}")
async def patch_dq_exception(exception_id: str, payload: DqResolvePayload):
    if not SUPABASE_DB_URI:
        raise HTTPException(status_code=500, detail="SUPABASE_DB_URI not configured")
    conn = pooled_connect(SUPABASE_DB_URI)
    try:
        result = dq_resolve_exception(
            conn,
            exception_id,
            status=payload.status,
            note=payload.note,
            operator=payload.operator_id,
        )
        conn.commit()
        invalidate_ops_cache()
        return result
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except Exception as exc:
        conn.rollback()
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    finally:
        conn.close()


@app.post("/api/v1/validation/run")
async def post_validation_run(
    payload: ValidationRunPayload,
    mode: Literal["deterministic", "agent"] | None = Query(default=None),
    async_run: bool = Query(default=True, alias="async"),
):
    if not SUPABASE_DB_URI:
        raise HTTPException(status_code=500, detail="SUPABASE_DB_URI not configured")
    clip = payload.clip.model_dump() if payload.clip else None
    req = ValidationRunRequest(
        run_type=RunType(payload.run_type),
        mode=RunMode(mode or payload.mode),
        mrid=payload.mrid,
        tier=payload.tier,
        operator_id=payload.operator_id,
        clip=clip,
    )

    if async_run:
        conn = pooled_connect(SUPABASE_DB_URI)
        try:
            run_id = repository.create_validation_run(
                conn,
                run_type=req.run_type.value,
                mode=req.mode.value,
                requested_by=req.operator_id,
                metadata={"current_phase": "queued", "completed_phases": []},
            )
            conn.commit()
        finally:
            conn.close()

        bg_payload = {
            "run_id": run_id,
            "run_type": req.run_type.value,
            "mode": req.mode.value,
            "mrid": req.mrid,
            "tier": req.tier,
            "operator_id": req.operator_id,
            "clip": req.clip,
        }

        async def _background() -> None:
            await asyncio.to_thread(
                __import__("agents.runner", fromlist=["execute_validation_background"]).execute_validation_background,
                bg_payload,
            )

        asyncio.create_task(_background())
        return {"run_id": run_id, "status": "running", "async": True}

    conn = pooled_connect(SUPABASE_DB_URI)
    try:
        if req.mode == RunMode.AGENT:
            result = await asyncio.to_thread(run_agent_validation_cycle, conn, req)
        else:
            result = await asyncio.to_thread(run_validation_cycle, conn, req)
        conn.commit()
        invalidate_ops_cache()
        invalidate_topology_cache()
        return result
    except Exception as exc:
        conn.rollback()
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    finally:
        conn.close()


@app.get("/api/v1/validation/runs/{run_id}/progress")
async def get_validation_run_progress(run_id: str):
    if not SUPABASE_DB_URI:
        raise HTTPException(status_code=500, detail="SUPABASE_DB_URI not configured")
    conn = pooled_connect(SUPABASE_DB_URI)
    try:
        progress = repository.get_run_progress(conn, run_id)
        if not progress:
            raise HTTPException(status_code=404, detail="Run not found")
        return progress
    finally:
        conn.close()


@app.get("/api/v1/agents/status")
async def get_agents_status():
    from agents.llm.provider import llm_configured
    import os

    model = os.getenv("GIOP_LLM_MODEL") or "gpt-4o-mini"
    return {
        "engine": "online" if SUPABASE_DB_URI else "offline",
        "llm_configured": llm_configured(),
        "llm_model": model if llm_configured() else None,
        "agents": [
            "OrchestratorAgent",
            "ValidatorAgent",
            "GraphAgent",
            "QueueManagerAgent",
            "CleanupAgent",
            "ApprovalAgent",
            "StewardAssistant",
        ],
    }


@app.get("/api/v1/validation/runs")
async def get_validation_runs(limit: int = Query(default=20, ge=1, le=100)):
    if not SUPABASE_DB_URI:
        raise HTTPException(status_code=500, detail="SUPABASE_DB_URI not configured")
    conn = pooled_connect(SUPABASE_DB_URI)
    try:
        return {"runs": repository.list_validation_runs(conn, limit=limit)}
    finally:
        conn.close()


@app.get("/api/v1/validation/runs/{run_id}")
async def get_validation_run(run_id: str):
    if not SUPABASE_DB_URI:
        raise HTTPException(status_code=500, detail="SUPABASE_DB_URI not configured")
    conn = pooled_connect(SUPABASE_DB_URI)
    try:
        run = repository.get_validation_run(conn, run_id)
        if not run:
            raise HTTPException(status_code=404, detail="Run not found")
        return run
    finally:
        conn.close()


@app.get("/api/v1/kpis/latest")
async def get_kpis_latest():
    if not SUPABASE_DB_URI:
        raise HTTPException(status_code=500, detail="SUPABASE_DB_URI not configured")
    conn = pooled_connect(SUPABASE_DB_URI)
    try:
        snap = repository.latest_kpi_snapshot(conn)
        if snap:
            return snap
        metrics = kpi.compute_kpis(conn)
        return metrics
    finally:
        conn.close()


@app.get("/api/v1/kpis/run/{run_id}")
async def get_kpis_for_run(run_id: str):
    if not SUPABASE_DB_URI:
        raise HTTPException(status_code=500, detail="SUPABASE_DB_URI not configured")
    conn = pooled_connect(SUPABASE_DB_URI)
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT id::text, run_id::text, topology_validity_pct, completeness_pct,
                       critical_exception_count, open_exception_count, auto_fix_success_rate,
                       pending_approval_count, export_blocked, escalation, created_at
                FROM public.kpi_snapshot WHERE run_id = %s::uuid
                ORDER BY created_at DESC LIMIT 1
                """,
                (run_id,),
            )
            row = cur.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="KPI snapshot not found for run")
        return {
            "id": row[0],
            "run_id": row[1],
            "topology_validity_pct": row[2],
            "completeness_pct": row[3],
            "critical_exception_count": row[4],
            "open_exception_count": row[5],
            "auto_fix_success_rate": row[6],
            "pending_approval_count": row[7],
            "export_blocked": row[8],
            "escalation": row[9],
            "created_at": row[10].isoformat() if row[10] else None,
        }
    finally:
        conn.close()


@app.post("/api/v1/portal/ai/chat")
async def portal_ai_chat(payload: PortalAiChatPayload):
    if not SUPABASE_DB_URI:
        raise HTTPException(status_code=500, detail="SUPABASE_DB_URI not configured")
    from agents.llm.chat import run_steward_chat

    conn = pooled_connect(SUPABASE_DB_URI)
    try:
        result = await asyncio.to_thread(
            run_steward_chat,
            conn,
            message=payload.message,
            exception_id=payload.exception_id,
            mrid=payload.mrid,
            operator_id=payload.operator_id,
            context=payload.context,
        )
        conn.commit()
        return result.model_dump()
    except Exception as exc:
        conn.rollback()
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    finally:
        conn.close()


class PortalVoiceTurnPayload(BaseModel):
    text: str = Field(min_length=1, max_length=2000)
    session_id: str | None = Field(default=None, max_length=64)
    exception_id: str | None = None
    mrid: str | None = None
    operator_id: str | None = Field(default=None, max_length=100)
    context: dict[str, Any] = Field(default_factory=dict)


class PortalSpeakPayload(BaseModel):
    text: str = Field(min_length=1, max_length=2000)


@app.get("/api/v1/portal/ai/voice/status")
async def portal_voice_status():
    from agents import voice_stt, voice_tts

    return {
        "stt": voice_stt.status(),
        "tts": voice_tts.status(),
    }


@app.post("/api/v1/portal/ai/transcribe")
async def portal_ai_transcribe(audio: UploadFile = File(...)):
    from agents import voice_stt

    if not voice_stt.is_available():
        raise HTTPException(
            status_code=503,
            detail=(
                "Local STT not installed. In the repo venv run: "
                "pip install -r sync-service/requirements-voice.txt "
                "(requires ffmpeg)"
            ),
        )
    data = await audio.read()
    if not data:
        raise HTTPException(status_code=400, detail="Empty audio upload")
    try:
        text = await asyncio.to_thread(
            voice_stt.transcribe_audio,
            data,
            content_type=audio.content_type,
        )
        from agents.voice_normalize import normalize_transcript

        normalized, meta = normalize_transcript(text)
        return {
            "text": normalized,
            "raw": meta.get("raw"),
            "fixes": meta.get("fixes") or [],
        }
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.post("/api/v1/portal/ai/voice-turn")
async def portal_voice_turn(payload: PortalVoiceTurnPayload):
    if not SUPABASE_DB_URI:
        raise HTTPException(status_code=500, detail="SUPABASE_DB_URI not configured")
    from agents.voice import run_voice_turn

    conn = pooled_connect(SUPABASE_DB_URI)
    try:
        result = await asyncio.to_thread(
            run_voice_turn,
            conn,
            text=payload.text,
            session_id=payload.session_id,
            exception_id=payload.exception_id,
            mrid=payload.mrid,
            operator_id=payload.operator_id,
            context=payload.context,
        )
        conn.commit()
        return result.model_dump()
    except Exception as exc:
        conn.rollback()
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    finally:
        conn.close()


@app.post("/api/v1/portal/ai/speak")
async def portal_ai_speak(payload: PortalSpeakPayload):
    from agents import voice_tts
    from fastapi.responses import Response

    wav = await asyncio.to_thread(voice_tts.synthesize_wav, payload.text)
    if not wav:
        raise HTTPException(
            status_code=503,
            detail=(
                "Supertonic TTS unavailable. Start with: ./scripts/start-supertonic.sh "
                "and set SUPERTONIC_URL in .env"
            ),
        )
    return Response(content=wav, media_type="audio/wav")


@app.get("/api/v1/staging/summary")
async def get_staging_summary():
    if not SUPABASE_DB_URI:
        raise HTTPException(status_code=500, detail="SUPABASE_DB_URI not configured")
    from agents import staging_review

    conn = pooled_connect(SUPABASE_DB_URI)
    try:
        return staging_review.staging_summary(conn)
    finally:
        conn.close()


@app.get("/api/v1/staging/territory-counts")
async def get_staging_territory_counts(
    group_by: str = Query(default="district"),
    region: str | None = Query(default=None),
    limit: int = Query(default=50, ge=1, le=200),
):
    if not SUPABASE_DB_URI:
        raise HTTPException(status_code=500, detail="SUPABASE_DB_URI not configured")
    from agents import staging_review

    conn = pooled_connect(SUPABASE_DB_URI)
    try:
        return {
            "group_by": group_by,
            "counts": staging_review.staging_territory_totals(
                conn, group_by=group_by, region=region, limit=limit
            ),
        }
    finally:
        conn.close()


@app.get("/api/v1/staging/review/{mrid}")
async def get_staging_review(mrid: str):
    if not SUPABASE_DB_URI:
        raise HTTPException(status_code=500, detail="SUPABASE_DB_URI not configured")
    from agents import staging_review

    conn = pooled_connect(SUPABASE_DB_URI)
    try:
        return staging_review.review_staging_asset(conn, mrid)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    finally:
        conn.close()


@app.get("/api/v1/spatial/territory")
async def get_spatial_territory(
    district: str | None = Query(default=None),
    region: str | None = Query(default=None),
):
    if not SUPABASE_DB_URI:
        raise HTTPException(status_code=500, detail="SUPABASE_DB_URI not configured")
    from agents import spatial

    conn = pooled_connect(SUPABASE_DB_URI)
    try:
        return spatial.resolve_territory(conn, district=district, region=region)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    finally:
        conn.close()


@app.get("/api/v1/spatial/territory/geojson")
async def get_spatial_territory_geojson(
    district: str | None = Query(default=None),
    region: str | None = Query(default=None),
):
    if not SUPABASE_DB_URI:
        raise HTTPException(status_code=500, detail="SUPABASE_DB_URI not configured")
    from agents import spatial

    conn = pooled_connect(SUPABASE_DB_URI)
    try:
        return spatial.territory_geojson(conn, district=district, region=region)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    finally:
        conn.close()


@app.get("/api/v1/spatial/inventory")
async def get_spatial_inventory(
    tier: str = Query(default="master"),
    asset_kind: str | None = Query(default=None),
    district: str | None = Query(default=None),
    region: str | None = Query(default=None),
    west: float | None = Query(default=None),
    south: float | None = Query(default=None),
    east: float | None = Query(default=None),
    north: float | None = Query(default=None),
):
    if not SUPABASE_DB_URI:
        raise HTTPException(status_code=500, detail="SUPABASE_DB_URI not configured")
    from agents import spatial

    bbox = None
    if None not in (west, south, east, north):
        bbox = {"west": west, "south": south, "east": east, "north": north}
    conn = pooled_connect(SUPABASE_DB_URI)
    try:
        return spatial.asset_inventory_counts(
            conn,
            tier=tier,
            asset_kind=asset_kind,
            district=district,
            region=region,
            bbox=bbox,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    finally:
        conn.close()


@app.get("/api/v1/approvals/pending")
async def get_pending_approvals(limit: int = Query(default=50, ge=1, le=200)):
    if not SUPABASE_DB_URI:
        raise HTTPException(status_code=500, detail="SUPABASE_DB_URI not configured")
    conn = pooled_connect(SUPABASE_DB_URI)
    try:
        return {"approvals": approval_agent.list_pending(conn, limit=limit)}
    finally:
        conn.close()


@app.post("/api/v1/approvals/{approval_id}/approve")
async def post_approval_approve(approval_id: str, payload: ApprovalDecisionPayload):
    if not SUPABASE_DB_URI:
        raise HTTPException(status_code=500, detail="SUPABASE_DB_URI not configured")
    conn = pooled_connect(SUPABASE_DB_URI)
    try:
        result = approval_agent.approve(
            conn,
            approval_id,
            operator_id=payload.operator_id,
            note=payload.note,
            execute=payload.execute,
        )
        conn.commit()
        invalidate_ops_cache()
        return result
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except Exception as exc:
        conn.rollback()
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    finally:
        conn.close()


@app.post("/api/v1/approvals/{approval_id}/reject")
async def post_approval_reject(approval_id: str, payload: ApprovalDecisionPayload):
    if not SUPABASE_DB_URI:
        raise HTTPException(status_code=500, detail="SUPABASE_DB_URI not configured")
    conn = pooled_connect(SUPABASE_DB_URI)
    try:
        result = approval_agent.reject(
            conn,
            approval_id,
            operator_id=payload.operator_id,
            note=payload.note,
        )
        conn.commit()
        return result
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except Exception as exc:
        conn.rollback()
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    finally:
        conn.close()


@app.post("/api/v1/cleanup/generate/{exception_id}")
async def post_cleanup_generate(exception_id: str, operator_id: str | None = Query(default=None)):
    if not SUPABASE_DB_URI:
        raise HTTPException(status_code=500, detail="SUPABASE_DB_URI not configured")
    conn = pooled_connect(SUPABASE_DB_URI)
    try:
        result = proposal_agent.generate_topology_proposal(
            conn, exception_id, operator_id=operator_id, proposed_by="CleanupAgent"
        )
        conn.commit()
        return result
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except Exception as exc:
        conn.rollback()
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    finally:
        conn.close()


@app.post("/api/v1/proposals/generate/{exception_id}")
async def post_proposal_generate(
    exception_id: str,
    operator_id: str | None = Query(default=None),
    proposed_by: str = Query(default="StewardPortal"),
):
    if not SUPABASE_DB_URI:
        raise HTTPException(status_code=500, detail="SUPABASE_DB_URI not configured")
    conn = pooled_connect(SUPABASE_DB_URI)
    try:
        result = proposal_agent.generate_topology_proposal(
            conn, exception_id, operator_id=operator_id, proposed_by=proposed_by
        )
        conn.commit()
        return result
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except Exception as exc:
        conn.rollback()
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    finally:
        conn.close()


@app.get("/api/v1/proposals/approved")
async def get_proposals_approved(limit: int = Query(default=50, ge=1, le=200)):
    if not SUPABASE_DB_URI:
        raise HTTPException(status_code=500, detail="SUPABASE_DB_URI not configured")
    conn = pooled_connect(SUPABASE_DB_URI)
    try:
        return {"proposals": repository.list_approved_proposals(conn, limit=limit)}
    finally:
        conn.close()


@app.get("/api/v1/proposals/{proposal_id}")
async def get_proposal(proposal_id: str):
    if not SUPABASE_DB_URI:
        raise HTTPException(status_code=500, detail="SUPABASE_DB_URI not configured")
    conn = pooled_connect(SUPABASE_DB_URI)
    try:
        proposal = repository.get_topology_proposal(conn, proposal_id)
        if not proposal:
            raise HTTPException(status_code=404, detail="Proposal not found")
        return proposal
    finally:
        conn.close()


@app.post("/api/v1/proposals/{proposal_id}/publish")
async def post_proposal_publish(proposal_id: str, payload: CleanupExecutePayload):
    if not SUPABASE_DB_URI:
        raise HTTPException(status_code=500, detail="SUPABASE_DB_URI not configured")
    conn = pooled_connect(SUPABASE_DB_URI)
    try:
        result = proposal_agent.publish_proposal_to_master(
            conn, proposal_id, operator_id=payload.operator_id
        )
        conn.commit()
        invalidate_topology_cache()
        invalidate_ops_cache()
        return result
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        conn.rollback()
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    finally:
        conn.close()


@app.post("/api/v1/cleanup/execute/{cleanup_id}")
async def post_cleanup_execute(cleanup_id: str, payload: CleanupExecutePayload):
    if not SUPABASE_DB_URI:
        raise HTTPException(status_code=500, detail="SUPABASE_DB_URI not configured")
    conn = pooled_connect(SUPABASE_DB_URI)
    try:
        result = cleanup_agent.execute_cleanup(
            conn,
            cleanup_id,
            operator_id=payload.operator_id,
            force=payload.force,
        )
        conn.commit()
        invalidate_topology_cache()
        invalidate_ops_cache()
        return result
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        conn.rollback()
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    finally:
        conn.close()


@app.get("/api/v1/cleanup/{cleanup_id}")
async def get_cleanup(cleanup_id: str):
    if not SUPABASE_DB_URI:
        raise HTTPException(status_code=500, detail="SUPABASE_DB_URI not configured")
    conn = pooled_connect(SUPABASE_DB_URI)
    try:
        action = repository.get_cleanup_action(conn, cleanup_id)
        if not action:
            raise HTTPException(status_code=404, detail="Cleanup action not found")
        return action
    finally:
        conn.close()


@app.get("/api/v1/exceptions/queue/{queue_name}")
async def get_exceptions_by_queue(queue_name: str, limit: int = Query(default=100, ge=1, le=500)):
    if not SUPABASE_DB_URI:
        raise HTTPException(status_code=500, detail="SUPABASE_DB_URI not configured")
    conn = pooled_connect(SUPABASE_DB_URI)
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT e.id::text, e.record_type, e.record_mrid::text, e.rule_code,
                       r.domain, e.severity::text, e.status::text, e.error_message,
                       e.queue_name, e.created_at
                FROM public.data_quality_exceptions e
                JOIN public.data_quality_rules r ON r.rule_code = e.rule_code
                WHERE e.queue_name = %s AND e.status = 'OPEN'
                ORDER BY e.created_at DESC
                LIMIT %s
                """,
                (queue_name, limit),
            )
            rows = cur.fetchall()
        return {
            "queue": queue_name,
            "exceptions": [
                {
                    "id": r[0],
                    "record_type": r[1],
                    "record_mrid": r[2],
                    "rule_code": r[3],
                    "domain": r[4],
                    "severity": r[5],
                    "status": r[6],
                    "error_message": r[7],
                    "queue_name": r[8],
                    "created_at": r[9].isoformat() if r[9] else None,
                }
                for r in rows
            ],
        }
    finally:
        conn.close()


def _run_export_job(job_id: str, operator_id: str | None = None) -> None:
    if not SUPABASE_DB_URI:
        return
    conn = pooled_connect(SUPABASE_DB_URI)
    try:
        meta = get_export_job(conn, job_id)
        fmt = (meta or {}).get("format", "cim-json")
        job = process_export_by_format(conn, job_id, fmt)
        action = LINEAGE_ACTIONS.get(fmt, "GIS_EXPORT")
        log_lineage(
            conn,
            target_mrid=job_id,
            source_type="SYSTEM",
            action_type=action,
            operator_id=operator_id,
            provenance_ref=f"gis_transfer_jobs:{job_id}",
            after_state={
                "format": fmt,
                "feature_count": job.get("feature_count"),
                "storage_bucket": job.get("storage_bucket"),
                "storage_path": job.get("storage_path"),
            },
        )
        conn.commit()
        invalidate_ops_cache()
    except Exception:
        conn.rollback()
    finally:
        conn.close()


@app.get("/api/v1/exports/cim/preview")
async def preview_cim_export(
    limit: int = Query(default=50, ge=1, le=500),
    west: float | None = Query(default=None),
    south: float | None = Query(default=None),
    east: float | None = Query(default=None),
    north: float | None = Query(default=None),
):
    if not SUPABASE_DB_URI:
        raise HTTPException(status_code=500, detail="SUPABASE_DB_URI not configured")
    clip = None
    if None not in (west, south, east, north):
        if west >= east or south >= north:
            raise HTTPException(status_code=400, detail="Invalid bbox")
        clip = {"west": west, "south": south, "east": east, "north": north}
    cache_key = cim_preview_key(limit, west, south, east, north)

    def _fetch():
        conn = pooled_connect(SUPABASE_DB_URI)
        try:
            return build_cim_payload(conn, clip=clip, limit=limit)
        finally:
            conn.close()

    return cached_json(cache_key, _fetch, CIM_PREVIEW_TTL_SEC)


@app.post("/api/v1/exports/cim")
async def start_cim_export(payload: CimExportPayload, background_tasks: BackgroundTasks):
    if not SUPABASE_DB_URI:
        raise HTTPException(status_code=500, detail="SUPABASE_DB_URI not configured")
    clip = payload.clip.model_dump() if payload.clip else None
    conn = pooled_connect(SUPABASE_DB_URI)
    try:
        validate_export_scope(conn, clip)
        job = create_export_job(
            conn,
            layers=payload.layers,
            clip=clip,
            exclude_dq_blocked=payload.exclude_dq_blocked,
            requested_by=payload.requested_by or payload.operator_id,
        )
        conn.commit()
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        conn.rollback()
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    finally:
        conn.close()
    invalidate_ops_cache()
    background_tasks.add_task(_run_export_job, job["id"], payload.operator_id)
    return {"job": job}


@app.get("/api/v1/exports/dxf/preview")
async def preview_dxf_export(
    limit: int = Query(default=50, ge=1, le=500),
    west: float | None = Query(default=None),
    south: float | None = Query(default=None),
    east: float | None = Query(default=None),
    north: float | None = Query(default=None),
    include_nodes: bool = Query(default=True),
    include_lines: bool = Query(default=True),
):
    if not SUPABASE_DB_URI:
        raise HTTPException(status_code=500, detail="SUPABASE_DB_URI not configured")
    clip = None
    if None not in (west, south, east, north):
        if west >= east or south >= north:
            raise HTTPException(status_code=400, detail="Invalid bbox")
        clip = {"west": west, "south": south, "east": east, "north": north}
    conn = pooled_connect(SUPABASE_DB_URI)
    try:
        _, meta = build_dxf_payload(
            conn,
            clip=clip,
            include_nodes=include_nodes,
            include_lines=include_lines,
            limit=limit,
        )
        return meta
    finally:
        conn.close()


@app.post("/api/v1/exports/dxf")
async def start_dxf_export(payload: DxfExportPayload, background_tasks: BackgroundTasks):
    if not SUPABASE_DB_URI:
        raise HTTPException(status_code=500, detail="SUPABASE_DB_URI not configured")
    clip = payload.clip.model_dump() if payload.clip else None
    conn = pooled_connect(SUPABASE_DB_URI)
    try:
        validate_export_scope(conn, clip)
        job = create_dxf_export_job(
            conn,
            clip=clip,
            exclude_dq_blocked=payload.exclude_dq_blocked,
            include_nodes=payload.include_nodes,
            include_lines=payload.include_lines,
            requested_by=payload.requested_by or payload.operator_id,
        )
        conn.commit()
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        conn.rollback()
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    finally:
        conn.close()
    invalidate_ops_cache()
    background_tasks.add_task(_run_export_job, job["id"], payload.operator_id)
    return {"job": job}


def _start_gis_export(fmt: str, payload: GisExportPayload, background_tasks: BackgroundTasks):
    if fmt not in SUPPORTED_FORMATS:
        raise HTTPException(status_code=404, detail=f"Unknown export format: {fmt}")
    if not SUPABASE_DB_URI:
        raise HTTPException(status_code=500, detail="SUPABASE_DB_URI not configured")
    clip = payload.clip.model_dump() if payload.clip else None
    conn = pooled_connect(SUPABASE_DB_URI)
    try:
        if fmt not in ("mdms-csv",):
            validate_export_scope(conn, clip)
        requested = payload.requested_by or payload.operator_id
        if fmt == "geopackage":
            job = create_gpkg_export_job(conn, clip=clip, exclude_dq_blocked=payload.exclude_dq_blocked, requested_by=requested)
        elif fmt == "kml":
            job = create_kml_export_job(conn, clip=clip, requested_by=requested)
        elif fmt == "shapefile":
            job = create_shapefile_export_job(conn, clip=clip, requested_by=requested)
        elif fmt == "csv":
            job = create_csv_export_job(
                conn, clip=clip, include_meters=payload.include_meters, requested_by=requested
            )
        elif fmt == "cim-xml":
            job = create_cim_xml_export_job(
                conn, layers=payload.layers, clip=clip, requested_by=requested
            )
        elif fmt == "cim-rdf":
            job = create_cim_rdf_export_job(
                conn, layers=payload.layers, clip=clip, requested_by=requested
            )
        elif fmt == "mdms-csv":
            job = create_mdms_export_job(conn, requested_by=requested)
        elif fmt == "sap-csv":
            job = create_sap_export_job(conn, clip=clip, requested_by=requested)
        else:
            raise HTTPException(status_code=404, detail=f"Format {fmt} uses a dedicated endpoint")
        conn.commit()
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except HTTPException:
        raise
    except Exception as exc:
        conn.rollback()
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    finally:
        conn.close()
    invalidate_ops_cache()
    background_tasks.add_task(_run_export_job, job["id"], payload.operator_id)
    return {"job": job}


@app.get("/api/v1/exports/formats")
async def list_export_formats():
    return {"formats": SUPPORTED_FORMATS}


@app.post("/api/v1/exports/{export_format}")
async def start_format_export(
    export_format: str,
    payload: GisExportPayload,
    background_tasks: BackgroundTasks,
):
    return _start_gis_export(export_format, payload, background_tasks)


@app.get("/api/v1/exports")
async def list_exports(limit: int = Query(default=50, ge=1, le=200)):
    if not SUPABASE_DB_URI:
        raise HTTPException(status_code=500, detail="SUPABASE_DB_URI not configured")

    def _fetch():
        conn = pooled_connect(SUPABASE_DB_URI)
        try:
            return {"jobs": list_export_jobs(conn, limit=limit)}
        finally:
            conn.close()

    return cached_json(exports_list_key(limit), _fetch, OPS_CACHE_TTL_SEC)


@app.get("/api/v1/exports/{job_id}")
async def get_export(job_id: str):
    if not SUPABASE_DB_URI:
        raise HTTPException(status_code=500, detail="SUPABASE_DB_URI not configured")
    conn = pooled_connect(SUPABASE_DB_URI)
    try:
        job = get_export_job(conn, job_id)
    finally:
        conn.close()
    if not job:
        raise HTTPException(status_code=404, detail="Export job not found")
    return job


@app.get("/api/v1/exports/{job_id}/download")
async def download_export(job_id: str):
    if not SUPABASE_DB_URI:
        raise HTTPException(status_code=500, detail="SUPABASE_DB_URI not configured")
    conn = pooled_connect(SUPABASE_DB_URI)
    try:
        job = get_export_job(conn, job_id)
        if not job:
            raise HTTPException(status_code=404, detail="Export job not found")
        fmt = job.get("format", "cim-json")
        body, media_type = read_export_bytes_by_format(conn, job_id, fmt)
        filename = download_filename(job_id, fmt)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    finally:
        conn.close()
    return Response(
        content=body,
        media_type=media_type,
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


def _run_boundary_import_job(job_id: str) -> None:
    if not SUPABASE_DB_URI:
        return
    conn = pooled_connect(SUPABASE_DB_URI)
    try:
        process_boundary_import_job(conn, job_id)
        invalidate_ops_cache()
    except Exception:
        conn.rollback()
        import logging

        logging.getLogger(__name__).exception("boundary import job %s failed", job_id)
    finally:
        conn.close()


@app.get("/api/v1/reference-layers")
async def api_list_reference_layers():
    if not SUPABASE_DB_URI:
        raise HTTPException(status_code=500, detail="SUPABASE_DB_URI not configured")
    conn = pooled_connect(SUPABASE_DB_URI)
    try:
        try:
            with conn.cursor() as cur:
                cur.execute("SELECT gis.refresh_reference_layer_counts()")
            conn.commit()
        except Exception:
            conn.rollback()
        refresh_all_render_policies(conn)
        conn.commit()
        layers = list_reference_layers(conn)
    finally:
        conn.close()
    return {"layers": layers}


@app.get("/api/v1/reference-layers/map-config")
async def api_reference_map_config():
    if not SUPABASE_DB_URI:
        raise HTTPException(status_code=500, detail="SUPABASE_DB_URI not configured")
    martin_url = os.getenv("MARTIN_URL", "http://127.0.0.1:3001")
    conn = pooled_connect(SUPABASE_DB_URI)
    try:
        try:
            refresh_all_render_policies(conn)
            conn.commit()
        except Exception:
            conn.rollback()
        config = build_map_config(conn, martin_url=martin_url)
    finally:
        conn.close()
    return {"layers": config}


@app.get("/api/v1/reference-layers/{slug}/geojson")
async def api_reference_layer_geojson(
    slug: str,
    west: float | None = Query(default=None),
    south: float | None = Query(default=None),
    east: float | None = Query(default=None),
    north: float | None = Query(default=None),
    limit: int = Query(default=10_000, ge=1, le=50_000),
):
    if not SUPABASE_DB_URI:
        raise HTTPException(status_code=500, detail="SUPABASE_DB_URI not configured")
    conn = pooled_connect(SUPABASE_DB_URI)
    try:
        return reference_layer_geojson(
            conn,
            slug,
            west=west,
            south=south,
            east=east,
            north=north,
            limit=limit,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    finally:
        conn.close()


@app.get("/api/v1/imports")
async def api_list_imports(limit: int = Query(default=50, ge=1, le=200)):
    if not SUPABASE_DB_URI:
        raise HTTPException(status_code=500, detail="SUPABASE_DB_URI not configured")
    conn = pooled_connect(SUPABASE_DB_URI)
    try:
        jobs = list_import_jobs(conn, limit=limit)
    finally:
        conn.close()
    return {"jobs": jobs}


@app.get("/api/v1/imports/{job_id}")
async def api_get_import(job_id: str):
    if not SUPABASE_DB_URI:
        raise HTTPException(status_code=500, detail="SUPABASE_DB_URI not configured")
    conn = pooled_connect(SUPABASE_DB_URI)
    try:
        job = get_import_job(conn, job_id)
    finally:
        conn.close()
    if not job or job.get("direction") != "import":
        raise HTTPException(status_code=404, detail="Import job not found")
    return job


@app.post("/api/v1/imports/boundaries")
async def api_import_boundaries(
    background_tasks: BackgroundTasks,
    file: UploadFile = File(...),
    layer_slug: str = Query(default="ecg-admin-boundaries"),
    operator_id: str | None = Query(default=None),
):
    if not SUPABASE_DB_URI:
        raise HTTPException(status_code=500, detail="SUPABASE_DB_URI not configured")
    if not file.filename:
        raise HTTPException(status_code=422, detail="Missing upload filename")
    body = await file.read()
    if not body:
        raise HTTPException(status_code=422, detail="Empty upload")

    conn = pooled_connect(SUPABASE_DB_URI)
    try:
        job = create_boundary_import_job(
            conn,
            storage_bucket=None,
            storage_path="pending",
            layer_slugs=[layer_slug],
            requested_by=operator_id,
        )
        bucket, storage_path = save_import_upload(job["id"], body, file.filename or "source.gpkg")
        with conn.cursor() as cur:
            cur.execute(
                """
                UPDATE public.gis_transfer_jobs
                SET storage_bucket = %s, storage_path = %s, updated_at = NOW()
                WHERE id = %s::uuid
                """,
                (bucket, storage_path, job["id"]),
            )
        conn.commit()
    finally:
        conn.close()

    background_tasks.add_task(_run_boundary_import_job, job["id"])
    return {"job": job}


class BundledBoundaryImportPayload(BaseModel):
    file_path: str
    layer_slugs: list[str] | None = None
    operator_id: str | None = None


@app.post("/api/v1/imports/boundaries/bundled")
async def api_import_boundaries_bundled(
    payload: BundledBoundaryImportPayload,
    background_tasks: BackgroundTasks,
):
    """Import boundaries from a server-local GPKG path (dev / ops)."""
    if not SUPABASE_DB_URI:
        raise HTTPException(status_code=500, detail="SUPABASE_DB_URI not configured")
    candidates = [
        Path(payload.file_path),
        Path(__file__).resolve().parent.parent / payload.file_path,
    ]
    path = next((p for p in candidates if p.is_file()), None)
    if path is None:
        raise HTTPException(status_code=400, detail=f"File not found: {payload.file_path}")

    conn = pooled_connect(SUPABASE_DB_URI)
    try:
        job = create_boundary_import_job(
            conn,
            storage_bucket=None,
            storage_path=str(path.resolve()),
            layer_slugs=payload.layer_slugs,
            requested_by=payload.operator_id,
        )
        conn.commit()
    finally:
        conn.close()

    background_tasks.add_task(_run_boundary_import_job, job["id"])
    return {"job": job}


class ReferenceImportPayload(BaseModel):
    inspect_id: str
    display_name: str
    source_layer: str
    dissolve_column: str | None = None
    label_field: str | None = None
    detail_min_zoom: float = 10
    catalog_slug: str | None = None
    operator_id: str | None = None


@app.post("/api/v1/imports/inspect")
async def api_inspect_import(file: UploadFile = File(...)):
    if not file.filename:
        raise HTTPException(status_code=422, detail="Missing upload filename")
    body = await file.read()
    if not body:
        raise HTTPException(status_code=422, detail="Empty upload")
    try:
        inspect_id, _path = save_inspect_upload(body, file.filename)
        result = inspect_uploaded(inspect_id)
    except RuntimeError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return result


@app.get("/api/v1/imports/inspect/{inspect_id}")
async def api_get_inspect(inspect_id: str):
    try:
        return inspect_uploaded(inspect_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.get("/api/v1/imports/inspect/{inspect_id}/preview")
async def api_inspect_preview(
    inspect_id: str,
    layer: str | None = Query(default=None),
    limit: int = Query(default=150, ge=1, le=500),
):
    try:
        return layer_preview_geojson(inspect_id, layer, limit=limit)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.get("/api/v1/imports/inspect/{inspect_id}/suggest")
async def api_inspect_suggest(inspect_id: str, layer: str = Query(...)):
    try:
        data = inspect_uploaded(inspect_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    match = next((l for l in data.get("layers", []) if l.get("name") == layer), None)
    if not match:
        raise HTTPException(status_code=404, detail=f"Layer not found: {layer}")
    return suggest_boundary_fields(match.get("fields") or [])


@app.post("/api/v1/imports/reference")
async def api_import_reference(
    payload: ReferenceImportPayload,
    background_tasks: BackgroundTasks,
):
    if not SUPABASE_DB_URI:
        raise HTTPException(status_code=500, detail="SUPABASE_DB_URI not configured")
    conn = pooled_connect(SUPABASE_DB_URI)
    try:
        job = create_reference_import_from_inspect(
            conn,
            inspect_id=payload.inspect_id,
            display_name=payload.display_name,
            source_layer=payload.source_layer,
            dissolve_column=payload.dissolve_column,
            label_field=payload.label_field,
            detail_min_zoom=payload.detail_min_zoom,
            catalog_slug=payload.catalog_slug,
            requested_by=payload.operator_id,
        )
        conn.commit()
    except ValueError as exc:
        conn.rollback()
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    finally:
        conn.close()

    background_tasks.add_task(_run_boundary_import_job, job["id"])
    return {"job": job}


def _resolve_affine(payload) -> dict[str, float]:
    if payload.apply_affine and payload.affine is None:
        raise HTTPException(status_code=422, detail="affine params required when apply_affine is true")
    if payload.affine is None:
        return {}
    return payload.affine.model_dump()


@app.post("/api/v1/migration/dxf")
async def migrate_dxf(payload: DxfMigrationPayload):
    if not SUPABASE_DB_URI:
        raise HTTPException(status_code=500, detail="SUPABASE_DB_URI not configured")
    if not payload.dxf_text and not payload.file_path:
        raise HTTPException(status_code=422, detail="Provide dxf_text or file_path")
    text = payload.dxf_text
    if text is None:
        try:
            text = Path(payload.file_path).read_text(errors="replace")
        except OSError as exc:
            raise HTTPException(status_code=400, detail=f"Cannot read DXF: {exc}") from exc
    affine = _resolve_affine(payload)
    features = parse_dxf(text)
    if not features:
        raise HTTPException(status_code=422, detail="No POINT or LINE primitives found in DXF")
    conn = pooled_connect(SUPABASE_DB_URI)
    try:
        result = run_migration(
            conn,
            source_format="dxf",
            source_name=payload.source_name,
            features=features,
            affine=affine,
            apply_affine=payload.apply_affine,
            default_feeder=payload.default_feeder,
            default_utility=payload.default_utility,
            requested_by=payload.requested_by,
        )
        conn.commit()
        invalidate_after_staging_write()
    except Exception as exc:
        conn.rollback()
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    finally:
        conn.close()
    return result


@app.post("/api/v1/migration/geopackage")
async def migrate_geopackage(payload: GpkgMigrationPayload):
    if not SUPABASE_DB_URI:
        raise HTTPException(status_code=500, detail="SUPABASE_DB_URI not configured")
    if not Path(payload.file_path).is_file():
        raise HTTPException(status_code=400, detail="GeoPackage file_path not found")
    affine = _resolve_affine(payload)
    try:
        features = parse_geopackage(payload.file_path, payload.table)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Cannot read GeoPackage: {exc}") from exc
    if not features:
        raise HTTPException(status_code=422, detail="No features found in GeoPackage")
    conn = pooled_connect(SUPABASE_DB_URI)
    try:
        result = run_migration(
            conn,
            source_format="geopackage",
            source_name=payload.source_name,
            features=features,
            affine=affine,
            apply_affine=payload.apply_affine,
            default_feeder=payload.default_feeder,
            default_utility=payload.default_utility,
            requested_by=payload.requested_by,
        )
        conn.commit()
        invalidate_after_staging_write()
    except Exception as exc:
        conn.rollback()
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    finally:
        conn.close()
    return result


@app.get("/api/v1/migration/runs")
async def list_migration_runs_endpoint(limit: int = Query(default=50, ge=1, le=200)):
    if not SUPABASE_DB_URI:
        raise HTTPException(status_code=500, detail="SUPABASE_DB_URI not configured")
    conn = pooled_connect(SUPABASE_DB_URI)
    try:
        return {"runs": list_migration_runs(conn, limit=limit)}
    finally:
        conn.close()


@app.get("/api/v1/migration/runs/{run_id}/failed")
async def list_migration_failed_endpoint(run_id: str, limit: int = Query(default=200, ge=1, le=1000)):
    if not SUPABASE_DB_URI:
        raise HTTPException(status_code=500, detail="SUPABASE_DB_URI not configured")
    conn = pooled_connect(SUPABASE_DB_URI)
    try:
        return {"failed": list_migration_failed(conn, run_id, limit=limit)}
    finally:
        conn.close()


@app.get("/api/v1/conflicts")
async def get_conflicts(limit: int = Query(default=100, ge=1, le=500)):
    if not SUPABASE_DB_URI:
        raise HTTPException(status_code=500, detail="SUPABASE_DB_URI not configured")

    def _fetch():
        conn = pooled_connect(SUPABASE_DB_URI)
        try:
            return {"conflicts": list_open_conflicts(conn, limit)}
        finally:
            conn.close()

    try:
        return cached_json(conflicts_key(limit), _fetch, OPS_CACHE_TTL_SEC)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.post("/api/v1/conflicts/{conflict_id}/resolve")
async def resolve_conflict_endpoint(conflict_id: str, payload: ConflictResolvePayload):
    if not SUPABASE_DB_URI:
        raise HTTPException(status_code=500, detail="SUPABASE_DB_URI not configured")
    try:
        conn = pooled_connect(SUPABASE_DB_URI)
        try:
            result = resolve_conflict(conn, conflict_id, payload.resolution)
            conn.commit()
        finally:
            conn.close()
        invalidate_after_staging_write()
        return result
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.get("/api/v1/schematic/generate")
async def schematic_generate(
    mrid: str = Query(...),
    depth: int = Query(default=10, ge=1, le=20),
):
    cache_key = schematic_key(mrid, depth)
    cached = get_json(cache_key)
    if cached is not None:
        return Response(content=cached["body"], media_type=cached["media_type"])
    try:
        payload = await asyncio.to_thread(_trace_payload_blocking, mrid, "traced")
        svg = generate_svg(payload, mrid)
        set_json(
            cache_key,
            {"body": svg, "media_type": "image/svg+xml"},
            SCHEMATIC_CACHE_TTL_SEC,
        )
        return Response(content=svg, media_type="image/svg+xml")
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.post("/api/v1/analytics/energy-accounting/balance")
async def energy_accounting_balance(payload: EnergyBalancePayload):
    try:
        return compute_balance(
            zone_key=payload.zone_key,
            period_start=payload.period_start,
            period_end=payload.period_end,
            nominal_injection_kwh=payload.nominal_injection_kwh,
        )
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.get("/api/v1/integrations/sap/status")
async def api_sap_status():
    if not SUPABASE_DB_URI:
        raise HTTPException(status_code=500, detail="SUPABASE_DB_URI not configured")
    try:
        conn = pooled_connect(SUPABASE_DB_URI)
        try:
            return sap_integration_status(conn)
        finally:
            conn.close()
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.post("/api/v1/integrations/sap/sync/customers")
async def api_sap_sync_customers():
    if not SUPABASE_DB_URI:
        raise HTTPException(status_code=500, detail="SUPABASE_DB_URI not configured")
    try:
        conn = pooled_connect(SUPABASE_DB_URI)
        try:
            result = sync_customers_from_sap(conn)
        finally:
            conn.close()
        return result
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.get("/api/v1/dlq")
async def get_dlq(status: str | None = Query(default="OPEN")):
    if not SUPABASE_DB_URI:
        raise HTTPException(status_code=500, detail="SUPABASE_DB_URI not configured")
    try:
        conn = pooled_connect(SUPABASE_DB_URI)
        try:
            items = list_dlq(conn, status=status)
        finally:
            conn.close()
        return {"items": items}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.patch("/api/v1/dlq/{dlq_id}")
async def patch_dlq_endpoint(dlq_id: str, payload: DlqPatchPayload):
    if not SUPABASE_DB_URI:
        raise HTTPException(status_code=500, detail="SUPABASE_DB_URI not configured")
    try:
        conn = pooled_connect(SUPABASE_DB_URI)
        try:
            result = patch_dlq(conn, dlq_id, payload.status, payload.payload)
            if payload.status in ("RESOLVED", "DISCARDED"):
                log_dlq_event(
                    conn,
                    dlq_id=dlq_id,
                    source=result["source"],
                    action_type=f"DLQ_{payload.status}",
                    payload=result.get("payload") if isinstance(result.get("payload"), dict) else payload.payload,
                )
            conn.commit()
        finally:
            conn.close()
        return result
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.post("/api/v1/dlq/{dlq_id}/retry")
async def retry_dlq(dlq_id: str):
    if not SUPABASE_DB_URI:
        raise HTTPException(status_code=500, detail="SUPABASE_DB_URI not configured")
    try:
        conn = pooled_connect(SUPABASE_DB_URI)
        try:
            item = mark_retrying(conn, dlq_id)
            if item["source"] == "KAFKA" and TIMESCALE_URI:
                import psycopg2 as pg

                payload = item["payload"] or {}
                meter_mrid = payload.get("meter_mrid")
                ts = payload.get("reading_timestamp")
                kwh = payload.get("active_energy_kwh")
                if meter_mrid and ts is not None and kwh is not None:
                    ts_conn = pg.connect(TIMESCALE_URI)
                    try:
                        with ts_conn.cursor() as cur:
                            cur.execute(
                                """
                                INSERT INTO public.meter_readings
                                  (meter_mrid, reading_timestamp, active_energy_kwh)
                                VALUES (%s, to_timestamp(%s / 1000.0), %s)
                                ON CONFLICT DO NOTHING
                                """,
                                (meter_mrid, ts, kwh),
                            )
                            ts_conn.commit()
                    finally:
                        ts_conn.close()
                    patch_dlq(conn, dlq_id, "RESOLVED")
                    log_dlq_event(
                        conn,
                        dlq_id=dlq_id,
                        source=item["source"],
                        action_type="DLQ_RETRY_RESOLVED",
                        payload=item["payload"] if isinstance(item.get("payload"), dict) else None,
                    )
                else:
                    patch_dlq(conn, dlq_id, "OPEN")
            elif item["source"] == "SAP":
                payload = item["payload"] or {}
                try:
                    upsert_customer_from_payload(conn, payload)
                    conn.commit()
                    patch_dlq(conn, dlq_id, "RESOLVED")
                    log_dlq_event(
                        conn,
                        dlq_id=dlq_id,
                        source=item["source"],
                        action_type="DLQ_RETRY_RESOLVED",
                        payload=payload,
                    )
                except Exception:
                    conn.rollback()
                    patch_dlq(conn, dlq_id, "OPEN")
            else:
                patch_dlq(conn, dlq_id, "RESOLVED")
            conn.commit()
        finally:
            conn.close()
        return {"status": "retried", "id": dlq_id}
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.get("/api/v1/health/metrics")
async def health_metrics():
    snapshot = metrics_snapshot()
    snapshot["redis"] = redis_status()
    return snapshot


# --- Operational modules (Phase 2 MVP) ---


class CaseCreatePayload(BaseModel):
    channel: str
    summary: str
    account_mrid: Optional[str] = None
    meter_mrid: Optional[str] = None
    asset_mrid: Optional[str] = None
    classification: str = "GENERAL"
    priority: int = 3
    assigned_to: Optional[str] = None
    due_at: Optional[str] = None
    notes: Optional[str] = None
    created_by: Optional[str] = None


class CasePatchPayload(BaseModel):
    classification: Optional[str] = None
    priority: Optional[int] = None
    status: Optional[str] = None
    assigned_to: Optional[str] = None
    due_at: Optional[str] = None
    summary: Optional[str] = None
    notes: Optional[str] = None
    operator_id: Optional[str] = None


class ConvertTicketPayload(BaseModel):
    ticket_type: Optional[str] = None
    severity: str = "MEDIUM"
    priority: Optional[int] = None
    summary: Optional[str] = None
    assigned_to: Optional[str] = None
    created_by: Optional[str] = None


class ConvertWorkOrderPayload(BaseModel):
    work_type: Optional[str] = None
    priority: Optional[int] = None
    assigned_crew: Optional[str] = None
    assigned_user: Optional[str] = None
    asset_mrid: Optional[str] = None
    summary: Optional[str] = None
    notes: Optional[str] = None
    created_by: Optional[str] = None


class TicketCreatePayload(BaseModel):
    summary: str
    source: str = "MANUAL"
    source_case_id: Optional[str] = None
    account_mrid: Optional[str] = None
    meter_mrid: Optional[str] = None
    asset_mrid: Optional[str] = None
    ticket_type: str = "CUSTOMER"
    category: Optional[str] = None
    severity: str = "MEDIUM"
    priority: int = 3
    assigned_to: Optional[str] = None
    due_at: Optional[str] = None
    created_by: Optional[str] = None


class TicketPatchPayload(BaseModel):
    ticket_type: Optional[str] = None
    category: Optional[str] = None
    severity: Optional[str] = None
    priority: Optional[int] = None
    status: Optional[str] = None
    assigned_to: Optional[str] = None
    due_at: Optional[str] = None
    summary: Optional[str] = None
    resolution_code: Optional[str] = None
    resolution_summary: Optional[str] = None
    operator_id: Optional[str] = None


class TicketLinkPayload(BaseModel):
    target_type: str
    target_id: str
    link_reason: Optional[str] = None
    operator_id: Optional[str] = None


class WorkOrderCreatePayload(BaseModel):
    summary: str
    work_type: str = "OTHER"
    priority: int = 3
    assigned_crew: Optional[str] = None
    assigned_user: Optional[str] = None
    due_at: Optional[str] = None
    account_mrid: Optional[str] = None
    asset_mrid: Optional[str] = None
    feeder_mrid: Optional[str] = None
    source_ticket_id: Optional[str] = None
    source_case_id: Optional[str] = None
    notes: Optional[str] = None
    created_by: Optional[str] = None


class WorkOrderPatchPayload(BaseModel):
    work_type: Optional[str] = None
    priority: Optional[int] = None
    status: Optional[str] = None
    assigned_crew: Optional[str] = None
    assigned_user: Optional[str] = None
    due_at: Optional[str] = None
    summary: Optional[str] = None
    notes: Optional[str] = None
    operator_id: Optional[str] = None


class OutageCreatePayload(BaseModel):
    summary: str
    outage_type: str = "UNPLANNED"
    status: str = "ACTIVE"
    started_at: Optional[str] = None
    estimated_restoration_at: Optional[str] = None
    affected_area: Optional[str] = None
    feeder_id: Optional[str] = None
    district: Optional[str] = None
    customers_affected: int = 0
    is_published: bool = False
    create_ticket: bool = False
    created_by: Optional[str] = None


class OutagePatchPayload(BaseModel):
    outage_type: Optional[str] = None
    status: Optional[str] = None
    estimated_restoration_at: Optional[str] = None
    restored_at: Optional[str] = None
    affected_area: Optional[str] = None
    feeder_id: Optional[str] = None
    district: Optional[str] = None
    customers_affected: Optional[int] = None
    is_published: Optional[bool] = None
    summary: Optional[str] = None
    operator_id: Optional[str] = None


class OutageRestorePayload(BaseModel):
    restored_at: Optional[str] = None
    operator_id: Optional[str] = None


class RegulatoryGeneratePayload(BaseModel):
    period_start: str
    period_end: str
    customer_base: int = 10000
    generated_by: Optional[str] = None


def _ops_conn():
    if not SUPABASE_DB_URI:
        raise HTTPException(status_code=500, detail="SUPABASE_DB_URI not configured")
    return pooled_connect(SUPABASE_DB_URI)


@app.get("/api/v1/cases")
async def api_list_cases(status: str | None = Query(default=None)):
    try:
        conn = _ops_conn()
        try:
            return {"cases": list_cases(conn, status=status)}
        finally:
            conn.close()
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.post("/api/v1/cases")
async def api_create_case(payload: CaseCreatePayload):
    try:
        conn = _ops_conn()
        try:
            case = create_case(conn, payload.model_dump())
            conn.commit()
        finally:
            conn.close()
        return case
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.get("/api/v1/cases/{case_id}")
async def api_get_case(case_id: str):
    try:
        conn = _ops_conn()
        try:
            return get_case(conn, case_id)
        finally:
            conn.close()
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.patch("/api/v1/cases/{case_id}")
async def api_patch_case(case_id: str, payload: CasePatchPayload):
    try:
        conn = _ops_conn()
        try:
            case = patch_case(conn, case_id, payload.model_dump(exclude_none=True))
            conn.commit()
        finally:
            conn.close()
        return case
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.post("/api/v1/cases/{case_id}/convert-ticket")
async def api_convert_case_ticket(case_id: str, payload: ConvertTicketPayload):
    try:
        conn = _ops_conn()
        try:
            ticket = convert_case_to_ticket(conn, case_id, payload.model_dump(exclude_none=True))
            conn.commit()
        finally:
            conn.close()
        return ticket
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.post("/api/v1/cases/{case_id}/convert-work-order")
async def api_convert_case_work_order(case_id: str, payload: ConvertWorkOrderPayload):
    try:
        conn = _ops_conn()
        try:
            wo = convert_case_to_work_order(conn, case_id, payload.model_dump(exclude_none=True))
            conn.commit()
        finally:
            conn.close()
        return wo
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.get("/api/v1/tickets")
async def api_list_tickets(status: str | None = Query(default=None)):
    try:
        conn = _ops_conn()
        try:
            return {"tickets": list_tickets(conn, status=status)}
        finally:
            conn.close()
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.post("/api/v1/tickets")
async def api_create_ticket(payload: TicketCreatePayload):
    try:
        conn = _ops_conn()
        try:
            ticket = create_ticket(conn, payload.model_dump())
            conn.commit()
        finally:
            conn.close()
        return ticket
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.get("/api/v1/tickets/{ticket_id}")
async def api_get_ticket(ticket_id: str):
    try:
        conn = _ops_conn()
        try:
            return get_ticket(conn, ticket_id)
        finally:
            conn.close()
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.patch("/api/v1/tickets/{ticket_id}")
async def api_patch_ticket(ticket_id: str, payload: TicketPatchPayload):
    try:
        conn = _ops_conn()
        try:
            ticket = patch_ticket(conn, ticket_id, payload.model_dump(exclude_none=True))
            conn.commit()
        finally:
            conn.close()
        return ticket
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.post("/api/v1/tickets/{ticket_id}/link")
async def api_link_ticket(ticket_id: str, payload: TicketLinkPayload):
    try:
        conn = _ops_conn()
        try:
            ticket = link_ticket(
                conn,
                ticket_id,
                target_type=payload.target_type,
                target_id=payload.target_id,
                link_reason=payload.link_reason,
                operator_id=payload.operator_id,
            )
            conn.commit()
        finally:
            conn.close()
        return ticket
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.get("/api/v1/work-orders")
async def api_list_work_orders(
    status: str | None = Query(default=None),
    assigned_user: str | None = Query(default=None),
    assigned_crew: str | None = Query(default=None),
):
    try:
        conn = _ops_conn()
        try:
            return {
                "work_orders": list_work_orders(
                    conn,
                    status=status,
                    assigned_user=assigned_user,
                    assigned_crew=assigned_crew,
                )
            }
        finally:
            conn.close()
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.get("/api/v1/work-orders/assigned")
async def api_assigned_work_orders(
    user: str | None = Query(default=None),
    crew: str | None = Query(default=None),
):
    if not user and not crew:
        raise HTTPException(status_code=400, detail="user or crew query param required")
    try:
        conn = _ops_conn()
        try:
            return {
                "work_orders": list_work_orders(
                    conn,
                    assigned_user=user,
                    assigned_crew=crew,
                )
            }
        finally:
            conn.close()
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.post("/api/v1/work-orders")
async def api_create_work_order(payload: WorkOrderCreatePayload):
    try:
        conn = _ops_conn()
        try:
            wo = create_work_order(conn, payload.model_dump())
            conn.commit()
        finally:
            conn.close()
        return wo
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.get("/api/v1/work-orders/{work_order_id}")
async def api_get_work_order(work_order_id: str):
    try:
        conn = _ops_conn()
        try:
            return get_work_order(conn, work_order_id)
        finally:
            conn.close()
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.patch("/api/v1/work-orders/{work_order_id}")
async def api_patch_work_order(work_order_id: str, payload: WorkOrderPatchPayload):
    try:
        conn = _ops_conn()
        try:
            wo = patch_work_order(conn, work_order_id, payload.model_dump(exclude_none=True))
            conn.commit()
        finally:
            conn.close()
        return wo
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.get("/api/v1/outages")
async def api_list_outages(
    status: str | None = Query(default=None),
    published_only: bool = Query(default=False),
):
    try:
        conn = _ops_conn()
        try:
            return {"outages": list_outages(conn, status=status, published_only=published_only)}
        finally:
            conn.close()
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.post("/api/v1/outages")
async def api_create_outage(payload: OutageCreatePayload):
    try:
        conn = _ops_conn()
        try:
            outage = create_outage(conn, payload.model_dump())
            conn.commit()
        finally:
            conn.close()
        return outage
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.get("/api/v1/outages/{outage_id}")
async def api_get_outage(outage_id: str):
    try:
        conn = _ops_conn()
        try:
            return get_outage(conn, outage_id)
        finally:
            conn.close()
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.patch("/api/v1/outages/{outage_id}")
async def api_patch_outage(outage_id: str, payload: OutagePatchPayload):
    try:
        conn = _ops_conn()
        try:
            outage = patch_outage(conn, outage_id, payload.model_dump(exclude_none=True))
            conn.commit()
        finally:
            conn.close()
        return outage
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.post("/api/v1/outages/{outage_id}/restore")
async def api_restore_outage(outage_id: str, payload: OutageRestorePayload):
    try:
        conn = _ops_conn()
        try:
            outage = restore_outage(conn, outage_id, payload.model_dump(exclude_none=True))
            conn.commit()
        finally:
            conn.close()
        return outage
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.get("/api/v1/regulatory/metrics")
async def api_regulatory_metrics(
    period_start: str = Query(...),
    period_end: str = Query(...),
    customer_base: int = Query(default=10000),
):
    try:
        conn = _ops_conn()
        try:
            return compute_metrics(
                conn,
                period_start=period_start,
                period_end=period_end,
                customer_base=customer_base,
            )
        finally:
            conn.close()
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.post("/api/v1/regulatory/reports/generate")
async def api_generate_regulatory_report(payload: RegulatoryGeneratePayload):
    try:
        conn = _ops_conn()
        try:
            report = generate_report(conn, **payload.model_dump())
            conn.commit()
        finally:
            conn.close()
        return report
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.get("/api/v1/regulatory/reports")
async def api_list_regulatory_reports():
    try:
        conn = _ops_conn()
        try:
            return {"reports": list_reports(conn)}
        finally:
            conn.close()
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.on_event("startup")
def warm_voice_pipeline() -> None:
    """Preload Whisper + boundary vocabulary off the request path."""

    def _warm() -> None:
        try:
            from agents import voice_stt

            voice_stt.warm_model()
            if SUPABASE_DB_URI:
                conn = pooled_connect(SUPABASE_DB_URI)
                try:
                    voice_stt.warm_boundary_prompt(conn)
                finally:
                    conn.close()
        except Exception:
            logging.getLogger(__name__).warning("voice warmup failed", exc_info=True)

    threading.Thread(target=_warm, name="voice-warmup", daemon=True).start()


@app.on_event("shutdown")
def shutdown():
    graph_driver.close()
    close_all_pools()


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("main:app", host="0.0.0.0", port=5000, reload=True)
