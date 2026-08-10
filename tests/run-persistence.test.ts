import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  createRunPersistence,
  type PersistedRunState,
  RUN_LEASE_STALE_AFTER_MS,
  summarizePersistedRun,
} from "../src/run-persistence.js";
import {
  assertSupportedNodeRuntime,
  openWorkflowDatabase,
  validateWorkflowDatabase,
  WORKFLOW_DATABASE_APPLICATION_ID,
  WORKFLOW_DATABASE_SCHEMA_VERSION,
  WORKFLOW_SCHEMA_DDL,
  WorkflowPersistenceError,
} from "../src/workflow-database.js";
import { workflowDatabasePath, workflowHomeDir } from "../src/workflow-paths.js";
import { withFakeHomeAsync } from "./helpers/fake-home.js";

function state(runId = "run-1", sessionId: string | undefined = "session-1"): PersistedRunState {
  return {
    runId,
    workflowName: "quotes ' ; DROP TABLE workflow_runs; --",
    script: "export const meta = { name: 'demo', description: 'demo' }",
    args: { quote: "' OR 1=1 --" },
    sessionId,
    modelScopeRestricted: true,
    modelScopePinnedEffort: "high",
    status: "running",
    phases: ["Scan"],
    currentPhase: "Scan",
    agents: [{ id: 1, label: "agent", prompt: "private prompt", status: "done", result: { ok: true } }],
    logs: ["private log"],
    journal: [{ index: 0, hash: "abc", result: "private result" }],
    tokenUsage: { input: 1, output: 2, total: 3, cost: 0.01, cacheRead: 4, cacheWrite: 5 },
    tokenBudget: 100,
    maxAgents: 7,
    agentTimeoutMs: 2500,
    concurrency: 3,
    startedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

async function isolated(fn: (home: string, cwd: string, dbPath: string) => void | Promise<void>): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), "pi-dw-db-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "pi-dw-db-project-"));
  try {
    await withFakeHomeAsync(home, () => fn(home, cwd, workflowDatabasePath()));
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
}

test("Node runtime guard rejects Node 23 before invoking a database constructor", () => {
  assert.throws(() => assertSupportedNodeRuntime("23.9.0"), /Node\.js 24/);
  assert.doesNotThrow(() => assertSupportedNodeRuntime("24.0.0"));
  let constructed = false;
  assert.throws(
    () =>
      openWorkflowDatabase({
        path: ":memory:",
        nodeVersion: "23.9.0",
        Database: class {
          constructor() {
            constructed = true;
          }
        } as never,
      }),
    /Node\.js 24/,
  );
  assert.equal(constructed, false);
});

test("creates exact schema v1, WAL/FULL pragmas, and private permissions", async () => {
  await isolated((_home, _cwd, path) => {
    const db = openWorkflowDatabase({ path });
    validateWorkflowDatabase(db);
    assert.equal(
      (db.prepare("PRAGMA application_id").get() as { application_id: number }).application_id,
      WORKFLOW_DATABASE_APPLICATION_ID,
    );
    assert.equal(
      (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version,
      WORKFLOW_DATABASE_SCHEMA_VERSION,
    );
    assert.equal((db.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode, "wal");
    assert.equal((db.prepare("PRAGMA synchronous").get() as { synchronous: number }).synchronous, 2);
    assert.equal((db.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number }).foreign_keys, 1);
    db.close();
    if (process.platform !== "win32") {
      assert.equal(statSync(workflowHomeDir()).mode & 0o777, 0o700);
      assert.equal(statSync(path).mode & 0o777, 0o600);
    }
  });
});

test("rejects a symlink database path", async () => {
  if (process.platform === "win32") return;
  await isolated((_home, _cwd, path) => {
    mkdirSync(workflowHomeDir(), { recursive: true });
    const target = join(workflowHomeDir(), "target");
    writeFileSync(target, "");
    symlinkSync(target, path);
    assert.throws(() => openWorkflowDatabase({ path }), /regular file/);
  });
});

test("foreign identity fails closed without mutating bytes, mode, or existing sidecars", async () => {
  await isolated((_home, _cwd, path) => {
    mkdirSync(workflowHomeDir(), { recursive: true });
    const foreign = new DatabaseSync(path);
    foreign.exec("CREATE TABLE foreign_data(value TEXT); PRAGMA application_id = 42; PRAGMA user_version = 7");
    foreign.close();
    if (process.platform !== "win32") chmodSync(path, 0o640);
    writeFileSync(`${path}-wal`, "existing-wal");
    writeFileSync(`${path}-shm`, "existing-shm");
    const before = readFileSync(path);
    const walBefore = readFileSync(`${path}-wal`);
    const shmBefore = readFileSync(`${path}-shm`);
    const mtime = statSync(path).mtimeMs;
    const mode = statSync(path).mode & 0o777;
    assert.throws(() => openWorkflowDatabase({ path }), /unsupported identity or version/);
    assert.deepEqual(readFileSync(path), before);
    assert.equal(statSync(path).mtimeMs, mtime);
    assert.equal(statSync(path).mode & 0o777, mode);
    assert.deepEqual(readFileSync(`${path}-wal`), walBefore);
    assert.deepEqual(readFileSync(`${path}-shm`), shmBefore);
  });
});

test("accepted existing databases are secured only after immutable validation", async () => {
  if (process.platform === "win32") return;
  await isolated((_home, _cwd, path) => {
    openWorkflowDatabase({ path }).close();
    chmodSync(workflowHomeDir(), 0o755);
    chmodSync(path, 0o644);

    const db = openWorkflowDatabase({ path });
    db.close();

    assert.equal(statSync(workflowHomeDir()).mode & 0o777, 0o700);
    assert.equal(statSync(path).mode & 0o777, 0o600);
  });
});

test("zero-identity unknown schemas and unsupported versions fail closed", async () => {
  await isolated((_home, _cwd, path) => {
    mkdirSync(workflowHomeDir(), { recursive: true });
    const unknown = new DatabaseSync(path);
    unknown.exec("CREATE TABLE unknown_data(value TEXT)");
    unknown.close();
    const unknownBefore = readFileSync(path);
    assert.throws(() => openWorkflowDatabase({ path }), /unsupported identity or version/);
    assert.deepEqual(readFileSync(path), unknownBefore);

    rmSync(path);
    openWorkflowDatabase({ path }).close();
    const newer = new DatabaseSync(path);
    newer.exec(`PRAGMA user_version = ${WORKFLOW_DATABASE_SCHEMA_VERSION + 1}`);
    newer.close();
    assert.throws(() => openWorkflowDatabase({ path }), /unsupported identity or version/);
  });
});

test("an accepted database with an extra trigger is rejected on reopen", async () => {
  await isolated((_home, _cwd, path) => {
    const db = openWorkflowDatabase({ path });
    db.exec("CREATE TRIGGER unexpected AFTER INSERT ON projects BEGIN SELECT 1; END");
    db.close();
    assert.throws(() => openWorkflowDatabase({ path }), /unexpected objects/);
  });
});

test("an altered same-name schema is rejected", async () => {
  await isolated((_home, _cwd, path) => {
    mkdirSync(workflowHomeDir(), { recursive: true });
    const db = new DatabaseSync(path);
    for (const ddl of WORKFLOW_SCHEMA_DDL) {
      db.exec(
        ddl.includes("CREATE TABLE workflow_runs")
          ? ddl.replace("agent_total INTEGER NOT NULL", "agent_total INTEGER")
          : ddl,
      );
    }
    db.exec(
      `PRAGMA application_id = ${WORKFLOW_DATABASE_APPLICATION_ID}; PRAGMA user_version = ${WORKFLOW_DATABASE_SCHEMA_VERSION}`,
    );
    db.close();
    assert.throws(() => openWorkflowDatabase({ path }), /does not match schema v1/);
  });
});

test("corrupt database is preserved", async () => {
  await isolated((_home, _cwd, path) => {
    mkdirSync(workflowHomeDir(), { recursive: true });
    writeFileSync(path, "not a sqlite database");
    if (process.platform !== "win32") chmodSync(path, 0o640);
    const before = readFileSync(path);
    const mode = statSync(path).mode & 0o777;
    assert.throws(
      () => openWorkflowDatabase({ path }),
      (error) => {
        assert.ok(error instanceof WorkflowPersistenceError);
        assert.equal(error.message.includes(path), false);
        assert.equal(error.cause, undefined);
        return true;
      },
    );
    assert.deepEqual(readFileSync(path), before);
    assert.equal(statSync(path).mode & 0o777, mode);
    assert.equal(existsSync(`${path}-wal`), false);
    assert.equal(existsSync(`${path}-shm`), false);
  });
});

test("partial initialization closes validation and writable connections", async () => {
  await isolated((_home, _cwd, path) => {
    openWorkflowDatabase({ path }).close();
    let closes = 0;
    class FailingDatabase extends DatabaseSync {
      override exec(sql: string): void {
        if (sql === "PRAGMA foreign_keys = ON") throw new Error("injected configuration failure");
        super.exec(sql);
      }

      override close(): void {
        closes += 1;
        super.close();
      }
    }
    assert.throws(() => openWorkflowDatabase({ path, Database: FailingDatabase }), /could not be initialized/);
    assert.equal(closes, 2);
    assert.doesNotThrow(() => openWorkflowDatabase({ path }).close());
  });
});

test("foreign-key corruption is rejected before writable open", async () => {
  await isolated((_home, _cwd, path) => {
    openWorkflowDatabase({ path }).close();
    const db = new DatabaseSync(path);
    db.exec("PRAGMA foreign_keys = OFF");
    db.prepare(
      `INSERT INTO workflow_run_leases(
        project_id, run_id, owner_pid, owner_token, acquired_at, heartbeat_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run("missing-project", "orphan", 1, "token", "2026-01-01T00:00:00.000Z", 1);
    db.close();
    const walBefore = existsSync(`${path}-wal`) ? readFileSync(`${path}-wal`) : null;
    const shmBefore = existsSync(`${path}-shm`) ? readFileSync(`${path}-shm`) : null;
    assert.throws(() => openWorkflowDatabase({ path }), /invalid references/);
    assert.deepEqual(existsSync(`${path}-wal`) ? readFileSync(`${path}-wal`) : null, walBefore);
    assert.deepEqual(existsSync(`${path}-shm`) ? readFileSync(`${path}-shm`) : null, shmBefore);
  });
});

test("summary mapping contains no payload fields", () => {
  const summary = summarizePersistedRun("project", state());
  assert.deepEqual(summary.agentCounts, { total: 1, running: 0, done: 1, error: 0 });
  assert.equal(summary.hasScript, true);
  assert.equal("agents" in summary, false);
  assert.equal("script" in summary, false);
  assert.equal("executionPolicy" in summary, false);
});

test("repository round-trips payload and lists summary-only data", async () => {
  await isolated((_home, cwd, path) => {
    const repository = createRunPersistence(cwd, { path });
    const lease = repository.acquireRunLease("run-1", "new");
    assert.ok(lease);
    const saved = state();
    repository.save(saved, lease);
    assert.equal(repository.listSummaries("session-1").length, 1);
    assert.equal(repository.listSummaries("other").length, 0);
    assert.deepEqual(repository.load("run-1")?.journal, saved.journal);
    assert.equal(repository.getSummary("run-1")?.workflowName, saved.workflowName);
    repository.releaseRunLease(lease);
    repository.close();
  });
});

test("payload v1 omits absent policy and round-trips explicit canonical policy", async () => {
  await isolated((_home, cwd, path) => {
    const repository = createRunPersistence(cwd, { path });
    const withoutLease = repository.acquireRunLease("without-policy", "new");
    assert.ok(withoutLease);
    const without = state("without-policy");
    repository.save(without, withoutLease);
    assert.equal(repository.load("without-policy")?.executionPolicy, undefined);

    const withLease = repository.acquireRunLease("with-policy", "new");
    assert.ok(withLease);
    const withPolicy = state("with-policy");
    withPolicy.executionPolicy = {
      agentRunRetries: 2,
      agentTurnRetry: { enabled: false, maxRetries: 1, baseDelayMs: 250 },
    };
    repository.save(withPolicy, withLease);
    assert.deepEqual(repository.load("with-policy")?.executionPolicy, withPolicy.executionPolicy);
    assert.equal("executionPolicy" in (repository.getSummary("with-policy") ?? {}), false);

    repository.releaseRunLease(withoutLease);
    repository.releaseRunLease(withLease);
    repository.close();
  });
});

test("payload v1 rejects non-canonical or invalid execution policy", async () => {
  await isolated((_home, cwd, path) => {
    const repository = createRunPersistence(cwd, { path });
    for (const [runId, policy] of [
      ["legacy", { agentRetries: 1 }],
      ["fraction", { agentRunRetries: 1.5 }],
      ["over-cap", { agentRunRetries: 4 }],
      ["unknown", { unknown: true }],
    ] as const) {
      const lease = repository.acquireRunLease(runId, "new");
      assert.ok(lease);
      const invalid = state(runId);
      invalid.executionPolicy = policy as never;
      assert.throws(() => repository.save(invalid, lease), /execution policy|safe integer|between|supported/);
      assert.equal(repository.getSummary(runId), null);
      repository.releaseRunLease(lease);
    }
    repository.close();
  });
});

test("payload v1 rejects a non-string journal run ID", async () => {
  await isolated((_home, cwd, path) => {
    const repository = createRunPersistence(cwd, { path });
    const lease = repository.acquireRunLease("invalid-journal-owner", "new");
    assert.ok(lease);
    const invalid = state("invalid-journal-owner");
    invalid.journal = [{ index: 0, runId: 42 as never, hash: "abc", result: "result" }];

    assert.throws(() => repository.save(invalid, lease), /journal run id/);
    assert.equal(repository.getSummary("invalid-journal-owner"), null);
    repository.releaseRunLease(lease);
    repository.close();
  });
});

test("payload v1 rejects malformed model scope provenance", async () => {
  await isolated((_home, cwd, path) => {
    const repository = createRunPersistence(cwd, { path });
    const lease = repository.acquireRunLease("invalid-scope-provenance", "new");
    assert.ok(lease);
    const invalid = state("invalid-scope-provenance");
    invalid.modelScopeRestricted = "yes" as never;
    assert.throws(() => repository.save(invalid, lease), /model scope restriction/);
    assert.equal(repository.getSummary("invalid-scope-provenance"), null);
    repository.releaseRunLease(lease);
    repository.close();
  });
});

test("two projects share one database without crossing payloads", async () => {
  await isolated((_home, cwd, path) => {
    const otherCwd = mkdtempSync(join(tmpdir(), "pi-dw-other-"));
    try {
      const a = createRunPersistence(cwd, { path });
      const b = createRunPersistence(otherCwd, { path });
      const lease = a.acquireRunLease("same-id", "new");
      assert.ok(lease);
      a.save(state("same-id"), lease);
      assert.equal(b.getSummary("same-id"), null);
      assert.equal(b.load("same-id"), null);
      a.releaseRunLease(lease);
      a.close();
      b.close();
    } finally {
      rmSync(otherCwd, { recursive: true, force: true });
    }
  });
});

test("project key collisions fail closed", async () => {
  await isolated((_home, cwd, path) => {
    const repository = createRunPersistence(cwd, { path });
    repository.close();
    const db = new DatabaseSync(path);
    db.prepare("UPDATE projects SET canonical_path = ?").run(`${cwd}-different`);
    db.close();
    assert.throws(() => createRunPersistence(cwd, { path }), /project identity is already bound/);
  });
});

test("fresh leases contend, renew, and ignore wrong-token release", async () => {
  await isolated((_home, cwd, path) => {
    let clock = 1000;
    const a = createRunPersistence(cwd, { path, now: () => clock, pid: 101, pidIsAlive: () => true });
    const b = createRunPersistence(cwd, { path, now: () => clock, pid: 202, pidIsAlive: () => true });
    const lease = a.acquireRunLease("lease", "new");
    assert.ok(lease);
    assert.equal(b.acquireRunLease("lease", "new"), null);
    a.releaseRunLease({ ...lease, token: "wrong" });
    assert.equal(b.acquireRunLease("lease", "new"), null);
    clock += 10_000;
    assert.equal(a.renewRunLease(lease), true);
    a.releaseRunLease(lease);
    assert.ok(b.acquireRunLease("lease", "new"));
    a.close();
    b.close();
  });
});

test("expired heartbeat permits takeover even when the PID appears alive and fences the old token", async () => {
  await isolated((_home, cwd, path) => {
    let clock = 1000;
    const a = createRunPersistence(cwd, { path, now: () => clock, pid: 303, pidIsAlive: () => true });
    const b = createRunPersistence(cwd, { path, now: () => clock, pid: 404, pidIsAlive: () => true });
    const oldLease = a.acquireRunLease("takeover", "new");
    assert.ok(oldLease);
    a.save(state("takeover"), oldLease);
    clock += RUN_LEASE_STALE_AFTER_MS + 1;
    const newLease = b.acquireRunLease("takeover", "existing");
    assert.ok(newLease);
    assert.equal(a.renewRunLease(oldLease), false);
    assert.throws(() => a.save({ ...state("takeover"), status: "failed" }, oldLease), /ownership was lost/);
    assert.equal(a.delete("takeover", oldLease), "leased");
    assert.equal(b.delete("takeover", newLease), "deleted");
    a.close();
    b.close();
  });
});

test("dead owner permits immediate takeover", async () => {
  await isolated((_home, cwd, path) => {
    const a = createRunPersistence(cwd, { path, pid: 505, pidIsAlive: () => false });
    const b = createRunPersistence(cwd, { path, pid: 606, pidIsAlive: () => false });
    const oldLease = a.acquireRunLease("dead", "new");
    assert.ok(oldLease);
    assert.ok(b.acquireRunLease("dead", "new"));
    a.close();
    b.close();
  });
});

test("new/existing lease modes enforce run absence and presence", async () => {
  await isolated((_home, cwd, path) => {
    const repository = createRunPersistence(cwd, { path, pidIsAlive: () => false });
    assert.equal(repository.acquireRunLease("missing", "existing"), null);
    const lease = repository.acquireRunLease("present", "new");
    assert.ok(lease);
    repository.save(state("present"), lease);
    repository.releaseRunLease(lease);
    assert.equal(repository.acquireRunLease("present", "new"), null);
    const existing = repository.acquireRunLease("present", "existing");
    assert.ok(existing);
    assert.equal(repository.delete("present", existing), "deleted");
    assert.equal(repository.acquireRunLease("present", "existing"), null);
    repository.close();
  });
});

test("delete after a stale summary read cannot recreate a run or orphan lease", async () => {
  await isolated((_home, cwd, path) => {
    const resumer = createRunPersistence(cwd, { path, pidIsAlive: () => true });
    const deleter = createRunPersistence(cwd, { path, pidIsAlive: () => true });
    const seedLease = deleter.acquireRunLease("race", "new");
    assert.ok(seedLease);
    deleter.save(state("race"), seedLease);
    deleter.releaseRunLease(seedLease);

    assert.ok(resumer.getSummary("race"), "resume reads the summary first");
    const deleteLease = deleter.acquireRunLease("race", "existing");
    assert.ok(deleteLease);
    assert.equal(deleter.delete("race", deleteLease), "deleted");
    assert.equal(resumer.acquireRunLease("race", "existing"), null);
    assert.equal(resumer.load("race"), null);

    const db = new DatabaseSync(path, { readOnly: true });
    assert.equal(
      (
        db.prepare("SELECT count(*) AS count FROM workflow_run_leases WHERE run_id = ?").get("race") as {
          count: number;
        }
      ).count,
      0,
    );
    db.close();
    resumer.close();
    deleter.close();
  });
});

test("session identity is immutable and invalid JSON values write nothing", async () => {
  await isolated((_home, cwd, path) => {
    const repository = createRunPersistence(cwd, { path });
    const lease = repository.acquireRunLease("immutable", "new");
    assert.ok(lease);
    repository.save(state("immutable", "owner"), lease);
    assert.throws(() => repository.save(state("immutable", "other"), lease), /session ownership/);
    const cyclic = state("cycle");
    cyclic.args = cyclic;
    const cycleLease = repository.acquireRunLease("cycle", "new");
    assert.ok(cycleLease);
    assert.throws(() => repository.save(cyclic, cycleLease), /cycle/);
    assert.equal(repository.getSummary("cycle"), null);
    const numeric = state("numeric");
    numeric.durationMs = Number.NaN;
    const numericLease = repository.acquireRunLease("numeric", "new");
    assert.ok(numericLease);
    assert.throws(() => repository.save(numeric, numericLease), /duration/);
    assert.equal(repository.getSummary("numeric"), null);
    repository.close();
  });
});

test("save transaction rolls summary and payload back together", async () => {
  await isolated((_home, cwd, path) => {
    const repository = createRunPersistence(cwd, { path });
    const lease = repository.acquireRunLease("rollback", "new");
    assert.ok(lease);
    repository.save(state("rollback"), lease);
    const beforeSummary = repository.getSummary("rollback");
    const beforePayload = repository.load("rollback");

    const fault = new DatabaseSync(path);
    fault.exec(`CREATE TRIGGER fail_payload_update BEFORE UPDATE ON workflow_run_payloads
      BEGIN SELECT RAISE(ABORT, 'injected payload failure'); END`);
    assert.throws(
      () => repository.save({ ...state("rollback"), status: "failed", workflowName: "changed" }, lease),
      /injected payload failure/,
    );
    assert.deepEqual(repository.getSummary("rollback"), beforeSummary);
    assert.deepEqual(repository.load("rollback"), beforePayload);
    fault.exec("DROP TRIGGER fail_payload_update");
    fault.close();
    repository.releaseRunLease(lease);
    repository.close();
  });
});

test("busy writer failures roll back and surface explicitly", async () => {
  await isolated((_home, cwd, path) => {
    openWorkflowDatabase({ path }).close();
    const blocker = new DatabaseSync(path);
    blocker.exec("PRAGMA journal_mode = WAL; BEGIN IMMEDIATE");
    class FastTimeoutDatabase extends DatabaseSync {
      constructor(
        databasePath: ConstructorParameters<typeof DatabaseSync>[0],
        options?: ConstructorParameters<typeof DatabaseSync>[1],
      ) {
        super(databasePath, { ...options, timeout: 1 });
      }
    }
    assert.throws(() => createRunPersistence(cwd, { path, Database: FastTimeoutDatabase }), /locked|busy/i);
    blocker.exec("ROLLBACK");
    blocker.close();
    const repository = createRunPersistence(cwd, { path });
    assert.deepEqual(repository.listSummaries(), []);
    repository.close();
  });
});

test("SQL metacharacters remain data across all scoped operations", async () => {
  await isolated((_home, cwd, path) => {
    const quotedCwd = join(cwd, "project ' ; --");
    mkdirSync(quotedCwd);
    const repository = createRunPersistence(quotedCwd, { path });
    const runId = "run ' ; DROP TABLE projects; --";
    const sessionId = "session ' OR 1=1 --";
    const lease = repository.acquireRunLease(runId, "new");
    assert.ok(lease);
    repository.save(state(runId, sessionId), lease);
    assert.equal(repository.listSummaries(sessionId)[0]?.runId, runId);
    assert.equal(repository.getSummary(runId)?.sessionId, sessionId);
    assert.equal(repository.load(runId)?.args && typeof repository.load(runId)?.args, "object");
    assert.equal(repository.delete(runId, lease), "deleted");
    repository.close();
  });
});

test("malformed and identity-mismatched payloads are rejected", async () => {
  await isolated((_home, cwd, path) => {
    const repository = createRunPersistence(cwd, { path });
    const lease = repository.acquireRunLease("bad", "new");
    assert.ok(lease);
    repository.save(state("bad"), lease);
    repository.releaseRunLease(lease);
    const db = new DatabaseSync(path);
    db.prepare("UPDATE workflow_run_payloads SET state_json = ? WHERE run_id = ?").run(
      JSON.stringify(state("other")),
      "bad",
    );
    db.close();
    assert.throws(() => repository.load("bad"), /identity/);
    repository.close();
  });
});

test("close is idempotent and operations after close fail explicitly", async () => {
  await isolated((_home, cwd, path) => {
    const repository = createRunPersistence(cwd, { path });
    repository.close();
    repository.close();
    assert.throws(() => repository.listSummaries(), /closed/);
  });
});

test("old JSON and lock files are ignored and left unchanged", async () => {
  await isolated((_home, cwd, path) => {
    const legacy = join(cwd, ".pi", "workflows", "runs");
    mkdirSync(legacy, { recursive: true });
    const json = join(legacy, "old.json");
    const lock = join(legacy, "old.lock");
    writeFileSync(json, JSON.stringify(state("old")));
    writeFileSync(lock, "legacy lock");
    const beforeJson = readFileSync(json);
    const beforeLock = readFileSync(lock);
    const repository = createRunPersistence(cwd, { path });
    assert.deepEqual(repository.listSummaries(), []);
    repository.close();
    assert.deepEqual(readFileSync(json), beforeJson);
    assert.deepEqual(readFileSync(lock), beforeLock);
    assert.equal(lstatSync(json).isFile(), true);
  });
});
