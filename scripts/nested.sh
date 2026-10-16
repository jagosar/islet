#!/usr/bin/env bash
# Runs the built extension in a nested GNOME Shell (mutter-devkit window).
#
# The nested Shell gets its own XDG config, data, cache and state directories under .devkit/
# and its own D-Bus session, so enabling the extension here never changes the real session.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
uuid="$(node -p "JSON.parse(require('fs').readFileSync('$root/dist/metadata.json', 'utf8')).uuid")"
sandbox="$root/.devkit"

mkdir -p "$sandbox/config" "$sandbox/cache" "$sandbox/state" "$sandbox/data/gnome-shell/extensions"
ln -sfn "$root/dist" "$sandbox/data/gnome-shell/extensions/$uuid"

export XDG_CONFIG_HOME="$sandbox/config"
export XDG_DATA_HOME="$sandbox/data"
export XDG_CACHE_HOME="$sandbox/cache"
export XDG_STATE_HOME="$sandbox/state"

exec dbus-run-session -- bash -c '
    gsettings set org.gnome.shell disable-user-extensions false
    gsettings set org.gnome.shell enabled-extensions "[\"$1\"]"
    exec gnome-shell --devkit --wayland
' nested "$uuid"
