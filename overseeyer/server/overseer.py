"""OVERSEEYER — local stack health, orchestration, and migration management."""

from __future__ import annotations

import os
import re
import signal
import socket
import subprocess
import threading
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator, Literal
from urllib.error import URLError
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parent.parent.parent
OVERSEYER_DIR = ROOT / "overseeyer"
RUN_DIR = Path(os.getenv("GIOP_RUN_DIR", str(ROOT / ".giop")))
LOG_DIR = RUN_DIR / "logs"
PID_DIR = RUN_DIR / "pids"
MIGRATIONS_DIR = ROOT / "supabase" / "migrations"

_DEFAULT_PYTHON = str(ROOT / ".venv" / "bin" / "python")
GIOP_PYTHON = os.getenv("GIOP_PYTHON") or (
    _DEFAULT_PYTHON if Path(_DEFAULT_PYTHON).is_file() else "python3"
)

OVERSEYER_API_PORT = int(os.getenv("OVERSEYER_API_PORT", "5190"))
OVERSEYER_WEB_PORT = int(os.getenv("OVERSEYER_WEB_PORT", "5191"))
SUPERTONIC_PORT = int(os.getenv("SUPERTONIC_PORT", "7788"))

# Started/stopped via service_ctl.sh (self-shutdown from the running API).
SELF_MANAGED_SERVICES = frozenset({"overseeyer-api", "overseeyer-web"})

ServiceKind = Literal["docker", "process", "supabase", "external"]


@dataclass(frozen=True)
class ServiceDef:
    id: str
    name: str
    kind: ServiceKind
    port: int | None = None
    health_url: str | None = None
    container: str | None = None
    pid_name: str | None = None
    workdir: Path | None = None
    start_cmd: tuple[str, ...] | None = None
    log_name: str | None = None


SERVICES: list[ServiceDef] = [
    ServiceDef(
        "overseeyer-api",
        "OVERSEEYER API",
        "process",
        OVERSEYER_API_PORT,
        f"http://127.0.0.1:{OVERSEYER_API_PORT}/api/health",
        pid_name="overseeyer-api",
        workdir=OVERSEYER_DIR / "server",
        start_cmd=(
            GIOP_PYTHON,
            "-m",
            "uvicorn",
            "main:app",
            "--host",
            "0.0.0.0",
            "--port",
            str(OVERSEYER_API_PORT),
            "--reload",
        ),
        log_name="overseeyer-api",
    ),
    ServiceDef(
        "overseeyer-web",
        "OVERSEEYER UI",
        "process",
        OVERSEYER_WEB_PORT,
        f"http://127.0.0.1:{OVERSEYER_WEB_PORT}/",
        pid_name="overseeyer-web",
        workdir=OVERSEYER_DIR / "web",
        log_name="overseeyer-web",
    ),
    ServiceDef("supabase", "Supabase", "supabase", 54321, "http://127.0.0.1:54321/rest/v1/"),
    ServiceDef("memgraph", "Memgraph", "docker", 7687, container="my-memgraph"),
    ServiceDef("martin", "Martin tiles", "docker", 3001, container="giop-martin"),
    ServiceDef(
        "martin-cache",
        "Martin nginx cache",
        "docker",
        3002,
        "http://127.0.0.1:3002/catalog",
        container="giop-martin-cache",
        log_name="martin-cache",
    ),
    ServiceDef("timescale", "TimescaleDB", "docker", 5433, container="giop-timescale"),
    ServiceDef("redis", "Redis cache", "docker", 6379, container="giop-redis", log_name="redis"),
    ServiceDef(
        "sync-service",
        "Sync gateway",
        "process",
        5000,
        "http://127.0.0.1:5000/api/v1/health/metrics",
        pid_name="sync-service",
        workdir=ROOT / "sync-service",
        start_cmd=(
            GIOP_PYTHON,
            "-m",
            "uvicorn",
            "main:app",
            "--host",
            "0.0.0.0",
            "--port",
            "5000",
            "--workers",
            "2",
        ),
        log_name="sync-service",
    ),
    ServiceDef(
        "supertonic",
        "Supertonic TTS (voice)",
        "process",
        SUPERTONIC_PORT,
        f"http://127.0.0.1:{SUPERTONIC_PORT}/docs",
        pid_name="supertonic",
        log_name="supertonic",
    ),
    ServiceDef(
        "ocr-service",
        "OCR service",
        "process",
        5002,
        "http://127.0.0.1:5002/docs",
        pid_name="ocr-service",
        workdir=ROOT / "ocr-service",
        start_cmd=(
            GIOP_PYTHON,
            "-m",
            "uvicorn",
            "main:app",
            "--host",
            "0.0.0.0",
            "--port",
            "5002",
        ),
        log_name="ocr-service",
    ),
    ServiceDef(
        "giop-portal",
        "GIOP React portal",
        "process",
        5173,
        "http://127.0.0.1:5173/",
        pid_name="giop-portal",
        workdir=ROOT / "backoffice-ui" / "cloudhound frontend portal",
        log_name="giop-portal",
    ),
    ServiceDef(
        "backoffice-ui",
        "GIOP legacy UI",
        "process",
        8080,
        "http://127.0.0.1:8080/",
        pid_name="backoffice-ui",
        workdir=ROOT / "backoffice-ui",
        log_name="backoffice-ui",
    ),
]


def log_name_for_service(service_id: str) -> str | None:
    for s in SERVICES:
        if s.id == service_id and s.log_name:
            return f"{s.log_name}.log"
    return None


def _python_bin() -> str:
    venv = ROOT / ".venv" / "bin" / "python"
    if venv.is_file():
        return str(venv)
    return os.getenv("GIOP_PYTHON", "python3")


def _port_open(host: str, port: int) -> bool:
    try:
        with socket.create_connection((host, port), timeout=1.5):
            return True
    except OSError:
        return False


def _http_reachable(url: str) -> bool:
    try:
        req = Request(url, method="GET")
        with urlopen(req, timeout=3) as resp:
            return 200 <= resp.status < 600
    except (URLError, OSError, ValueError):
        return False


def _docker_running(name: str) -> bool:
    try:
        out = subprocess.run(
            ["docker", "inspect", "-f", "{{.State.Running}}", name],
            capture_output=True,
            text=True,
            timeout=5,
            check=False,
        )
        return out.stdout.strip() == "true"
    except (OSError, subprocess.TimeoutExpired):
        return False


def _docker_exists(name: str) -> bool:
    try:
        out = subprocess.run(
            ["docker", "ps", "-a", "--format", "{{.Names}}"],
            capture_output=True,
            text=True,
            timeout=5,
            check=False,
        )
        return name in out.stdout.splitlines()
    except (OSError, subprocess.TimeoutExpired):
        return False


def _read_pid(pid_name: str) -> int | None:
    pidfile = PID_DIR / f"{pid_name}.pid"
    if not pidfile.is_file():
        return None
    try:
        pid = int(pidfile.read_text().strip())
        os.kill(pid, 0)
        return pid
    except (OSError, ValueError):
        return None


def _probe_service(defn: ServiceDef) -> dict[str, Any]:
    status = "unknown"
    detail = ""
    pid = None

    if defn.kind == "docker":
        if not _docker_exists(defn.container or ""):
            status = "missing"
            detail = f"container {(defn.container)} not found"
        elif not _docker_running(defn.container or ""):
            status = "down"
            detail = f"docker start {(defn.container)}"
        elif defn.port and not _port_open("127.0.0.1", defn.port):
            status = "partial"
            detail = f"container up, port :{defn.port} closed"
        else:
            status = "up"
            detail = f":{defn.port}" if defn.port else "running"

    elif defn.kind == "supabase":
        pg_up = _port_open("127.0.0.1", 54322)
        api_up = _http_reachable(defn.health_url or "")
        if pg_up and api_up:
            status = "up"
            detail = "API :54321, PG :54322"
        elif pg_up:
            status = "partial"
            detail = "Postgres only"
        else:
            status = "down"
            detail = "npx supabase start"

    elif defn.kind == "process":
        if defn.id == "supertonic":
            try:
                from supertonic_ops import supertonic_status

                st = supertonic_status()
                pid = st.get("pid")
                phase = st.get("phase", "down")
                if phase == "ready":
                    status = "up"
                    detail = f":{defn.port} ready"
                elif phase in ("starting", "warming") or st.get("start_job_running"):
                    status = "partial"
                    detail = phase + (f" · pid {pid}" if pid else "")
                elif pid:
                    status = "partial"
                    detail = f"pid {pid} · {phase}"
                else:
                    status = "down"
                    detail = st.get("hint") or f":{defn.port} offline"
            except Exception as exc:
                pid = _read_pid(defn.pid_name or defn.id)
                port_up = defn.port and _port_open("127.0.0.1", defn.port)
                health_up = defn.health_url and _http_reachable(defn.health_url)
                if port_up or health_up:
                    status = "up"
                    detail = f":{defn.port}" if defn.port else "running"
                elif pid:
                    status = "partial"
                    detail = f"pid {pid} but port closed"
                else:
                    status = "down"
                    detail = str(exc)[:120]
        else:
            pid = _read_pid(defn.pid_name or defn.id)
            port_up = defn.port and _port_open("127.0.0.1", defn.port)
            health_up = defn.health_url and _http_reachable(defn.health_url)
            if port_up or health_up:
                status = "up"
                detail = f":{defn.port}" if defn.port else "running"
            elif pid:
                status = "partial"
                detail = f"pid {pid} but port closed"
            else:
                status = "down"
                detail = f":{defn.port}" if defn.port else "offline"

    log_path = str(LOG_DIR / f"{(defn.log_name or defn.id)}.log") if defn.log_name else None
    return {
        "id": defn.id,
        "name": defn.name,
        "kind": defn.kind,
        "status": status,
        "detail": detail,
        "port": defn.port,
        "pid": pid,
        "log_path": log_path,
        "checked_at": datetime.now(timezone.utc).isoformat(),
    }


def stack_status() -> dict[str, Any]:
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    PID_DIR.mkdir(parents=True, exist_ok=True)
    services = [_probe_service(s) for s in SERVICES]
    up = sum(1 for s in services if s["status"] == "up")
    down = sum(1 for s in services if s["status"] in ("down", "missing", "failed"))
    partial = sum(1 for s in services if s["status"] == "partial")
    overall = "healthy"
    if down > 0:
        overall = "degraded"
    if up == 0:
        overall = "offline"
    elif partial > 0 and down == 0:
        overall = "partial"

    return {
        "platform": "OVERSEEYER",
        "overall": overall,
        "summary": {"up": up, "down": down, "partial": partial, "total": len(services)},
        "services": services,
        "paths": {
            "root": str(ROOT),
            "overseeyer": str(OVERSEYER_DIR),
            "logs": str(LOG_DIR),
            "pids": str(PID_DIR),
        },
    }


def _pids_listening_on_port(port: int) -> list[int]:
    """Return PIDs bound to TCP *port* on localhost (best-effort)."""
    try:
        out = subprocess.run(
            ["ss", "-ltnp"],
            capture_output=True,
            text=True,
            timeout=5,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return []
    pids: list[int] = []
    needle = f":{port}"
    for line in out.stdout.splitlines():
        if needle not in line:
            continue
        for match in re.finditer(r"pid=(\d+)", line):
            pids.append(int(match.group(1)))
    return sorted(set(pids))


def _terminate_pid(pid: int) -> None:
    try:
        os.killpg(os.getpgid(pid), signal.SIGTERM)
    except OSError:
        try:
            os.kill(pid, signal.SIGTERM)
        except OSError:
            pass


def _free_port(port: int, *, grace_seconds: float = 2.0) -> None:
    deadline = time.monotonic() + grace_seconds
    while time.monotonic() < deadline:
        pids = _pids_listening_on_port(port)
        if not pids:
            return
        for pid in pids:
            _terminate_pid(pid)
        time.sleep(0.25)
    for pid in _pids_listening_on_port(port):
        try:
            os.killpg(os.getpgid(pid), signal.SIGKILL)
        except OSError:
            try:
                os.kill(pid, signal.SIGKILL)
            except OSError:
                pass


def _run_background(cmd: list[str], workdir: Path, log_name: str) -> int:
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    PID_DIR.mkdir(parents=True, exist_ok=True)
    logfile = LOG_DIR / f"{log_name}.log"
    pidfile = PID_DIR / f"{log_name}.pid"
    with logfile.open("a", encoding="utf-8") as log_handle:
        proc = subprocess.Popen(
            cmd,
            cwd=str(workdir),
            stdout=log_handle,
            stderr=subprocess.STDOUT,
            start_new_session=True,
        )
    pidfile.write_text(str(proc.pid), encoding="utf-8")
    return proc.pid


def _spawn_overseeyer_ctl(service_id: str, action: Literal["stop", "start", "restart"]) -> dict[str, Any]:
    """Delegate stop/start/restart for OVERSEEYER API/UI to an external shell script."""
    if service_id not in SELF_MANAGED_SERVICES:
        raise ValueError(f"Not a self-managed service: {service_id}")
    script = OVERSEYER_DIR / "scripts" / "service_ctl.sh"
    if not script.is_file():
        raise ValueError(f"Missing control script: {script}")
    defn = next((s for s in SERVICES if s.id == service_id), None)
    if not defn:
        raise ValueError(f"Unknown service: {service_id}")

    LOG_DIR.mkdir(parents=True, exist_ok=True)
    log_ctl = LOG_DIR / "overseeyer-ctl.log"
    with log_ctl.open("a", encoding="utf-8") as log_handle:
        subprocess.Popen(
            ["bash", str(script), action, service_id],
            cwd=str(ROOT),
            stdout=log_handle,
            stderr=subprocess.STDOUT,
            stdin=subprocess.DEVNULL,
            start_new_session=True,
        )

    scheduled = service_id == "overseeyer-api" and action in ("stop", "restart")
    if scheduled and action == "stop":
        detail = (
            "OVERSEEYER API will stop in ~1s — run ./overseeyer/scripts/start.sh "
            "--api-only to bring it back"
        )
    elif scheduled and action == "restart":
        detail = "OVERSEEYER API restart scheduled — UI reconnects in ~5s"
    elif service_id == "overseeyer-web" and action == "restart":
        detail = "OVERSEEYER UI restart scheduled"
    else:
        detail = f"{service_id} {action} scheduled"

    return {
        "service_id": service_id,
        "action": action,
        "scheduled": scheduled or action in ("start", "restart", "stop"),
        "stopped": action == "stop" and not scheduled,
        "detail": detail,
        "result": _probe_service(defn),
    }


def _run_ensure_script(script_name: str, *, log_name: str | None = None, timeout: int = 120) -> subprocess.CompletedProcess[str]:
    script = ROOT / "scripts" / script_name
    if not script.is_file():
        raise FileNotFoundError(f"Missing script: {script}")
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    logfile = LOG_DIR / f"{log_name or script_name.replace('.sh', '')}.log"
    proc = subprocess.run(
        [str(script)],
        cwd=str(ROOT),
        capture_output=True,
        text=True,
        timeout=timeout,
        check=False,
    )
    with logfile.open("a", encoding="utf-8") as handle:
        handle.write(f"\n--- {datetime.now(timezone.utc).isoformat()} {script_name} exit={proc.returncode} ---\n")
        if proc.stdout:
            handle.write(proc.stdout)
        if proc.stderr:
            handle.write(proc.stderr)
    return proc


def start_service(service_id: str) -> dict[str, Any]:
    if service_id in SELF_MANAGED_SERVICES:
        return _spawn_overseeyer_ctl(service_id, "start")

    defn = next((s for s in SERVICES if s.id == service_id), None)
    if not defn:
        raise ValueError(f"Unknown service: {service_id}")

    if defn.kind == "docker" and defn.container:
        if service_id == "redis":
            proc = _run_ensure_script("ensure_redis.sh", log_name="redis")
            time.sleep(1)
            return {
                "service_id": service_id,
                "action": "start",
                "exit_code": proc.returncode,
                "stdout": proc.stdout[-2000:] if proc.stdout else "",
                "stderr": proc.stderr[-1000:] if proc.stderr else "",
                "result": _probe_service(defn),
            }
        if service_id == "martin-cache":
            # Recreate when nginx conf hash changes; requires Martin on :3001.
            proc = _run_ensure_script("ensure_martin_cache.sh", log_name="martin-cache")
            time.sleep(1)
            return {
                "service_id": service_id,
                "action": "start",
                "exit_code": proc.returncode,
                "stdout": proc.stdout[-2000:] if proc.stdout else "",
                "stderr": proc.stderr[-1000:] if proc.stderr else "",
                "result": _probe_service(defn),
            }
        subprocess.run(["docker", "start", defn.container], check=True, timeout=30)
        time.sleep(2)
        return {"service_id": service_id, "action": "start", "result": _probe_service(defn)}

    if defn.kind == "supabase":
        import supabase_ops

        proc_result = supabase_ops.start_local()
        time.sleep(3)
        return {
            "service_id": service_id,
            "action": "start",
            "exit_code": proc_result.get("exit_code"),
            "stdout": proc_result.get("stdout", ""),
            "stderr": proc_result.get("stderr", ""),
            "result": _probe_service(defn),
        }

    if defn.kind == "process":
        if defn.id in ("giop-portal", "overseeyer-web"):
            web_dir = defn.workdir
            if web_dir and not (web_dir / "node_modules").is_dir():
                subprocess.run(["npm", "install"], cwd=str(web_dir), check=False, timeout=600)
            port = str(defn.port or 5173)
            vite = web_dir / "node_modules" / ".bin" / "vite"
            cmd = [str(vite), "--host", "127.0.0.1", "--port", port]
            pid = _run_background(cmd, web_dir or ROOT, defn.pid_name or defn.id)
            time.sleep(2)
            return {"service_id": service_id, "action": "start", "pid": pid, "result": _probe_service(defn)}

        if defn.id == "backoffice-ui":
            cmd = ["python3", "-m", "http.server", "8080", "--bind", "0.0.0.0"]
            pid = _run_background(cmd, defn.workdir or ROOT, defn.pid_name or defn.id)
            time.sleep(1)
            return {"service_id": service_id, "action": "start", "pid": pid, "result": _probe_service(defn)}

        if defn.id == "supertonic":
            proc = _run_ensure_script("start-supertonic.sh", log_name="supertonic", timeout=300)
            time.sleep(2)
            return {
                "service_id": service_id,
                "action": "start",
                "exit_code": proc.returncode,
                "stdout": proc.stdout[-2000:] if proc.stdout else "",
                "stderr": proc.stderr[-1000:] if proc.stderr else "",
                "result": _probe_service(defn),
            }

        if defn.start_cmd and defn.workdir:
            cmd = list(defn.start_cmd)
            if cmd[0] == "python3":
                cmd[0] = _python_bin()
            pid = _run_background(cmd, defn.workdir, defn.pid_name or defn.id)
            time.sleep(2)
            return {"service_id": service_id, "action": "start", "pid": pid, "result": _probe_service(defn)}

    raise ValueError(f"Cannot start service {service_id}")


def stop_service(service_id: str) -> dict[str, Any]:
    if service_id in SELF_MANAGED_SERVICES:
        return _spawn_overseeyer_ctl(service_id, "stop")

    defn = next((s for s in SERVICES if s.id == service_id), None)
    if not defn:
        raise ValueError(f"Unknown service: {service_id}")

    if defn.kind == "docker" and defn.container:
        subprocess.run(["docker", "stop", defn.container], check=False, timeout=30)
        return {"service_id": service_id, "action": "stop", "result": _probe_service(defn)}

    if defn.kind == "process" and defn.pid_name:
        pid = _read_pid(defn.pid_name)
        if pid:
            _terminate_pid(pid)
        # Free the port regardless of pidfile state — covers orphans started by a
        # previous overseer instance or processes whose pidfile was already removed.
        if defn.port:
            _free_port(defn.port)
        # Only drop the pidfile once the process is actually gone, so a failed
        # stop doesn't leave an untracked orphan behind.
        still_running = bool(defn.port and _port_open("127.0.0.1", defn.port))
        pidfile = PID_DIR / f"{defn.pid_name}.pid"
        if not still_running and pidfile.is_file():
            pidfile.unlink()
        result = _probe_service(defn)
        if still_running:
            result["detail"] = (
                f"stop failed — port :{defn.port} still open "
                "(check permissions / run start.sh as the owning user)"
            )
        return {
            "service_id": service_id,
            "action": "stop",
            "stopped": not still_running,
            "result": result,
        }

    raise ValueError(f"Cannot stop service {service_id}")


def restart_service(service_id: str) -> dict[str, Any]:
    if service_id in SELF_MANAGED_SERVICES:
        return _spawn_overseeyer_ctl(service_id, "restart")
    if service_id == "martin":
        script = ROOT / "scripts" / "ensure_martin.sh"
        if script.is_file():
            proc = subprocess.run(
                [str(script)],
                cwd=str(ROOT),
                capture_output=True,
                text=True,
                timeout=120,
                check=False,
            )
            return {
                "service_id": service_id,
                "action": "restart",
                "exit_code": proc.returncode,
                "stdout": proc.stdout[-2000:] if proc.stdout else "",
                "stderr": proc.stderr[-1000:] if proc.stderr else "",
                "result": _probe_service(next(s for s in SERVICES if s.id == "martin")),
            }
    if service_id == "martin-cache":
        proc = _run_ensure_script("ensure_martin_cache.sh", log_name="martin-cache")
        return {
            "service_id": service_id,
            "action": "restart",
            "exit_code": proc.returncode,
            "stdout": proc.stdout[-2000:] if proc.stdout else "",
            "stderr": proc.stderr[-1000:] if proc.stderr else "",
            "result": _probe_service(next(s for s in SERVICES if s.id == "martin-cache")),
        }
    if service_id == "redis":
        proc = _run_ensure_script("ensure_redis.sh", log_name="redis")
        return {
            "service_id": service_id,
            "action": "restart",
            "exit_code": proc.returncode,
            "stdout": proc.stdout[-2000:] if proc.stdout else "",
            "stderr": proc.stderr[-1000:] if proc.stderr else "",
            "result": _probe_service(next(s for s in SERVICES if s.id == "redis")),
        }
    if service_id == "supertonic":
        try:
            stop_service(service_id)
        except ValueError:
            pass
        time.sleep(1)
        proc = _run_ensure_script("start-supertonic.sh", log_name="supertonic", timeout=300)
        return {
            "service_id": service_id,
            "action": "restart",
            "exit_code": proc.returncode,
            "stdout": proc.stdout[-2000:] if proc.stdout else "",
            "stderr": proc.stderr[-1000:] if proc.stderr else "",
            "result": _probe_service(next(s for s in SERVICES if s.id == "supertonic")),
        }
    try:
        stop_service(service_id)
    except ValueError:
        pass
    defn = next((s for s in SERVICES if s.id == service_id), None)
    if defn and defn.port:
        _free_port(defn.port, grace_seconds=3.0)
    time.sleep(1)
    return start_service(service_id)


def start_stack(portal: bool = False, backoffice: bool = False, bootstrap: bool = False) -> dict[str, Any]:
    script = ROOT / "scripts" / "start_giop_stack.sh"
    cmd = [str(script)]
    if portal:
        cmd.append("--portal")
    if backoffice:
        cmd.append("--backoffice")
    if bootstrap:
        cmd.append("--bootstrap")
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    log_path = LOG_DIR / "stack-start.log"
    header = f"--- stack start {datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')} {' '.join(cmd)} ---"
    proc = subprocess.run(cmd, cwd=str(ROOT), capture_output=True, text=True, timeout=600, check=False)
    with log_path.open("a", encoding="utf-8") as logf:
        logf.write(f"\n{header}\n")
        if proc.stdout:
            logf.write(proc.stdout)
        if proc.stderr:
            logf.write(proc.stderr)
        logf.write(f"--- exit {proc.returncode} ---\n")
    return {
        "action": "stack_start",
        "exit_code": proc.returncode,
        "stdout": proc.stdout[-8000:] if proc.stdout else "",
        "stderr": proc.stderr[-4000:] if proc.stderr else "",
        "log_name": "stack-start.log",
        "status": stack_status(),
    }


BOOTSTRAP_LOG_NAME = "memgraph-bootstrap.log"
BOOTSTRAP_PID_NAME = "memgraph-bootstrap"
_bootstrap_lock = threading.Lock()
_bootstrap_running = False


def _bootstrap_pidfile() -> Path:
    return PID_DIR / f"{BOOTSTRAP_PID_NAME}.pid"


def _bootstrap_pid_alive() -> bool:
    pidfile = _bootstrap_pidfile()
    if not pidfile.is_file():
        return False
    try:
        pid = int(pidfile.read_text().strip())
        os.kill(pid, 0)
        return True
    except (OSError, ValueError):
        pidfile.unlink(missing_ok=True)
        return False


def bootstrap_memgraph_status() -> dict[str, Any]:
    running = _bootstrap_running or _bootstrap_pid_alive()
    return {
        "running": running,
        "log_name": BOOTSTRAP_LOG_NAME,
        "python": _python_bin(),
        "script": "memgraph/bootstrap.py",
    }


def _check_bootstrap_preflight() -> None:
    if not _docker_running("my-memgraph") and not _port_open("127.0.0.1", 7687):
        raise ValueError("Memgraph is not running — start the memgraph service first")
    if not _port_open("127.0.0.1", 54322):
        raise ValueError("Postgres is not reachable on :54322 — start Supabase first")


def iter_bootstrap_memgraph() -> Iterator[dict[str, Any]]:
    """Run memgraph/bootstrap.py detached; tail log output for SSE."""
    global _bootstrap_running

    with _bootstrap_lock:
        if _bootstrap_running or _bootstrap_pid_alive():
            raise ValueError("Memgraph bootstrap already running")
        _bootstrap_running = True

    proc: subprocess.Popen[Any] | None = None
    logf = None
    try:
        _check_bootstrap_preflight()
        LOG_DIR.mkdir(parents=True, exist_ok=True)
        PID_DIR.mkdir(parents=True, exist_ok=True)
        log_path = LOG_DIR / BOOTSTRAP_LOG_NAME
        cmd = [_python_bin(), "memgraph/bootstrap.py"]
        header = f"--- bootstrap {datetime.now(timezone.utc).isoformat()} ---"
        yield {"type": "line", "text": header}

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
            start_new_session=True,
        )
        _bootstrap_pidfile().write_text(str(proc.pid), encoding="utf-8")

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
                            yield {"type": "line", "text": line.rstrip("\r")}
            if exit_code is not None:
                if pending.strip():
                    yield {"type": "line", "text": pending.rstrip("\r")}
                break
            time.sleep(0.5)

        yield {"type": "done", "exit_code": exit_code}
    finally:
        if proc is not None and proc.poll() is None:
            proc.wait(timeout=5)
        if logf is not None:
            logf.close()
        _bootstrap_pidfile().unlink(missing_ok=True)
        with _bootstrap_lock:
            _bootstrap_running = False


def _migration_version(path: Path) -> str:
    return path.stem.split("_", 1)[0]


def list_migrations() -> dict[str, Any]:
    local_files = sorted(MIGRATIONS_DIR.glob("*.sql"))
    local = [
        {
            "version": _migration_version(p),
            "filename": p.name,
            "path": str(p.relative_to(ROOT)),
            "size_bytes": p.stat().st_size,
            "modified_at": datetime.fromtimestamp(p.stat().st_mtime, tz=timezone.utc).isoformat(),
        }
        for p in local_files
    ]

    applied: list[dict[str, str]] = []
    pending: list[str] = []
    db_error = None

    if _port_open("127.0.0.1", 54322):
        try:
            import psycopg2

            uri = os.getenv(
                "SUPABASE_DB_URI",
                "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
            )
            conn = psycopg2.connect(uri)
            try:
                with conn.cursor() as cur:
                    cur.execute(
                        """
                        SELECT version::text, name
                        FROM supabase_migrations.schema_migrations
                        ORDER BY version
                        """
                    )
                    for row in cur.fetchall():
                        applied.append({"version": row[0], "name": row[1]})
            finally:
                conn.close()
            applied_versions = {a["version"] for a in applied}
            for item in local:
                if item["version"] not in applied_versions:
                    pending.append(item["filename"])
        except Exception as exc:
            db_error = str(exc)

    return {
        "local_count": len(local),
        "applied_count": len(applied),
        "pending_count": len(pending),
        "local": local,
        "applied": applied,
        "pending": pending,
        "db_reachable": _port_open("127.0.0.1", 54322),
        "db_error": db_error,
    }


def create_migration(name: str, sql_body: str | None = None) -> dict[str, Any]:
    slug = re.sub(r"[^a-z0-9_]+", "_", name.lower()).strip("_")
    if not slug:
        raise ValueError("Migration name required")

    existing = sorted(MIGRATIONS_DIR.glob("*.sql"))
    next_num = 1
    if existing:
        last_ver = _migration_version(existing[-1])
        if last_ver.isdigit():
            next_num = int(last_ver) + 1

    filename = f"{next_num:05d}_{slug}.sql"
    path = MIGRATIONS_DIR / filename
    if path.exists():
        raise ValueError(f"Migration already exists: {filename}")

    body = sql_body or (
        f"-- Migration: {slug}\n-- Created by OVERSEEYER at {datetime.now(timezone.utc).isoformat()}\n\n"
    )
    path.write_text(body if body.endswith("\n") else body + "\n", encoding="utf-8")
    return {"filename": filename, "path": str(path.relative_to(ROOT)), "version": f"{next_num:05d}"}


def _run_apply_migrations_sync(mode: Literal["up", "reset"] = "up") -> dict[str, Any]:
    import supabase_ops

    martin_paused = False
    if mode == "up" and _port_open("127.0.0.1", 3001):
        try:
            stop_service("martin")
            martin_paused = True
        except Exception:
            martin_paused = False

    try:
        proc = supabase_ops.run_db_command(mode)
    except FileNotFoundError as exc:
        return {
            "mode": mode,
            "exit_code": 127,
            "stdout": "",
            "stderr": str(exc),
            "martin_paused": martin_paused,
            "martin_restarted": False,
            "migrations": list_migrations(),
        }

    martin_restarted = False
    if martin_paused and proc.returncode == 0:
        try:
            script = ROOT / "scripts" / "ensure_martin.sh"
            if script.is_file():
                subprocess.run([str(script)], cwd=str(ROOT), capture_output=True, text=True, timeout=120, check=False)
                martin_restarted = True
            else:
                start_service("martin")
                martin_restarted = True
        except Exception:
            martin_restarted = False

    return {
        "mode": mode,
        "exit_code": proc.returncode,
        "stdout": proc.stdout[-8000:] if proc.stdout else "",
        "stderr": proc.stderr[-4000:] if proc.stderr else "",
        "martin_paused": martin_paused,
        "martin_restarted": martin_restarted,
        "migrations": list_migrations(),
    }


def apply_migrations(mode: Literal["up", "reset"] = "up") -> dict[str, Any]:
    """Synchronous apply — prefer start_apply_migrations() from the API."""
    return _run_apply_migrations_sync(mode)


_migration_lock = threading.Lock()
_migration_job: dict[str, Any] | None = None


def migration_apply_status() -> dict[str, Any]:
    with _migration_lock:
        if _migration_job is None:
            return {"running": False}
        return dict(_migration_job)


def _set_migration_job(**fields: Any) -> dict[str, Any]:
    global _migration_job
    with _migration_lock:
        if _migration_job is None:
            _migration_job = {}
        _migration_job.update(fields)
        return dict(_migration_job)


def _migration_worker(mode: Literal["up", "reset"]) -> None:
    try:
        _set_migration_job(phase="running_supabase")
        result = _run_apply_migrations_sync(mode)
        exit_code = result.get("exit_code")
        error = None
        if exit_code not in (0, None):
            error = (result.get("stderr") or result.get("stdout") or "migration command failed").strip()
        _set_migration_job(
            running=False,
            finished_at=datetime.now(timezone.utc).isoformat(),
            phase="done",
            exit_code=exit_code,
            error=error[-4000:] if error else None,
            result=result,
        )
    except Exception as exc:
        _set_migration_job(
            running=False,
            finished_at=datetime.now(timezone.utc).isoformat(),
            phase="error",
            exit_code=-1,
            error=str(exc),
            result=None,
        )


def start_apply_migrations(mode: Literal["up", "reset"] = "up") -> dict[str, Any]:
    """Start migration apply in a background thread; returns immediately."""
    global _migration_job
    with _migration_lock:
        if _migration_job and _migration_job.get("running"):
            raise ValueError("Migration apply already running")
        _migration_job = {
            "running": True,
            "mode": mode,
            "phase": "starting",
            "started_at": datetime.now(timezone.utc).isoformat(),
            "finished_at": None,
            "exit_code": None,
            "error": None,
            "result": None,
        }
        job = dict(_migration_job)

    threading.Thread(target=_migration_worker, args=(mode,), daemon=True).start()
    return job
