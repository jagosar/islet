#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-2.0-or-later
# Development only: runs the hook bridge against the nested Shell's D-Bus session (written by
# nested.sh), so Claude Code sessions can be tested without enabling Islet in the real session.
# Like the bridge itself, it always exits 0.
#
# Each run appends a diagnostic line to dev-hook.log next to the bus address (or in /tmp when
# XDG_RUNTIME_DIR is unset): which environment it ran in and any bridge error. No event content.

root="$(cd "$(dirname "$0")/.." && pwd)"
devkit="${XDG_RUNTIME_DIR:-/tmp}/islet-devkit"
address_file="$devkit/bus-address"
log_file="$devkit/dev-hook.log"
[ -d "$devkit" ] || log_file="/tmp/islet-dev-hook.log"

status="no-address-file"
error=""
if [ -r "$address_file" ]; then
    error="$(DBUS_SESSION_BUS_ADDRESS="$(cat "$address_file")" ISLET_HOOK_DEBUG=1 gjs -m "$root/dist/bridge/hook.js" 2>&1 >/dev/null)"
    status="ran"
fi

printf '%s entrypoint=%s xdg_runtime_dir=%s gjs=%s status=%s error=%s\n' \
    "$(date --iso-8601=seconds)" "${CLAUDE_CODE_ENTRYPOINT:--}" "${XDG_RUNTIME_DIR:-unset}" \
    "$(command -v gjs || echo missing)" "$status" "${error:-none}" >> "$log_file" 2>/dev/null
exit 0
