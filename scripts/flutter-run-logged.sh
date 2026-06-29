#!/usr/bin/env bash
# Run Flutter field app with logs tee'd for Cursor agent debugging.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOG_DIR="${GIOP_RUN_DIR:-$ROOT/.giop}/logs"
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/flutter.log"

echo "Logging to $LOG_FILE (also printed here)."
echo "Tip: grep AGENTLOG $LOG_FILE"

cd "$ROOT/mobile"
exec flutter run "$@" 2>&1 | tee -a "$LOG_FILE"
