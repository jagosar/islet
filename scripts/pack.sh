#!/usr/bin/env bash
# Builds the installable extension zip from dist/ (run `npm run build` first; `npm run pack`
# does both). GSettings schemas in schemas/ are copied and compiled into the package when
# there are any.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
uuid="$(node -p "JSON.parse(require('fs').readFileSync('$root/dist/metadata.json', 'utf8')).uuid")"
out="$root/$uuid.zip"

shopt -s nullglob
schemas=("$root"/schemas/*.gschema.xml)
if [ ${#schemas[@]} -gt 0 ]; then
    mkdir -p "$root/dist/schemas"
    cp "${schemas[@]}" "$root/dist/schemas/"
    glib-compile-schemas --strict "$root/dist/schemas"
fi

rm -f "$out"
# dev/ holds development-only tools (see src/dev/) and never ships.
(cd "$root/dist" && zip -qr "$out" . -x 'dev/*')
echo "$out"
