#!/usr/bin/env bash
# Optional nginx HTTP cache in front of giop-martin (does not change zoom settings).
# Publishes MARTIN_CACHE_PORT (default 3002) → nginx → host Martin on MARTIN_PORT (3001).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NAME="${MARTIN_CACHE_CONTAINER:-giop-martin-cache}"
PORT="${MARTIN_CACHE_PORT:-3002}"
MARTIN_PORT="${MARTIN_PORT:-3001}"
CONFIG_SRC="$ROOT/config/nginx-martin-cache.conf"
ACTIVE_CONF="$ROOT/.giop/nginx-martin-cache.active.conf"
IMAGE="${MARTIN_CACHE_IMAGE:-nginx:alpine}"

if [[ ! -f "$CONFIG_SRC" ]]; then
  echo "ensure_martin_cache: missing $CONFIG_SRC" >&2
  exit 1
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "ensure_martin_cache: docker not installed" >&2
  exit 1
fi

mkdir -p "$ROOT/.giop"
sed "s/host.docker.internal:3001/host.docker.internal:${MARTIN_PORT}/g" "$CONFIG_SRC" >"$ACTIVE_CONF"
CONFIG_HASH="$(sha256sum "$ACTIVE_CONF" | awk '{print $1}')"

needs_recreate() {
  if ! docker inspect "$NAME" >/dev/null 2>&1; then
    return 0
  fi
  local hash
  hash="$(docker inspect "$NAME" --format '{{index .Config.Labels "giop.martin_cache_sha256"}}' 2>/dev/null || true)"
  [[ "$hash" != "$CONFIG_HASH" ]]
}

if needs_recreate; then
  echo "==> Recreating $NAME (cache :${PORT} → Martin :${MARTIN_PORT})"
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  docker run -d \
    --name "$NAME" \
    --label "giop.martin_cache_sha256=${CONFIG_HASH}" \
    --add-host=host.docker.internal:host-gateway \
    -p "${PORT}:3001" \
    -v "${ACTIVE_CONF}:/etc/nginx/conf.d/default.conf:ro" \
    "$IMAGE" >/dev/null
else
  echo "==> Starting existing $NAME"
  docker start "$NAME" >/dev/null 2>&1 || true
fi

echo -n "==> Waiting for Martin cache on :${PORT}"
for _ in $(seq 1 60); do
  if curl -sf --max-time 2 "http://127.0.0.1:${PORT}/catalog" >/dev/null 2>&1; then
    echo " OK"
    echo "    Direct Martin:  http://127.0.0.1:${MARTIN_PORT}"
    echo "    Cached Martin:  http://127.0.0.1:${PORT}  (set VITE_MARTIN_URL to use)"
    exit 0
  fi
  echo -n "."
  sleep 1
done

echo " TIMEOUT" >&2
docker logs "$NAME" --tail 30 >&2 || true
exit 1
