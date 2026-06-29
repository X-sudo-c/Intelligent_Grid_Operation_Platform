#!/usr/bin/env bash
# Check GIOP local stack health and start anything that is offline.
#
# Usage:
#   ./scripts/start_giop_stack.sh              # check + start missing services
#   ./scripts/start_giop_stack.sh --check-only # report status only
#   ./scripts/start_giop_stack.sh --backoffice # also start backoffice-ui :8080
#   ./scripts/start_giop_stack.sh --portal     # also start GIOP React portal :5173
#   ./scripts/start_giop_stack.sh --bootstrap  # run memgraph/bootstrap.py after Memgraph is up
#
# Environment (optional):
#   START_BACKOFFICE=1   same as --backoffice
#   START_PORTAL=1       same as --portal
#   RUN_BOOTSTRAP=1    same as --bootstrap
#   GIOP_PYTHON=path     python/uvicorn binary (default: .venv/bin/python or python3)

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RUN_DIR="${GIOP_RUN_DIR:-$ROOT/.giop}"
LOG_DIR="$RUN_DIR/logs"
PID_DIR="$RUN_DIR/pids"

SUPABASE_HOST="${SUPABASE_HOST:-127.0.0.1}"
SUPABASE_PG_PORT="${SUPABASE_PG_PORT:-54322}"
SUPABASE_API_PORT="${SUPABASE_API_PORT:-54321}"
SYNC_PORT="${SYNC_PORT:-5000}"
OCR_PORT="${OCR_PORT:-5002}"
BACKOFFICE_PORT="${BACKOFFICE_PORT:-8080}"
PORTAL_PORT="${PORTAL_PORT:-5173}"
MARTIN_PORT="${MARTIN_PORT:-3001}"
MEMGRAPH_PORT="${MEMGRAPH_PORT:-7687}"
TIMESCALE_PORT="${TIMESCALE_PORT:-5433}"

DOCKER_CONTAINERS=(
  my-memgraph
  giop-martin
  giop-timescale
  giop-redis
)

CHECK_ONLY=0
WITH_BACKOFFICE="${START_BACKOFFICE:-0}"
WITH_PORTAL="${START_PORTAL:-0}"
WITH_BOOTSTRAP="${RUN_BOOTSTRAP:-0}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --check-only|-c) CHECK_ONLY=1 ;;
    --backoffice) WITH_BACKOFFICE=1 ;;
    --portal) WITH_PORTAL=1 ;;
    --bootstrap) WITH_BOOTSTRAP=1 ;;
    -h|--help)
      sed -n '2,12p' "$0"
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      exit 2
      ;;
  esac
  shift
done

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

declare -a REPORT_NAMES=()
declare -a REPORT_STATUS=()
declare -a REPORT_DETAIL=()

FAILED=0

log() { printf '%s\n' "$*"; }
ok() { log "  OK   $*"; }
warn() { log "  WARN $*"; }
start() { log "  START $*"; }
fail() { log "  FAIL $*"; FAILED=1; }

record() {
  REPORT_NAMES+=("$1")
  REPORT_STATUS+=("$2")
  REPORT_DETAIL+=("$3")
}

port_open() {
  local host="$1" port="$2"
  if command -v nc >/dev/null 2>&1; then
    nc -z "$host" "$port" >/dev/null 2>&1
    return $?
  fi
  (echo >/dev/tcp/"$host"/"$port") >/dev/null 2>&1
}

http_ok() {
  local url="$1"
  curl -fsS --max-time 3 "$url" >/dev/null 2>&1
}

# PostgREST returns 401 without a key — any HTTP response means the API is up.
http_reachable() {
  local url="$1"
  local code
  code="$(curl -sS --max-time 3 -o /dev/null -w '%{http_code}' "$url" 2>/dev/null || echo 000)"
  [[ "$code" =~ ^[2345][0-9]{2}$ ]]
}

docker_exists() {
  docker ps -a --format '{{.Names}}' 2>/dev/null | grep -Fxq "$1"
}

docker_running() {
  [[ "$(docker inspect -f '{{.State.Running}}' "$1" 2>/dev/null || echo false)" == "true" ]]
}

pid_alive() {
  local pidfile="$1"
  [[ -f "$pidfile" ]] || return 1
  local pid
  pid="$(cat "$pidfile")"
  [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null
}

  start_bg_process() {
  local name="$1"
  local workdir="$2"
  local port="$3"
  shift 3
  local pidfile="$PID_DIR/${name}.pid"
  local logfile="$LOG_DIR/${name}.log"
  local health_url=""
  case "$name" in
    sync-service) health_url="http://127.0.0.1:${port}/api/v1/health/metrics" ;;
    ocr-service) health_url="http://127.0.0.1:${port}/docs" ;;
  esac

  if port_open 127.0.0.1 "$port"; then
    if [[ -n "$health_url" ]] && http_ok "$health_url"; then
      ok "$name already healthy on :$port"
      record "$name" "up" ":$port"
      return 0
    fi
    if [[ -z "$health_url" ]]; then
      ok "$name already listening on :$port"
      record "$name" "up" ":$port"
      return 0
    fi
    warn "$name on :$port is not responding — restarting"
    if [[ -f "$pidfile" ]]; then
      local pid
      pid="$(cat "$pidfile")"
      kill "$pid" 2>/dev/null || true
      sleep 1
      kill -9 "$pid" 2>/dev/null || true
      rm -f "$pidfile"
    fi
    local port_pid
    port_pid="$(ss -ltnp 2>/dev/null | awk -v p=":${port}" '$4 ~ p { gsub(/.*pid=/, "", $6); gsub(/,.*/, "", $6); print $6; exit }' || true)"
    if [[ -n "$port_pid" ]]; then
      kill "$port_pid" 2>/dev/null || true
      sleep 1
    fi
  fi

  if pid_alive "$pidfile"; then
    warn "$name pid $(cat "$pidfile") exists but port :$port is closed"
    rm -f "$pidfile"
  fi

  if [[ "$CHECK_ONLY" == "1" ]]; then
    warn "$name offline (:$port)"
    record "$name" "down" ":$port"
    return 1
  fi

  start "$name on :$port"
  (
    cd "$workdir"
    nohup "$@" >>"$logfile" 2>&1 &
    echo $! >"$pidfile"
  )
  sleep 2
  if http_ok "http://127.0.0.1:${port}/health" 2>/dev/null || \
     http_ok "http://127.0.0.1:${port}/docs" 2>/dev/null || \
     port_open 127.0.0.1 "$port"; then
    ok "$name started (pid $(cat "$pidfile"), log $logfile)"
    record "$name" "started" ":$port"
  else
    fail "$name did not come up on :$port (see $logfile)"
    record "$name" "failed" "$logfile"
    return 1
  fi
}

ensure_supabase() {
  if port_open "$SUPABASE_HOST" "$SUPABASE_PG_PORT" && \
     http_reachable "http://${SUPABASE_HOST}:${SUPABASE_API_PORT}/rest/v1/"; then
    ok "Supabase API :${SUPABASE_API_PORT} + Postgres :${SUPABASE_PG_PORT}"
    record "Supabase" "up" "API :${SUPABASE_API_PORT}, PG :${SUPABASE_PG_PORT}"
    return 0
  fi

  if port_open "$SUPABASE_HOST" "$SUPABASE_PG_PORT"; then
    warn "Postgres :${SUPABASE_PG_PORT} up but REST :${SUPABASE_API_PORT} not ready"
    record "Supabase" "partial" "PG only"
    [[ "$CHECK_ONLY" == "1" ]] && return 1
  fi

  if [[ "$CHECK_ONLY" == "1" ]]; then
    warn "Supabase offline"
    record "Supabase" "down" "npx supabase start"
    return 1
  fi

  if ! command -v npx >/dev/null 2>&1; then
    fail "npx not found; cannot start Supabase"
    record "Supabase" "failed" "npx missing"
    return 1
  fi

  local supabase_cli="${SUPABASE_CLI:-$ROOT/.tools/supabase/supabase}"
  if [[ ! -x "$supabase_cli" ]]; then
  if [[ -x "$ROOT/scripts/ensure_supabase_cli.sh" ]]; then
    start "Supabase CLI (ensure_supabase_cli.sh)"
    bash "$ROOT/scripts/ensure_supabase_cli.sh" >>"$LOG_DIR/supabase.log" 2>&1 || true
    supabase_cli="${SUPABASE_CLI:-$ROOT/.tools/supabase/supabase}"
  fi
  fi

  if [[ ! -x "$supabase_cli" ]]; then
    fail "Supabase CLI missing — run ./scripts/ensure_supabase_cli.sh"
    record "Supabase" "failed" "CLI missing (npx broken on Node 24+)"
    return 1
  fi

  start "Supabase ($supabase_cli start)"
  (cd "$ROOT" && "$supabase_cli" start) >>"$LOG_DIR/supabase.log" 2>&1 || true

  local i
  for i in $(seq 1 30); do
    if port_open "$SUPABASE_HOST" "$SUPABASE_PG_PORT" && \
       http_reachable "http://${SUPABASE_HOST}:${SUPABASE_API_PORT}/rest/v1/"; then
      ok "Supabase ready"
      record "Supabase" "started" "API :${SUPABASE_API_PORT}"
      return 0
    fi
    sleep 2
  done

  fail "Supabase did not become ready (see $LOG_DIR/supabase.log)"
  record "Supabase" "failed" "$LOG_DIR/supabase.log"
  return 1
}

ensure_docker_container() {
  local name="$1"
  local port="${2:-}"

  if ! command -v docker >/dev/null 2>&1; then
    warn "docker not installed; skipping $name"
    record "$name" "skip" "docker missing"
    return 0
  fi

  if ! docker_exists "$name"; then
    warn "container '$name' not found (create it first)"
    record "$name" "missing" "docker ps -a"
    return 0
  fi

  if docker_running "$name"; then
    if [[ -n "$port" ]] && ! port_open 127.0.0.1 "$port"; then
      warn "$name running but port :$port not open yet"
      record "$name" "partial" ":$port"
      return 0
    fi
    ok "$name container running${port:+ (:$port)}"
    record "$name" "up" "${port:+:$port}"
    return 0
  fi

  if [[ "$CHECK_ONLY" == "1" ]]; then
    warn "$name container stopped"
    record "$name" "down" "docker start $name"
    return 1
  fi

  start "docker container $name"
  if docker start "$name" >/dev/null; then
    sleep 2
    ok "$name started"
    record "$name" "started" "docker"
  else
    fail "could not start $name"
    record "$name" "failed" "docker start"
    return 1
  fi
}

ensure_sync_service() {
  sync_service_ready() {
    local code
    code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 3 \
      "http://127.0.0.1:${SYNC_PORT}/api/v1/cases" 2>/dev/null || echo 000)"
    [[ "$code" == "200" ]]
  }

  stop_sync_service() {
    local pidfile="$PID_DIR/sync-service.pid"
    if [[ -f "$pidfile" ]]; then
      local pid
      pid="$(cat "$pidfile")"
      if kill -0 "$pid" 2>/dev/null; then
        kill "$pid" 2>/dev/null || true
        sleep 1
        kill -9 "$pid" 2>/dev/null || true
      fi
      rm -f "$pidfile"
    fi
    if port_open 127.0.0.1 "$SYNC_PORT"; then
      local port_pid
      port_pid="$(ss -ltnp 2>/dev/null | awk -v p=":${SYNC_PORT}" '$4 ~ p { gsub(/.*pid=/, "", $6); gsub(/,.*/, "", $6); print $6; exit }' || true)"
      if [[ -n "$port_pid" ]]; then
        kill "$port_pid" 2>/dev/null || true
        sleep 1
      fi
    fi
  }

  if port_open 127.0.0.1 "$SYNC_PORT" && sync_service_ready; then
    ok "sync-service on :$SYNC_PORT (ops routes OK)"
    record "sync-service" "up" ":$SYNC_PORT"
    return 0
  fi

  if port_open 127.0.0.1 "$SYNC_PORT"; then
    warn "Restarting stale sync-service on :$SYNC_PORT (missing /api/v1/cases — reload Phase 2 code)"
    if [[ "$CHECK_ONLY" == "1" ]]; then
      record "sync-service" "stale" "restart sync-service"
      return 1
    fi
    stop_sync_service
  fi

  start_bg_process "sync-service" "$ROOT/sync-service" "$SYNC_PORT" \
    "$PYTHON" -m uvicorn main:app --host 0.0.0.0 --port "$SYNC_PORT" --workers 2
}

ensure_ocr_service() {
  start_bg_process "ocr-service" "$ROOT/ocr-service" "$OCR_PORT" \
    "$PYTHON" -m uvicorn main:app --host 0.0.0.0 --port "$OCR_PORT"
}

ensure_backoffice() {
  if [[ "$WITH_BACKOFFICE" != "1" ]]; then
    record "backoffice-ui" "skip" "use --backoffice"
    return 0
  fi

  if port_open 127.0.0.1 "$BACKOFFICE_PORT"; then
    ok "backoffice-ui on :$BACKOFFICE_PORT"
    record "backoffice-ui" "up" ":$BACKOFFICE_PORT"
    return 0
  fi

  if [[ "$CHECK_ONLY" == "1" ]]; then
    warn "backoffice-ui offline :$BACKOFFICE_PORT"
    record "backoffice-ui" "down" ":$BACKOFFICE_PORT"
    return 1
  fi

  local pidfile="$PID_DIR/backoffice-ui.pid"
  local logfile="$LOG_DIR/backoffice-ui.log"
  start "backoffice-ui on :$BACKOFFICE_PORT"
  (
    cd "$ROOT/backoffice-ui"
    nohup python3 -m http.server "$BACKOFFICE_PORT" --bind 0.0.0.0 >>"$logfile" 2>&1 &
    echo $! >"$pidfile"
  )
  sleep 1
  if port_open 127.0.0.1 "$BACKOFFICE_PORT"; then
    ok "backoffice-ui started (http://127.0.0.1:$BACKOFFICE_PORT)"
    record "backoffice-ui" "started" ":$BACKOFFICE_PORT"
  else
    fail "backoffice-ui failed to start"
    record "backoffice-ui" "failed" "$logfile"
  fi
}

ensure_portal() {
  if [[ "$WITH_PORTAL" != "1" ]]; then
    record "giop-portal" "skip" "use --portal"
    return 0
  fi

  local portal_dir="$ROOT/backoffice-ui/cloudhound frontend portal"

  if port_open 127.0.0.1 "$PORTAL_PORT"; then
    ok "giop-portal on :$PORTAL_PORT"
    record "giop-portal" "up" ":$PORTAL_PORT"
    return 0
  fi

  if [[ "$CHECK_ONLY" == "1" ]]; then
    warn "giop-portal offline :$PORTAL_PORT"
    record "giop-portal" "down" ":$PORTAL_PORT"
    return 1
  fi

  if ! command -v npm >/dev/null 2>&1; then
    fail "npm not found; cannot start giop-portal"
    record "giop-portal" "failed" "npm missing"
    return 1
  fi

  if [[ ! -d "$portal_dir/node_modules" ]]; then
    start "npm install (giop-portal)"
    (cd "$portal_dir" && npm install) >>"$LOG_DIR/giop-portal-install.log" 2>&1 || {
      fail "npm install failed (see $LOG_DIR/giop-portal-install.log)"
      record "giop-portal" "failed" "npm install"
      return 1
    }
  fi

  if [[ ! -f "$portal_dir/.env.local" ]] && [[ -f "$portal_dir/.env.local.example" ]]; then
    cp "$portal_dir/.env.local.example" "$portal_dir/.env.local"
    ok "created $portal_dir/.env.local from example"
  fi

  local pidfile="$PID_DIR/giop-portal.pid"
  local logfile="$LOG_DIR/giop-portal.log"
  start "giop-portal on :$PORTAL_PORT"
  (
    cd "$portal_dir"
    setsid ./node_modules/.bin/vite --host 127.0.0.1 --port "$PORTAL_PORT" \
      >>"$logfile" 2>&1 </dev/null &
  )
  sleep 2
  local vite_pid
  vite_pid="$(pgrep -f "node.*vite.*--port ${PORTAL_PORT}" 2>/dev/null | head -1 || true)"
  if [[ -n "$vite_pid" ]]; then
    echo "$vite_pid" >"$pidfile"
  fi
  if port_open 127.0.0.1 "$PORTAL_PORT"; then
    ok "giop-portal started (http://127.0.0.1:$PORTAL_PORT)"
    record "giop-portal" "started" ":$PORTAL_PORT"
  else
    fail "giop-portal failed to start (see $logfile)"
    record "giop-portal" "failed" "$logfile"
  fi
}

maybe_bootstrap_memgraph() {
  if [[ "$WITH_BOOTSTRAP" != "1" ]]; then
    return 0
  fi
  if [[ "$CHECK_ONLY" == "1" ]]; then
    record "memgraph-bootstrap" "skip" "check-only mode"
    return 0
  fi
  if ! docker_running my-memgraph && ! port_open 127.0.0.1 "$MEMGRAPH_PORT"; then
    warn "Memgraph not up; skipping bootstrap"
    record "memgraph-bootstrap" "skip" "memgraph down"
    return 0
  fi
  start "memgraph/bootstrap.py"
  if (cd "$ROOT" && "$PYTHON" memgraph/bootstrap.py) >>"$LOG_DIR/memgraph-bootstrap.log" 2>&1; then
    ok "Memgraph reconciled from Postgres"
    record "memgraph-bootstrap" "ok" "memgraph/bootstrap.py"
  else
    warn "Memgraph bootstrap failed (see $LOG_DIR/memgraph-bootstrap.log)"
    record "memgraph-bootstrap" "failed" "$LOG_DIR/memgraph-bootstrap.log"
  fi
}

verify_topology_health() {
  local script="$ROOT/scripts/verify_topology.sh"
  if [[ ! -x "$script" ]]; then
    chmod +x "$script" 2>/dev/null || true
  fi
  if [[ ! -f "$script" ]]; then
    record "topology" "skip" "verify_topology.sh missing"
    return 0
  fi
  if ! port_open "$SUPABASE_HOST" "$SUPABASE_PG_PORT"; then
    record "topology" "skip" "postgres down"
    return 0
  fi
  if "$script" >>"$LOG_DIR/verify-topology.log" 2>&1; then
    ok "topology edge density OK"
    record "topology" "ok" "verify_topology.sh"
  else
    warn "topology sparse — run ./scripts/promote_topology.sh then python memgraph/bootstrap.py"
    record "topology" "warn" "promote_topology.sh"
    [[ "$CHECK_ONLY" == "1" ]] && FAILED=1
  fi
}

print_summary() {
  log ""
  log "=== GIOP stack summary ==="
  local i
  for i in "${!REPORT_NAMES[@]}"; do
    printf '  %-18s %-8s %s\n' "${REPORT_NAMES[$i]}" "${REPORT_STATUS[$i]}" "${REPORT_DETAIL[$i]}"
  done
  log ""
  if [[ "$CHECK_ONLY" == "1" ]]; then
    log "Check-only mode (nothing was started)."
  else
    log "Logs: $LOG_DIR"
    log "PIDs: $PID_DIR"
  fi
  log ""
  log "Mobile:    cd mobile && flutter run"
  log "Backoffice: http://127.0.0.1:${BACKOFFICE_PORT}  (--backoffice to auto-start)"
  log "Portal:    http://127.0.0.1:${PORTAL_PORT}  (--portal to auto-start)"
  log "Supabase:  http://127.0.0.1:${SUPABASE_API_PORT}  (npx supabase status)"
}

main() {
  log "GIOP stack check (${ROOT})"
  log ""

  ensure_supabase || true
  log ""

  log "Docker services"
  ensure_docker_container my-memgraph "$MEMGRAPH_PORT" || true
  if [[ -x "$ROOT/scripts/ensure_martin.sh" ]]; then
    "$ROOT/scripts/ensure_martin.sh" >>"$LOG_DIR/martin.log" 2>&1 || ensure_docker_container giop-martin "$MARTIN_PORT" || true
  else
    ensure_docker_container giop-martin "$MARTIN_PORT" || true
  fi
  ensure_docker_container giop-timescale "$TIMESCALE_PORT" || true
  if [[ -x "$ROOT/scripts/ensure_redis.sh" ]]; then
    "$ROOT/scripts/ensure_redis.sh" >>"$LOG_DIR/redis.log" 2>&1 || ensure_docker_container giop-redis "${REDIS_PORT:-6379}" || true
  else
    ensure_docker_container giop-redis "${REDIS_PORT:-6379}" || true
  fi
  log ""

  log "Python services"
  ensure_sync_service || true
  ensure_ocr_service || true
  ensure_backoffice || true
  ensure_portal || true
  log ""

  maybe_bootstrap_memgraph || true
  verify_topology_health || true
  print_summary

  if [[ "$FAILED" -gt 0 ]]; then
    exit 1
  fi

  if [[ "$CHECK_ONLY" == "1" ]]; then
    for s in "${REPORT_STATUS[@]}"; do
      if [[ "$s" == "down" || "$s" == "partial" || "$s" == "failed" ]]; then
        exit 1
      fi
    done
  fi
}

main "$@"
