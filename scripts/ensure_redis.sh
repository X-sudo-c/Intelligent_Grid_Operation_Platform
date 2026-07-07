#!/usr/bin/env bash
# Ensure giop-redis is running for sync-service caching.
set -euo pipefail

NAME="${REDIS_CONTAINER:-giop-redis}"
PORT="${REDIS_PORT:-6379}"
IMAGE="${REDIS_IMAGE:-redis:7-alpine}"
MAXMEM="${REDIS_MAXMEMORY:-2gb}"
MAXMEM_POLICY="${REDIS_MAXMEMORY_POLICY:-allkeys-lru}"
REDIS_SERVER_ARGS=(
  redis-server
  --save ""
  --appendonly no
  --maxmemory "$MAXMEM"
  --maxmemory-policy "$MAXMEM_POLICY"
)

if ! command -v docker >/dev/null 2>&1; then
  echo "ensure_redis: docker not installed" >&2
  exit 1
fi

if ! docker inspect "$NAME" >/dev/null 2>&1; then
  echo "==> Creating $NAME on :${PORT}"
  docker run -d \
    --name "$NAME" \
    --label "giop.service=redis" \
    -p "${PORT}:6379" \
    "$IMAGE" \
    "${REDIS_SERVER_ARGS[@]}" >/dev/null
else
  echo "==> Starting existing $NAME"
  docker start "$NAME" >/dev/null 2>&1 || true
fi

echo -n "==> Waiting for Redis on :${PORT}"
for _ in $(seq 1 30); do
  if command -v redis-cli >/dev/null 2>&1; then
    if redis-cli -p "$PORT" ping 2>/dev/null | grep -q PONG; then
      echo " OK"
      exit 0
    fi
  elif docker exec "$NAME" redis-cli ping 2>/dev/null | grep -q PONG; then
    echo " OK"
    exit 0
  fi
  sleep 0.5
done

echo " timeout" >&2
exit 1
