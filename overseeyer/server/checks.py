"""Read-only observability probes for OVERSEEYER."""

from __future__ import annotations

import json
import os
import socket
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.error import URLError
from urllib.request import Request, urlopen

import overseer

SYNC_METRICS_URL = os.getenv(
    "SYNC_METRICS_URL",
    "http://127.0.0.1:5000/api/v1/health/metrics",
)
SYNC_DLQ_URL = os.getenv(
    "SYNC_DLQ_URL",
    "http://127.0.0.1:5000/api/v1/dlq?status=OPEN",
)
GRAPH_PARITY_URL = os.getenv(
    "GRAPH_PARITY_URL",
    "http://127.0.0.1:5000/api/v1/graph/parity",
)
MEMGRAPH_PORT = int(os.getenv("MEMGRAPH_PORT", "7687"))
REDIS_PORT = int(os.getenv("REDIS_PORT", "6379"))
REDIS_URL = os.getenv("REDIS_URL", f"redis://127.0.0.1:{REDIS_PORT}/0")
SUPERTONIC_PORT = int(os.getenv("SUPERTONIC_PORT", "7788"))
SUPERTONIC_URL = (os.getenv("SUPERTONIC_URL") or f"http://127.0.0.1:{SUPERTONIC_PORT}").rstrip("/")
VOICE_STATUS_URL = os.getenv(
    "VOICE_STATUS_URL",
    "http://127.0.0.1:5000/api/v1/portal/ai/voice/status",
)
SUPABASE_DB_URI = os.getenv(
    "SUPABASE_DB_URI",
    "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
)
TIMESCALE_URI = os.getenv(
    "TIMESCALE_URI",
    "postgresql://postgres:postgres@127.0.0.1:5433/telemetry",
)
MIN_EDGE_RATIO = float(os.getenv("GIOP_MIN_EDGE_RATIO", "0.0001"))
MIN_EDGES = int(os.getenv("GIOP_MIN_EDGES", "10"))
MARTIN_PORT = int(os.getenv("MARTIN_PORT", "3001"))
MARTIN_MAP_LAYERS = ("map_connectivity_nodes", "map_ac_line_segments")

LOG_NAME_TO_SERVICE: dict[str, str] = {
    s.log_name: s.id for s in overseer.SERVICES if s.log_name
}


def _port_open(host: str, port: int) -> bool:
    try:
        with socket.create_connection((host, port), timeout=1.5):
            return True
    except OSError:
        return False


def _fetch_json(url: str, timeout: float = 3.0) -> dict[str, Any] | None:
    try:
        req = Request(url, method="GET")
        with urlopen(req, timeout=timeout) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        return data if isinstance(data, dict) else None
    except (URLError, OSError, ValueError, json.JSONDecodeError):
        return None


def _martin_catalog_ids(port: int = MARTIN_PORT) -> tuple[set[str], str | None]:
    if not _port_open("127.0.0.1", port):
        return set(), f"Martin not reachable on :{port} (is giop-martin running?)"
    last_error: str | None = None
    for attempt in range(5):
        try:
            req = Request(f"http://127.0.0.1:{port}/catalog", method="GET")
            with urlopen(req, timeout=8.0) as resp:
                data = json.loads(resp.read().decode("utf-8"))
            if isinstance(data, list):
                return {str(item["id"]) for item in data if isinstance(item, dict) and item.get("id")}, None
            if isinstance(data, dict):
                tiles = data.get("tiles") or data
                if isinstance(tiles, dict):
                    return set(tiles.keys()), None
            return set(), "unexpected Martin catalog format"
        except (URLError, OSError, ValueError, json.JSONDecodeError) as exc:
            last_error = str(exc)
            if attempt < 4:
                time.sleep(1.5)
    hint = (
        "Run ./scripts/ensure_martin.sh — Martin may be missing layers "
        "(bounds scan on map_connectivity_nodes can exhaust Postgres /dev/shm; "
        "config/martin.yaml sets explicit bounds)"
    )
    if last_error:
        return set(), f"{last_error} — {hint}"
    return set(), hint


def _unavailable(reason: str) -> dict[str, Any]:
    return {"status": "unavailable", "reason": reason}


def check_sync_metrics() -> dict[str, Any]:
    if not _port_open("127.0.0.1", 5000):
        return _unavailable("sync-service port :5000 closed")
    data = _fetch_json(SYNC_METRICS_URL)
    if not data:
        return _unavailable("could not fetch /api/v1/health/metrics")
    return {
        "status": "ok",
        "apm_status": data.get("status"),
        "request_count": data.get("request_count"),
        "error_count": data.get("error_count"),
        "error_rate_pct": data.get("error_rate_pct"),
        "latency_p50_ms": data.get("latency_p50_ms"),
        "latency_p95_ms": data.get("latency_p95_ms"),
        "last_kafka_ingest_at": data.get("last_kafka_ingest_at"),
    }


def check_dlq() -> dict[str, Any]:
    if _port_open("127.0.0.1", 5000):
        data = _fetch_json(SYNC_DLQ_URL)
        if data and "items" in data:
            items = data["items"]
            return {
                "status": "ok",
                "source": "sync-service",
                "open_count": len(items),
            }

    if not _port_open("127.0.0.1", 54322):
        return _unavailable("sync-service down and Postgres :54322 closed")

    try:
        import psycopg2

        conn = psycopg2.connect(SUPABASE_DB_URI)
        try:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT COUNT(*) FROM public.integration_dlq WHERE status = 'OPEN'"
                )
                count = cur.fetchone()[0]
        finally:
            conn.close()
        return {"status": "ok", "source": "postgres", "open_count": int(count)}
    except Exception as exc:
        return _unavailable(str(exc))


def _pg_row_estimate(cur, schema: str, relation: str) -> int:
    cur.execute(
        """
        SELECT COALESCE(c.reltuples::bigint, 0)
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = %s AND c.relname = %s
        """,
        (schema, relation),
    )
    row = cur.fetchone()
    return max(0, int(row[0])) if row else 0


def check_topology(*, fast: bool = False) -> dict[str, Any]:
    if not _port_open("127.0.0.1", 54322):
        return _unavailable("Postgres :54322 closed")

    try:
        import psycopg2

        conn = psycopg2.connect(SUPABASE_DB_URI)
        try:
            with conn.cursor() as cur:
                if fast:
                    node_count = _pg_row_estimate(cur, "public", "connectivity_nodes")
                    edge_count = _pg_row_estimate(cur, "public", "ac_line_segments")
                else:
                    cur.execute("SELECT COUNT(*) FROM public.connectivity_nodes")
                    node_count = int(cur.fetchone()[0])
                    cur.execute("SELECT COUNT(*) FROM public.ac_line_segments")
                    edge_count = int(cur.fetchone()[0])
        finally:
            conn.close()
    except Exception as exc:
        return _unavailable(str(exc))

    if node_count == 0:
        return {
            "status": "warn",
            "node_count": node_count,
            "edge_count": edge_count,
            "edge_ratio": 0.0,
            "hint": "No connectivity_nodes — run GPKG import or seed data",
        }

    ratio = edge_count / node_count if node_count else 0.0
    if edge_count < MIN_EDGES:
        return {
            "status": "fail",
            "node_count": node_count,
            "edge_count": edge_count,
            "edge_ratio": round(ratio, 6),
            "hint": f"Only {edge_count} edges (min {MIN_EDGES}) — run ./scripts/promote_topology.sh",
        }

    if ratio < MIN_EDGE_RATIO:
        return {
            "status": "fail",
            "node_count": node_count,
            "edge_count": edge_count,
            "edge_ratio": round(ratio, 6),
            "hint": f"Edge/node ratio too low ({edge_count}/{node_count}) — run ./scripts/promote_topology.sh",
        }

    return {
        "status": "ok",
        "node_count": node_count,
        "edge_count": edge_count,
        "edge_ratio": round(ratio, 6),
        "hint": None,
        "estimate": fast,
    }


def check_graph_sync() -> dict[str, Any]:
    """Compare Postgres topology counts with Memgraph via sync-service."""
    if not _port_open("127.0.0.1", 5000):
        return _unavailable("sync-service port :5000 closed — start sync gateway for parity check")

    if not _port_open("127.0.0.1", MEMGRAPH_PORT):
        return {
            "status": "unavailable",
            "reason": f"Memgraph :{MEMGRAPH_PORT} closed",
            "hint": "Start Memgraph, then Sync Memgraph",
        }

    data = _fetch_json(GRAPH_PARITY_URL)
    if not data:
        return _unavailable("could not fetch /api/v1/graph/parity")

    return {
        "status": data.get("status", "unavailable"),
        "in_sync": bool(data.get("in_sync")),
        "postgres_nodes": data.get("postgres_nodes"),
        "postgres_edges": data.get("postgres_edges"),
        "memgraph_nodes": data.get("memgraph_nodes"),
        "memgraph_edges": data.get("memgraph_edges"),
        "node_delta": data.get("node_delta"),
        "edge_delta": data.get("edge_delta"),
        "hint": data.get("hint"),
    }


def check_data_plane() -> dict[str, Any]:
    result: dict[str, Any] = {"status": "ok", "staging_count": None, "open_conflicts": None, "timescale": None}

    if _port_open("127.0.0.1", 54322):
        try:
            import psycopg2

            conn = psycopg2.connect(SUPABASE_DB_URI)
            try:
                with conn.cursor() as cur:
                    cur.execute("SELECT COUNT(*) FROM staging.identified_objects")
                    result["staging_count"] = int(cur.fetchone()[0])
                    cur.execute(
                        "SELECT COUNT(*) FROM public.conflict_proposals WHERE status = 'OPEN'"
                    )
                    result["open_conflicts"] = int(cur.fetchone()[0])
            finally:
                conn.close()
        except Exception as exc:
            result["status"] = "partial"
            result["postgres_error"] = str(exc)
    else:
        result["status"] = "unavailable"
        result["postgres_error"] = "Postgres :54322 closed"

    if _port_open("127.0.0.1", 5433):
        try:
            import psycopg2

            conn = psycopg2.connect(TIMESCALE_URI)
            try:
                with conn.cursor() as cur:
                    cur.execute(
                        """
                        SELECT EXISTS (
                          SELECT 1 FROM information_schema.tables
                          WHERE table_schema = 'public' AND table_name = 'meter_readings'
                        )
                        """
                    )
                    result["timescale"] = {
                        "reachable": True,
                        "meter_readings_table": bool(cur.fetchone()[0]),
                    }
            finally:
                conn.close()
        except Exception as exc:
            result["timescale"] = {"reachable": False, "error": str(exc)}
    else:
        result["timescale"] = {"reachable": False, "error": "port :5433 closed"}

    return result


def list_log_files() -> list[dict[str, Any]]:
    overseer.LOG_DIR.mkdir(parents=True, exist_ok=True)
    files: list[dict[str, Any]] = []
    for path in sorted(overseer.LOG_DIR.glob("*.log")):
        stat = path.stat()
        name = path.name
        service_id = LOG_NAME_TO_SERVICE.get(name.removesuffix(".log"), None)
        files.append(
            {
                "name": name,
                "service_id": service_id,
                "path": str(path),
                "size_bytes": stat.st_size,
                "modified_at": datetime.fromtimestamp(stat.st_mtime, tz=timezone.utc).isoformat(),
            }
        )
    return files


def tail_log_file(name: str, tail: int = 200) -> dict[str, Any]:
    safe = Path(name).name
    if not safe.endswith(".log") or safe != name:
        raise ValueError("Invalid log filename")

    path = overseer.LOG_DIR / safe
    if not path.is_file():
        raise FileNotFoundError(f"Log not found: {safe}")

    tail = max(1, min(tail, 2000))
    try:
        with path.open("r", encoding="utf-8", errors="replace") as handle:
            lines = handle.readlines()
    except OSError as exc:
        raise ValueError(str(exc)) from exc

    return {
        "name": safe,
        "path": str(path),
        "service_id": LOG_NAME_TO_SERVICE.get(safe.removesuffix(".log")),
        "tail": tail,
        "total_lines": len(lines),
        "lines": [line.rstrip("\n") for line in lines[-tail:]],
    }


def check_map_tile_views(*, fast: bool = False) -> dict[str, Any]:
    """Verify migration 00017 map views and Martin map_* tile layers."""
    if not _port_open("127.0.0.1", 54322):
        return _unavailable("Postgres :54322 closed")

    try:
        import psycopg2

        conn = psycopg2.connect(SUPABASE_DB_URI)
        try:
            with conn.cursor() as cur:
                if fast:
                    node_rows = _pg_row_estimate(cur, "public", "map_connectivity_nodes")
                    line_rows = _pg_row_estimate(cur, "public", "map_ac_line_segments")
                    if node_rows == 0:
                        cur.execute("SELECT EXISTS(SELECT 1 FROM public.map_connectivity_nodes LIMIT 1)")
                        if cur.fetchone()[0]:
                            node_rows = 1
                    if line_rows == 0:
                        cur.execute("SELECT EXISTS(SELECT 1 FROM public.map_ac_line_segments LIMIT 1)")
                        if cur.fetchone()[0]:
                            line_rows = 1
                    voltage_mix: list[dict[str, Any]] = []
                else:
                    cur.execute("SELECT COUNT(*) FROM public.map_connectivity_nodes")
                    node_rows = int(cur.fetchone()[0])
                    cur.execute("SELECT COUNT(*) FROM public.map_ac_line_segments")
                    line_rows = int(cur.fetchone()[0])
                    cur.execute(
                        """
                        SELECT nominal_voltage::text, COUNT(*)::bigint AS lines
                        FROM public.map_ac_line_segments
                        GROUP BY 1
                        ORDER BY 2 DESC
                        LIMIT 6
                        """
                    )
                    voltage_mix = [
                        {"nominal_voltage": row[0], "lines": int(row[1])}
                        for row in cur.fetchall()
                    ]
                    cur.execute(
                        """
                        SELECT relkind
                        FROM pg_class c
                        JOIN pg_namespace n ON n.oid = c.relnamespace
                        WHERE n.nspname = 'public' AND c.relname = 'map_connectivity_nodes'
                        """
                    )
                    relkind_row = cur.fetchone()
                    nodes_is_matview = relkind_row is not None and relkind_row[0] == "m"
                    cur.execute(
                        """
                        SELECT column_name
                        FROM information_schema.columns
                        WHERE table_schema = 'public'
                          AND table_name = 'map_connectivity_nodes'
                          AND column_name = 'asset_kind'
                        """
                    )
                    has_asset_kind = cur.fetchone() is not None
                    asset_kind_mix: list[dict[str, Any]] = []
                    transformer_nodes = 0
                    if has_asset_kind:
                        cur.execute(
                            """
                            SELECT source_layer, COUNT(*)::bigint AS nodes
                            FROM gis.asset_id_map
                            WHERE source_layer IN (
                              'distribution_transformer',
                              'power_transformer',
                              'oh_support_structure_11kv',
                              'oh_support_structure_33kv',
                              'oh_support_structure_lvle'
                            )
                            GROUP BY 1
                            ORDER BY 2 DESC
                            """
                        )
                        kind_map = {
                            "distribution_transformer": "distribution_transformer",
                            "power_transformer": "power_transformer",
                            "oh_support_structure_11kv": "pole_11kv",
                            "oh_support_structure_33kv": "pole_33kv",
                            "oh_support_structure_lvle": "pole_lv",
                        }
                        asset_kind_mix = [
                            {"asset_kind": kind_map.get(row[0], row[0]), "nodes": int(row[1])}
                            for row in cur.fetchall()
                        ]
                        transformer_nodes = sum(
                            row["nodes"]
                            for row in asset_kind_mix
                            if row["asset_kind"] in ("distribution_transformer", "power_transformer")
                        )
        finally:
            conn.close()
    except Exception as exc:
        message = str(exc)
        if "map_connectivity_nodes" in message or "map_ac_line_segments" in message:
            return {
                "status": "fail",
                "reason": "map tile views missing — apply migration 00017_map_tile_views.sql",
                "postgres_error": message,
            }
        return _unavailable(message)

    martin_ids, martin_error = _martin_catalog_ids()
    martin_layers = {layer: layer in martin_ids for layer in MARTIN_MAP_LAYERS}
    all_layers = all(martin_layers.values())

    if node_rows == 0 and line_rows == 0:
        return {
            "status": "fail",
            "reason": "map tile views are empty — import GPKG and run topology promote",
            "node_view_rows": node_rows,
            "line_view_rows": line_rows,
            "voltage_mix": voltage_mix,
            "martin_port": MARTIN_PORT,
            "martin_layers": martin_layers,
            "martin_error": martin_error,
        }

    if not all_layers:
        return {
            "status": "warn",
            "reason": martin_error or "Martin catalog missing map_* layers",
            "hint": "Run ./scripts/ensure_martin.sh after map tile migrations (recreates giop-martin with bounds config)",
            "node_view_rows": node_rows,
            "line_view_rows": line_rows,
            "voltage_mix": voltage_mix,
            "martin_port": MARTIN_PORT,
            "martin_layers": martin_layers,
            "martin_error": martin_error,
        }

    if not fast:
        if not has_asset_kind:
            # asset_kind optional since 00020; transformer icons use gis.* layers
            pass
    else:
        has_asset_kind = False
        asset_kind_mix = []
        transformer_nodes = 0

    result: dict[str, Any] = {
        "status": "pass",
        "node_view_rows": node_rows,
        "line_view_rows": line_rows,
        "voltage_mix": voltage_mix,
        "has_asset_kind": has_asset_kind,
        "nodes_is_matview": nodes_is_matview if not fast else False,
        "asset_kind_mix": asset_kind_mix,
        "transformer_nodes": transformer_nodes,
        "martin_port": MARTIN_PORT,
        "martin_layers": martin_layers,
        "martin_error": None,
    }
    if fast:
        result["estimate"] = True
    return result


def check_redis() -> dict[str, Any]:
    if not REDIS_URL:
        return {"status": "disabled", "enabled": False, "hint": "REDIS_URL not set"}

    if not _port_open("127.0.0.1", REDIS_PORT):
        return {
            "status": "unavailable",
            "enabled": True,
            "hint": "Start Redis: ./scripts/ensure_redis.sh (sync-service falls back without cache)",
        }

    try:
        import subprocess

        proc = subprocess.run(
            ["docker", "exec", "giop-redis", "redis-cli", "ping"],
            capture_output=True,
            text=True,
            timeout=3,
            check=False,
        )
        if proc.stdout.strip().upper() == "PONG":
            return {"status": "ok", "enabled": True, "port": REDIS_PORT}
    except Exception:
        pass

    return {
        "status": "partial",
        "enabled": True,
        "port": REDIS_PORT,
        "hint": "Port open — verify with docker exec giop-redis redis-cli ping",
    }


def check_voice_tts() -> dict[str, Any]:
    """Supertonic local TTS + sync-service voice copilot bridge."""
    if not _port_open("127.0.0.1", SUPERTONIC_PORT):
        return {
            "status": "unavailable",
            "port": SUPERTONIC_PORT,
            "url": SUPERTONIC_URL,
            "hint": "Start: ./scripts/start-supertonic.sh (GIOP copilot voice replies)",
        }

    supertonic_ok = False
    try:
        with urlopen(f"{SUPERTONIC_URL}/docs", timeout=3) as resp:
            supertonic_ok = resp.status == 200
    except (URLError, OSError, TimeoutError):
        supertonic_ok = False

    voice_api: dict[str, Any] | None = None
    if _port_open("127.0.0.1", 5000):
        try:
            with urlopen(VOICE_STATUS_URL, timeout=3) as resp:
                voice_api = json.loads(resp.read().decode("utf-8"))
        except (URLError, OSError, TimeoutError, json.JSONDecodeError):
            voice_api = None

    if supertonic_ok:
        return {
            "status": "ok",
            "port": SUPERTONIC_PORT,
            "url": SUPERTONIC_URL,
            "voice_api": voice_api,
            "hint": None,
        }

    return {
        "status": "partial",
        "port": SUPERTONIC_PORT,
        "url": SUPERTONIC_URL,
        "voice_api": voice_api,
        "hint": f"Port {SUPERTONIC_PORT} open but Supertonic /docs not responding — check .giop/logs/supertonic.log",
    }


def observability_snapshot() -> dict[str, Any]:
    return {
        "checked_at": datetime.now(timezone.utc).isoformat(),
        "stack": overseer.stack_status(),
        "sync_metrics": check_sync_metrics(),
        "dlq": check_dlq(),
        "topology": check_topology(fast=True),
        "graph_sync": check_graph_sync(),
        "redis": check_redis(),
        "voice_tts": check_voice_tts(),
        "data_plane": check_data_plane(),
        "map_tiles": check_map_tile_views(fast=True),
        "logs": list_log_files(),
        "migrations": overseer.list_migrations(),
    }
