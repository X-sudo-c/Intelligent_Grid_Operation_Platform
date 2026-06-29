#!/usr/bin/env bash
# Restore Postgres from a trial backup (pg_dump custom format).
#
# Usage:
#   ./scripts/trial/restore_from_backup.sh
#   ./scripts/trial/restore_from_backup.sh .giop/backups/trial/LATEST.dump
#   TRIAL_CONFIRM=1 ./scripts/trial/restore_from_backup.sh
#
# WARNING: Overwrites objects in the target database. Dev/local only.

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib_trial.sh
source "${SCRIPT_DIR}/lib_trial.sh"

trial_load_env
trial_db_ping

DUMP_FILE="${1:-$(trial_latest_backup)}"
if [[ -z "${DUMP_FILE}" || ! -f "${DUMP_FILE}" ]]; then
  echo "Error: no backup file found. Run ./scripts/trial/backup_before_trial.sh first." >&2
  exit 1
fi

command -v pg_restore >/dev/null 2>&1 || {
  echo "Error: pg_restore not found." >&2
  exit 1
}

trial_confirm "This will RESTORE ${DUMP_FILE} into ${SUPABASE_DB_URI}. All current DB data will be replaced."

echo "==> Restoring from ${DUMP_FILE}"
pg_restore \
  --dbname="${SUPABASE_DB_URI}" \
  --clean \
  --if-exists \
  --no-owner \
  --no-privileges \
  "${DUMP_FILE}"

echo ""
trial_print_counts
echo ""
echo "Restore complete. Reconcile Memgraph when ready:"
echo "  .venv/bin/python memgraph/bootstrap.py"
echo "  curl -X POST ${SYNC_SERVICE_URL}/api/v1/graph/reconcile"
