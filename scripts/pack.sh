#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-2.0-or-later
# Builds the installable extension zip from dist/ (run `npm run build` first; `npm run pack`
# does both). The build already compiled the GSettings schemas into dist/schemas.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
uuid="$(node -p "JSON.parse(require('fs').readFileSync('$root/dist/metadata.json', 'utf8')).uuid")"
out="$root/$uuid.zip"

# The package is built from a copy of dist/ without the development-only code: the dev/ folder
# (see src/dev/) and the regions marked DEV-ONLY in the sources (test hooks switched on by
# environment variables), which scripts/strip-dev.mjs removes.
stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT
cp -r "$root/dist/." "$stage/"
rm -rf "${stage:?}/dev"
find "$stage" -name '*.js' -print0 | xargs -0 node "$root/scripts/strip-dev.mjs"

rm -f "$out"
(cd "$stage" && zip -qr "$out" .)
echo "$out"
