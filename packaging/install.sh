#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-2.0-or-later
#
# Installs Islet for the current user. No root needed. Run it from the unpacked release folder:
#
#   ./install.sh            asks whether to connect Claude Code
#   ./install.sh --yes      connects Claude Code without asking
#   ./install.sh --no       does not connect Claude Code
set -euo pipefail

UUID=islet@jagosar.github.io
here="$(cd "$(dirname "$0")" && pwd)"
data_home="${XDG_DATA_HOME:-$HOME/.local/share}"
extension_dir="$data_home/gnome-shell/extensions/$UUID"

say() { printf '%s\n' "$*"; }
fail() { printf 'Islet: %s\n' "$*" >&2; exit 1; }

connect=ask
case "${1:-}" in
    --yes) connect=yes ;;
    --no) connect=no ;;
    '') ;;
    *) fail "unknown option $1 (use --yes or --no)" ;;
esac

# Requirements.
command -v gnome-extensions >/dev/null || fail "gnome-extensions was not found. Islet needs GNOME Shell."
command -v gjs >/dev/null || fail "gjs was not found. Install it with: sudo apt install gjs"
shell_version="$(gnome-shell --version 2>/dev/null | grep -oE '[0-9]+' | head -n 1 || true)"
if [ "$shell_version" != "50" ]; then
    say "Warning: Islet is built and tested for GNOME Shell 50; this is GNOME Shell ${shell_version:-unknown}."
    say "GNOME will not load it on other versions."
fi
[ -f "$here/$UUID.zip" ] || fail "$UUID.zip is missing next to install.sh."

# Install, replacing any previous version.
gnome-extensions install --force "$here/$UUID.zip"
say "Installed Islet in $extension_dir"

# Enable it. GNOME Shell on Wayland only loads new extensions at login, so if the running Shell
# does not know Islet yet, add it to the enabled list directly; it starts at the next login.
if ! gnome-extensions enable "$UUID" 2>/dev/null; then
    enabled="$(gsettings get org.gnome.shell enabled-extensions)"
    case "$enabled" in
        *"'$UUID'"*) ;;
        "@as []"|"[]") gsettings set org.gnome.shell enabled-extensions "['$UUID']" ;;
        *) gsettings set org.gnome.shell enabled-extensions "${enabled%]}, '$UUID']" ;;
    esac
fi
gsettings set org.gnome.shell disable-user-extensions false
say "Enabled Islet."

# Claude Code: usage works without this; connecting adds live alerts and plan usage.
if [ "$connect" = ask ] && [ -t 0 ]; then
    say ""
    say "Connect Claude Code? Islet would add hooks (live agent alerts) and a status line"
    say "(plan usage) to ~/.claude/settings.json. Everything else in the file is kept, a backup"
    say "is saved, and ./uninstall.sh or Preferences > Disconnect undo it exactly."
    read -r -p "Connect Claude Code now? [y/N] " answer
    case "$answer" in [yY]*) connect=yes ;; *) connect=no ;; esac
fi
tool="$extension_dir/tools/claudeConnection.js"
if gjs -m "$tool" status 2>/dev/null | grep -q 'needs repair'; then
    # An earlier version connected Claude Code and the connection is out of date (its commands
    # changed, or Islet moved). Those entries are Islet's own and were agreed to before: update them.
    gjs -m "$tool" repair
    say "Restart any running Claude Code sessions to pick up the update."
elif [ "$connect" = yes ]; then
    gjs -m "$tool" connect
    say "Restart any running Claude Code sessions to pick up the hooks."
else
    say "Claude Code not connected. You can connect it later in Islet's preferences."
fi

say ""
say "Done. Log out and back in to start Islet: it appears next to the clock."
say "Ctrl+Alt+Space opens it. To remove it, run ./uninstall.sh."
