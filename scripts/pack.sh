#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-2.0-or-later
# Builds the installable extension zip from dist/ (run `npm run build` first; `npm run pack`
# does both). The build already compiled the GSettings schemas into dist/schemas.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
uuid="$(node -p "JSON.parse(require('fs').readFileSync('$root/dist/metadata.json', 'utf8')).uuid")"
out="$root/$uuid.zip"

rm -f "$out"
# dev/ holds development-only tools (see src/dev/) and never ships.
(cd "$root/dist" && zip -qr "$out" . -x 'dev/*')
echo "$out"
