# Shared OVERSEEYER process helpers (sourced by start.sh and service_ctl.sh).
GIOP_OVERSEEER_LIB=1

_overseeyer_root() {
  if [[ -n "${GIOP_ROOT:-}" ]]; then
    return 0
  fi
  GIOP_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
}

_overseeyer_init() {
  _overseeyer_root
  RUN_DIR="${GIOP_RUN_DIR:-$GIOP_ROOT/.giop}"
  LOG_DIR="$RUN_DIR/logs"
  PID_DIR="$RUN_DIR/pids"
  API_PORT="${OVERSEYER_API_PORT:-5190}"
  WEB_PORT="${OVERSEYER_WEB_PORT:-5191}"
  mkdir -p "$LOG_DIR" "$PID_DIR"
  if [[ -f "$GIOP_ROOT/.env" ]]; then
    set -a
    # shellcheck disable=SC1091
    source "$GIOP_ROOT/.env"
    set +a
  fi
  if [[ -x "$GIOP_ROOT/.venv/bin/python" ]]; then
    PYTHON="${GIOP_PYTHON:-$GIOP_ROOT/.venv/bin/python}"
  else
    PYTHON="${GIOP_PYTHON:-python3}"
  fi
}

port_open() {
  (echo >/dev/tcp/127.0.0.1/"$1") >/dev/null 2>&1
}

api_ready() {
  local code
  code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 3 "http://127.0.0.1:${API_PORT}/api/health" 2>/dev/null || echo 000)"
  [[ "$code" == "200" ]]
}

observability_ready() {
  local code
  code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 30 "http://127.0.0.1:${API_PORT}/api/observability" 2>/dev/null || echo 000)"
  [[ "$code" == "200" ]]
}

# Kill every process group listening on TCP *port* (handles uvicorn --reload workers).
kill_port_listeners() {
  local port="$1"
  local grace="${2:-2}"
  local deadline=$((SECONDS + grace))
  while (( SECONDS < deadline )); do
    local pids
    pids="$(ss -ltnp 2>/dev/null | grep ":${port}" | grep -oE 'pid=[0-9]+' | sed 's/pid=//' | sort -u)"
    if [[ -z "$pids" ]]; then
      return 0
    fi
    while IFS= read -r pid; do
      [[ -z "$pid" ]] && continue
      local pgid
      pgid="$(ps -o pgid= -p "$pid" 2>/dev/null | tr -d ' ')"
      if [[ -n "$pgid" ]]; then
        kill -TERM "-${pgid}" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
      else
        kill -TERM "$pid" 2>/dev/null || true
      fi
    done <<< "$pids"
    sleep 0.25
  done
  pids="$(ss -ltnp 2>/dev/null | grep ":${port}" | grep -oE 'pid=[0-9]+' | sed 's/pid=//' | sort -u)"
  while IFS= read -r pid; do
    [[ -z "$pid" ]] && continue
    local pgid
    pgid="$(ps -o pgid= -p "$pid" 2>/dev/null | tr -d ' ')"
    if [[ -n "$pgid" ]]; then
      kill -KILL "-${pgid}" 2>/dev/null || kill -KILL "$pid" 2>/dev/null || true
    else
      kill -KILL "$pid" 2>/dev/null || true
    fi
  done <<< "$pids"
}

stop_api() {
  rm -f "$PID_DIR/overseeyer-api.pid"
  kill_port_listeners "$API_PORT" 3
}

stop_web() {
  rm -f "$PID_DIR/overseeyer-web.pid"
  kill_port_listeners "$WEB_PORT" 2
  pkill -f "node.*vite.*--port ${WEB_PORT}" 2>/dev/null || true
}

start_api() {
  if port_open "$API_PORT" && api_ready; then
    echo "OVERSEEYER API already on :$API_PORT"
    return 0
  fi
  if port_open "$API_PORT"; then
    echo "Restarting stale OVERSEEYER API on :$API_PORT"
    stop_api
  fi
  echo "Starting OVERSEEYER API on :$API_PORT"
  (
    cd "$GIOP_ROOT/overseeyer/server"
    nohup "$PYTHON" -m uvicorn main:app --host 0.0.0.0 --port "$API_PORT" --reload \
      >>"$LOG_DIR/overseeyer-api.log" 2>&1 &
    echo $! >"$PID_DIR/overseeyer-api.pid"
  )
  sleep 2
  local i
  for i in 1 2 3 4 5; do
    if api_ready; then
      echo "  OK   OVERSEEYER API ready (/api/health)"
      return 0
    fi
    sleep 1
  done
  echo "WARN: API started but /api/health not ready (see $LOG_DIR/overseeyer-api.log)" >&2
}

start_web() {
  if port_open "$WEB_PORT"; then
    echo "OVERSEEYER UI already on :$WEB_PORT"
    return 0
  fi
  local web_dir="$GIOP_ROOT/overseeyer/web"
  if [[ ! -d "$web_dir/node_modules" ]]; then
    echo "Running npm install in overseeyer/web"
    (cd "$web_dir" && npm install) >>"$LOG_DIR/overseeyer-web-install.log" 2>&1
  fi
  echo "Starting OVERSEEYER UI on :$WEB_PORT"
  (
    cd "$web_dir"
    setsid ./node_modules/.bin/vite --host 127.0.0.1 --port "$WEB_PORT" \
      >>"$LOG_DIR/overseeyer-web.log" 2>&1 </dev/null &
  )
  sleep 2
  local vite_pid
  vite_pid="$(pgrep -f "node.*vite.*--port ${WEB_PORT}" 2>/dev/null | head -1 || true)"
  if [[ -n "$vite_pid" ]]; then
    echo "$vite_pid" >"$PID_DIR/overseeyer-web.pid"
  fi
}

follow_stack_logs() {
  # shellcheck disable=SC1091
  source "$GIOP_ROOT/scripts/lib_giop_logs.sh"
  giop_tail_stack_logs
}
