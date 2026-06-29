#!/usr/bin/env bash
# Import supabase/Power System.gpkg into local Supabase PostGIS (gis schema).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
GPKG="${GPKG_PATH:-$ROOT/supabase/Power System.gpkg}"
PGHOST="${PGHOST:-127.0.0.1}"
PGPORT="${PGPORT:-54322}"
PGUSER="${PGUSER:-postgres}"
PGPASSWORD="${PGPASSWORD:-postgres}"
PGDATABASE="${PGDATABASE:-postgres}"

export PGPASSWORD

PG_CONN="PG:host=${PGHOST} port=${PGPORT} dbname=${PGDATABASE} user=${PGUSER} password=${PGPASSWORD} active_schema=gis"

IMPORT_METERS="${IMPORT_METERS:-0}"

if [[ ! -f "$GPKG" ]]; then
  echo "GeoPackage not found: $GPKG" >&2
  exit 1
fi

if ! command -v ogr2ogr >/dev/null 2>&1; then
  echo "ogr2ogr not found. Install GDAL (e.g. apt install gdal-bin)." >&2
  exit 1
fi

if ! psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d "$PGDATABASE" -c "SELECT 1" >/dev/null 2>&1; then
  echo "Postgres not reachable at ${PGHOST}:${PGPORT}. Run: npx supabase start" >&2
  exit 1
fi

ogr_common=(
  -f PostgreSQL "$PG_CONN"
  -overwrite
  -lco GEOMETRY_NAME=geom
  -lco FID=fid
  -lco SPATIAL_INDEX=GIST
  -nlt PROMOTE_TO_MULTI
  -progress
)

import_layer() {
  local gpkg_layer="$1"
  local pg_table="$2"
  local started ended elapsed count
  started=$(date +%s%3N)
  echo "==> Importing ${gpkg_layer} -> gis.${pg_table}"
  ogr2ogr "${ogr_common[@]}" -nln "gis.${pg_table}" "$GPKG" "$gpkg_layer"
  ended=$(date +%s%3N)
  elapsed=$((ended - started))
  count=$(psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d "$PGDATABASE" -Atqc \
    "SELECT COUNT(*) FROM gis.\"${pg_table}\";")
  psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d "$PGDATABASE" -q -c \
    "INSERT INTO gis.import_runs (layer_name, target_table, feature_count, duration_ms)
     VALUES ('${gpkg_layer}', 'gis.${pg_table}', ${count}, ${elapsed});"
  echo "    ${count} features in ${elapsed}ms"
}

echo "Source: $GPKG"
echo "Target: postgres://${PGUSER}@${PGHOST}:${PGPORT}/${PGDATABASE} (schema gis)"
echo

psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d "$PGDATABASE" -q -c "CREATE SCHEMA IF NOT EXISTS gis;"

if [[ "${BOUNDARIES_ONLY:-0}" == "1" ]]; then
  echo "==> Boundaries-only import (skipping network layers and post_import_refresh)"
  import_layer "ECG-Admin_Boundaries" "ecg_admin_boundaries"
  psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d "$PGDATABASE" -q -c \
    "GRANT SELECT ON ALL TABLES IN SCHEMA gis TO anon, authenticated, service_role;" || true
  psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d "$PGDATABASE" -q -c \
    "UPDATE gis.reference_layers
     SET feature_count = (SELECT COUNT(*) FROM gis.ecg_admin_boundaries),
         last_imported_at = NOW(), updated_at = NOW()
     WHERE slug = 'ecg-admin-boundaries';" 2>/dev/null || true
  echo
  echo "Done. Boundaries imported."
  psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d "$PGDATABASE" -c \
    "SELECT COUNT(*) AS district_polygons FROM gis.ecg_admin_boundaries;"
  exit 0
fi

import_layer "power_transformer" "power_transformer"
import_layer "distribution_transformer" "distribution_transformer"
import_layer "ECG-Admin_Boundaries" "ecg_admin_boundaries"
import_layer "oh_conductor_11kv" "oh_conductor_11kv"
import_layer "oh_conductor_33kv" "oh_conductor_33kv"
import_layer "ug_cable_11kv" "ug_cable_11kv"
import_layer "taa_data__dbo_ug_cable_33kv_evw" "ug_cable_33kv"
import_layer "oh_conductor_lvle" "oh_conductor_lvle"
import_layer "ug_cable_lvle" "ug_cable_lvle"
import_layer "service_line_lvle" "service_line_lvle"
import_layer "oh_support_structure_11kv" "oh_support_structure_11kv"
import_layer "oh_support_structure_33kv" "oh_support_structure_33kv"
import_layer "_oh_support_structure_33kv" "oh_support_structure_33kv_dup"
import_layer "oh_support_structure_lvle" "oh_support_structure_lvle"

if [[ "$IMPORT_METERS" == "1" ]]; then
  echo "==> Importing customer_meter_lvle (~1.25M features; this may take a while)"
  import_layer "customer_meter_lvle" "customer_meter_lvle"
else
  echo "==> Skipping customer_meter_lvle (set IMPORT_METERS=1 to include)"
fi

echo
echo "==> Running post-import ETL (node map, conductors, CIM transformers)"
psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d "$PGDATABASE" -v ON_ERROR_STOP=1 \
  -f "$ROOT/scripts/gis_etl_functions.sql" >/dev/null
psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d "$PGDATABASE" -Atqc \
  "SELECT gis.post_import_refresh();" | sed 's/^/    /'
psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d "$PGDATABASE" -q -c \
  "GRANT SELECT ON ALL TABLES IN SCHEMA gis TO anon, authenticated, service_role;"

echo
echo "Done. Summary:"
psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d "$PGDATABASE" -c \
  "SELECT target_table, feature_count, duration_ms, imported_at
   FROM gis.import_runs
   ORDER BY imported_at DESC
   LIMIT 20;"

psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d "$PGDATABASE" -c \
  "SELECT 'connectivity_nodes' AS table_name, COUNT(*) AS rows FROM public.connectivity_nodes
   UNION ALL
   SELECT 'conductor_segments', COUNT(*) FROM gis.conductor_segments
   UNION ALL
   SELECT 'asset_id_map', COUNT(*) FROM gis.asset_id_map;"
