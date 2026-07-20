#!/usr/bin/env bash
set -Eeuo pipefail

PROJECT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
TEMP_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/pi-dynamic-workflows-package.XXXXXX")
trap 'rm -rf "$TEMP_ROOT"' EXIT

rm -rf "$PROJECT_DIR/dist"
npm run build --prefix "$PROJECT_DIR"
npm pack --ignore-scripts --pack-destination "$TEMP_ROOT" --prefix "$PROJECT_DIR" >/dev/null
TARBALL=$(find "$TEMP_ROOT" -maxdepth 1 -name '*.tgz' -print -quit)
SMOKE_DIR="$TEMP_ROOT/consumer"
mkdir -p "$SMOKE_DIR"

PACK_INSPECT_DIR="$TEMP_ROOT/inspect"
mkdir -p "$PACK_INSPECT_DIR"
tar -xzf "$TARBALL" -C "$PACK_INSPECT_DIR"
TARBALL_ENTRIES=$(tar -tzf "$TARBALL")
if grep -Eq '(^|/)(home|tmp)/' <<<"$TARBALL_ENTRIES"; then
  printf '%s\n' 'package tarball contains an absolute path entry' >&2
  exit 1
fi
if grep -Eq 'file:\.\./pi' "$PACK_INSPECT_DIR/package/package.json"; then
  printf '%s\n' 'package tarball references a sibling Pi path via a file: specifier' >&2
  exit 1
fi

npm init -y --prefix "$SMOKE_DIR" >/dev/null
npm install --ignore-scripts --prefix "$SMOKE_DIR" \
  "$TARBALL" \
  "@earendil-works/pi-ai@0.80.10" \
  "@earendil-works/pi-coding-agent@0.80.10" \
  "@earendil-works/pi-tui@0.80.10" \
  "typebox" \
  "typescript" >/dev/null

(
  cd "$SMOKE_DIR"
  node --input-type=module -e '
    const pkg = await import("@quintinshaw/pi-dynamic-workflows");
    if (typeof pkg.runWorkflow !== "function" || typeof pkg.WorkflowManager !== "function") throw new Error("public ESM import is incomplete");
    const resolved = await import.meta.resolve("@quintinshaw/pi-dynamic-workflows");
    if (!resolved.startsWith(`file://${process.cwd()}/node_modules/`)) throw new Error(`unexpected package path: ${resolved}`);
    console.log(`package import: ${resolved}`);
  '
  cp "$PROJECT_DIR/tests/fixtures/package-consumer.ts" "$SMOKE_DIR/consumer.ts"
  npx tsc --noEmit --skipLibCheck --target ES2022 --module NodeNext --moduleResolution NodeNext consumer.ts
)

printf '%s\n' 'Package smoke passed.'
