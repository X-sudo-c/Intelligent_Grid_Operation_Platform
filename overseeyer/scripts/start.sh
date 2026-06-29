#!/usr/bin/env bash
# Start OVERSEEYER API (:5190) and web UI (:5191).
#
# Usage:
#   ./overseeyer/scripts/start.sh
#   ./overseeyer/scripts/start.sh --api-only
#   ./overseeyer/scripts/start.sh --web-only

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/lib_overseeyer.sh"
_overseeyer_init

API_ONLY=0
WEB_ONLY=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --api-only) API_ONLY=1 ;;
    --web-only) WEB_ONLY=1 ;;
    -h|--help)
      sed -n '2,7p' "$0"
      exit 0
      ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

if [[ "$WEB_ONLY" != "1" ]]; then
  start_api
fi

if [[ "$API_ONLY" != "1" ]]; then
  start_web
fi

echo ""
echo "OVERSEEYER"
echo "  API: http://127.0.0.1:${API_PORT}/api/observability"
echo "  UI:  http://127.0.0.1:${WEB_PORT}"
echo "  Logs: $LOG_DIR/overseeyer-*.log"
