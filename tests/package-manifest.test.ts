import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const packageJson = JSON.parse(readFileSync(join(repositoryRoot, "package.json"), "utf8")) as {
  name?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  files?: string[];
  peerDependencies?: Record<string, string>;
  private?: boolean;
  scripts?: Record<string, string>;
};

test("package metadata keeps Pi SDK packages host-provided and sibling-only", () => {
  assert.equal(packageJson.name, "@mizuikki/pi-workflow-orchestrator");
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
  assert.equal(packageJson.scripts?.["test:local-install-smoke"], "node scripts/test-local-install-smoke.mjs");
  assert.equal(packageJson.scripts?.["verify:product-boundary"], "node scripts/verify-product-boundary.mjs");
  assert.ok(packageJson.files?.includes("docs/architecture.md"));
  assert.ok(packageJson.files?.includes("docs/storage.md"));
});

test("public exports match the lite orchestrator boundary", async () => {
  const exports = await import("../src/index.js");
  assert.equal(typeof exports.WorkflowManager, "function");
  assert.equal(typeof exports.runWorkflow, "function");
  assert.equal(typeof exports.registerWorkflowCommand, "function");
  assert.equal(typeof exports.createTrellisContextLoader, "function");
  assert.equal(typeof exports.createTrellisSubagentTool, "function");
  assert.equal(typeof exports.createKeelPiHostDescriptor, "function");
  for (const deleted of [
    "registerBuiltinWorkflows",
    "createWebTools",
    "generateDeepResearchWorkflow",
    "registerEffortCommand",
    "registerWorkflowModelsCommand",
  ]) {
    assert.equal(deleted in exports, false, `${deleted} must not remain public`);
  }
});
