#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-2.0-or-later
#
# Removes Islet completely for the current user: disconnects Claude Code (restoring
# settings.json), disables and uninstalls the extension, and deletes Islet's saved state.
set -uo pipefail

UUID=islet@jagosar.github.io
data_home="${XDG_DATA_HOME:-$HOME/.local/share}"
state_home="${XDG_STATE_HOME:-$HOME/.local/state}"
extension_dir="$data_home/gnome-shell/extensions/$UUID"

say() { printf '%s\n' "$*"; }

# 1. Claude Code first, while the tool is still installed.
if [ -f "$extension_dir/tools/claudeConnection.js" ] && command -v gjs >/dev/null; then
    if ! gjs -m "$extension_dir/tools/claudeConnection.js" disconnect; then
        say "Islet could not disconnect Claude Code (see above); its hooks stay harmless without Islet."
    fi
fi

# 2. Disable: stops the capsule and its background process right away.
gnome-extensions disable "$UUID" 2>/dev/null || true
enabled="$(gsettings get org.gnome.shell enabled-extensions 2>/dev/null || echo '[]')"
case "$enabled" in
    *"'$UUID'"*)
        cleaned="$(printf '%s' "$enabled" | sed -E "s/'$UUID'(, )?//; s/, \]/]/")"
        gsettings set org.gnome.shell enabled-extensions "$cleaned"
        ;;
esac

# 3. Uninstall.
gnome-extensions uninstall "$UUID" 2>/dev/null || rm -rf "$extension_dir"

# 4. Saved state (focus history and the last plan figures).
rm -rf "$state_home/islet"

say "Islet is removed."
