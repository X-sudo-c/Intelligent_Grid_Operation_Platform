#!/usr/bin/env bash
# Smoke-test map tile materialized views (00100) and Martin layer catalog.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGHOST="${PGHOST:-127.0.0.1}"
PGPORT="${PGPORT:-54322}"
PGUSER="${PGUSER:-postgres}"
PGDATABASE="${PGDATABASE:-postgres}"
PGPASSWORD="${PGPASSWORD:-postgres}"
MARTIN_PORT="${MARTIN_PORT:-3001}"
export PGPASSWORD

psql_cmd() {
  psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d "$PGDATABASE" -v ON_ERROR_STOP=1 "$@"
}

echo "== map tile layers (materialized) =="
psql_cmd -c "
SELECT c.relname AS layer,
       c.relkind,
       pg_size_pretty(pg_total_relation_size(c.oid)) AS size
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN (
    'map_connectivity_nodes',
    'map_ac_line_segments',
    'map_power_transformers'
  )
ORDER BY 1;
"

psql_cmd -c "
SELECT 'map_connectivity_nodes' AS layer, COUNT(*) AS rows FROM public.map_connectivity_nodes
UNION ALL
SELECT 'map_ac_line_segments', COUNT(*) FROM public.map_ac_line_segments
UNION ALL
SELECT 'map_power_transformers', COUNT(*) FROM public.map_power_transformers;
"

psql_cmd -c "
SELECT nominal_voltage, COUNT(*) AS lines
FROM public.map_ac_line_segments
GROUP BY 1
ORDER BY 2 DESC
LIMIT 6;
"

echo "== map tile refresh age-aware (00106) =="
psql_cmd -c "
SELECT pg_get_function_identity_arguments(oid) AS args
FROM pg_proc
WHERE proname = 'refresh_map_tile_layers'
ORDER BY 1;
SELECT key, refreshed_at, details
FROM public.topology_scan_cache_meta
WHERE key = 'map_tile_layers';
"

echo "== Martin catalog (optional) =="
CATALOG_TMP="${ROOT}/.giop/martin-catalog-check.json"
mkdir -p "${ROOT}/.giop"
if curl -sf "http://127.0.0.1:${MARTIN_PORT}/catalog" >"${CATALOG_TMP}" 2>/dev/null; then
  CATALOG_TMP="${CATALOG_TMP}" python3 - <<'PY'
import json
import os

catalog_path = os.environ["CATALOG_TMP"]


def catalog_ids(data):
    if isinstance(data, list):
        return {str(item.get("id", "")) for item in data if isinstance(item, dict)}
    if isinstance(data, dict):
        tiles = data.get("tiles") or data
        if isinstance(tiles, dict):
            return set(tiles.keys())
    return set()


with open(catalog_path) as f:
    names = catalog_ids(json.load(f))
missing = []
for want in ("map_connectivity_nodes", "map_ac_line_segments", "map_power_transformers"):
    ok = want in names
    print(f"  {want}: {'present' if ok else 'MISSING'}")
    if not ok:
        missing.append(want)
if missing:
    raise SystemExit(f"Martin catalog missing layers: {', '.join(missing)} (restart giop-martin)")
PY
else
  echo "  Martin not reachable on :${MARTIN_PORT} — skip catalog check"
  exit 1
fi

echo "OK: map tile layers verified"
