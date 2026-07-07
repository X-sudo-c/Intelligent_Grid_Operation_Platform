#!/usr/bin/env bash
# Recreate supabase_db_<project> with a larger /dev/shm (default Docker limit is 64MB).
# Run AFTER `npx supabase start` if the DB container was created with default shm.
#
# Usage:
#   ./scripts/patch_supabase_db_shm.sh
#   SUPABASE_DB_SHM_SIZE=1g ./scripts/patch_supabase_db_shm.sh

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PROJECT_ID="${SUPABASE_PROJECT_ID:-ECG}"
SHM="${SUPABASE_DB_SHM_SIZE:-1g}"
CONTAINER="supabase_db_${PROJECT_ID}"
VOL="supabase_db_${PROJECT_ID}"
NET="supabase_network_${PROJECT_ID}"
PORT="${SUPABASE_PG_PORT:-54322}"

if ! docker volume inspect "$VOL" >/dev/null 2>&1; then
  echo "Volume $VOL not found. Run: cd $ROOT && npx supabase start" >&2
  exit 1
fi

IMAGE="$(docker image ls 'public.ecr.aws/supabase/postgres' --format '{{.Repository}}:{{.Tag}}' | head -1)"
if [[ -z "$IMAGE" ]]; then
  echo "Postgres image not found locally. Run: npx supabase start" >&2
  exit 1
fi

if docker container inspect "$CONTAINER" >/dev/null 2>&1; then
  current="$(docker container inspect "$CONTAINER" --format '{{.HostConfig.ShmSize}}')"
  want_bytes=$((1024 * 1024 * 1024))
  if [[ "$SHM" == *g ]]; then
    gb="${SHM%g}"
    want_bytes=$((gb * 1024 * 1024 * 1024))
  elif [[ "$SHM" == *m ]]; then
    mb="${SHM%m}"
    want_bytes=$((mb * 1024 * 1024))
  fi
  if [[ "$current" -ge "$want_bytes" ]]; then
    echo "OK: $CONTAINER shm_size=${current} bytes (>= target)"
    docker exec "$CONTAINER" df -h /dev/shm
    exit 0
  fi
  echo "Recreating $CONTAINER (shm ${current} -> ${SHM})"
  docker rm -f "$CONTAINER"
else
  echo "Creating $CONTAINER with shm_size=${SHM}"
fi

if ! docker network inspect "$NET" >/dev/null 2>&1; then
  docker network create "$NET"
fi

docker run -d \
  --name "$CONTAINER" \
  --hostname "$CONTAINER" \
  --network "$NET" \
  --shm-size="$SHM" \
  -p "${PORT}:5432" \
  -v "${VOL}:/var/lib/postgresql/data" \
  --label "com.docker.compose.project=${PROJECT_ID}" \
  --label "com.supabase.cli.project=${PROJECT_ID}" \
  "$IMAGE"

echo "Waiting for Postgres..."
for _ in $(seq 1 60); do
  if docker exec "$CONTAINER" pg_isready -U postgres -h localhost >/dev/null 2>&1; then
    break
  fi
  sleep 2
done

echo "Done:"
docker container inspect "$CONTAINER" --format 'shm_size={{.HostConfig.ShmSize}}'
docker exec "$CONTAINER" df -h /dev/shm
