#!/usr/bin/env bash
# Build acme-multi.gpkg (districts polygons + substations points) for import wizard tests.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
GPKG="$ROOT/acme-multi.gpkg"
GEOJSON="$ROOT/acme-districts.geojson"
CSV="$ROOT/acme-substations.csv"

if ! command -v ogr2ogr >/dev/null 2>&1; then
  echo "ogr2ogr not found — install gdal-bin" >&2
  exit 1
fi

rm -f "$GPKG"
ogr2ogr -f GPKG "$GPKG" "$GEOJSON" -nln districts -nlt PROMOTE_TO_MULTI
ogr2ogr -f GPKG -update "$GPKG" "$CSV" -nln substations -oo X_POSSIBLE_NAMES=lon -oo Y_POSSIBLE_NAMES=lat

echo "Wrote $GPKG"
ogrinfo -al -so "$GPKG" | grep -E '^[0-9]+:|Feature Count'
