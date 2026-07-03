#!/usr/bin/env bash
# Start GIOP sync-service on all interfaces (reachable from phone on LAN).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT/sync-service"
if [[ -f "$ROOT/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$ROOT/.env"
  set +a
fi
export PYTHONUNBUFFERED=1
# No --reload: survives nohup/background; use restart script after code changes.
exec "$ROOT/.venv/bin/python" -m uvicorn main:app --host 0.0.0.0 --port 5000
