#!/usr/bin/env bash
# Smoke-test map tile views (migration 00017) and Martin layer catalog.
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

echo "== map tile views =="
psql_cmd -c "
SELECT 'map_connectivity_nodes' AS view, COUNT(*) AS rows FROM public.map_connectivity_nodes
UNION ALL
SELECT 'map_ac_line_segments', COUNT(*) FROM public.map_ac_line_segments;
"

psql_cmd -c "
SELECT nominal_voltage, COUNT(*) AS lines
FROM public.map_ac_line_segments
GROUP BY 1
ORDER BY 2 DESC
LIMIT 6;
"

psql_cmd -c "
SELECT source_layer, COUNT(*) AS nodes
FROM gis.asset_id_map
WHERE source_layer IN (
  'distribution_transformer',
  'power_transformer',
  'oh_support_structure_11kv',
  'oh_support_structure_33kv',
  'oh_support_structure_lvle'
)
GROUP BY 1
ORDER BY 2 DESC;
" 2>/dev/null || psql_cmd -c "
SELECT column_name
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'map_connectivity_nodes' AND column_name = 'asset_kind';
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
for want in ("map_connectivity_nodes", "map_ac_line_segments"):
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

echo "OK: map tile views verified"
