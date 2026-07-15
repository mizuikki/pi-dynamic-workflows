#!/usr/bin/env bash
set -Eeuo pipefail

PROJECT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
PI_FORK_DIR=${PI_FORK_DIR:-"$PROJECT_DIR/../pi"}
PI_FORK_REF=${PI_FORK_REF:-4a4a2ab3}
KEEP_TEMP=${KEEP_TEMP:-0}
TEMP_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/pi-dynamic-workflows-fork.XXXXXX")

cleanup() {
  local status=$?
  if [[ "$KEEP_TEMP" == "1" && "$status" != "0" ]]; then
    printf 'fork verification failed; temporary directory retained at %s\n' "$TEMP_ROOT" >&2
  else
    rm -rf "$TEMP_ROOT"
  fi
  exit "$status"
}
trap cleanup EXIT

if [[ ! -d "$PI_FORK_DIR/.git" ]]; then
  printf 'PI_FORK_DIR is not a git checkout: %s\n' "$PI_FORK_DIR" >&2
  exit 2
fi

FORK_DIR="$TEMP_ROOT/pi-fork"
TARBALL_DIR="$TEMP_ROOT/tarballs"
PROJECT_COPY="$TEMP_ROOT/project"
mkdir -p "$FORK_DIR" "$TARBALL_DIR" "$PROJECT_COPY"

git -C "$PI_FORK_DIR" archive --format=tar "$PI_FORK_REF" | tar -xf - -C "$FORK_DIR"
FORK_COMMIT=$(git -C "$PI_FORK_DIR" rev-parse "$PI_FORK_REF^{commit}")
printf 'Pi fork commit: %s\n' "$FORK_COMMIT"
if [[ "$FORK_COMMIT" != 4a4a2ab3630a0a6f65ad655e07d6f3babe4e07f5* ]]; then
  printf 'unexpected fork commit for the fixed contract: %s\n' "$FORK_COMMIT" >&2
  exit 2
fi

printf '%s\n' 'Installing Pi fork dependencies in the isolated checkout.'
npm ci --ignore-scripts --prefix "$FORK_DIR"
for workspace in tui ai agent coding-agent; do
  npm run build --prefix "$FORK_DIR/packages/$workspace"
done
for workspace in tui ai agent coding-agent; do
  (cd "$FORK_DIR/packages/$workspace" && npm pack --ignore-scripts --pack-destination "$TARBALL_DIR" >/dev/null)
done

for tarball in "$TARBALL_DIR"/*.tgz; do
  printf 'tarball sha256: %s  %s\n' "$(sha256sum "$tarball" | cut -d' ' -f1)" "$(basename "$tarball")"
done

tar \
  --exclude='./node_modules' \
  --exclude='./dist' \
  --exclude='./.git' \
  --exclude='./.worktrees' \
  -C "$PROJECT_DIR" -cf - . | tar -xf - -C "$PROJECT_COPY"

printf '%s\n' 'Installing the project and explicitly replacing its four Pi packages with fork tarballs.'
npm ci --ignore-scripts --prefix "$PROJECT_COPY"
npm install --ignore-scripts --no-save --prefix "$PROJECT_COPY" "$TARBALL_DIR"/*.tgz

(
cd "$PROJECT_COPY"
PROJECT_DIR="$PROJECT_COPY" node --input-type=module -e '
const packages = ["@earendil-works/pi-ai", "@earendil-works/pi-agent-core", "@earendil-works/pi-coding-agent", "@earendil-works/pi-tui"];
for (const specifier of packages) {
  const resolved = await import.meta.resolve(specifier);
  console.log(`resolved ${specifier}: ${resolved}`);
  if (!resolved.startsWith(`file://${process.env.PROJECT_DIR}/`)) throw new Error(`module resolved outside isolated project: ${specifier}`);
}
const { AuthStorage, ModelRegistry } = await import("@earendil-works/pi-coding-agent");
const registry = ModelRegistry.inMemory(AuthStorage.inMemory());
if (typeof registry.getExplicitModelsSource !== "function") throw new Error("fork explicit Models API missing");
if (typeof registry.getAvailableSync !== "function") throw new Error("fork sync availability API missing");
const available = registry.getAvailable();
if (!available || typeof available.then !== "function") throw new Error("fork getAvailable() is not async");
await available;
console.log("capability probe: explicit Models, getAvailableSync, and async getAvailable confirmed");
'
)

npm run check --prefix "$PROJECT_COPY"
npm run build --prefix "$PROJECT_COPY"
npm run test:unit --prefix "$PROJECT_COPY"
printf '%s\n' 'Pi fork contract passed.'
