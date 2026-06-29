#!/usr/bin/env bash
# Clear all staging field captures (fresh trial queue).
#
# Usage:
#   TRIAL_CONFIRM=1 ./scripts/trial/clear_staging.sh

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib_trial.sh
source "${SCRIPT_DIR}/lib_trial.sh"

trial_load_env
trial_require_psql
trial_db_ping

trial_confirm "This will TRUNCATE all staging.identified_objects (field trial data)."

psql "${SUPABASE_DB_URI}" -v ON_ERROR_STOP=1 -c \
  "TRUNCATE staging.identified_objects CASCADE;"

echo "Staging cleared."
trial_print_counts
