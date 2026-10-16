#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-2.0-or-later
#
# Builds the release archive islet-VERSION.tar.gz: the extension zip, install.sh, uninstall.sh,
# README.md and LICENSE in an islet-VERSION/ folder. Run `npm run release`.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
version="$(node -p "require('$root/package.json').version")"
zip="$("$root/scripts/pack.sh")"
name="islet-$version"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

mkdir "$work/$name"
cp "$zip" "$root/packaging/install.sh" "$root/packaging/uninstall.sh" "$root/LICENSE" "$root/CHANGELOG.md" "$work/$name/"
# The README in the archive is the install guide; its images live in the repository.
cp "$root/README.md" "$work/$name/README.md"
chmod +x "$work/$name/install.sh" "$work/$name/uninstall.sh"
tar -C "$work" -czf "$root/$name.tar.gz" "$name"
echo "$root/$name.tar.gz"
