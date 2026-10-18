#!/usr/bin/env bash
# Rebuilds public/vendor/cm/ (the Files view's CodeMirror editor) from bin/editor/entry.js with the versions pinned in
# bin/editor/package.json. The packages install into a temp dir, so the app's own node_modules never carry them.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"; out="$here/../../public/vendor/cm"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
cp "$here/package.json" "$here/entry.js" "$tmp/"
(cd "$tmp" && npm install --silent --no-audit --no-fund)
rm -rf "$out"; mkdir -p "$out"
(cd "$tmp" && npx esbuild entry.js --bundle --splitting --format=esm --minify --target=es2020,safari15 \
  --outdir="$out" --entry-names=editor --chunk-names='[name]-[hash]' --legal-comments=none --log-level=warning)
ls -la "$out" | tail -n +2
