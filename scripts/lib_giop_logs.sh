# Shared helpers for tailing GIOP stack service logs (sourced by start scripts).
GIOP_LOGS_LIB=1

giop_logs_init() {
  if [[ -z "${GIOP_ROOT:-}" ]]; then
    if [[ -n "${BASH_SOURCE[0]:-}" ]]; then
      GIOP_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
    else
      GIOP_ROOT="$(pwd)"
    fi
  fi
  RUN_DIR="${GIOP_RUN_DIR:-$GIOP_ROOT/.giop}"
  LOG_DIR="$RUN_DIR/logs"
  mkdir -p "$LOG_DIR"
}

# Highest-signal stack logs first; install-only logs are excluded.
GIOP_STACK_LOG_STEMS=(
  sync-service
  ocr-service
  supabase
  giop-portal
  backoffice-ui
  redis
  martin
  memgraph-bootstrap
  verify-topology
  supertonic
  trial-ops
  stack-start
  overseeyer-api
  overseeyer-web
  overseeyer-ctl
)

giop_stack_log_files() {
  giop_logs_init
  local -A seen=()
  local files=() stem path base

  for stem in "${GIOP_STACK_LOG_STEMS[@]}"; do
    path="$LOG_DIR/${stem}.log"
    if [[ -f "$path" && -z "${seen[$path]+x}" ]]; then
      seen[$path]=1
      files+=("$path")
    fi
  done

  for path in "$LOG_DIR"/*.log; do
    [[ -f "$path" ]] || continue
    base="${path##*/}"
    [[ "$base" == *-install.log ]] && continue
    [[ -n "${seen[$path]+x}" ]] && continue
    seen[$path]=1
    files+=("$path")
  done

  printf '%s\n' "${files[@]}"
}

giop_ensure_stack_log_targets() {
  giop_logs_init
  local stem
  for stem in "${GIOP_STACK_LOG_STEMS[@]}"; do
    : >>"$LOG_DIR/${stem}.log"
  done
}

giop_tail_stack_logs() {
  giop_ensure_stack_log_targets
  local files=()
  while IFS= read -r path; do
    [[ -n "$path" ]] && files+=("$path")
  done < <(giop_stack_log_files)

  if [[ ${#files[@]} -eq 0 ]]; then
    echo "No stack logs under $LOG_DIR yet." >&2
    return 1
  fi

  echo "" >&2
  echo "Following ${#files[@]} stack log(s) under $LOG_DIR (Ctrl+C stops tail only; services keep running)" >&2
  echo "" >&2
  exec tail -F "${files[@]}"
}
