#!/usr/bin/env bash
# Start Supertonic 3 local TTS server (OpenAI-compatible /v1/audio/speech).
#
# Usage:
#   ./scripts/start-supertonic.sh
#   SUPERTONIC_PORT=7788 ./scripts/start-supertonic.sh
#
# First run downloads ~400MB model to ~/.cache/supertonic3/

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

if ! "$PYTHON" -c "import supertonic" 2>/dev/null; then
  echo "Installing supertonic[serve] into venv…"
  "$PYTHON" -m pip install 'supertonic[serve]'
fi

PID_FILE="$PID_DIR/supertonic.pid"
if [[ -f "$PID_FILE" ]] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
  echo "Supertonic already running (pid $(cat "$PID_FILE")) on http://${HOST}:${PORT}"
  exit 0
fi

LOG_FILE="$LOG_DIR/supertonic.log"
echo "Starting Supertonic on http://${HOST}:${PORT} (log: $LOG_FILE)"
nohup "${ROOT}/.venv/bin/supertonic" serve --host "$HOST" --port "$PORT" >>"$LOG_FILE" 2>&1 &
echo $! >"$PID_FILE"
sleep 2
if kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
  echo "Supertonic started (pid $(cat "$PID_FILE"))"
else
  echo "Supertonic failed to start — see $LOG_FILE" >&2
  exit 1
fi
