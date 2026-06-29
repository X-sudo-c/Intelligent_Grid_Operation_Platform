"""Supabase CLI resolution, diagnostics, and debug probes for OVERSEEYER."""

from __future__ import annotations

import json
import os
import subprocess
import time
from pathlib import Path
from typing import Any
from urllib.error import URLError
from urllib.request import Request, urlopen

import overseer

ROOT = overseer.ROOT
DEBUG_LOG = ROOT / ".cursor" / "debug-f110b8.log"
SESSION_ID = "f110b8"
ENSURE_CLI = ROOT / "scripts" / "ensure_supabase_cli.sh"
SUPABASE_LOG = overseer.LOG_DIR / "supabase.log"


def _agent_log(hypothesis_id: str, location: str, message: str, data: dict[str, Any] | None = None) -> None:
    # #region agent log
    try:
        payload = {
            "sessionId": SESSION_ID,
            "timestamp": int(time.time() * 1000),
            "hypothesisId": hypothesis_id,
            "location": location,
            "message": message,
            "data": data or {},
        }
        DEBUG_LOG.parent.mkdir(parents=True, exist_ok=True)
        with DEBUG_LOG.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(payload) + "\n")
    except OSError:
        pass
    # #endregion


def supabase_bin() -> str | None:
    """Resolve Supabase CLI binary (not npx — broken on some Node versions)."""
    candidates: list[str] = []
    if os.getenv("SUPABASE_CLI"):
        candidates.append(os.getenv("SUPABASE_CLI", ""))
    candidates.extend(
        [
            str(ROOT / ".tools" / "supabase" / "supabase"),
            "/usr/local/bin/supabase",
            str(Path.home() / ".local" / "bin" / "supabase"),
        ]
    )
    for path in candidates:
        if path and Path(path).is_file():
            return path
    which = subprocess.run(["which", "supabase"], capture_output=True, text=True, check=False)
    if which.returncode == 0 and which.stdout.strip():
        return which.stdout.strip()
    return None


def ensure_cli_installed() -> dict[str, Any]:
    path = supabase_bin()
    if path:
        return {"installed": True, "path": path}
    if not ENSURE_CLI.is_file():
        return {"installed": False, "error": f"Missing installer: {ENSURE_CLI}"}
    proc = subprocess.run(
        ["bash", str(ENSURE_CLI)],
        cwd=str(ROOT),
        capture_output=True,
        text=True,
        timeout=180,
        check=False,
    )
    path = supabase_bin()
    return {
        "installed": path is not None,
        "path": path,
        "exit_code": proc.returncode,
        "stdout": (proc.stdout or "")[-2000:],
        "stderr": (proc.stderr or "")[-1000:],
    }


def _run_supabase(args: list[str], *, timeout: int = 120) -> subprocess.CompletedProcess[str]:
    bin_path = supabase_bin()
    if not bin_path:
        installed = ensure_cli_installed()
        bin_path = installed.get("path")
        _agent_log("A", "supabase_ops._run_supabase", "cli_install_attempt", installed)
    if not bin_path:
        raise FileNotFoundError(
            "Supabase CLI not found. Run: ./scripts/ensure_supabase_cli.sh"
        )
    cmd = [bin_path, *args]
    _agent_log("A", "supabase_ops._run_supabase", "exec", {"cmd": cmd, "timeout": timeout})
    overseer.LOG_DIR.mkdir(parents=True, exist_ok=True)
    proc = subprocess.run(
        cmd,
        cwd=str(ROOT),
        capture_output=True,
        text=True,
        timeout=timeout,
        check=False,
    )
    with SUPABASE_LOG.open("a", encoding="utf-8") as logf:
        logf.write(f"\n--- {time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())} {' '.join(cmd)} exit={proc.returncode} ---\n")
        if proc.stdout:
            logf.write(proc.stdout)
        if proc.stderr:
            logf.write(proc.stderr)
    _agent_log(
        "B",
        "supabase_ops._run_supabase",
        "exec_done",
        {
            "exit_code": proc.returncode,
            "stdout_tail": (proc.stdout or "")[-500:],
            "stderr_tail": (proc.stderr or "")[-500:],
        },
    )
    return proc


def _npx_probe() -> dict[str, Any]:
    proc = subprocess.run(
        ["npx", "supabase", "--version"],
        cwd=str(ROOT),
        capture_output=True,
        text=True,
        timeout=30,
        check=False,
    )
    return {
        "exit_code": proc.returncode,
        "stdout": (proc.stdout or "").strip(),
        "stderr": (proc.stderr or "")[-500:],
    }


def _docker_supabase_containers() -> list[dict[str, str]]:
    proc = subprocess.run(
        ["docker", "ps", "-a", "--filter", "name=supabase", "--format", "{{.Names}}\t{{.Status}}"],
        capture_output=True,
        text=True,
        timeout=15,
        check=False,
    )
    rows: list[dict[str, str]] = []
    if proc.returncode != 0:
        return rows
    for line in proc.stdout.splitlines():
        if not line.strip():
            continue
        parts = line.split("\t", 1)
        rows.append({"name": parts[0], "status": parts[1] if len(parts) > 1 else ""})
    return rows


def diagnose() -> dict[str, Any]:
    pg_port = overseer._port_open("127.0.0.1", 54322)
    api_port = overseer._port_open("127.0.0.1", 54321)
    studio_port = overseer._port_open("127.0.0.1", 54323)

    cli_path = supabase_bin()
    npx_probe = _npx_probe()
    containers = _docker_supabase_containers()
    seed_path = ROOT / "supabase" / "seed.sql"
    seed_exists = seed_path.is_file()

    _agent_log(
        "C",
        "supabase_ops.diagnose",
        "snapshot",
        {
            "cli_path": cli_path,
            "npx_probe": npx_probe,
            "container_count": len(containers),
            "pg_port": pg_port,
            "api_port": api_port,
            "seed_exists": seed_exists,
        },
    )

    status_proc: subprocess.CompletedProcess[str] | None = None
    status_error: str | None = None
    if cli_path:
        try:
            status_proc = _run_supabase(["status"], timeout=45)
        except (OSError, subprocess.TimeoutExpired) as exc:
            status_error = str(exc)

    hints: list[str] = []
    if not cli_path and npx_probe.get("exit_code") != 0:
        hints.append("npx supabase is broken on this Node version — use ./scripts/ensure_supabase_cli.sh")
    if not containers:
        hints.append("No supabase Docker containers — run Supabase Start from Overseeyer or: .tools/supabase/supabase start")
    if not pg_port:
        hints.append("Postgres :54322 is down — Supabase stack is not running")
    if pg_port and not api_port:
        hints.append("Postgres up but API :54321 down — stack may still be starting or kong failed")
    if not seed_exists:
        hints.append("Missing supabase/seed.sql — db reset can fail when [db.seed] is enabled")

    return {
        "cli_path": cli_path,
        "npx_probe": npx_probe,
        "containers": containers,
        "ports": {"postgres": pg_port, "api": api_port, "studio": studio_port},
        "seed_sql_exists": seed_exists,
        "status": {
            "exit_code": status_proc.returncode if status_proc else None,
            "stdout": (status_proc.stdout or "")[-4000:] if status_proc else None,
            "stderr": (status_proc.stderr or "")[-1000:] if status_proc else None,
            "error": status_error,
        },
        "log_path": str(SUPABASE_LOG),
        "hints": hints,
    }


def start_local() -> dict[str, Any]:
    proc = _run_supabase(["start"], timeout=300)
    return {
        "action": "start",
        "exit_code": proc.returncode,
        "stdout": proc.stdout[-4000:] if proc.stdout else "",
        "stderr": proc.stderr[-2000:] if proc.stderr else "",
        "diagnose": diagnose(),
    }


def run_db_command(mode: str) -> subprocess.CompletedProcess[str]:
    if mode == "reset":
        return _run_supabase(["db", "reset", "--local"], timeout=900)
    return _run_supabase(["migration", "up", "--local"], timeout=600)
