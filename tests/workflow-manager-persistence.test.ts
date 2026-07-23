import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createRunPersistence, type RunPersistence, type WorkflowRunSummary } from "../src/run-persistence.js";
import { WorkflowManager } from "../src/workflow-manager.js";
import { withFakeHomeAsync } from "./helpers/fake-home.js";

const script = `export const meta = { name: 'lease_test', description: 'lease test' }
const a = await agent('wait', { label: 'a' })
return { a }`;

function deferredAgent() {
  let resolve: ((value: unknown) => void) | undefined;
  return {
    resolve: (value: unknown = "done") => resolve?.(value),
    runner: {
      run: () => new Promise((done) => (resolve = done)),
    },
  };
}

function isolated(fn: (cwd: string) => Promise<void>) {
  return async () => {
    const home = mkdtempSync(join(tmpdir(), "pi-dw-manager-home-"));
    const cwd = mkdtempSync(join(tmpdir(), "pi-dw-manager-project-"));
    try {
      await withFakeHomeAsync(home, () => fn(cwd));
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  };
}

test(
  "foreign live leases make manager deletion non-mutating",
  isolated(async (cwd) => {
    const deferred = deferredAgent();
    const owner = new WorkflowManager({ cwd, sessionId: "session", agent: deferred.runner });
    owner.on("error", () => {});
    const { runId, promise } = owner.startInBackground(script);

    const contender = new WorkflowManager({ cwd, sessionId: "session" });
    contender.initialize();
    assert.equal(await contender.deleteRun(runId), "leased");
    assert.equal(contender.listRuns()[0]?.runId, runId);

    await new Promise((resolve) => setTimeout(resolve, 10));
    deferred.resolve();
    await promise;
    await Promise.all([owner.dispose(), contender.dispose()]);
  }),
);

test(
  "initial durable save failure prevents execution and releases the lease",
  isolated(async (cwd) => {
    let agentCalls = 0;
    let repository: RunPersistence | undefined;
    const manager = new WorkflowManager({
      cwd,
      agent: {
        run: async () => {
          agentCalls += 1;
          return "unexpected";
        },
      },
      persistenceFactory: (project) => {
        const delegate = createRunPersistence(project);
        repository = delegate;
        return {
          ...delegate,
          save: () => {
            throw new Error("injected initial save failure");
          },
        };
      },
    });
    assert.throws(() => manager.startInBackground(script), /injected initial save failure/);
    assert.equal(agentCalls, 0);
    assert.deepEqual(repository?.listSummaries(), []);
    await manager.dispose();
  }),
);

test(
  "active deletion waits for execution settlement before guarded deletion",
  isolated(async (cwd) => {
    const deferred = deferredAgent();
    const manager = new WorkflowManager({ cwd, agent: deferred.runner });
    manager.on("error", () => {});
    const { runId } = manager.startInBackground(script);
    await new Promise((resolve) => setTimeout(resolve, 10));

    let settled = false;
    const deletion = manager.deleteRun(runId).then((result) => {
      settled = true;
      return result;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(settled, false);
    deferred.resolve();
    assert.equal(await deletion, "deleted");
    await manager.dispose();
  }),
);

test(
  "transient heartbeat failures retry before the stale deadline",
  isolated(async (cwd) => {
    const deferred = deferredAgent();
    let renewals = 0;
    const manager = new WorkflowManager({
      cwd,
      agent: deferred.runner,
      leaseHeartbeatIntervalMs: 5,
      leaseStaleAfterMs: 80,
      persistenceFactory: (project) => {
        const repository = createRunPersistence(project);
        return {
          ...repository,
          renewRunLease: (lease) => {
            renewals += 1;
            if (renewals <= 2) throw new Error("transient busy");
            return repository.renewRunLease(lease);
          },
        };
      },
    });
    manager.on("error", () => {});
    const { runId, promise } = manager.startInBackground(script);
    await new Promise((resolve) => setTimeout(resolve, 35));
    assert.ok(renewals >= 3);
    assert.equal(manager.getRun(runId)?.controller.signal.aborted, false);
    deferred.resolve();
    await promise;
    await manager.dispose();
  }),
);

test(
  "heartbeat loss self-fences and suppresses stale terminal writes",
  isolated(async (cwd) => {
    const deferred = deferredAgent();
    let completeEvents = 0;
    let errorEvents = 0;
    const manager = new WorkflowManager({
      cwd,
      agent: deferred.runner,
      leaseHeartbeatIntervalMs: 5,
      leaseStaleAfterMs: 30,
      persistenceFactory: (project) => {
        const repository = createRunPersistence(project);
        return { ...repository, renewRunLease: () => false };
      },
    });
    manager.on("complete", () => (completeEvents += 1));
    manager.on("error", () => (errorEvents += 1));
    const previousWarn = console.warn;
    console.warn = () => {};
    try {
      const { runId, promise } = manager.startInBackground(script);
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(manager.getRun(runId)?.controller.signal.aborted, true);
      deferred.resolve();
      await promise.catch(() => undefined);
      assert.equal(completeEvents, 0);
      assert.equal(errorEvents, 0);

      const observer = createRunPersistence(cwd);
      assert.equal(observer.getSummary(runId)?.status, "running");
      const recoveredLease = observer.acquireRunLease(runId, "existing");
      assert.ok(recoveredLease, "the stale owner must release or lose its lease");
      observer.releaseRunLease(recoveredLease);
      observer.close();
    } finally {
      console.warn = previousWarn;
      await manager.dispose();
    }
  }),
);

test(
  "bound-session operations authorize before payload load",
  isolated(async (cwd) => {
    let loads = 0;
    const summary: WorkflowRunSummary = {
      projectId: "project",
      runId: "foreign",
      sessionId: "session-a",
      workflowName: "private",
      status: "paused",
      startedAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      agentCounts: { total: 0, running: 0, done: 0, error: 0 },
      hasScript: true,
    };
    const repository: RunPersistence = {
      save: () => assert.fail("save must not run"),
      getSummary: () => summary,
      load: () => {
        loads += 1;
        return null;
      },
      listSummaries: () => [],
      delete: () => assert.fail("delete must not run"),
      acquireRunLease: () => assert.fail("lease must not be acquired"),
      renewRunLease: () => false,
      releaseRunLease: () => {},
      close: () => {},
    };
    const manager = new WorkflowManager({
      cwd,
      sessionId: "session-b",
      persistenceFactory: () => repository,
    });
    manager.initialize();
    assert.equal(manager.loadRun("foreign"), null);
    assert.equal(await manager.resume("foreign"), false);
    assert.equal(await manager.deleteRun("foreign"), "not_found");
    assert.equal(loads, 0);
    await manager.dispose();
  }),
);

test(
  "dispose checkpoints and settles active runs, releases leases, and closes once",
  isolated(async (cwd) => {
    const deferred = deferredAgent();
    let closes = 0;
    const manager = new WorkflowManager({
      cwd,
      agent: deferred.runner,
      persistenceFactory: (project) => {
        const repository = createRunPersistence(project);
        return {
          ...repository,
          close: () => {
            closes += 1;
            repository.close();
          },
        };
      },
    });
    manager.on("error", () => {});
    const { runId } = manager.startInBackground(script);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const first = manager.dispose();
    const second = manager.dispose();
    deferred.resolve();
    await Promise.all([first, second]);
    assert.equal(closes, 1);

    const observer = createRunPersistence(cwd);
    assert.equal(observer.getSummary(runId)?.status, "paused");
    const lease = observer.acquireRunLease(runId, "existing");
    assert.ok(lease);
    observer.releaseRunLease(lease);
    observer.close();
  }),
);

test(
  "shutdown racing with completion leaves no owned lease",
  isolated(async (cwd) => {
    const deferred = deferredAgent();
    const manager = new WorkflowManager({ cwd, agent: deferred.runner });
    manager.on("error", () => {});
    const { runId, promise } = manager.startInBackground(script);
    await new Promise((resolve) => setTimeout(resolve, 10));
    deferred.resolve();
    await Promise.allSettled([promise, manager.dispose()]);

    const observer = createRunPersistence(cwd);
    const summary = observer.getSummary(runId);
    assert.ok(summary);
    assert.ok(summary.status === "completed" || summary.status === "paused");
    const lease = observer.acquireRunLease(runId, "existing");
    assert.ok(lease);
    observer.releaseRunLease(lease);
    observer.close();
  }),
);
