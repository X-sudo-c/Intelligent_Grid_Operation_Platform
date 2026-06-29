#!/usr/bin/env bash
# Remove master network geometry (nodes + lines). Keeps gis.* raw import, meters, staging.
#
# Usage:
#   TRIAL_CONFIRM=1 ./scripts/trial/clear_master_network.sh
#
# Does NOT delete staging captures or gis schema tables.

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib_trial.sh
source "${SCRIPT_DIR}/lib_trial.sh"

trial_load_env
trial_require_psql
trial_db_ping

trial_confirm "This will DELETE all public connectivity_nodes and ac_line_segments (master map). gis.* is kept."

echo "==> Counts before"
trial_print_counts

psql "${SUPABASE_DB_URI}" -v ON_ERROR_STOP=1 <<'SQL'
BEGIN;

CREATE TEMP TABLE _trial_line_mrids ON COMMIT DROP AS
  SELECT mrid FROM public.ac_line_segments;

CREATE TEMP TABLE _trial_node_mrids ON COMMIT DROP AS
  SELECT mrid FROM public.connectivity_nodes;

DELETE FROM public.data_quality_exceptions
WHERE record_mrid IN (
  SELECT mrid FROM _trial_node_mrids
  UNION
  SELECT mrid FROM _trial_line_mrids
);

DELETE FROM public.ac_line_segments;
DELETE FROM public.conducting_equipment
WHERE mrid IN (SELECT mrid FROM _trial_line_mrids);

DELETE FROM public.connectivity_nodes;
DELETE FROM public.ghana_grid_assets
WHERE mrid IN (SELECT mrid FROM _trial_node_mrids);

DELETE FROM public.identified_objects
WHERE mrid IN (
  SELECT mrid FROM _trial_node_mrids
  UNION
  SELECT mrid FROM _trial_line_mrids
);

COMMIT;
SQL

echo ""
echo "==> Counts after"
trial_print_counts

echo ""
echo "Master network cleared. Optional:"
echo "  curl -X POST ${SYNC_SERVICE_URL}/api/v1/graph/reconcile"
echo "  ./scripts/trial/reimport_master_from_gis.sh   # rebuild master from gis.*"
