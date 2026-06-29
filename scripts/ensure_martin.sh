#!/usr/bin/env bash
# Ensure giop-martin runs with config/martin.yaml (auto_bounds: skip).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NAME="${MARTIN_CONTAINER:-giop-martin}"
PORT="${MARTIN_PORT:-3001}"
CONFIG="$ROOT/config/martin.yaml"
IMAGE="${MARTIN_IMAGE:-maplibre/martin:latest}"
PG_URL="${DATABASE_URL:-postgresql://postgres:postgres@host.docker.internal:54322/postgres}"

if [[ ! -f "$CONFIG" ]]; then
  echo "ensure_martin: missing $CONFIG" >&2
  exit 1
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "ensure_martin: docker not installed" >&2
  exit 1
fi

CONFIG_HASH="$(sha256sum "$CONFIG" | awk '{print $1}')"

needs_recreate() {
  if ! docker inspect "$NAME" >/dev/null 2>&1; then
    return 0
  fi
  local mount hash
  mount="$(docker inspect "$NAME" --format '{{range .Mounts}}{{if eq .Destination "/config/martin.yaml"}}{{.Source}}{{end}}{{end}}' 2>/dev/null || true)"
  hash="$(docker inspect "$NAME" --format '{{index .Config.Labels "giop.martin_config_sha256"}}' 2>/dev/null || true)"
  [[ "$mount" != "$CONFIG" || "$hash" != "$CONFIG_HASH" ]]
}

if needs_recreate; then
  echo "==> Recreating $NAME with $CONFIG"
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  docker run -d \
    --name "$NAME" \
    --label "giop.martin_config_sha256=${CONFIG_HASH}" \
    --add-host=host.docker.internal:host-gateway \
    -p "${PORT}:3000" \
    -e "DATABASE_URL=${PG_URL}" \
    -v "${CONFIG}:/config/martin.yaml:ro" \
    "$IMAGE" \
    --config /config/martin.yaml >/dev/null
else
  echo "==> Starting existing $NAME"
  docker start "$NAME" >/dev/null 2>&1 || true
fi

echo -n "==> Waiting for Martin catalog on :${PORT}"
for _ in $(seq 1 90); do
  if curl -sf --max-time 2 "http://127.0.0.1:${PORT}/catalog" >/dev/null 2>&1; then
    missing="$(curl -sf "http://127.0.0.1:${PORT}/catalog" | python3 -c "
import json, sys
data = json.load(sys.stdin)
ids = set()
if isinstance(data, list):
    ids = {str(x.get('id', '')) for x in data if isinstance(x, dict)}
elif isinstance(data, dict):
    tiles = data.get('tiles') or data
    if isinstance(tiles, dict):
        ids = set(tiles.keys())
required = ('map_connectivity_nodes', 'map_ac_line_segments')
missing = [layer for layer in required if layer not in ids]
for layer in required:
    print(f'    {layer}: {\"present\" if layer in ids else \"MISSING\"}')
if missing:
    print('MISSING:' + ','.join(missing), file=sys.stderr)
    sys.exit(1)
")"
    if [[ $? -eq 0 ]]; then
      echo " OK"
      echo "$missing"
      exit 0
    fi
    echo -n "m"
  fi
  echo -n "."
  sleep 1
done

echo " TIMEOUT" >&2
docker logs "$NAME" --tail 20 >&2 || true
exit 1
