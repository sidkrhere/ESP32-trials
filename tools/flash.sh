#!/usr/bin/env bash
#
# Compile and flash the firmware to the ESP32-C3 Super Mini.
#
#   ./tools/flash.sh              # compile + upload
#   ./tools/flash.sh mpu_diag     # upload the diagnostic sweep sketch
#   ESP32_PORT=/dev/cu.usbmodemX ./tools/flash.sh
#
set -euo pipefail

SKETCH="${1:-3d_box}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SKETCH_DIR="$ROOT/firmware/$SKETCH"

if [ ! -d "$SKETCH_DIR" ]; then
  echo "no such sketch: $SKETCH_DIR" >&2
  exit 1
fi

# --- locate arduino-cli -------------------------------------------------
if command -v arduino-cli >/dev/null 2>&1; then
  CLI="$(command -v arduino-cli)"
elif [ -x "/Applications/Arduino IDE.app/Contents/Resources/app/lib/backend/resources/arduino-cli" ]; then
  CLI="/Applications/Arduino IDE.app/Contents/Resources/app/lib/backend/resources/arduino-cli"
else
  echo "arduino-cli not found. Install it with:  brew install arduino-cli" >&2
  exit 1
fi

# the IDE keeps its own package/config in ~/.arduinoIDE
CONFIG="$HOME/.arduinoIDE/arduino-cli.yaml"
CONFIG_ARG=()
[ -f "$CONFIG" ] && CONFIG_ARG=(--config-file "$CONFIG")

# --- locate the board ---------------------------------------------------
PORT_PATH="${ESP32_PORT:-}"
if [ -z "$PORT_PATH" ]; then
  for candidate in /dev/cu.usbmodem* /dev/tty.usbmodem*; do
    if [ -e "$candidate" ]; then PORT_PATH="$candidate"; break; fi
  done
fi
if [ -z "$PORT_PATH" ]; then
  echo "no ESP32 found on /dev/cu.usbmodem* - plug it in" >&2
  exit 1
fi

FQBN="esp32:esp32:esp32c3:CDCOnBoot=cdc,UploadSpeed=921600,FlashSize=4M,FlashMode=qio"

echo "==> compiling $SKETCH"
"$CLI" "${CONFIG_ARG[@]}" compile --fqbn "$FQBN" "$SKETCH_DIR"

echo "==> uploading to $PORT_PATH"
"$CLI" "${CONFIG_ARG[@]}" upload --fqbn "$FQBN" -p "$PORT_PATH" "$SKETCH_DIR"

echo
echo "done. close the Arduino IDE Serial Monitor before running: npm start"
