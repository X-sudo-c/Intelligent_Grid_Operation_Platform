#!/usr/bin/env bash
# Rebuild master network from gis.* (after trial clear). Does not re-ogr2ogr the GPKG.
#
# Usage:
#   ./scripts/trial/reimport_master_from_gis.sh
#
# Full GPKG reload (if gis.* was wiped):
#   ./scripts/import_power_system_gpkg.sh
#   ./scripts/trial/reimport_master_from_gis.sh

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
# shellcheck source=lib_trial.sh
source "${SCRIPT_DIR}/lib_trial.sh"

trial_load_env
trial_db_ping

GIS_ROWS=$(psql "${SUPABASE_DB_URI}" -Atqc \
  "SELECT COALESCE(SUM(n_live_tup),0)::bigint FROM pg_stat_user_tables WHERE schemaname = 'gis';" 2>/dev/null || echo "0")

if [[ "${GIS_ROWS}" == "0" ]]; then
  echo "gis.* appears empty. Run full import first:"
  echo "  ./scripts/import_power_system_gpkg.sh"
  exit 1
fi

echo "==> Refreshing GIS-derived master (gis.post_import_refresh)"
started=$(date +%s)
psql "${SUPABASE_DB_URI}" -v ON_ERROR_STOP=1 -q -c \
  "SELECT gis.post_import_refresh();" | sed 's/^/    /'
ended=$(date +%s)
echo "    completed in $((ended - started))s"

if psql "${SUPABASE_DB_URI}" -Atqc \
  "SELECT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'gis' AND p.proname = 'promote_topology_to_cim');" \
  | grep -q t; then
  echo ""
  echo "==> Promoting conductor topology to CIM (optional, may take several minutes)"
  echo "    Run manually if needed: ${ROOT}/scripts/promote_topology.sh"
fi

echo ""
trial_print_counts
echo ""
echo "Reconcile graph:"
echo "  .venv/bin/python ${ROOT}/memgraph/bootstrap.py"
