import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import test from "node:test";
import { workflowGlobalSavedDir, workflowProjectPaths } from "../src/workflow-paths.js";
import { createWorkflowStorage } from "../src/workflow-saved.js";
import { withFakeHomeAsync } from "./helpers/fake-home.js";

/**
 * Run tests with HOME overridden to a temp directory so the user-level
 * global saved workflows directory is isolated.
 */
function withIsolatedHome(fn: (cwd: string) => Promise<void>) {
  return async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-dw-ws-"));
    const fakeHome = mkdtempSync(join(tmpdir(), "pi-dw-home-"));
    try {
      await withFakeHomeAsync(fakeHome, () => fn(cwd));
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(fakeHome, { recursive: true, force: true });
    }
  };
}

test(
  "createWorkflowStorage save creates directory and file",
  withIsolatedHome(async (cwd) => {
    const storage = createWorkflowStorage(cwd);
    const saved = storage.save({
      name: "test-wf",
      description: "A test workflow",
      script: "export const meta = { name: 'test', description: 'test' }",
    });
    assert.equal(saved.name, "test-wf");
    assert.equal(saved.location, "project");
    assert.ok(saved.path.endsWith("test-wf.json"), "should end with test-wf.json");
    assert.ok(saved.savedAt, "should have savedAt timestamp");
    const dir = workflowProjectPaths(cwd).savedDir;
    assert.ok(existsSync(dir), "project saved dir should exist");
    assert.ok(existsSync(join(dir, "test-wf.json")), "file should exist");
    assert.equal(existsSync(join(cwd, ".pi", "workflows")), false, "old project state must not be created");
  }),
);

test(
  "createWorkflowStorage save to global location",
  withIsolatedHome(async (cwd) => {
    const storage = createWorkflowStorage(cwd);
    const saved = storage.save(
      {
        name: "global-wf",
        description: "Global workflow",
        script: "export const meta = { name: 'u', description: 'u' }",
      },
      "global",
    );
    assert.equal(saved.location, "global");
    assert.ok(
      saved.path.includes(`.pi${sep}workflow-orchestrator${sep}saved`),
      "should use the new global saved directory",
    );
  }),
);

test(
  "createWorkflowStorage load returns project workflow (takes precedence)",
  withIsolatedHome(async (cwd) => {
    const storage = createWorkflowStorage(cwd);
    storage.save({
      name: "shared",
      description: "Project version",
      script: "project script",
    });
    storage.save(
      {
        name: "shared",
        description: "Global version",
        script: "global script",
      },
      "global",
    );
    const loaded = storage.load("shared");
    assert.ok(loaded, "should load");
    assert.equal(loaded?.script, "project script", "project should take precedence");
  }),
);

test(
  "createWorkflowStorage load returns null for nonexistent workflow",
  withIsolatedHome(async (cwd) => {
    const storage = createWorkflowStorage(cwd);
    const loaded = storage.load("nonexistent");
    assert.equal(loaded, null);
  }),
);

test(
  "createWorkflowStorage supports explicit project/global lookup and all-scope listing",
  withIsolatedHome(async (cwd) => {
    const storage = createWorkflowStorage(cwd);
    storage.save({ name: "shared", description: "Project", script: "project" }, "project");
    storage.save({ name: "shared", description: "Global", script: "global" }, "global");

    assert.equal(storage.load("shared", "project")?.script, "project");
    assert.equal(storage.load("shared", "global")?.script, "global");
    assert.deepEqual(
      storage.list("all").map((workflow) => `${workflow.location}:${workflow.name}`),
      ["project:shared", "global:shared"],
    );
  }),
);

test(
  "createWorkflowStorage load returns global workflow when no project version exists",
  withIsolatedHome(async (cwd) => {
    const storage = createWorkflowStorage(cwd);
    storage.save(
      {
        name: "global-only",
        description: "Only global",
        script: "global script",
      },
      "global",
    );
    const loaded = storage.load("global-only");
    assert.ok(loaded, "should load successfully");
    assert.equal(loaded?.script, "global script");
    assert.equal(loaded?.location, "global");
  }),
);

test(
  "createWorkflowStorage never reads old project state",
  withIsolatedHome(async (cwd) => {
    const storage = createWorkflowStorage(cwd);
    const oldProjectDir = join(cwd, ".pi", "workflows", "saved");
    mkdirSync(oldProjectDir, { recursive: true });
    writeFileSync(
      join(oldProjectDir, "shared.json"),
      JSON.stringify({
        name: "shared",
        description: "Old project version",
        script: "old project script",
        location: "project",
        savedAt: "2024-01-01T00:00:00.000Z",
        path: join(oldProjectDir, "shared.json"),
      }),
      "utf-8",
    );
    storage.save(
      {
        name: "shared",
        description: "Global version",
        script: "global script",
      },
      "global",
    );

    const loaded = storage.load("shared");
    assert.equal(loaded?.script, "global script");
    assert.equal(loaded?.location, "global");
    assert.equal(readFileSync(join(oldProjectDir, "shared.json"), "utf-8").includes("old project script"), true);
  }),
);

test(
  "createWorkflowStorage never reads or deletes old global state",
  withIsolatedHome(async (cwd) => {
    const oldGlobalDir = join(workflowGlobalSavedDir(), "..", "..", "workflows", "saved");
    const oldGlobalPath = join(oldGlobalDir, "old-only.json");
    mkdirSync(oldGlobalDir, { recursive: true });
    writeFileSync(
      oldGlobalPath,
      JSON.stringify({
        name: "old-only",
        description: "Old global version",
        script: "old global script",
        location: "user",
        savedAt: "2024-01-01T00:00:00.000Z",
      }),
      "utf-8",
    );

    const storage = createWorkflowStorage(cwd);
    assert.equal(storage.load("old-only"), null);
    assert.deepEqual(storage.list(), []);
    assert.equal(storage.delete("old-only"), false);
    assert.equal(readFileSync(oldGlobalPath, "utf-8").includes("old global script"), true);
  }),
);

test(
  "createWorkflowStorage list combines project and global workflows sorted by name",
  withIsolatedHome(async (cwd) => {
    const storage = createWorkflowStorage(cwd);
    storage.save({ name: "b-project", description: "b", script: "b" });
    storage.save({ name: "a-project", description: "a", script: "a" });
    storage.save({ name: "c-global", description: "c", script: "c" }, "global");

    const list = storage.list();
    assert.equal(list.length, 3);
    assert.equal(list[0].name, "a-project");
    assert.equal(list[1].name, "b-project");
    assert.equal(list[2].name, "c-global");
  }),
);

test(
  "createWorkflowStorage list returns empty array when no workflows saved",
  withIsolatedHome(async (cwd) => {
    const storage = createWorkflowStorage(cwd);
    const list = storage.list();
    assert.deepEqual(list, []);
  }),
);

test(
  "createWorkflowStorage delete removes project workflow",
  withIsolatedHome(async (cwd) => {
    const storage = createWorkflowStorage(cwd);
    storage.save({ name: "to-delete", description: "d", script: "d" });
    assert.ok(storage.load("to-delete"), "load() should succeed");
    const deleted = storage.delete("to-delete");
    assert.equal(deleted, true);
    assert.equal(storage.load("to-delete"), null);
  }),
);

test(
  "createWorkflowStorage delete removes a backup-only workflow",
  withIsolatedHome(async (cwd) => {
    const storage = createWorkflowStorage(cwd);
    storage.save({ name: "backup-only", description: "d", script: "d" });
    const path = join(workflowProjectPaths(cwd).savedDir, "backup-only.json");
    unlinkSync(path);

    assert.ok(storage.load("backup-only"), "the backup remains loadable");
    assert.equal(storage.delete("backup-only"), true);
    assert.equal(storage.load("backup-only"), null);
  }),
);

test(
  "createWorkflowStorage keeps the primary when backup deletion fails",
  withIsolatedHome(async (cwd) => {
    const good = createWorkflowStorage(cwd);
    good.save({ name: "delete-failure", description: "d", script: "d" });
    const failing = createWorkflowStorage(cwd, {
      unlinkSync: (path) => {
        if (String(path).endsWith(".bak")) throw new Error("simulated backup unlink failure");
        unlinkSync(path);
      },
    });

    assert.throws(() => failing.delete("delete-failure"), /simulated backup unlink failure/);
    assert.ok(good.load("delete-failure"), "the primary remains loadable after the failed delete");
  }),
);

test(
  "createWorkflowStorage delete returns false for nonexistent",
  withIsolatedHome(async (cwd) => {
    const storage = createWorkflowStorage(cwd);
    assert.equal(storage.delete("no-such"), false);
  }),
);

test(
  "createWorkflowStorage delete removes from one location only",
  withIsolatedHome(async (cwd) => {
    const storage = createWorkflowStorage(cwd);
    storage.save({ name: "both", description: "p", script: "p" });
    storage.save({ name: "both", description: "g", script: "g" }, "global");
    assert.ok(storage.load("both"), "load() should succeed");
    // Delete only from project
    const deleted = storage.delete("both", "project");
    assert.equal(deleted, true);
    // Global version should still exist.
    const globalVersion = storage.load("both");
    assert.ok(globalVersion, "global version should still exist");
    assert.equal(globalVersion?.location, "global");
  }),
);

test(
  "createWorkflowStorage save preserves parameters",
  withIsolatedHome(async (cwd) => {
    const storage = createWorkflowStorage(cwd);
    const saved = storage.save({
      name: "param-wf",
      description: "Has params",
      script: "export const meta = { name: 'p', description: 'p' }",
      parameters: {
        input: { type: "string", description: "Input value", required: true },
        limit: { type: "number", description: "Max results", default: 10 },
      },
    });
    assert.ok(saved.parameters, "parameters should be truthy");
    assert.equal(saved.parameters?.input.type, "string");
    assert.equal(saved.parameters?.input.required, true);
    assert.equal(saved.parameters?.limit.default, 10);

    const loaded = storage.load("param-wf");
    assert.deepEqual(loaded?.parameters, saved.parameters);
  }),
);

test(
  "createWorkflowStorage rejects path-unsafe workflow names",
  withIsolatedHome(async (cwd) => {
    const storage = createWorkflowStorage(cwd);
    assert.throws(() => storage.save({ name: "../escape", description: "bad", script: "bad" }), /path-safe name/);
    assert.equal(storage.load("../escape"), null);
    assert.equal(storage.delete("../escape"), false);
    assert.equal(existsSync(join(workflowProjectPaths(cwd).rootDir, "escape.json")), false);
  }),
);

test(
  "createWorkflowStorage file contents are valid JSON with expected fields",
  withIsolatedHome(async (cwd) => {
    const storage = createWorkflowStorage(cwd);
    storage.save({
      name: "check-json",
      description: "desc",
      script: "export const meta = { name: 'c', description: 'c' }",
    });
    const filePath = join(workflowProjectPaths(cwd).savedDir, "check-json.json");
    const raw = JSON.parse(readFileSync(filePath, "utf-8"));
    assert.equal(raw.name, "check-json");
    assert.equal(raw.description, "desc");
    assert.equal(raw.script, "export const meta = { name: 'c', description: 'c' }");
    assert.ok(raw.savedAt, "savedAt should be truthy");
    assert.ok(raw.path, "path should be truthy");
  }),
);

test(
  "createWorkflowStorage handles corrupted files gracefully",
  withIsolatedHome(async (cwd) => {
    const storage = createWorkflowStorage(cwd);
    const projectDir = workflowProjectPaths(cwd).savedDir;
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, "corrupted.json"), "not valid json{{{");

    const loaded = storage.load("corrupted");
    assert.equal(loaded, null, "corrupted file returns null");
    const list = storage.list();
    assert.ok(Array.isArray(list), "list should be an array");
    assert.equal(list.length, 0); // only corrupted file
  }),
);

test(
  "createWorkflowStorage rejects a structurally invalid saved-workflow payload",
  withIsolatedHome(async (cwd) => {
    const storage = createWorkflowStorage(cwd);
    const projectDir = workflowProjectPaths(cwd).savedDir;
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(
      join(projectDir, "invalid.json"),
      JSON.stringify({
        name: "invalid",
        description: "invalid parameters",
        script: "return null",
        savedAt: "2026-08-04T00:00:00.000Z",
        parameters: { query: { type: 42 } },
      }),
    );

    assert.equal(storage.load("invalid"), null);
    assert.deepEqual(storage.list(), []);
  }),
);

test(
  "createWorkflowStorage keeps an atomic backup and recovers a corrupt primary",
  withIsolatedHome(async (cwd) => {
    const storage = createWorkflowStorage(cwd);
    storage.save({ name: "recoverable", description: "good", script: "good script" });
    const path = join(workflowProjectPaths(cwd).savedDir, "recoverable.json");
    assert.equal(existsSync(`${path}.bak`), true);
    writeFileSync(path, "{ truncated", "utf-8");

    const recovered = storage.load("recoverable");
    assert.equal(recovered?.description, "good");
    assert.equal(recovered?.script, "good script");
  }),
);

test(
  "createWorkflowStorage opens the temporary file read-write before fsync",
  withIsolatedHome(async (cwd) => {
    let flags: string | number | undefined;
    const storage = createWorkflowStorage(cwd, {
      openSync: (path, requestedFlags) => {
        flags = requestedFlags;
        return openSync(path, requestedFlags);
      },
    });

    storage.save({ name: "fsync-mode", description: "d", script: "d" });
    assert.equal(flags, "r+");
  }),
);

test(
  "createWorkflowStorage failed rename preserves the last valid primary",
  withIsolatedHome(async (cwd) => {
    const good = createWorkflowStorage(cwd);
    good.save({ name: "atomic", description: "old", script: "old script" });
    const failing = createWorkflowStorage(cwd, {
      renameSync: () => {
        throw new Error("simulated rename failure");
      },
    });

    assert.throws(() => failing.save({ name: "atomic", description: "new", script: "new script" }));
    assert.equal(good.load("atomic")?.description, "old");
  }),
);

test(
  "createWorkflowStorage list tolerates an unreadable directory",
  withIsolatedHome(async (cwd) => {
    mkdirSync(workflowProjectPaths(cwd).savedDir, { recursive: true });
    const storage = createWorkflowStorage(cwd, {
      readdirSync: () => {
        throw new Error("EACCES");
      },
    });
    assert.deepEqual(storage.list(), []);
  }),
);

test(
  "createWorkflowStorage skips legacy files with unsafe workflow names",
  withIsolatedHome(async (cwd) => {
    const storage = createWorkflowStorage(cwd);
    const projectDir = workflowProjectPaths(cwd).savedDir;
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(
      join(projectDir, "unsafe.json"),
      JSON.stringify({
        name: "../unsafe",
        description: "unsafe",
        script: "unsafe",
        location: "project",
        savedAt: "2024-01-01T00:00:00.000Z",
        path: join(projectDir, "unsafe.json"),
      }),
      "utf-8",
    );

    assert.deepEqual(storage.list(), []);
  }),
);
