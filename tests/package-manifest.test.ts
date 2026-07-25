import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const packageJson = JSON.parse(readFileSync(join(repositoryRoot, "package.json"), "utf8")) as {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  private?: boolean;
};

test("package metadata keeps Pi SDK packages host-provided and sibling-only", () => {
  assert.equal(packageJson.private, true);
  const packages = {
    "@earendil-works/pi-ai": "ai",
    "@earendil-works/pi-coding-agent": "coding-agent",
    "@earendil-works/pi-tui": "tui",
  };
  for (const [name, workspace] of Object.entries(packages)) {
    assert.equal(packageJson.peerDependencies?.[name], "*");
    assert.equal(packageJson.devDependencies?.[name], `file:../pi/packages/${workspace}`);
    assert.equal(packageJson.dependencies?.[name], undefined);
  }
});
