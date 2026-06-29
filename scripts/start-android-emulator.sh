#!/usr/bin/env bash
# Launch the GIOP Android emulator with Ghana GPS preset.
# Default AVD is giop_light (lighter than giop_pixel) to avoid ANR / "not responding".
set -euo pipefail

export ANDROID_HOME="${ANDROID_HOME:-$HOME/Android/Sdk}"
export PATH="$PATH:$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/emulator:$ANDROID_HOME/platform-tools"

AVD="${1:-giop_light}"
EMULATOR_BIN="$ANDROID_HOME/emulator/emulator"

if [ ! -x "$EMULATOR_BIN" ]; then
  echo "Android emulator not found at: $EMULATOR_BIN"
  echo "Set ANDROID_HOME (e.g. export ANDROID_HOME=\$HOME/Android/Sdk) and install SDK emulator."
  exit 1
fi

if ! "$EMULATOR_BIN" -list-avds 2>/dev/null | grep -Fxq "$AVD"; then
  echo "AVD '$AVD' not found."
  echo "Available:"
  "$EMULATOR_BIN" -list-avds 2>/dev/null | sed 's/^/  /' || true
  echo ""
  echo "Create one: avdmanager create avd -n giop_light -k \"system-images;android-34;google_apis;x86_64\" -d medium_phone"
  exit 1
fi

# Kill any stuck instance of this AVD before starting fresh.
if pgrep -f "qemu-system.*${AVD}" >/dev/null 2>&1; then
  echo "Stopping existing $AVD process..."
  pkill -f "qemu-system.*${AVD}" || true
  sleep 2
fi

echo "Starting emulator: $AVD (first cold boot may take 2–3 min)"
# xcb avoids Wayland plugin warnings on Kali/X11.
export QT_QPA_PLATFORM="${QT_QPA_PLATFORM:-xcb}"

EMU_EXTRA=()
if [ -r /dev/kvm ] && groups | grep -qw kvm; then
  echo "KVM available — using hardware acceleration (-accel on -gpu auto)"
  EMU_EXTRA=(-accel on -gpu auto)
else
  echo "No KVM — using software CPU/GPU (slower; close other apps)"
  EMU_EXTRA=(-accel off -gpu swiftshader_indirect)
fi

"$EMULATOR_BIN" \
  -avd "$AVD" \
  "${EMU_EXTRA[@]}" \
  -no-snapshot-load \
  -no-snapshot-save \
  -no-audio \
  -no-boot-anim \
  -cores 2 \
  -memory 1536 \
  &
EMU_PID=$!

echo "Waiting for boot (do not run flutter until this finishes)..."
for i in $(seq 1 120); do
  if adb wait-for-device 2>/dev/null; then
    booted=$(adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')
    if [ "$booted" = "1" ]; then
      echo "Boot complete (${i} checks)."
      break
    fi
  fi
  if [ "$i" -eq 120 ]; then
    echo "Timed out waiting for boot. Try: $0 $AVD wipe"
    exit 1
  fi
  sleep 2
done

# Roman Ridge, Accra — grid data area
adb emu geo fix -0.187 5.6037 2>/dev/null || true
echo ""
echo "Emulator ready. GPS set to Accra (5.6037, -0.187)."
echo "Run app: cd mobile && flutter run"
echo "In app: Settings → Android emulator preset → Save"
echo ""
echo "If the UI freezes or shows 'isn't responding':"
echo "  1. Close emulator, run: $0 $AVD"
echo "  2. Still stuck: $EMULATOR_BIN -avd $AVD -wipe-data"
echo "  3. Prefer giop_light over giop_pixel on low-RAM machines"

if [ "${2:-}" = "wipe" ]; then
  echo "(wipe flag is only for manual: emulator -avd $AVD -wipe-data)"
fi

wait "$EMU_PID" 2>/dev/null || true
