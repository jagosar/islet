#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-2.0-or-later
# Development only: talks to the nested Shell started by `npm run nested`.
#
#   scripts/dev-debug.sh state                 capsule state as JSON
#   scripts/dev-debug.sh screenshot FILE.png   screenshot of the nested Shell
#   scripts/dev-debug.sh menu                  open or close the capsule menu
#   scripts/dev-debug.sh page ID               show a page of the expanded view (claude, media, focus)
#   scripts/dev-debug.sh keys COMBO            press keys, e.g. Control_L+Alt_L+space, Right, Escape
#   scripts/dev-debug.sh click X Y             click at stage coordinates
#   scripts/dev-debug.sh call METHOD ARGS...   call a method of the Islet daemon
set -euo pipefail

address="$(cat "${XDG_RUNTIME_DIR:-/tmp}/islet-devkit/bus-address")"
debug=(gdbus call --address "$address" --dest io.github.jagosar.IsletDebug --object-path /io/github/jagosar/IsletDebug)

case "${1:-}" in
    state) "${debug[@]}" --method io.github.jagosar.IsletDebug.State | sed -E "s/^\('(.*)',\)$/\1/" ;;
    screenshot) "${debug[@]}" --method io.github.jagosar.IsletDebug.Screenshot "$(realpath -m "$2")" >/dev/null ;;
    menu) "${debug[@]}" --method io.github.jagosar.IsletDebug.ToggleMenu >/dev/null ;;
    page) "${debug[@]}" --method io.github.jagosar.IsletDebug.SelectPage "$2" >/dev/null ;;
    keys) "${debug[@]}" --method io.github.jagosar.IsletDebug.PressKeys "$2" >/dev/null ;;
    click) "${debug[@]}" --method io.github.jagosar.IsletDebug.Click "$2" "$3" >/dev/null ;;
    call)
        method="$2"; shift 2
        gdbus call --address "$address" --dest io.github.jagosar.Islet --object-path /io/github/jagosar/Islet \
            --method "io.github.jagosar.Islet1.$method" "$@" ;;
    *) sed -n '2,11p' "$0"; exit 2 ;;
esac
