#!/usr/bin/env bash
set -Eeuo pipefail

PROJECT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
PI_FORK_DIR=${PI_FORK_DIR:-"$PROJECT_DIR/../pi"}
PI_FORK_REF=${PI_FORK_REF:-HEAD}
TEMP_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/pi-local-package.XXXXXX")
trap 'rm -rf "$TEMP_ROOT"' EXIT

if [[ ! -d "$PI_FORK_DIR/.git" ]]; then
  printf 'PI_FORK_DIR is not a git checkout: %s\n' "$PI_FORK_DIR" >&2
  exit 2
fi

node "$PI_FORK_DIR/scripts/pack-local-sdk.mjs" --out "$TEMP_ROOT" --ref "$PI_FORK_REF"
npm run build --prefix "$PROJECT_DIR"
npm pack --ignore-scripts --pack-destination "$TEMP_ROOT" --prefix "$PROJECT_DIR" >/dev/null
TARBALL=$(find "$TEMP_ROOT" -maxdepth 1 -name '*.tgz' -print -quit)
if [[ -z "$TARBALL" ]]; then
  printf '%s\n' 'package tarball was not created' >&2
  exit 1
fi

PACKAGE_JSON=$(tar -xOf "$TARBALL" package/package.json)
PACK_INSPECT_DIR="$TEMP_ROOT/inspect"
mkdir -p "$PACK_INSPECT_DIR"
tar -xzf "$TARBALL" -C "$PACK_INSPECT_DIR"
TARBALL_ENTRIES=$(tar -tzf "$TARBALL")
if grep -Eq '(^|/)(home|tmp)/' <<<"$TARBALL_ENTRIES"; then
  printf '%s\n' 'package tarball contains an absolute path entry' >&2
  exit 1
fi
if grep -Eq '/home/|/tmp/' "$PACK_INSPECT_DIR/package/package.json"; then
  printf '%s\n' 'package tarball references a local workspace path' >&2
  exit 1
fi
PACKAGE_JSON="$PACKAGE_JSON" node --input-type=module -e '
  const packageJson = JSON.parse(process.env.PACKAGE_JSON);
  for (const name of ["@earendil-works/pi-ai", "@earendil-works/pi-coding-agent", "@earendil-works/pi-tui"]) {
    if (packageJson.peerDependencies?.[name] !== "*") {
      throw new Error(`package tarball does not declare a host-provided Pi peer: ${name}`);
    }
    if (packageJson.dependencies?.[name] !== undefined) {
      throw new Error(`package tarball has a Pi production dependency: ${name}`);
    }
  }
  if (packageJson.private !== true) throw new Error("package tarball is not private");
'

SMOKE_DIR="$TEMP_ROOT/consumer"
mkdir -p "$SMOKE_DIR"
node "$PROJECT_DIR/scripts/create-package-smoke-consumer.mjs" \
  "$TEMP_ROOT/pi-sdk-manifest.json" "$SMOKE_DIR" "$TARBALL" >/dev/null
(
  cd "$SMOKE_DIR"
  node --input-type=module -e '
    const pkg = await import("@quintinshaw/pi-dynamic-workflows");
    if (typeof pkg.runWorkflow !== "function" || typeof pkg.WorkflowManager !== "function") throw new Error("public ESM import is incomplete");
  '
  cp "$PROJECT_DIR/tests/fixtures/package-consumer.ts" "$SMOKE_DIR/consumer.ts"
  npx tsc --noEmit --skipLibCheck --target ES2022 --module NodeNext --moduleResolution NodeNext consumer.ts
)

printf '%s\n' 'Package smoke passed.'

UPSTREAM_DIR="$TEMP_ROOT/upstream-host"
mkdir -p "$UPSTREAM_DIR"
npm install --ignore-scripts --legacy-peer-deps --prefix "$UPSTREAM_DIR" \
  "@earendil-works/pi-agent-core@0.82.1" \
  "@earendil-works/pi-ai@0.82.1" \
  "@earendil-works/pi-coding-agent@0.82.1" \
  "@earendil-works/pi-tui@0.82.1" \
  "typebox" \
  "$TARBALL" >/dev/null
cat > "$UPSTREAM_DIR/verify-upstream-host.mjs" <<'EOF'
import { discoverAndLoadExtensions } from "@earendil-works/pi-coding-agent";
const extensionPath = new URL("./node_modules/@quintinshaw/pi-dynamic-workflows/extensions/workflow.ts", import.meta.url).pathname;
const result = await discoverAndLoadExtensions([extensionPath], process.cwd(), process.env.HOME);
if (result.errors.length > 0) throw new Error(result.errors.map((entry) => entry.error).join("; "));
throw new Error("upstream host unexpectedly loaded pi-dynamic-workflows");
EOF
if HOME="$UPSTREAM_DIR/home" node "$UPSTREAM_DIR/verify-upstream-host.mjs" 2>"$UPSTREAM_DIR/upstream-error.log"; then
  printf '%s\n' 'upstream Pi host unexpectedly loaded the extension' >&2
  exit 1
fi
if ! grep -Fq 'Pi host is incompatible: requires extension SDK API version 1' "$UPSTREAM_DIR/upstream-error.log"; then
  cat "$UPSTREAM_DIR/upstream-error.log" >&2
  exit 1
fi

printf '%s\n' 'Upstream host rejection passed.'
