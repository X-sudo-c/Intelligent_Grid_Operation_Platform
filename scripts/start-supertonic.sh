#!/usr/bin/env bash
# Start Supertonic 3 local TTS server (OpenAI-compatible /v1/audio/speech).
#
# Usage:
#   ./scripts/start-supertonic.sh
#   SUPERTONIC_PORT=7788 ./scripts/start-supertonic.sh
#
# First run installs supertonic[serve] and may download ~400MB model to ~/.cache/supertonic3/

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RUN_DIR="${GIOP_RUN_DIR:-$ROOT/.giop}"
LOG_DIR="$RUN_DIR/logs"
PID_DIR="$RUN_DIR/pids"

HOST="${SUPERTONIC_HOST:-127.0.0.1}"
PORT="${SUPERTONIC_PORT:-7788}"

mkdir -p "$LOG_DIR" "$PID_DIR"

if [[ -f "$ROOT/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$ROOT/.env"
  set +a
fi

if [[ -x "$ROOT/.venv/bin/python" ]]; then
  PYTHON="${GIOP_PYTHON:-$ROOT/.venv/bin/python}"
else
  PYTHON="${GIOP_PYTHON:-python3}"
fi

VENV_BIN="$(dirname "$PYTHON")"
SUPERTONIC_BIN="${VENV_BIN}/supertonic"
if [[ ! -x "$SUPERTONIC_BIN" && -x "$ROOT/.venv/bin/supertonic" ]]; then
  SUPERTONIC_BIN="$ROOT/.venv/bin/supertonic"
fi

PID_FILE="$PID_DIR/supertonic.pid"
LOG_FILE="$LOG_DIR/supertonic.log"

log() {
  echo "$@"
  echo "$@" >>"$LOG_FILE"
}

wait_for_docs() {
  local max_attempts="${1:-90}"
  local attempt
  for ((attempt = 1; attempt <= max_attempts; attempt++)); do
    if curl -sf "http://${HOST}:${PORT}/docs" >/dev/null 2>&1; then
      log "Supertonic HTTP ready after ${attempt} check(s)"
      return 0
    fi
    if [[ -f "$PID_FILE" ]] && ! kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
      log "Supertonic process exited during startup — see log above"
      return 1
    fi
    if (( attempt % 5 == 0 )); then
      log "Still waiting for Supertonic /docs (${attempt}/${max_attempts})…"
    fi
    sleep 2
  done
  log "Supertonic did not become ready on http://${HOST}:${PORT}/docs — check $LOG_FILE"
  return 1
}

if [[ -f "$PID_FILE" ]]; then
  old_pid="$(cat "$PID_FILE" 2>/dev/null || true)"
  if [[ -n "${old_pid}" ]] && kill -0 "${old_pid}" 2>/dev/null; then
    if curl -sf "http://${HOST}:${PORT}/docs" >/dev/null 2>&1; then
      log "Supertonic already running (pid ${old_pid}) on http://${HOST}:${PORT}"
      exit 0
    fi
    log "Stale Supertonic pid ${old_pid} — port not responding, restarting"
    kill "${old_pid}" 2>/dev/null || true
    sleep 1
  fi
  rm -f "$PID_FILE"
fi

if ! "$PYTHON" -c "import supertonic" 2>/dev/null; then
  log "Installing supertonic[serve] into venv (first run only)…"
  "$PYTHON" -m pip install 'supertonic[serve]' 2>&1 | tee -a "$LOG_FILE"
fi

if [[ ! -x "$SUPERTONIC_BIN" ]]; then
  log "Error: supertonic binary not found at $SUPERTONIC_BIN" >&2
  exit 1
fi

log "Starting Supertonic on http://${HOST}:${PORT} (log: $LOG_FILE)"
nohup "$SUPERTONIC_BIN" serve --host "$HOST" --port "$PORT" >>"$LOG_FILE" 2>&1 &
echo $! >"$PID_FILE"
sleep 1

if ! kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
  log "Supertonic failed to start — see $LOG_FILE"
  exit 1
fi

log "Supertonic process started (pid $(cat "$PID_FILE")) — waiting for HTTP…"
wait_for_docs 90
exit $?
