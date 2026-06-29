#!/usr/bin/env bash
# Stop / start / restart OVERSEEYER API or UI (used from the running API for self-shutdown).
#
# Usage:
#   ./overseeyer/scripts/service_ctl.sh stop overseeyer-api
#   ./overseeyer/scripts/service_ctl.sh restart overseeyer-api
#   ./overseeyer/scripts/service_ctl.sh stop overseeyer-web

set -euo pipefail

ACTION="${1:?action required: stop|start|restart}"
SERVICE="${2:?service required: overseeyer-api|overseeyer-web}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/lib_overseeyer.sh"
_overseeyer_init

LOG_CTL="$LOG_DIR/overseeyer-ctl.log"
exec >>"$LOG_CTL" 2>&1
echo "--- $(date -Is) service_ctl $ACTION $SERVICE ---"

# Let the HTTP response return before we kill the caller (overseeyer-api stop/restart).
if [[ "$SERVICE" == "overseeyer-api" && "$ACTION" != "start" ]]; then
  sleep 0.85
fi
if [[ "$SERVICE" == "overseeyer-web" && "$ACTION" == "restart" ]]; then
  sleep 0.3
fi

case "$SERVICE" in
  overseeyer-api)
    case "$ACTION" in
      stop) stop_api ;;
      start) start_api ;;
      restart) stop_api; start_api ;;
      *) echo "Unknown action: $ACTION" >&2; exit 2 ;;
    esac
    ;;
  overseeyer-web)
    case "$ACTION" in
      stop) stop_web ;;
      start) start_web ;;
      restart) stop_web; start_web ;;
      *) echo "Unknown action: $ACTION" >&2; exit 2 ;;
    esac
    ;;
  *)
    echo "Unknown service: $SERVICE" >&2
    exit 2
    ;;
esac

echo "--- $(date -Is) service_ctl $ACTION $SERVICE done ---"
