#!/usr/bin/env bash
set -Eeuo pipefail

PROJECT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
exec node "$PROJECT_DIR/scripts/test-pi-fork.mjs" "$@"
