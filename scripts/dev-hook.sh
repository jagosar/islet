#!/usr/bin/env bash
# Development only: runs the hook bridge against the nested Shell's D-Bus session (written by
# nested.sh), so Claude Code sessions can be tested without enabling Islet in the real session.
# Like the bridge itself, it always exits 0.

root="$(cd "$(dirname "$0")/.." && pwd)"
address_file="${XDG_RUNTIME_DIR:-/tmp}/islet-devkit/bus-address"

if [ -r "$address_file" ]; then
    DBUS_SESSION_BUS_ADDRESS="$(cat "$address_file")" gjs -m "$root/dist/bridge/hook.js"
fi
exit 0
