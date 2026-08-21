#!/usr/bin/env bash
# Stable Bash adapter for RB Ralph and other shell consumers.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="${1:-.}"

exec node "$SCRIPT_DIR/rb-harness.cjs" tree resolve "$PROJECT_ROOT" \
  --kind execution-plan \
  --status ready \
  --format tsv
