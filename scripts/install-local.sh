#!/usr/bin/env bash
# Installs the packed extension for the current user. It does not enable it: on Wayland,
# GNOME Shell only picks up a new extension after you log out and back in.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
zip="$("$root/scripts/pack.sh")"
uuid="$(basename "$zip" .zip)"

gnome-extensions install --force "$zip"

cat <<EOF
Installed $uuid.

Islet is a prototype: an extension runs inside GNOME Shell, and a serious bug can end your
session. To try it anyway:
  1. Log out and back in (needed on Wayland).
  2. gnome-extensions enable $uuid
To remove it: gnome-extensions uninstall $uuid
EOF
