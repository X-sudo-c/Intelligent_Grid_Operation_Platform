#!/usr/bin/env bash
# Stream GIOP stack service logs to the terminal (combined tail -F).
#
# Usage:
#   ./scripts/tail_giop_stack_logs.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/lib_giop_logs.sh"

giop_tail_stack_logs
