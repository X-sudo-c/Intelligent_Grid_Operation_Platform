#!/usr/bin/env bash
# Install Supabase CLI binary into .tools/supabase/ (avoids broken npx on Node 24+).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN_DIR="${SUPABASE_CLI_DIR:-$ROOT/.tools/supabase}"
BIN="$BIN_DIR/supabase"
VERSION="${SUPABASE_CLI_VERSION:-2.108.0}"
ARCH="$(uname -m)"
case "$ARCH" in
  x86_64|amd64) ASSET="supabase_linux_amd64.tar.gz" ;;
  aarch64|arm64) ASSET="supabase_linux_arm64.tar.gz" ;;
  *)
    echo "Unsupported arch: $ARCH" >&2
    exit 1
    ;;
esac

if [[ -x "$BIN" ]] && "$BIN" --version >/dev/null 2>&1; then
  echo "Supabase CLI already installed: $BIN ($("$BIN" --version 2>/dev/null))"
  exit 0
fi

rm -f "$BIN"

mkdir -p "$BIN_DIR"
TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT

URL="https://github.com/supabase/cli/releases/download/v${VERSION}/${ASSET}"
echo "Downloading Supabase CLI v${VERSION} (${ASSET})…"
if command -v curl >/dev/null 2>&1; then
  curl -fsSL "$URL" -o "$TMP"
elif command -v wget >/dev/null 2>&1; then
  wget -qO "$TMP" "$URL"
else
  echo "Need curl or wget to download Supabase CLI" >&2
  exit 1
fi

tar -xzf "$TMP" -C "$BIN_DIR"
chmod +x "$BIN"
echo "Installed: $BIN"
"$BIN" --version
