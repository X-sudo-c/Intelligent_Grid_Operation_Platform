"""Field trial backup / restore / simulate — OVERSEEYER job runner."""

from __future__ import annotations

import os
import subprocess
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator

from dotenv import load_dotenv

import overseer

ROOT = overseer.ROOT
TRIAL_SCRIPTS = ROOT / "scripts" / "trial"
TRIAL_LOG_NAME = "trial-ops.log"
TRIAL_PID_NAME = "trial-ops"

_trial_lock = threading.Lock()
_trial_running = False
_trial_action: str | None = None

load_dotenv(ROOT / ".env", override=False)

SUPABASE_DB_URI = os.getenv(
    "SUPABASE_DB_URI",
    "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
)
TRIAL_BACKUP_DIR = Path(
    os.getenv("TRIAL_BACKUP_DIR", str(ROOT / ".giop" / "backups" / "trial")),
)


def _trial_pidfile() -> Path:
    return overseer.PID_DIR / f"{TRIAL_PID_NAME}.pid"


def _trial_pid_alive() -> bool:
    pidfile = _trial_pidfile()
    if not pidfile.is_file():
        return False
    try:
        pid = int(pidfile.read_text().strip())
        os.kill(pid, 0)
        return True
    except (OSError, ValueError):
        pidfile.unlink(missing_ok=True)
        return False


def _db_reachable() -> bool:
    return overseer._port_open("127.0.0.1", 54322)


def _sync_reachable() -> bool:
    return overseer._port_open("127.0.0.1", 5000)


def _requires_confirm(action: str, *, empty_master: bool, fresh_staging: bool) -> bool:
    if action in ("restore", "clear_master", "clear_staging"):
        return True
    if action == "prep" and (empty_master or fresh_staging):
        return True
    return False


def trial_counts() -> dict[str, Any]:
    if not _db_reachable():
        return {"status": "unavailable", "reason": "Postgres :54322 closed"}
    try:
        import psycopg2

        conn = psycopg2.connect(SUPABASE_DB_URI)
        try:
            with conn.cursor() as cur:
                rows: dict[str, int] = {}
                for label, sql in (
                    ("connectivity_nodes", "SELECT COUNT(*) FROM public.connectivity_nodes"),
                    ("ac_line_segments", "SELECT COUNT(*) FROM public.ac_line_segments"),
                    ("identified_objects", "SELECT COUNT(*) FROM public.identified_objects"),
                    ("staging_identified_objects", "SELECT COUNT(*) FROM staging.identified_objects"),
                    (
                        "dq_exceptions_open",
                        "SELECT COUNT(*) FROM public.data_quality_exceptions WHERE status = 'OPEN'",
                    ),
                    ("gis_asset_id_map", "SELECT COUNT(*) FROM gis.asset_id_map"),
                ):
                    cur.execute(sql)
                    rows[label] = int(cur.fetchone()[0])
        finally:
            conn.close()
        return {"status": "ok", "counts": rows}
    except Exception as exc:
        return {"status": "error", "reason": str(exc)}


def list_backups() -> dict[str, Any]:
    backup_dir = TRIAL_BACKUP_DIR
    if not backup_dir.is_dir():
        return {
            "status": "ok",
            "backup_dir": str(backup_dir),
            "latest": None,
            "backups": [],
        }
    dumps = sorted(backup_dir.glob("*.dump"), key=lambda p: p.stat().st_mtime, reverse=True)
    latest_link = backup_dir / "LATEST.dump"
    latest: str | None = None
    if latest_link.is_symlink():
        latest = str(latest_link.resolve())
    elif dumps:
        latest = str(dumps[0])
    backups = [
        {
            "path": str(p),
            "name": p.name,
            "size_bytes": p.stat().st_size,
            "modified_at": datetime.fromtimestamp(p.stat().st_mtime, tz=timezone.utc).isoformat(),
        }
        for p in dumps[:20]
    ]
    return {
        "status": "ok",
        "backup_dir": str(backup_dir),
        "latest": latest,
        "backups": backups,
    }


def trial_status() -> dict[str, Any]:
    counts = trial_counts()
    backups = list_backups()
    return {
        "running": _trial_running or _trial_pid_alive(),
        "action": _trial_action,
        "log_name": TRIAL_LOG_NAME,
        "backup_dir": str(TRIAL_BACKUP_DIR),
        "latest_backup": backups.get("latest"),
        "counts": counts.get("counts"),
        "counts_status": counts.get("status"),
        "sync_reachable": _sync_reachable(),
        "postgres_reachable": _db_reachable(),
    }


def _build_cmd(
    action: str,
    *,
    empty_master: bool = False,
    fresh_staging: bool = False,
    dump_file: str | None = None,
    count: int = 20,
    run_validation: bool = False,
) -> list[str]:
    if action == "backup":
        return ["bash", str(TRIAL_SCRIPTS / "backup_before_trial.sh")]
    if action == "prep":
        cmd = ["bash", str(TRIAL_SCRIPTS / "prep_trial.sh")]
        if empty_master:
            cmd.append("--empty-master")
        if fresh_staging:
            cmd.append("--fresh-staging")
        return cmd
    if action == "restore":
        cmd = ["bash", str(TRIAL_SCRIPTS / "restore_from_backup.sh")]
        if dump_file:
            cmd.append(dump_file)
        return cmd
    if action == "clear_master":
        return ["bash", str(TRIAL_SCRIPTS / "clear_master_network.sh")]
    if action == "clear_staging":
        return ["bash", str(TRIAL_SCRIPTS / "clear_staging.sh")]
    if action == "reimport_gis":
        return ["bash", str(TRIAL_SCRIPTS / "reimport_master_from_gis.sh")]
    if action == "simulate":
        py = overseer.GIOP_PYTHON
        cmd = [py, str(TRIAL_SCRIPTS / "simulate_field_captures.py"), "--count", str(count)]
        if run_validation:
            cmd.append("--run-validation")
        return cmd
    raise ValueError(f"Unknown trial action: {action}")


def _check_preflight(action: str) -> None:
    if action == "simulate":
        if not _sync_reachable():
            raise ValueError("sync-service is not running on :5000 — start it before simulating captures")
        return
    if not _db_reachable():
        raise ValueError("Postgres is not reachable on :54322 — start Supabase first")


def iter_trial_job(
    action: str,
    *,
    confirm: bool = False,
    empty_master: bool = False,
    fresh_staging: bool = False,
    dump_file: str | None = None,
    count: int = 20,
    run_validation: bool = False,
) -> Iterator[dict[str, Any]]:
    """Run a trial script; stream log lines for SSE."""
    global _trial_running, _trial_action

    allowed = {
        "backup",
        "prep",
        "restore",
        "clear_master",
        "clear_staging",
        "reimport_gis",
        "simulate",
    }
    if action not in allowed:
        raise ValueError(f"Invalid action — choose one of: {', '.join(sorted(allowed))}")

    if _requires_confirm(action, empty_master=empty_master, fresh_staging=fresh_staging) and not confirm:
        raise ValueError("Destructive trial action — pass confirm=true")

    if action == "restore" and dump_file and not Path(dump_file).is_file():
        raise ValueError(f"Backup file not found: {dump_file}")

    with _trial_lock:
        if _trial_running or _trial_pid_alive():
            raise ValueError("Trial job already running")
        _trial_running = True
        _trial_action = action

    proc: subprocess.Popen[Any] | None = None
    logf = None
    try:
        _check_preflight(action)
        overseer.LOG_DIR.mkdir(parents=True, exist_ok=True)
        overseer.PID_DIR.mkdir(parents=True, exist_ok=True)
        log_path = overseer.LOG_DIR / TRIAL_LOG_NAME
        cmd = _build_cmd(
            action,
            empty_master=empty_master,
            fresh_staging=fresh_staging,
            dump_file=dump_file,
            count=count,
            run_validation=run_validation,
        )
        header = f"--- trial {action} {datetime.now(timezone.utc).isoformat()} ---"
        yield {"type": "line", "text": header, "action": action}

        env = os.environ.copy()
        env["TRIAL_CONFIRM"] = "1"
        env.setdefault("SUPABASE_DB_URI", SUPABASE_DB_URI)
        env.setdefault("TRIAL_BACKUP_DIR", str(TRIAL_BACKUP_DIR))

        logf = open(log_path, "a", encoding="utf-8")
        logf.write(f"\n{header}\n")
        logf.flush()
        tail_offset = logf.tell()

        proc = subprocess.Popen(
            cmd,
            cwd=str(ROOT),
            stdout=logf,
            stderr=subprocess.STDOUT,
            text=True,
            env=env,
            start_new_session=True,
        )
        _trial_pidfile().write_text(str(proc.pid), encoding="utf-8")

        pending = ""
        while True:
            exit_code = proc.poll()
            logf.flush()
            with open(log_path, encoding="utf-8") as reader:
                reader.seek(tail_offset)
                chunk = reader.read()
                if chunk:
                    tail_offset = reader.tell()
                    pending += chunk
                    while "\n" in pending:
                        line, pending = pending.split("\n", 1)
                        if line.strip():
                            yield {"type": "line", "text": line.rstrip("\r"), "action": action}
            if exit_code is not None:
                if pending.strip():
                    yield {"type": "line", "text": pending.rstrip("\r"), "action": action}
                break
            time.sleep(0.5)

        yield {"type": "done", "exit_code": exit_code, "action": action}
    finally:
        if proc is not None and proc.poll() is None:
            proc.wait(timeout=5)
        if logf is not None:
            logf.close()
        _trial_pidfile().unlink(missing_ok=True)
        with _trial_lock:
            _trial_running = False
            _trial_action = None
