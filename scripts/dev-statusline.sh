#!/usr/bin/env bash
# Development only: runs the status line bridge against the nested Shell's D-Bus session (see
# nested.sh), passing its arguments through. Used by dev/hook-playground.

root="$(cd "$(dirname "$0")/.." && pwd)"
address_file="${XDG_RUNTIME_DIR:-/tmp}/islet-devkit/bus-address"
address="$(cat "$address_file" 2>/dev/null || echo unix:path=/nonexistent)"

DBUS_SESSION_BUS_ADDRESS="$address" exec gjs -m "$root/dist/bridge/statusline.js" "$@"
