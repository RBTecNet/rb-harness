#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLI="$ROOT/plugins/rb-harness/scripts/rb-harness.cjs"
FIXTURE="$ROOT/tests/fixtures/execution/valid/minimal/PHASES.md"
TEMP_ROOT="$(mktemp -d)"
PROJECT="$TEMP_ROOT/project"

mkdir -p "$PROJECT"
node "$CLI" project init "$PROJECT" --name "Bash Compatibility" --id bash-compat >/dev/null
cp "$FIXTURE" "$PROJECT/.rb/init/PHASES.md"
node "$CLI" manifest sync "$PROJECT" >/dev/null

OUTPUT="$TEMP_ROOT/resolved.tsv"
"$ROOT/plugins/rb-harness/scripts/rb-resolve.sh" "$PROJECT" > "$OUTPUT"

grep -Fxq '# rb-artifacts-index: rb-manifest/v1' "$OUTPUT"

found=0
while IFS=$'\t' read -r id kind status contract path sha256; do
  case "$id" in
    \#*|id) continue ;;
  esac
  if [ "$id" = "init-minimal-execution" ]; then
    [ "$kind" = "execution-plan" ]
    [ "$status" = "ready" ]
    [ "$contract" = "rb-execution/v1" ]
    [ "$path" = ".rb/init/PHASES.md" ]
    [ "${#sha256}" -eq 64 ]
    found=1
  fi
done < "$OUTPUT"

[ "$found" -eq 1 ]
echo "OK: Bash resolved the ready execution plan from the RB artifact tree."
