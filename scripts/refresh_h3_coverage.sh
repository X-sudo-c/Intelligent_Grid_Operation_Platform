#!/usr/bin/env bash
# Rebuild public.h3_rebuild_coverage for Martin H3 heatmap (run after promote or first setup).
set -euo pipefail

SYNC_PORT="${SYNC_PORT:-5000}"
SYNC_URL="${SYNC_URL:-http://127.0.0.1:${SYNC_PORT}}"

echo "Refreshing H3 rebuild coverage table (national scan, may take ~1 min)..."
result="$(curl -sf -X POST "${SYNC_URL}/api/v1/h3/coverage/refresh?sync=true")"
echo "$result"

rows="$(echo "$result" | python3 -c "import sys,json; print(json.load(sys.stdin).get('rows', 0))" 2>/dev/null || echo "?")"
echo "Done — ${rows} hex rows. Hard-refresh the portal map tab and toggle Rebuild coverage."
echo "Martin restart is not required (tiles read live from Postgres)."
