#!/usr/bin/env bash
# Full Postgres backup before staging/rules trials.
#
# Usage:
#   ./scripts/trial/backup_before_trial.sh
#   TRIAL_BACKUP_DIR=/path/to/backups ./scripts/trial/backup_before_trial.sh
#
# Output:
#   .giop/backups/trial/giop-pre-trial-<timestamp>.dump
#   .giop/backups/trial/giop-pre-trial-<timestamp>.manifest.txt

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib_trial.sh
source "${SCRIPT_DIR}/lib_trial.sh"

trial_load_env
trial_require_pg_dump
trial_db_ping

TS="$(trial_timestamp)"
mkdir -p "${TRIAL_BACKUP_DIR}"

DUMP_FILE="${TRIAL_BACKUP_DIR}/giop-pre-trial-${TS}.dump"
MANIFEST="${TRIAL_BACKUP_DIR}/giop-pre-trial-${TS}.manifest.txt"

echo "==> Backing up Postgres"
echo "    URI:      ${SUPABASE_DB_URI}"
echo "    Dump:     ${DUMP_FILE}"

trial_print_counts | tee "${MANIFEST}"

echo "==> Running pg_dump (custom format, may take a few minutes)..."
pg_dump "${SUPABASE_DB_URI}" \
  --format=custom \
  --no-owner \
  --no-privileges \
  --file="${DUMP_FILE}"

ln -sfn "$(basename "${DUMP_FILE}")" "${TRIAL_BACKUP_DIR}/LATEST.dump"
ln -sfn "$(basename "${MANIFEST}")" "${TRIAL_BACKUP_DIR}/LATEST.manifest.txt"

echo ""
echo "Backup complete."
echo "  Dump:      ${DUMP_FILE}"
echo "  Manifest:  ${MANIFEST}"
echo "  Latest:    ${TRIAL_BACKUP_DIR}/LATEST.dump"
echo ""
echo "Restore with:"
echo "  ./scripts/trial/restore_from_backup.sh ${DUMP_FILE}"
