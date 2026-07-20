#!/usr/bin/env bash
set -Eeuo pipefail

PROJECT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
PI_FORK_DIR=${PI_FORK_DIR:-"$PROJECT_DIR/../pi"}
# Prefer a tag/branch that provides ModelRuntime (Pi >= 0.80.8). Default: v0.80.10.
PI_FORK_REF=${PI_FORK_REF:-v0.80.10}
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
printf 'Pi fork commit: %s (%s)\n' "$FORK_COMMIT" "$PI_FORK_REF"

printf '%s\n' 'Installing Pi fork dependencies in the isolated checkout.'
npm ci --ignore-scripts --prefix "$FORK_DIR"
npm run build --prefix "$FORK_DIR/packages/tui"
# Compile the tagged AI catalog snapshot without regenerating it from mutable
# network catalogs; the contract test must exercise the archived source exactly.
"$FORK_DIR/node_modules/.bin/tsgo" -p "$FORK_DIR/packages/ai/tsconfig.build.json"
npm run build --prefix "$FORK_DIR/packages/agent"
npm run build --prefix "$FORK_DIR/packages/coding-agent"
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

const codingAgent = await import("@earendil-works/pi-coding-agent");
const { ModelRuntime, ModelRegistry, createAgentSession } = codingAgent;

if (typeof ModelRuntime?.create !== "function") throw new Error("ModelRuntime.create missing");
if (typeof ModelRegistry !== "function") throw new Error("ModelRegistry facade missing");
if (typeof createAgentSession !== "function") throw new Error("createAgentSession missing");

// Legacy APIs removed in the ModelRuntime migration must stay gone.
if (typeof ModelRegistry.create === "function") throw new Error("legacy ModelRegistry.create must not exist");
if (typeof ModelRegistry.inMemory === "function") throw new Error("legacy ModelRegistry.inMemory must not exist");
if ("AuthStorage" in codingAgent) throw new Error("legacy AuthStorage export must not exist");

const runtime = await ModelRuntime.create({ modelsPath: null, allowModelNetwork: false });
if (typeof runtime.registerProvider !== "function") throw new Error("ModelRuntime.registerProvider missing");
if (typeof runtime.getModels !== "function") throw new Error("ModelRuntime.getModels missing");
if (typeof runtime.getAvailable !== "function") throw new Error("ModelRuntime.getAvailable missing");

const registry = new ModelRegistry(runtime);
if (typeof registry.getAvailable !== "function") throw new Error("ModelRegistry.getAvailable missing");
if (typeof registry.getAvailableSync === "function") throw new Error("legacy getAvailableSync must not exist");
if (typeof registry.getExplicitModelsSource === "function") throw new Error("legacy getExplicitModelsSource must not exist");

// createAgentSession accepts modelRuntime (legacy modelRegistry/models options are gone).
const { session } = await createAgentSession({
  modelRuntime: runtime,
  cwd: process.cwd(),
});
session.dispose();

console.log("capability probe: ModelRuntime.create/registerProvider, ModelRegistry facade, no legacy APIs confirmed");
'
)

npm run check --prefix "$PROJECT_COPY"
npm run build --prefix "$PROJECT_COPY"
npm run test:unit --prefix "$PROJECT_COPY"
printf '%s\n' 'Pi ModelRuntime contract passed.'
