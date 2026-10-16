#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-2.0-or-later
# Runs the built extension in a nested GNOME Shell (mutter-devkit window).
#
# The nested Shell gets its own XDG config, data, cache and state directories and its own D-Bus
# session, so enabling the extension here never changes the real session.
#
# The sandbox lives in the runtime directory, not in the repository: services in the nested
# session (IBus, for one) create Unix sockets under XDG_CACHE_HOME, and a socket path longer
# than 108 bytes cannot be bound, so a deep checkout path makes them crash.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
uuid="$(node -p "JSON.parse(require('fs').readFileSync('$root/dist/metadata.json', 'utf8')).uuid")"
sandbox="${XDG_RUNTIME_DIR:-/tmp}/islet-devkit"

mkdir -p "$sandbox/config" "$sandbox/cache" "$sandbox/state" "$sandbox/data/gnome-shell/extensions"
extension_dir="$sandbox/data/gnome-shell/extensions/$uuid"
mode="${1:-}"
[ "$mode" = "--installed" ] || rm -rf "$extension_dir"

# By default the sandbox links to dist/ for quick iteration. With --zip, the packed extension
# is installed instead, exactly as a user would install a release. With --installed, nothing is
# touched: the Shell starts with whatever an installer put in the sandbox, like after a login.
if [ "$mode" = "--installed" ]; then
    :
elif [ "$mode" = "--zip" ]; then
    zip="$("$root/scripts/pack.sh")"
    # Without the real session's bus address, so the install cannot touch the real Shell.
    # gnome-extensions extracts into XDG_CACHE_HOME and then moves the folder, which fails
    # across filesystems, so the cache must be in the sandbox too.
    env -u DBUS_SESSION_BUS_ADDRESS XDG_DATA_HOME="$sandbox/data" XDG_CACHE_HOME="$sandbox/cache" \
        gnome-extensions install --force "$zip"
else
    ln -s "$root/dist" "$extension_dir"
fi

export XDG_CONFIG_HOME="$sandbox/config"
export XDG_DATA_HOME="$sandbox/data"
export XDG_CACHE_HOME="$sandbox/cache"
export XDG_STATE_HOME="$sandbox/state"

# The bus address is saved for scripts/dev-hook.sh, which sends Claude Code hook events here.
# The script is single-quoted on purpose: $1, $2 and $3 belong to the inner shell.
# shellcheck disable=SC2016
exec dbus-run-session -- bash -c '
    if [ "$3" != "--installed" ]; then
        gsettings set org.gnome.shell disable-user-extensions false
        gsettings set org.gnome.shell enabled-extensions "[\"$1\"]"
    fi
    # Animations only advance while the nested window is being painted; tests that need
    # deterministic widths turn them off (this is also what "reduce animation" does).
    if [ -n "${ISLET_NESTED_NO_ANIMATIONS:-}" ]; then
        gsettings set org.gnome.desktop.interface enable-animations false
    fi
    echo "$DBUS_SESSION_BUS_ADDRESS" > "$2/bus-address"
    ISLET_DEV_DEBUG=1 exec gnome-shell --devkit --wayland
' nested "$uuid" "$sandbox" "$mode"
