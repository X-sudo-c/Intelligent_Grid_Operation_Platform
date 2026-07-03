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
UNION ALL SELECT 'staging.data_quality_exceptions_open', COUNT(*)::text
  FROM staging.data_quality_exceptions WHERE status = 'OPEN'
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

# Bust sync-service Redis caches so map staging pins and nav badges refresh immediately
# after a direct psql TRUNCATE (bypasses API invalidation hooks).
trial_invalidate_portal_cache() {
  trial_load_env
  local py="${_TRIAL_ROOT}/.venv/bin/python"
  if [[ ! -x "${py}" ]]; then
    py="$(command -v python3 2>/dev/null || true)"
  fi
  if [[ -z "${py}" ]]; then
    echo "Note: python not found — skip Redis cache invalidation (wait ~60s or restart sync-service)."
    return 0
  fi
  if ! TRIAL_ROOT="${_TRIAL_ROOT}" "${py}" - <<'PY'
import os
import sys

root = os.environ["TRIAL_ROOT"]
sys.path.insert(0, os.path.join(root, "sync-service"))
try:
    from dotenv import load_dotenv

    load_dotenv(os.path.join(root, ".env"))
except ImportError:
    pass

from redis_cache import invalidate_h3_cache, invalidate_ops_cache, invalidate_staging_cache

n = invalidate_staging_cache() + invalidate_ops_cache() + invalidate_h3_cache()
print(f"==> Redis cache invalidated ({n} key(s): staging lists, DQ summaries, nav badges, H3)")
PY
  then
    echo "Note: Redis cache invalidation failed (is Redis running? wait ~60s for TTL expiry)."
    return 0
  fi
}

trial_latest_backup() {
  ls -1t "${TRIAL_BACKUP_DIR}"/*.dump 2>/dev/null | head -1 || true
}
