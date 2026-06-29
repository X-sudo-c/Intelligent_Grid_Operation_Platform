"""Supertonic TTS — install probe, readiness, and streamed start for OVERSEEYER."""

from __future__ import annotations

import os
import subprocess
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator
from urllib.error import URLError
from urllib.request import Request, urlopen

from dotenv import load_dotenv

import overseer

ROOT = overseer.ROOT
LOG_NAME = "supertonic.log"
PID_NAME = "supertonic"
START_SCRIPT = ROOT / "scripts" / "start-supertonic.sh"

load_dotenv(ROOT / ".env", override=False)

SUPERTONIC_PORT = int(os.getenv("SUPERTONIC_PORT", "7788"))
SUPERTONIC_URL = (os.getenv("SUPERTONIC_URL") or f"http://127.0.0.1:{SUPERTONIC_PORT}").rstrip("/")

_start_lock = threading.Lock()
_start_running = False


def _venv_python() -> str:
    return overseer.GIOP_PYTHON


def _supertonic_bin() -> Path | None:
    venv_bin = Path(_venv_python()).resolve().parent / "supertonic"
    if venv_bin.is_file():
        return venv_bin
    fallback = ROOT / ".venv" / "bin" / "supertonic"
    return fallback if fallback.is_file() else None


def package_installed() -> bool:
    try:
        subprocess.run(
            [_venv_python(), "-c", "import supertonic"],
            capture_output=True,
            timeout=15,
            check=True,
        )
        return True
    except (subprocess.CalledProcessError, OSError, subprocess.TimeoutExpired):
        return False


def _pidfile() -> Path:
    return overseer.PID_DIR / f"{PID_NAME}.pid"


def _read_pid() -> int | None:
    return overseer._read_pid(PID_NAME)


def _pid_alive() -> bool:
    return _read_pid() is not None


def _docs_ok(timeout: float = 3.0) -> bool:
    try:
        req = Request(f"{SUPERTONIC_URL}/docs", method="GET")
        with urlopen(req, timeout=timeout) as resp:
            return resp.status == 200
    except (URLError, OSError, ValueError, TimeoutError):
        return False


def _log_path() -> Path:
    return overseer.LOG_DIR / LOG_NAME


def _log_tail_lines(max_lines: int = 30) -> list[str]:
    path = _log_path()
    if not path.is_file():
        return []
    try:
        lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
        return [ln for ln in lines[-max_lines:] if ln.strip() and "\x00" not in ln]
    except OSError:
        return []


def _infer_phase(*, port_open: bool, docs_ok: bool, pid_alive: bool, tail: str) -> str:
    lower = tail.lower()
    if docs_ok and port_open:
        if "fetching" in lower and "100%" not in lower.split("fetching")[-1][:120]:
            return "warming"
        return "ready"
    if pid_alive and not port_open:
        return "starting"
    if port_open and not docs_ok:
        return "starting"
    if "failed" in lower or "error" in lower[-500:]:
        return "failed"
    if pid_alive:
        return "starting"
    return "down"


def supertonic_status() -> dict[str, Any]:
    installed = package_installed()
    pid = _read_pid()
    port_open = overseer._port_open("127.0.0.1", SUPERTONIC_PORT)
    docs_ok = _docs_ok() if port_open else False
    tail_lines = _log_tail_lines()
    tail_text = "\n".join(tail_lines)
    phase = _infer_phase(
        port_open=port_open,
        docs_ok=docs_ok,
        pid_alive=pid is not None,
        tail=tail_text,
    )

    hint: str | None = None
    if not installed:
        hint = "First start installs supertonic[serve] (~50MB) and may download ~400MB models"
    elif phase == "down":
        hint = "Start Supertonic — first run can take several minutes while models download"
    elif phase == "starting":
        hint = "Supertonic process is up; waiting for HTTP on :7788"
    elif phase == "warming":
        hint = "HTTP is up; model files are still loading from HuggingFace cache"
    elif phase == "failed":
        hint = f"Check {_log_path()} for errors"

    return {
        "installed": installed,
        "running": pid is not None or port_open,
        "pid": pid,
        "port": SUPERTONIC_PORT,
        "url": SUPERTONIC_URL,
        "port_open": port_open,
        "docs_ok": docs_ok,
        "phase": phase,
        "log_name": LOG_NAME,
        "hint": hint,
        "log_tail": tail_lines[-8:],
        "start_job_running": _start_running,
    }


def iter_start_supertonic() -> Iterator[dict[str, Any]]:
    """Run start-supertonic.sh and stream combined script + server log output."""
    global _start_running

    status = supertonic_status()
    if status["phase"] == "ready" and not _start_running:
        yield {"type": "line", "text": "Supertonic already ready"}
        yield {"type": "done", "exit_code": 0, "phase": "ready"}
        return

    with _start_lock:
        if _start_running:
            raise ValueError("Supertonic start already in progress")
        _start_running = True

    proc: subprocess.Popen[Any] | None = None
    try:
        if not START_SCRIPT.is_file():
            raise FileNotFoundError(f"Missing script: {START_SCRIPT}")

        overseer.LOG_DIR.mkdir(parents=True, exist_ok=True)
        overseer.PID_DIR.mkdir(parents=True, exist_ok=True)
        log_path = _log_path()
        header = f"--- supertonic start {datetime.now(timezone.utc).isoformat()} ---"
        yield {"type": "line", "text": header}

        with log_path.open("a", encoding="utf-8") as logf:
            logf.write(f"\n{header}\n")
            logf.flush()
            tail_offset = logf.tell()

        env = os.environ.copy()
        env.setdefault("SUPERTONIC_PORT", str(SUPERTONIC_PORT))
        env.setdefault("SUPERTONIC_HOST", "127.0.0.1")

        proc = subprocess.Popen(
            ["bash", str(START_SCRIPT)],
            cwd=str(ROOT),
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            env=env,
            bufsize=1,
            start_new_session=True,
        )

        pending = ""
        exit_code: int | None = None
        while True:
            exit_code = proc.poll()
            if proc.stdout is not None:
                chunk = proc.stdout.read()
                if chunk:
                    pending += chunk
                    with log_path.open("a", encoding="utf-8") as logf:
                        logf.write(chunk)
                        logf.flush()
                    while "\n" in pending:
                        line, pending = pending.split("\n", 1)
                        if line.strip():
                            yield {"type": "line", "text": line.rstrip("\r")}

            if exit_code is not None:
                if pending.strip():
                    yield {"type": "line", "text": pending.rstrip("\r")}
                exit_code = proc.returncode
                break
            time.sleep(0.4)

        if exit_code not in (None, 0):
            final = supertonic_status()
            yield {
                "type": "done",
                "exit_code": exit_code,
                "phase": final["phase"],
                "docs_ok": final["docs_ok"],
            }
            return

        # Serve continues in background — tail log until ready or timeout.
        deadline = time.time() + 180
        last_phase: str | None = None
        while time.time() < deadline:
            with log_path.open(encoding="utf-8") as reader:
                reader.seek(tail_offset)
                chunk = reader.read()
                if chunk:
                    tail_offset = reader.tell()
                    pending += chunk
                    while "\n" in pending:
                        line, pending = pending.split("\n", 1)
                        if line.strip():
                            yield {"type": "line", "text": line.rstrip("\r")}

            st = supertonic_status()
            phase = st.get("phase")
            if phase != last_phase:
                last_phase = phase
                yield {"type": "line", "text": f"[status] phase={phase}"}
            if phase == "ready" and st.get("docs_ok"):
                exit_code = 0
                break
            if phase == "failed" or (st.get("pid") is None and not st.get("port_open")):
                exit_code = exit_code if exit_code not in (None, 0) else 1
                break
            time.sleep(1.0)
        else:
            exit_code = exit_code if exit_code not in (None, 0) else 1
            yield {"type": "line", "text": "Timed out waiting for Supertonic readiness"}

        final = supertonic_status()
        yield {
            "type": "done",
            "exit_code": exit_code,
            "phase": final["phase"],
            "docs_ok": final["docs_ok"],
        }
    finally:
        if proc is not None and proc.poll() is None:
            proc.wait(timeout=10)
        with _start_lock:
            _start_running = False
