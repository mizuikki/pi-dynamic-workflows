import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, normalize, resolve } from "node:path";
import { describe, it } from "node:test";
import {
  WORKFLOW_DATABASE_FILENAME,
  WORKFLOW_HOME_RELATIVE_DIR,
  WORKFLOW_PROJECTS_SUBDIR,
  workflowCanonicalProjectPath,
  workflowDatabasePath,
  workflowHomeDir,
  workflowProjectKey,
  workflowProjectPaths,
  workflowUserSavedDir,
} from "../src/workflow-paths.js";
import { withFakeHomeAsync } from "./helpers/fake-home.js";

async function withIsolatedHome(fn: (home: string, cwd: string) => Promise<void>): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), "pi-dw-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "pi-dw-project-"));
  try {
    await withFakeHomeAsync(home, async () => fn(home, cwd));
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
}

describe("workflow paths", () => {
  it("resolves workflow home under the user home", async () => {
    await withIsolatedHome(async (home) => {
      assert.equal(workflowHomeDir(), join(home, WORKFLOW_HOME_RELATIVE_DIR));
      assert.equal(workflowUserSavedDir(), join(home, WORKFLOW_HOME_RELATIVE_DIR, "saved"));
      assert.equal(workflowDatabasePath(), join(home, WORKFLOW_HOME_RELATIVE_DIR, WORKFLOW_DATABASE_FILENAME));
    });
  });

  it("creates stable project namespaces from cwd", async () => {
    await withIsolatedHome(async (_home, cwd) => {
      const key = workflowProjectKey(cwd);
      assert.equal(key, workflowProjectKey(cwd));
      assert.match(key, /^[a-z0-9._-]+-[a-f0-9]{12}$/);
      assert.ok(key.startsWith(basename(cwd).toLowerCase()));
    });
  });

  it("keeps file-backed project storage while run persistence is global", async () => {
    await withIsolatedHome(async (home, cwd) => {
      const paths = workflowProjectPaths(cwd);
      assert.ok(paths.rootDir.startsWith(join(home, WORKFLOW_HOME_RELATIVE_DIR, WORKFLOW_PROJECTS_SUBDIR)));
      assert.equal(paths.savedDir, join(paths.rootDir, "saved"));
      assert.equal(paths.settingsPath, join(paths.rootDir, "settings.json"));
      assert.equal(paths.legacySavedDir, normalize(join(cwd, ".pi/workflows/saved")));
      assert.equal(workflowCanonicalProjectPath(cwd), resolve(cwd));
    });
  });
});
