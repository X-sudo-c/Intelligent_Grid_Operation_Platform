#!/usr/bin/env bash
# One-shot trial prep: backup → optional clear master/staging → status.
#
# Usage:
#   ./scripts/trial/prep_trial.sh                    # backup only
#   ./scripts/trial/prep_trial.sh --empty-master     # backup + clear master network
#   ./scripts/trial/prep_trial.sh --fresh-staging   # also truncate staging
#   TRIAL_CONFIRM=1 ./scripts/trial/prep_trial.sh --empty-master --fresh-staging
#
# Non-interactive:
#   TRIAL_CONFIRM=1 ./scripts/trial/prep_trial.sh --empty-master

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib_trial.sh
source "${SCRIPT_DIR}/lib_trial.sh"

EMPTY_MASTER=0
FRESH_STAGING=0

for arg in "$@"; do
  case "${arg}" in
    --empty-master) EMPTY_MASTER=1 ;;
    --fresh-staging) FRESH_STAGING=1 ;;
    -h|--help)
      sed -n '2,12p' "$0"
      exit 0
      ;;
    *)
      echo "Unknown option: ${arg}" >&2
      exit 1
      ;;
  esac
done

trial_load_env

echo "=============================================="
echo " GIOP trial environment prep"
echo "=============================================="
echo ""

"${SCRIPT_DIR}/backup_before_trial.sh"

if [[ "${EMPTY_MASTER}" -eq 1 ]]; then
  echo ""
  "${SCRIPT_DIR}/clear_master_network.sh"
fi

if [[ "${FRESH_STAGING}" -eq 1 ]]; then
  echo ""
  "${SCRIPT_DIR}/clear_staging.sh"
fi

echo ""
echo "=============================================="
echo " Ready for trials"
echo "=============================================="
echo ""
echo "Simulate field captures (mixed good/bad):"
echo "  python3 scripts/trial/simulate_field_captures.py --count 20"
echo ""
echo "Run rules engine on staging:"
echo "  curl -X POST '${SYNC_SERVICE_URL}/api/v1/validation/run?async=false' \\"
echo "    -H 'Content-Type: application/json' \\"
echo "    -d '{\"run_type\":\"asset_checks\",\"tier\":\"staging\",\"operator_id\":\"trial\"}'"
echo ""
echo "Restore full DB after trials:"
echo "  TRIAL_CONFIRM=1 ./scripts/trial/restore_from_backup.sh"
echo ""
echo "Re-import master from GeoPackage (if gis.* intact):"
echo "  ./scripts/trial/reimport_master_from_gis.sh"
