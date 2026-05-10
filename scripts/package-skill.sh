#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="${1:-"$ROOT/dist/workflow.zip"}"

mkdir -p "$(dirname "$OUT")"
rm -f "$OUT"

cd "$ROOT"

MANIFEST="$(mktemp)"
FILTERED_MANIFEST="$(mktemp)"
trap 'rm -f "$MANIFEST" "$FILTERED_MANIFEST"' EXIT

git ls-files > "$MANIFEST"
awk '
  /^dist\// { next }
  /^\.workflows\// { next }
  /^\.claude\// { next }
  /^tmp\// { next }
  /(^|\/)\.DS_Store$/ { next }
  /\.log$/ { next }
  { print }
' "$MANIFEST" > "$FILTERED_MANIFEST"

zip -q "$OUT" -@ < "$FILTERED_MANIFEST"

echo "OK: wrote $OUT ($(du -h "$OUT" | cut -f1))"
