#!/bin/sh
# Builds the Chrome Web Store upload: only the files the extension needs at runtime,
# with manifest.json at the top of the zip.
set -e
cd "$(dirname "$0")/.."
VERSION=$(node -p "require('./manifest.json').version")
OUT="dist/just-filed-$VERSION"
rm -rf "$OUT" "$OUT.zip"
mkdir -p "$OUT"
cp -R manifest.json background.js LICENSE PRIVACY.md src popup ai fonts icons "$OUT"/
(cd "$OUT" && zip -qr -X "../just-filed-$VERSION.zip" .)
echo "Built $OUT.zip ($(du -h "$OUT.zip" | cut -f1))"
