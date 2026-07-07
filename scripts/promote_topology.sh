#!/usr/bin/env bash
# Promote GIS conductor topology into public connectivity_nodes + ac_line_segments.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PGHOST="${PGHOST:-127.0.0.1}"
PGPORT="${PGPORT:-54322}"
PGUSER="${PGUSER:-postgres}"
PGPASSWORD="${PGPASSWORD:-postgres}"
PGDATABASE="${PGDATABASE:-postgres}"
export PGPASSWORD

echo "==> Rebuilding asset ID map + unique_id lookup (if needed)"
psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d "$PGDATABASE" -q -c \
  "SELECT gis.rebuild_asset_id_map();"
psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d "$PGDATABASE" -Atqc \
  "SELECT gis.rebuild_unique_id_lookup();" | sed 's/^/    lookup: /'

echo "==> Promoting support structures + conductors to CIM (may take several minutes)"
echo "    (includes conservative endpoint snap before conductor promote)"
started=$(date +%s)
result=$(psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d "$PGDATABASE" -Atqc \
  "SELECT gis.promote_topology_to_cim();")
ended=$(date +%s)
echo "$result" | sed 's/^/    /'
echo "    completed in $((ended - started))s"

echo
echo "==> Unpromoted gap layer (Both mode cyan lines)"
psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d "$PGDATABASE" -Atqc \
  "SELECT COUNT(*) FROM public.map_unpromoted_conductor_segments;" | sed 's/^/    segments: /'

echo
echo "==> Topology summary"
psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d "$PGDATABASE" -c \
  "SELECT 'connectivity_nodes' AS t, COUNT(*) FROM public.connectivity_nodes
   UNION ALL SELECT 'ac_line_segments', COUNT(*) FROM public.ac_line_segments
   UNION ALL SELECT 'unique_id_lookup', COUNT(*) FROM gis.unique_id_lookup;"

echo
echo "==> Clearing map/graph Redis cache"
curl -sf -X POST "http://127.0.0.1:${SYNC_PORT:-5000}/api/v1/map/invalidate-cache?refresh_h3=true" >/dev/null \
  && echo "    cache cleared (+ H3 Martin coverage refresh queued)" \
  || echo "    WARN: sync-service cache clear failed (is it running on :5000?)"

echo
echo "Reconcile Memgraph when ready:"
echo "  python memgraph/bootstrap.py"
