#!/usr/bin/env bash
# Populate or refresh public.map_unpromoted_conductor_segments (Both-mode cyan gap layer).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PGHOST="${PGHOST:-127.0.0.1}"
PGPORT="${PGPORT:-54322}"
PGUSER="${PGUSER:-postgres}"
PGPASSWORD="${PGPASSWORD:-postgres}"
PGDATABASE="${PGDATABASE:-postgres}"
export PGPASSWORD

CONCURRENT="${1:-false}"

echo "==> map_unpromoted_conductor_segments materialized view"
populated=$(psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d "$PGDATABASE" -Atqc \
  "SELECT COALESCE(c.relispopulated, false)
   FROM pg_class c
   JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relname = 'map_unpromoted_conductor_segments' AND c.relkind = 'm';" 2>/dev/null || echo "f")
if [[ "$populated" != "t" ]]; then
  echo "    not populated — running initial refresh (may take several minutes)"
else
  count=$(psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d "$PGDATABASE" -Atqc \
    "SELECT COUNT(*) FROM public.map_unpromoted_conductor_segments;")
  echo "    current rows: $count"
fi

started=$(date +%s)
result=$(psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d "$PGDATABASE" -Atqc \
  "SELECT public.refresh_map_unpromoted_conductor_segments(${CONCURRENT}::boolean);")
ended=$(date +%s)
echo "$result" | sed 's/^/    /'
echo "    completed in $((ended - started))s"
