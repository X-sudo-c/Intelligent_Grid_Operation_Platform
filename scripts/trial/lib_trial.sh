#!/usr/bin/env bash
# Shared helpers for GIOP trial scripts (backup, restore, clear master, simulate).
set -euo pipefail

_TRIAL_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
_TRIAL_ROOT="$(cd "${_TRIAL_LIB_DIR}/../.." && pwd)"

trial_load_env() {
  if [[ -f "${_TRIAL_ROOT}/.env" ]]; then
    set -a
    # shellcheck disable=SC1091
    source "${_TRIAL_ROOT}/.env"
    set +a
  fi
  export SUPABASE_DB_URI="${SUPABASE_DB_URI:-postgresql://postgres:postgres@127.0.0.1:54322/postgres}"
  export SYNC_SERVICE_URL="${SYNC_SERVICE_URL:-http://127.0.0.1:5000}"
  export TRIAL_BACKUP_DIR="${TRIAL_BACKUP_DIR:-${_TRIAL_ROOT}/.giop/backups/trial}"
  export PGPASSWORD="${PGPASSWORD:-postgres}"

  if [[ "${SUPABASE_DB_URI}" =~ postgresql://([^:]+):([^@]+)@([^:]+):([0-9]+)/(.+) ]]; then
    export PGUSER="${PGUSER:-${BASH_REMATCH[1]}}"
    export PGPASSWORD="${PGPASSWORD:-${BASH_REMATCH[2]}}"
    export PGHOST="${PGHOST:-${BASH_REMATCH[3]}}"
    export PGPORT="${PGPORT:-${BASH_REMATCH[4]}}"
    export PGDATABASE="${PGDATABASE:-${BASH_REMATCH[5]}}"
  else
    export PGHOST="${PGHOST:-127.0.0.1}"
    export PGPORT="${PGPORT:-54322}"
    export PGUSER="${PGUSER:-postgres}"
    export PGDATABASE="${PGDATABASE:-postgres}"
  fi
}

trial_require_psql() {
  command -v psql >/dev/null 2>&1 || {
    echo "Error: psql not found." >&2
    exit 1
  }
}

trial_require_pg_dump() {
  command -v pg_dump >/dev/null 2>&1 || {
    echo "Error: pg_dump not found." >&2
    exit 1
  }
}

trial_db_ping() {
  trial_require_psql
  psql "${SUPABASE_DB_URI}" -v ON_ERROR_STOP=1 -q -c "SELECT 1" >/dev/null
}

trial_timestamp() {
  date -u +"%Y%m%dT%H%M%SZ"
}

trial_confirm() {
  local msg="${1:-Proceed?}"
  if [[ "${TRIAL_CONFIRM:-}" == "1" ]]; then
    return 0
  fi
  echo "${msg}"
  read -r -p "Type YES to continue: " answer
  [[ "${answer}" == "YES" ]] || {
    echo "Aborted."
    exit 1
  }
}

trial_counts_sql() {
  psql "${SUPABASE_DB_URI}" -v ON_ERROR_STOP=1 -At -F $'\t' <<'SQL'
SELECT 'public.connectivity_nodes', COUNT(*)::text FROM public.connectivity_nodes
UNION ALL SELECT 'public.ac_line_segments', COUNT(*)::text FROM public.ac_line_segments
UNION ALL SELECT 'public.identified_objects', COUNT(*)::text FROM public.identified_objects
UNION ALL SELECT 'staging.identified_objects', COUNT(*)::text FROM staging.identified_objects
UNION ALL SELECT 'public.data_quality_exceptions_open', COUNT(*)::text
  FROM public.data_quality_exceptions WHERE status = 'OPEN'
UNION ALL SELECT 'gis.asset_id_map', COUNT(*)::text FROM gis.asset_id_map;
SQL
}

trial_print_counts() {
  echo "==> Database counts"
  trial_counts_sql | while IFS=$'\t' read -r label count; do
    printf "    %-40s %s\n" "${label}" "${count}"
  done
}

trial_latest_backup() {
  ls -1t "${TRIAL_BACKUP_DIR}"/*.dump 2>/dev/null | head -1 || true
}
