import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AgentUsage } from "../src/agent.js";
import { WorkflowError, WorkflowErrorCode } from "../src/errors.js";
import { createRunPersistence, type PersistedRunState } from "../src/run-persistence.js";
import { WorkflowManager } from "../src/workflow-manager.js";
import { withFakeHomeAsync } from "./helpers/fake-home.js";

/** Agent runner that reports fixed usage so token accounting is exercised. */
function fakeAgent(usage: Partial<AgentUsage> = {}, result: unknown = "ok") {
  return {
    async run(_prompt: string, options: { onUsage?: (u: AgentUsage) => void }) {
      options.onUsage?.({
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
        cost: 0,
        ...usage,
      });
      return result;
    },
  };
}

/** Agent that stays running until a deferred resolve is called externally. */
function deferredAgent() {
  let deferredResolve: ((value: unknown) => void) | null = null;
  let deferredReject: ((err: Error) => void) | null = null;
  const promise = new Promise((resolve, reject) => {
    deferredResolve = resolve;
    deferredReject = reject;
  });
  return {
    resolve: (value: unknown = "done") => deferredResolve?.(value),
    reject: (err: Error) => deferredReject?.(err),
    runner: {
      async run(_prompt: string, _options?: { onUsage?: (u: AgentUsage) => void }) {
        return promise;
      },
    },
  };
}

function delayedAgent(delayMs: number, result: unknown = "slow") {
  return {
    async run(_prompt: string, options?: { onUsage?: (u: AgentUsage) => void }) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      options?.onUsage?.({
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
        cost: 0,
      });
      return result;
    },
  };
}

const oneAgentScript = `export const meta = { name: 'tracked_demo', description: 'one agent' }
phase('Work')
const a = await agent('do it', { label: 'a' })
return { a }`;

function seedRun(cwd: string, state: PersistedRunState) {
  const repository = createRunPersistence(cwd);
  const lease = repository.acquireRunLease(state.runId, "new");
  assert.ok(lease);
  repository.save(state, lease);
  repository.releaseRunLease(lease);
  repository.close();
}

async function waitForRunStatus(
  manager: WorkflowManager,
  runId: string,
  expected: PersistedRunState["status"],
): Promise<PersistedRunState> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const persisted = manager.loadRun(runId);
    if (persisted?.status === expected) return persisted;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`Run ${runId} did not reach ${expected} before the timeout.`);
}

/** Run each manager test with isolated cwd and HOME so workflow state is isolated. */
function withTempCwd(fn: (cwd: string) => Promise<void>) {
  return async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-dw-mgr-"));
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
  "runSync registers the run so /workflows (listRuns) can see it",
  withTempCwd(async (cwd) => {
    const manager = new WorkflowManager({ cwd, agent: fakeAgent({ input: 100, output: 40, total: 140 }) });
    const events: string[] = [];
    for (const ev of ["agentStart", "agentEnd", "phase", "complete"]) {
      manager.on(ev, () => events.push(ev));
    }
    let progressCalls = 0;
    const result = await manager.runSync(oneAgentScript, undefined, {
      onProgress: () => {
        progressCalls++;
      },
    });

    assert.equal(result.agentCount, 1);
    assert.ok(progressCalls > 0, "onProgress should fire while the run executes");
    assert.ok(events.includes("agentStart") && events.includes("complete"), "manager emits live events");

    const runs = manager.listRuns();
    assert.equal(runs.length, 1, "the sync run is persisted and listable");
    assert.equal(runs[0].workflowName, "tracked_demo");
    assert.equal(runs[0].status, "completed");
    assert.equal(runs[0].tokenUsage?.total, 140, "token usage is persisted for the navigator");
  }),
);

test(
  "manager progress retains disabled-schema diagnostics for /workflows",
  withTempCwd(async (cwd) => {
    const seen: Array<{ schema?: unknown; structuredOutputEnabled?: boolean }> = [];
    const manager = new WorkflowManager({
      cwd,
      agent: {
        async run(_prompt: string, options: { schema?: unknown; structuredOutputEnabled?: boolean }) {
          seen.push(options);
          return "text result";
        },
      },
    });
    const script = `export const meta = { name: 'schema-progress', description: 'schema progress' }
return await agent('answer', { label: 'visible schema', schema: { type: 'object' } })`;

    const result = await manager.runSync(script, undefined, { structuredOutputEnabled: false });
    const run = manager.listRuns()[0];
    const persisted = run ? manager.loadRun(run.runId) : undefined;

    assert.equal(result.result, "text result");
    assert.equal(seen[0]?.schema, undefined);
    assert.equal(seen[0]?.structuredOutputEnabled, false);
    assert.ok(persisted?.logs.some((message) => /opts\.schema ignored/.test(message)));
    assert.ok(persisted?.logs.some((message) => /using text output/.test(message)));
  }),
);

test(
  "persisted agent timestamps follow actual lifecycle events",
  withTempCwd(async (cwd) => {
    const deferred = deferredAgent();
    const manager = new WorkflowManager({ cwd, agent: deferred.runner });
    const { runId, promise } = manager.startInBackground(oneAgentScript);

    let running = manager.loadRun(runId)?.agents[0];
    for (let attempt = 0; attempt < 200 && !running; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      running = manager.loadRun(runId)?.agents[0];
    }
    assert.equal(running?.status, "running");
    assert.ok(running?.startedAt);
    assert.equal(running?.endedAt, undefined);

    deferred.resolve("done");
    await promise;

    const terminal = manager.loadRun(runId)?.agents[0];
    assert.equal(terminal?.status, "done");
    assert.ok(terminal?.startedAt);
    assert.ok(terminal?.endedAt);
    assert.ok(Date.parse(terminal?.endedAt ?? "") >= Date.parse(terminal?.startedAt ?? ""));
  }),
);

test(
  "concurrent agent starts share one persistence checkpoint",
  withTempCwd(async (cwd) => {
    const persistence = createRunPersistence(cwd);
    const deferred = deferredAgent();
    let saves = 0;
    let starts = 0;
    const manager = new WorkflowManager({
      cwd,
      agent: deferred.runner,
      persistenceFactory: () => ({
        ...persistence,
        save(state, lease) {
          saves++;
          persistence.save(state, lease);
        },
      }),
    });
    manager.on("agentStart", () => {
      starts++;
    });
    const script = `export const meta = { name: 'coalesced_starts', description: 'coalesced starts' }
return await parallel([
  () => agent('one', { label: 'one' }),
  () => agent('two', { label: 'two' }),
  () => agent('three', { label: 'three' }),
])`;

    const { promise } = manager.startInBackground(script);
    for (let attempt = 0; attempt < 200 && starts < 3; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(starts, 3);
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(saves, 2, "the initial state and one coalesced start checkpoint should be saved");

    deferred.resolve("done");
    await promise;
  }),
);

test(
  "manager defaultAgentTimeoutMs applies when run options omit agentTimeoutMs",
  withTempCwd(async (cwd) => {
    const manager = new WorkflowManager({ cwd, agent: delayedAgent(25), defaultAgentTimeoutMs: 5 });

    const result = await manager.runSync(oneAgentScript);

    assert.equal((result.result as { a: unknown }).a, null);
    const first = manager.listRuns()[0];
    const agent = first ? manager.loadRun(first.runId)?.agents[0] : undefined;
    assert.equal(agent?.status, "error");
    assert.match(agent?.error ?? "", /timed out after 5ms/);
    assert.match(agent?.error ?? "", /raise or omit timeoutMs\/agentTimeoutMs/);
  }),
);

test(
  "run option agentTimeoutMs overrides manager defaultAgentTimeoutMs",
  withTempCwd(async (cwd) => {
    const manager = new WorkflowManager({ cwd, agent: delayedAgent(25), defaultAgentTimeoutMs: 5 });

    const result = await manager.runSync(oneAgentScript, undefined, { agentTimeoutMs: null });

    assert.equal((result.result as { a: unknown }).a, "slow");
    const first = manager.listRuns()[0];
    const agent = first ? manager.loadRun(first.runId)?.agents[0] : undefined;
    assert.equal(agent?.status, "done");
  }),
);

test(
  "manager forwards exec concurrency and agentRunRetries to runtime",
  withTempCwd(async (cwd) => {
    let active = 0;
    let maxActive = 0;
    const callsByPrompt = new Map<string, number>();
    const manager = new WorkflowManager({
      cwd,
      concurrency: 8,
      agent: {
        async run(prompt: string) {
          active++;
          maxActive = Math.max(maxActive, active);
          await new Promise((resolve) => setTimeout(resolve, 5));
          active--;
          const calls = (callsByPrompt.get(prompt) ?? 0) + 1;
          callsByPrompt.set(prompt, calls);
          return calls === 1 ? "" : `ok:${prompt}`;
        },
      },
    });
    const script = `export const meta = { name: 'forwarding', description: 'manager controls' }
const xs = await parallel(['a','b'].map((p) => () => agent(p, { label: p })))
return xs`;

    const result = await manager.runSync(script, undefined, { concurrency: 1, agentRunRetries: 1 });

    assert.deepEqual(result.result, ["ok:a", "ok:b"]);
    assert.equal(maxActive, 1, "exec concurrency should override the manager default");
    assert.deepEqual([...callsByPrompt.values()], [2, 2], "exec agentRunRetries should be forwarded");
  }),
);

test(
  "manager ignores legacy defaultAgentRetries when run options omit agentRunRetries",
  withTempCwd(async (cwd) => {
    let calls = 0;
    const manager = new WorkflowManager({
      cwd,
      defaultAgentRetries: 1,
      agent: {
        async run() {
          calls++;
          return calls === 1 ? "" : "ok";
        },
      },
    } as ConstructorParameters<typeof WorkflowManager>[0] & { defaultAgentRetries: number });

    const result = await manager.runSync(oneAgentScript);

    assert.equal((result.result as { a: unknown }).a, null);
    assert.equal(calls, 1);
  }),
);

test(
  "manager persists only explicit canonical execution policy",
  withTempCwd(async (cwd) => {
    let calls = 0;
    const manager = new WorkflowManager({
      cwd,
      agent: {
        async run() {
          calls++;
          return calls === 1 ? "" : "ok";
        },
      },
    });
    await manager.runSync(oneAgentScript, undefined, {
      agentRetries: 1,
      agentTurnRetry: { enabled: false, maxRetries: 1 },
      hostRetryPolicy: {
        agentTurn: { enabled: true, maxRetries: 3, baseDelayMs: 1000 },
        providerRequest: { maxRetryDelayMs: 30_000 },
      },
    });
    const summary = manager.listRuns()[0];
    assert.ok(summary);
    assert.equal("executionPolicy" in summary, false);
    assert.deepEqual(manager.loadRun(summary.runId)?.executionPolicy, {
      agentTurnRetry: { enabled: false, maxRetries: 1 },
      agentRunRetries: 1,
    });
  }),
);

test(
  "runSync persists the run immediately (visible while still running)",
  withTempCwd(async (cwd) => {
    const manager = new WorkflowManager({ cwd, agent: fakeAgent() });
    let listedWhileRunning = 0;
    manager.on("agentStart", () => {
      listedWhileRunning = manager.listRuns().filter((r) => r.status === "running").length;
    });
    await manager.runSync(oneAgentScript);
    assert.equal(listedWhileRunning, 1, "the run shows as running in listRuns mid-flight");
  }),
);

test(
  "each agent's concrete model and effort are recorded for /workflows",
  withTempCwd(async (cwd) => {
    const mainModel = { provider: "anthropic", id: "claude-opus-4-8", name: "opus", reasoning: false } as any;
    const selectedModel = { provider: "openai", id: "gpt-5-mini", name: "mini", reasoning: false } as any;
    const modelRegistry = { getAvailable: () => [mainModel, selectedModel] } as any;
    const manager = new WorkflowManager({
      cwd,
      agent: fakeAgent(),
      mainModel: "anthropic/claude-opus-4-8",
      modelRegistry,
      session: { model: mainModel },
    });
    const script = `export const meta = { name: 'model_demo', description: 'per-agent models' }
const a = await agent('explore', { label: 'scan', model: 'openai/gpt-5-mini' })
const b = await agent('reason', { label: 'judge' })
return { a, b }`;
    await manager.runSync(script);

    const summary = manager.listRuns().find((r) => r.workflowName === "model_demo");
    const run = summary ? manager.loadRun(summary.runId) : null;
    const byLabel = Object.fromEntries((run?.agents ?? []).map((a) => [a.label, a.model]));
    assert.equal(byLabel.scan, "openai/gpt-5-mini", "explicit per-agent model is recorded");
    assert.equal(byLabel.judge, "anthropic/claude-opus-4-8", "default agent shows the main model");
    assert.ok(run?.agents.every((a) => a.effort === "off"));
    assert.equal(run?.defaultModel, "anthropic/claude-opus-4-8");
  }),
);

test(
  "runSync persists recoverable agent error details for /workflows",
  withTempCwd(async (cwd) => {
    const manager = new WorkflowManager({
      cwd,
      agent: {
        async run() {
          throw new Error("HTTP 503 service unavailable");
        },
      },
    });

    await manager.runSync(oneAgentScript);

    const summary = manager.listRuns().find((r) => r.workflowName === "tracked_demo");
    const run = summary ? manager.loadRun(summary.runId) : null;
    const agent = run?.agents[0];
    assert.equal(agent?.status, "error");
    assert.equal(agent?.error, "HTTP 503 service unavailable");
    assert.equal(agent?.errorCode, WorkflowErrorCode.AGENT_EXECUTION_ERROR);
    assert.equal(agent?.recoverable, true);
  }),
);

test(
  "runSync stores compact subagent history for /workflows detail",
  withTempCwd(async (cwd) => {
    const manager = new WorkflowManager({
      cwd,
      agent: {
        async run(_prompt: string, options: { onHistory?: (history: unknown[]) => void }) {
          options.onHistory?.([{ role: "assistant", kind: "text", text: "inspecting files" }]);
          return "ok";
        },
      },
    });

    await manager.runSync(oneAgentScript);

    const summary = manager.listRuns().find((r) => r.workflowName === "tracked_demo");
    const run = summary ? manager.loadRun(summary.runId) : null;
    const agent = run?.agents[0];
    assert.equal(agent?.history?.length, 1);
    assert.equal(agent?.history?.[0]?.text, "inspecting files");
  }),
);

test(
  "startInBackground returns immediately with runId and promise",
  withTempCwd(async (cwd) => {
    const manager = new WorkflowManager({ cwd, agent: fakeAgent() });
    const { runId, promise } = manager.startInBackground(oneAgentScript);
    assert.ok(runId, "should generate a run id");
    assert.ok(promise instanceof Promise, "should return a promise");
    const runs = manager.listRuns();
    assert.equal(runs.length, 1);
    assert.equal(runs[0].runId, runId);
    assert.equal(runs[0].status, "running");
    await promise;
  }),
);

test(
  "startInBackground result resolves on completion",
  withTempCwd(async (cwd) => {
    const manager = new WorkflowManager({ cwd, agent: fakeAgent({ total: 50 }) });
    const { promise } = manager.startInBackground(oneAgentScript);
    const result = await promise;
    assert.equal(result.agentCount, 1);
    assert.equal(result.meta.name, "tracked_demo");
  }),
);

test(
  "stop stops a running workflow and transitions to aborted",
  withTempCwd(async (cwd) => {
    const da = deferredAgent();
    const manager = new WorkflowManager({ cwd, agent: da.runner });
    // Suppress the expected unhandled rejection from the aborted run
    manager.on("error", () => {});
    const { runId, promise } = manager.startInBackground(oneAgentScript);
    // Wait a tick for the run to start processing
    await new Promise((r) => setTimeout(r, 20));
    const stopped = manager.stop(runId);
    assert.equal(stopped, true);
    const run = manager.getRun(runId);
    assert.equal(run?.status, "aborted", "run should be aborted");
    // Clean up: resolve the deferred agent and catch the expected rejection
    da.resolve("done");
    await promise.catch(() => {});
  }),
);

test(
  "stop returns false for nonexistent run",
  withTempCwd(async (cwd) => {
    const manager = new WorkflowManager({ cwd });
    assert.equal(manager.stop("nonexistent"), false);
  }),
);

test(
  "pause pauses a running workflow",
  withTempCwd(async (cwd) => {
    const da = deferredAgent();
    const manager = new WorkflowManager({ cwd, agent: da.runner });
    manager.on("error", () => {});
    const { runId, promise } = manager.startInBackground(oneAgentScript);
    await new Promise((r) => setTimeout(r, 20));
    const paused = manager.pause(runId);
    assert.equal(paused, true);
    const run = manager.getRun(runId);
    assert.equal(run?.status, "paused", "run should be paused");
    da.resolve("done");
    await promise.catch(() => {});
  }),
);

test(
  "pause returns false for nonexistent run",
  withTempCwd(async (cwd) => {
    const manager = new WorkflowManager({ cwd });
    assert.equal(manager.pause("nonexistent"), false);
  }),
);

test(
  "getRun returns undefined for unknown run id",
  withTempCwd(async (cwd) => {
    const manager = new WorkflowManager({ cwd });
    const run = manager.getRun("no-such-run");
    assert.equal(run, undefined);
  }),
);

test(
  "getSnapshot returns null for unknown run",
  withTempCwd(async (cwd) => {
    const manager = new WorkflowManager({ cwd });
    const snap = manager.getSnapshot("unknown");
    assert.equal(snap, null);
  }),
);

test(
  "deleteRun removes the run from memory and persistence",
  withTempCwd(async (cwd) => {
    const manager = new WorkflowManager({ cwd, agent: fakeAgent() });
    const { runId } = manager.startInBackground(oneAgentScript);
    // Wait for completion first (fast agent)
    await new Promise((r) => setTimeout(r, 30));
    const deletion = manager.deleteRun(runId);
    const deleted = await deletion;
    assert.equal(deleted, "deleted");
    assert.equal(manager.getRun(runId), undefined);
  }),
);

test(
  "deleteRun returns false for nonexistent run",
  withTempCwd(async (cwd) => {
    const manager = new WorkflowManager({ cwd });
    assert.equal(await manager.deleteRun("nonexistent"), "not_found");
  }),
);

test(
  "setModelRegistry stores the registry and forwards it to subagent runs",
  withTempCwd(async (cwd) => {
    const fakeRegistry = {
      getAvailable: () => [{ provider: "mock", id: "m" }],
      find: () => undefined,
    } as any;
    const rec = new (class {
      calls: Array<{ options: any }> = [];
      async run(_prompt: string, options: any) {
        this.calls.push({ options });
        options.onUsage?.({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 });
        return "ok";
      }
    })();
    const manager = new WorkflowManager({ cwd, agent: rec });
    manager.setModelRegistry(fakeRegistry);
    await manager.runSync(oneAgentScript);
    assert.equal(rec.calls.length, 1);
    assert.equal(rec.calls[0].options.modelRegistry, fakeRegistry);
  }),
);

test(
  "setMainModel sets the main model used for default agents",
  withTempCwd(async (cwd) => {
    const manager = new WorkflowManager({ cwd, agent: fakeAgent() });
    manager.setMainModel("anthropic/claude-sonnet-4");
    const script = `export const meta = { name: 'mm_test', description: 'main model test' }
const a = await agent('test', { label: 'a' })
return { a }`;
    await manager.runSync(script);
    const run = manager.listRuns().find((r) => r.workflowName === "mm_test");
    assert.ok(run, "run should exist");
  }),
);

test(
  "runSync emits manager events (agentStart -> agentEnd -> complete)",
  withTempCwd(async (cwd) => {
    const manager = new WorkflowManager({ cwd, agent: fakeAgent() });
    const events: string[] = [];
    manager.on("agentStart", () => events.push("agentStart"));
    manager.on("agentEnd", () => events.push("agentEnd"));
    manager.on("complete", () => events.push("complete"));
    await manager.runSync(oneAgentScript);
    assert.deepEqual(events, ["agentStart", "agentEnd", "complete"]);
  }),
);

test(
  "resume returns false when run is already running",
  withTempCwd(async (cwd) => {
    const da = deferredAgent();
    const manager = new WorkflowManager({ cwd, agent: da.runner });
    const { runId, promise } = manager.startInBackground(oneAgentScript);
    await new Promise((r) => setTimeout(r, 20));
    const resumed = await manager.resume(runId);
    assert.equal(resumed, false);
    da.resolve("done");
    await promise.catch(() => {});
  }),
);

test(
  "resume returns false when run doesn't exist",
  withTempCwd(async (cwd) => {
    const manager = new WorkflowManager({ cwd });
    const resumed = await manager.resume("nonexistent");
    assert.equal(resumed, false);
  }),
);

test(
  "manager emits complete event with runId",
  withTempCwd(async (cwd) => {
    const manager = new WorkflowManager({ cwd, agent: fakeAgent() });
    let capturedId = "";
    manager.on("complete", ({ runId }: { runId: string }) => {
      capturedId = runId;
    });
    await manager.runSync(oneAgentScript);
    assert.ok(capturedId, "should capture runId on complete");
  }),
);

test(
  "stop returns false for completed/aborted run",
  withTempCwd(async (cwd) => {
    const manager = new WorkflowManager({ cwd, agent: fakeAgent() });
    const { runId, promise } = manager.startInBackground(oneAgentScript);
    await promise; // wait for completion
    const stopped = manager.stop(runId);
    assert.equal(stopped, false, "cannot stop an already completed run");
  }),
);

test(
  "pause returns false for completed run",
  withTempCwd(async (cwd) => {
    const manager = new WorkflowManager({ cwd, agent: fakeAgent() });
    const { runId, promise } = manager.startInBackground(oneAgentScript);
    await promise; // wait for completion
    const paused = manager.pause(runId);
    assert.equal(paused, false, "cannot pause completed run");
  }),
);

// ─── Abort propagation tests ───────────────────────────────────────────────────

test(
  "abort via externalSignal propagates through workflow execution and yields WorkflowError",
  withTempCwd(async (cwd) => {
    const ac = new AbortController();
    const da = deferredAgent();
    const manager = new WorkflowManager({ cwd, agent: da.runner });
    let errorEmitted = false;
    manager.on("error", () => {
      errorEmitted = true;
    });

    // runSync with externalSignal links the abort controller to the manager
    const runPromise = manager.runSync(oneAgentScript, undefined, {
      externalSignal: ac.signal,
    });

    // Let the agent start (deferred, so it hangs inside agentRunner.run())
    await new Promise((r) => setTimeout(r, 20));

    // Abort from outside — this triggers managed.controller.abort()
    ac.abort();

    // Resolve the deferred agent so the in-flight agent completes,
    // then throwIfAborted() fires and the error propagates.
    da.resolve("done");

    try {
      await runPromise;
      assert.fail("runSync should have thrown on abort");
    } catch (err) {
      assert.ok(err instanceof WorkflowError, "error should be WorkflowError");
      assert.equal(
        (err as WorkflowError).code,
        WorkflowErrorCode.WORKFLOW_ABORTED,
        "error code should be WORKFLOW_ABORTED",
      );
      assert.ok((err as WorkflowError).recoverable, "abort error should be recoverable");
    }

    assert.equal(errorEmitted, true, "manager should emit 'error' event on abort");
  }),
);

test(
  "abort via externalSignal does not crash Pi (no uncaught exception)",
  withTempCwd(async (cwd) => {
    const ac = new AbortController();
    const da = deferredAgent();
    const manager = new WorkflowManager({ cwd, agent: da.runner });
    manager.on("error", () => {});

    let uncaughtFromTest: Error | null = null;
    const errorHandler = (err: Error) => {
      uncaughtFromTest = err;
    };
    process.on("uncaughtException", errorHandler);

    try {
      const runPromise = manager.runSync(oneAgentScript, undefined, {
        externalSignal: ac.signal,
      });
      await new Promise((r) => setTimeout(r, 20));
      ac.abort();
      da.resolve("done");

      try {
        await runPromise;
      } catch {
        // Expected — abort throws WorkflowError
      }

      // Give microtasks a chance to settle
      await new Promise((r) => setTimeout(r, 20));

      assert.equal(uncaughtFromTest, null, "abort should NOT produce an uncaught exception");
    } finally {
      process.off("uncaughtException", errorHandler);
    }
  }),
);

test(
  "abort mid-way through multi-agent workflow: remaining agents are skipped",
  withTempCwd(async (cwd) => {
    // Per-call deferred agent: each call to run() gets its own promise.
    const resolves: Array<(v: unknown) => void> = [];
    let callIdx = 0;
    const multiDa = {
      resolve(idx: number, v: unknown = "done") {
        resolves[idx]?.(v);
      },
      runner: {
        async run(_prompt: string, _options?: { onUsage?: (u: AgentUsage) => void }) {
          const idx = callIdx++;
          return new Promise((resolve) => {
            resolves[idx] = resolve;
          });
        },
      },
    };

    const manager = new WorkflowManager({ cwd, agent: multiDa.runner });
    manager.on("error", () => {});

    const twoAgentScript = `export const meta = { name: 'two_agent', description: 'two agents test' }
const a = await agent('first', { label: 'first' })
const b = await agent('second', { label: 'second' })
return { a, b }`;

    const { runId, promise } = manager.startInBackground(twoAgentScript);
    await new Promise((r) => setTimeout(r, 20));

    // Let agent 1 complete (gets journaled)
    multiDa.resolve(0, "first-done");
    // Wait for agent 1's result to be journaled and agent 2 to start
    await new Promise((r) => setTimeout(r, 30));

    // Stop the run while agent 2 is in-flight
    const stopped = manager.stop(runId);
    assert.equal(stopped, true, "stop should succeed");

    // Resolve agent 2 so the abort/throwIfAborted path executes
    multiDa.resolve(1, "second-done");
    await promise.catch(() => {});

    // Verify the run is aborted
    const persisted = manager.listRuns().find((r) => r.runId === runId);
    assert.equal(persisted?.status, "aborted", "run should be aborted after stop");

    const agents = manager.loadRun(runId)?.agents;
    assert.equal(agents?.find((agent) => agent.label === "first")?.status, "done");
    assert.equal(agents?.find((agent) => agent.label === "second")?.status, "skipped");
    assert.ok(agents?.find((agent) => agent.label === "second")?.endedAt);

    // Verify the error is a WorkflowError
    const managedRun = manager.getRun(runId);
    assert.ok(managedRun?.error instanceof WorkflowError, "error should be instance of WorkflowError");
    assert.equal((managedRun.error as WorkflowError).code, WorkflowErrorCode.WORKFLOW_ABORTED);
  }),
);

// ─── Stop tests ────────────────────────────────────────────────────────────────

test(
  "stop on paused run transitions to aborted",
  withTempCwd(async (cwd) => {
    const da = deferredAgent();
    const manager = new WorkflowManager({ cwd, agent: da.runner });
    manager.on("error", () => {});
    const { runId, promise } = manager.startInBackground(oneAgentScript);
    await new Promise((r) => setTimeout(r, 20));

    // Pause first
    const paused = manager.pause(runId);
    assert.equal(paused, true);
    assert.equal(manager.getRun(runId)?.status, "paused");

    // Then stop the paused run
    const stopped = manager.stop(runId);
    assert.equal(stopped, true);
    assert.equal(manager.getRun(runId)?.status, "aborted", "paused run should become aborted after stop");

    da.resolve("done");
    await promise.catch(() => {});
  }),
);

test(
  "stop emits 'stopped' event with runId",
  withTempCwd(async (cwd) => {
    const da = deferredAgent();
    const manager = new WorkflowManager({ cwd, agent: da.runner });
    manager.on("error", () => {});

    let stoppedEvent: { runId: string } | null = null;
    manager.on("stopped", (ev: { runId: string }) => {
      stoppedEvent = ev;
    });

    const { runId, promise } = manager.startInBackground(oneAgentScript);
    await new Promise((r) => setTimeout(r, 20));
    manager.stop(runId);

    assert.ok(stoppedEvent, "stopped event should fire");
    assert.equal(stoppedEvent?.runId, runId);

    da.resolve("done");
    await promise.catch(() => {});
  }),
);

test(
  "stop returns false for already-stopped run",
  withTempCwd(async (cwd) => {
    const da = deferredAgent();
    const manager = new WorkflowManager({ cwd, agent: da.runner });
    manager.on("error", () => {});
    const { runId, promise } = manager.startInBackground(oneAgentScript);
    await new Promise((r) => setTimeout(r, 20));

    manager.stop(runId);
    const secondStop = manager.stop(runId);
    assert.equal(secondStop, false, "second stop on same run should return false");

    da.resolve("done");
    await promise.catch(() => {});
  }),
);

// ─── Pause tests ───────────────────────────────────────────────────────────────

test(
  "pause emits 'paused' event with runId",
  withTempCwd(async (cwd) => {
    const da = deferredAgent();
    const manager = new WorkflowManager({ cwd, agent: da.runner });
    manager.on("error", () => {});

    let pausedEvent: { runId: string } | null = null;
    manager.on("paused", (ev: { runId: string }) => {
      pausedEvent = ev;
    });

    const { runId, promise } = manager.startInBackground(oneAgentScript);
    await new Promise((r) => setTimeout(r, 20));
    manager.pause(runId);

    assert.ok(pausedEvent, "paused event should fire");
    assert.equal(pausedEvent?.runId, runId);

    da.resolve("done");
    await promise.catch(() => {});
  }),
);

test(
  "pause returns false for already-stopped run",
  withTempCwd(async (cwd) => {
    const da = deferredAgent();
    const manager = new WorkflowManager({ cwd, agent: da.runner });
    manager.on("error", () => {});
    const { runId, promise } = manager.startInBackground(oneAgentScript);
    await new Promise((r) => setTimeout(r, 20));

    manager.stop(runId);
    const paused = manager.pause(runId);
    assert.equal(paused, false, "cannot pause an already stopped/aborted run");

    da.resolve("done");
    await promise.catch(() => {});
  }),
);

test(
  "pause returns false for already-paused run",
  withTempCwd(async (cwd) => {
    const da = deferredAgent();
    const manager = new WorkflowManager({ cwd, agent: da.runner });
    manager.on("error", () => {});
    const { runId, promise } = manager.startInBackground(oneAgentScript);
    await new Promise((r) => setTimeout(r, 20));

    manager.pause(runId);
    const secondPause = manager.pause(runId);
    assert.equal(secondPause, false, "second pause on same run should return false");

    da.resolve("done");
    await promise.catch(() => {});
  }),
);

// ─── Resume tests ──────────────────────────────────────────────────────────────

test(
  "resume full cycle: pause then resume then complete",
  withTempCwd(async (cwd) => {
    const da = deferredAgent();
    const manager = new WorkflowManager({ cwd, agent: da.runner });
    manager.on("error", () => {});

    const { runId, promise: origPromise } = manager.startInBackground(oneAgentScript);
    await new Promise((r) => setTimeout(r, 20));

    // Pause while the deferred agent is in-flight
    const paused = manager.pause(runId);
    assert.equal(paused, true);
    assert.equal(manager.getRun(runId)?.status, "paused");

    da.resolve("old-run-settled");
    await origPromise.catch(() => {});
    da.runner.run = async () => "resumed-done";

    // Resume — replays journal (empty for single-agent that never completed) and
    // re-runs the live agent with a fresh (non-aborted) controller.
    const resumed = await manager.resume(runId);
    assert.equal(resumed, true, "resume should succeed");

    // Wait for the resumed run to complete
    await new Promise((r) => setTimeout(r, 50));

    const finalRun = manager.getRun(runId);
    assert.equal(finalRun?.status, "completed", "resumed run should complete successfully");
    assert.equal(finalRun?.result?.result?.a, "resumed-done", "resumed run should have the agent result");

    // The run should also appear in listRuns as completed
    const persisted = manager.listRuns().find((r) => r.runId === runId);
    assert.equal(persisted?.status, "completed");
  }),
);

test(
  "resume with journal replay replays completed agents and runs remaining live",
  withTempCwd(async (cwd) => {
    // Use a multi-agent workflow: agent 1 completes before pause (gets journaled),
    // agent 2 runs live after resume.
    const da = deferredAgent();
    const manager = new WorkflowManager({ cwd, agent: da.runner });
    manager.on("error", () => {});

    const twoAgentScript = `export const meta = { name: 'two_agent', description: 'two agents test' }
const a = await agent('first', { label: 'first' })
const b = await agent('second', { label: 'second' })
return { a, b }`;

    const { runId, promise: origPromise } = manager.startInBackground(twoAgentScript);
    await new Promise((r) => setTimeout(r, 20));

    // Let agent 1 complete
    da.resolve("first-result");
    await new Promise((r) => setTimeout(r, 30));

    // Agent 1 should have completed and been journaled. Pause.
    const paused = manager.pause(runId);
    const statusAtPause = manager.getRun(runId)?.status;

    if (paused) {
      assert.equal(statusAtPause, "paused");

      // Journal should have at least agent 1's entry
      const persisted = manager.loadRun(runId);
      assert.ok(persisted?.journal && persisted.journal.length >= 1, "journal should have at least one entry");

      // Resume
      const resumed = await manager.resume(runId);
      assert.equal(resumed, true);

      // Wait for resumed run to complete (agent 1 replayed from journal, agent 2 live)
      await new Promise((r) => setTimeout(r, 50));

      const finalRun = manager.getRun(runId);
      assert.equal(finalRun?.status, "completed", "resumed multi-agent run should complete");
      assert.equal(finalRun?.result?.result?.a, "first-result");
    }

    await origPromise.catch(() => {});
  }),
);

test(
  "a provider usage limit pauses the run (not failed) and is resumable, replaying the journal",
  withTempCwd(async (cwd) => {
    let limitActive = true;
    const manager = new WorkflowManager({
      cwd,
      agent: {
        async run(prompt: string) {
          if (prompt.includes("second") && limitActive) {
            throw new WorkflowError(
              "Codex usage limit reached (plus plan). Resets in ~3h.",
              WorkflowErrorCode.PROVIDER_USAGE_LIMIT,
              { recoverable: false, resetHint: "Resets in ~3h" },
            );
          }
          return prompt.includes("first") ? "first-result" : "second-result";
        },
      },
    });
    const pausedEvents: Array<{ runId: string; reason?: string; resetHint?: string }> = [];
    manager.on("paused", (e: { runId: string; reason?: string; resetHint?: string }) => pausedEvents.push(e));

    const twoAgentScript = `export const meta = { name: 'quota_demo', description: 'two agents' }
const a = await agent('first', { label: 'first' })
const b = await agent('second', { label: 'second' })
return { a, b }`;

    const { runId, promise } = manager.startInBackground(twoAgentScript);
    await promise.catch(() => {}); // settles: rejects with PROVIDER_USAGE_LIMIT

    // The run is checkpointed as paused, not failed.
    assert.equal(manager.getRun(runId)?.status, "paused");
    const persisted = manager.loadRun(runId);
    assert.equal(persisted?.status, "paused");
    assert.equal(persisted?.pauseReason, "usage_limit");
    assert.equal(persisted?.resetHint, "Resets in ~3h");
    assert.ok((persisted?.journal?.length ?? 0) >= 1, "agent 1's result should be journaled");

    // A 'paused' event with reason usage_limit fired (not 'error').
    assert.equal(pausedEvents.length, 1);
    assert.equal(pausedEvents[0].reason, "usage_limit");
    assert.equal(pausedEvents[0].resetHint, "Resets in ~3h");

    // After the budget refills, resume replays agent 1 and runs agent 2 live to completion.
    limitActive = false;
    const resumed = await manager.resume(runId);
    assert.equal(resumed, true);
    await new Promise((r) => setTimeout(r, 50));
    const finalRun = manager.getRun(runId);
    assert.equal(finalRun?.status, "completed", "resumed run completes once the limit clears");
    assert.equal(finalRun?.result?.result?.a, "first-result");
    assert.equal(finalRun?.result?.result?.b, "second-result");
  }),
);

test(
  "a non-quota non-recoverable agent error still fails the run (control)",
  withTempCwd(async (cwd) => {
    const manager = new WorkflowManager({
      cwd,
      agent: {
        async run() {
          throw new WorkflowError("schema bad", WorkflowErrorCode.SCHEMA_NONCOMPLIANCE, { recoverable: false });
        },
      },
    });
    manager.on("error", () => {});
    const { runId, promise } = manager.startInBackground(oneAgentScript);
    await promise.catch(() => {});
    assert.equal(manager.getRun(runId)?.status, "failed");
    const persisted = manager.loadRun(runId);
    assert.equal(persisted?.pauseReason, undefined, "a real failure carries no usage-limit pause reason");
  }),
);

test(
  "resume returns false for completed run",
  withTempCwd(async (cwd) => {
    const manager = new WorkflowManager({ cwd, agent: fakeAgent() });
    const { promise } = manager.startInBackground(oneAgentScript);
    await promise; // wait for completion

    const runs = manager.listRuns();
    const runId = runs[0]?.runId;
    if (runId) {
      const resumed = await manager.resume(runId);
      assert.equal(resumed, false, "cannot resume a completed run");
    }
  }),
);

// ─── Cold-start resume tests ────────────────────────────────────────────────────
// These tests manually persist runs via the persistence layer (as though the
// process was restarted) and then resume them from disk — no in-memory state.

test(
  "cold-start resume: persisted run can be resumed from disk",
  withTempCwd(async (cwd) => {
    const manager = new WorkflowManager({ cwd, agent: fakeAgent() });
    const runId = "cold-start-ok-1";

    // Manually save a persisted run — cold-start scenario, no in-memory state
    seedRun(cwd, {
      runId,
      workflowName: "cold_start",
      script: oneAgentScript,
      args: undefined,
      status: "paused",
      phases: [],
      agents: [],
      logs: [],
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    // No in-memory run exists at this point; resume loads from persistence
    const resumed = await manager.resume(runId);
    assert.equal(resumed, true, "resume should succeed for cold-start persisted run");

    // Wait for the background execution (fake agent resolves instantly)
    await new Promise((r) => setTimeout(r, 100));

    const run = manager.getRun(runId);
    assert.ok(run, "run should be in memory after resume");
    assert.equal(run?.status, "completed", "cold-start resumed run should complete");
    assert.equal(run?.result?.result?.a, "ok", "agent result should be present");

    // Verify persistence was updated to completed
    const persisted = manager.listRuns().find((r) => r.runId === runId);
    assert.equal(persisted?.status, "completed", "persistence should reflect completed status");
  }),
);

test(
  "cold-start resume admits a current model for older additive payloads",
  withTempCwd(async (cwd) => {
    const sessionModel = { provider: "provider", id: "session", name: "session", reasoning: false } as any;
    const manager = new WorkflowManager({
      cwd,
      agent: fakeAgent(),
      session: { model: sessionModel },
      modelRegistry: { getAvailable: () => [sessionModel] } as any,
    });
    const runId = "cold-start-legacy-model-1";

    seedRun(cwd, {
      runId,
      workflowName: "cold_start_legacy_model",
      script: oneAgentScript,
      status: "paused",
      phases: [],
      agents: [],
      logs: [],
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    assert.equal(await manager.resume(runId), true);
    await new Promise((r) => setTimeout(r, 100));

    const run = manager.getRun(runId);
    assert.equal(run?.status, "completed");
    assert.equal(run?.snapshot.defaultModel, "provider/session");
    assert.equal(run?.snapshot.defaultEffort, "off");
  }),
);

test(
  "cold-start resume reuses a persisted model only when it remains available",
  withTempCwd(async (cwd) => {
    const availableModel = { provider: "provider", id: "available", name: "available", reasoning: false } as any;
    const manager = new WorkflowManager({
      cwd,
      agent: fakeAgent(),
      modelRegistry: { getAvailable: () => [availableModel] } as any,
    });
    const runId = "cold-start-available-model-1";

    seedRun(cwd, {
      runId,
      workflowName: "cold_start_available_model",
      script: oneAgentScript,
      defaultModel: "provider/available",
      defaultEffort: "off",
      status: "paused",
      phases: [],
      agents: [],
      logs: [],
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    assert.equal(await manager.resume(runId), true);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(manager.getRun(runId)?.status, "completed");
    assert.equal(manager.getRun(runId)?.snapshot.defaultModel, "provider/available");
  }),
);

test(
  "cold-start resume rejects an unavailable persisted model without invoking a child",
  withTempCwd(async (cwd) => {
    let agentCalls = 0;
    const availableModel = { provider: "provider", id: "available", name: "available", reasoning: false } as any;
    const manager = new WorkflowManager({
      cwd,
      agent: {
        async run() {
          agentCalls++;
          return "unexpected";
        },
      },
      modelRegistry: { getAvailable: () => [availableModel] } as any,
    });
    const runId = "cold-start-unavailable-model-1";

    seedRun(cwd, {
      runId,
      workflowName: "cold_start_unavailable_model",
      script: oneAgentScript,
      defaultModel: "provider/registered-only",
      defaultEffort: "off",
      status: "paused",
      phases: [],
      agents: [],
      logs: [],
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    await assert.rejects(manager.resume(runId), { code: "MODEL_SELECTION_ERROR" });
    assert.equal(agentCalls, 0, "unavailable persisted models must fail before child execution");
  }),
);

test(
  "cold-start resume reuses explicit policy while accepting a fresh host snapshot",
  withTempCwd(async (cwd) => {
    const manager = new WorkflowManager({
      cwd,
      agent: {
        async run() {
          return "ok";
        },
      },
    });
    const runId = "cold-start-policy-1";
    seedRun(cwd, {
      runId,
      workflowName: "cold_policy",
      script: oneAgentScript,
      status: "paused",
      phases: [],
      agents: [],
      logs: [],
      executionPolicy: { agentTurnRetry: { enabled: false, baseDelayMs: 250 }, agentRunRetries: 1 },
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    assert.equal(
      await manager.resume(runId, {
        hostRetryPolicy: {
          agentTurn: { enabled: true, maxRetries: 7, baseDelayMs: 900 },
          providerRequest: { timeoutMs: 5000, maxRetries: 4, maxRetryDelayMs: 30_000 },
        },
      }),
      true,
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(manager.loadRun(runId)?.executionPolicy, {
      agentTurnRetry: { enabled: false, baseDelayMs: 250 },
      agentRunRetries: 1,
    });
  }),
);

test(
  "cold-start resume enforces cumulative token spend and persisted run limits",
  withTempCwd(async (cwd) => {
    let calls = 0;
    const runId = "cold-start-cumulative-budget";
    seedRun(cwd, {
      runId,
      workflowName: "cumulative_budget",
      script: oneAgentScript,
      status: "paused",
      phases: [],
      agents: [],
      logs: [],
      tokenUsage: { input: 6, output: 4, total: 10, cost: 0, cacheRead: 0, cacheWrite: 0 },
      tokenBudget: 10,
      maxAgents: 1,
      agentTimeoutMs: 25,
      concurrency: 1,
      executionPolicy: { agentRunRetries: 1 },
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    const manager = new WorkflowManager({
      cwd,
      concurrency: 8,
      defaultAgentTimeoutMs: null,
      agent: {
        async run() {
          calls++;
          return "unexpected";
        },
      },
    });
    manager.on("error", () => {});

    assert.equal(await manager.resume(runId), true);
    const persisted = await waitForRunStatus(manager, runId, "failed");

    assert.equal(calls, 0);
    assert.equal(persisted.tokenBudget, 10);
    assert.equal(persisted.maxAgents, 1);
    assert.equal(persisted.agentTimeoutMs, 25);
    assert.equal(persisted.concurrency, 1);
    assert.deepEqual(persisted.executionPolicy, { agentRunRetries: 1 });
  }),
);

test(
  "cold-start resume: completed run cannot be resumed",
  withTempCwd(async (cwd) => {
    const manager = new WorkflowManager({ cwd });
    const runId = "cold-start-completed-1";

    seedRun(cwd, {
      runId,
      workflowName: "completed_test",
      script: oneAgentScript,
      args: undefined,
      status: "completed",
      phases: [],
      agents: [],
      logs: [],
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
    });

    const resumed = await manager.resume(runId);
    assert.equal(resumed, false, "completed persisted run cannot be resumed");
  }),
);

test(
  "cold-start resume: persisted run with empty script cannot be resumed",
  withTempCwd(async (cwd) => {
    const manager = new WorkflowManager({ cwd });
    const runId = "cold-start-noscript-1";

    seedRun(cwd, {
      runId,
      workflowName: "no_script_test",
      script: "",
      args: undefined,
      status: "paused",
      phases: [],
      agents: [],
      logs: [],
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const resumed = await manager.resume(runId);
    assert.equal(resumed, false, "persisted run with empty script cannot be resumed");
  }),
);

test(
  "cold-start resume: a second manager cannot resume a run while another manager owns the lease",
  withTempCwd(async (cwd) => {
    const ownerAgent = deferredAgent();
    const owner = new WorkflowManager({ cwd, agent: ownerAgent.runner });
    owner.on("error", () => {});
    const runId = "cold-start-leased-1";
    seedRun(cwd, {
      runId,
      workflowName: "leased",
      script: oneAgentScript,
      status: "paused",
      phases: [],
      agents: [],
      logs: [],
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    assert.equal(await owner.resume(runId), true, "first manager should acquire the lease and start");
    await new Promise((r) => setTimeout(r, 20));

    const contender = new WorkflowManager({
      cwd,
      agent: {
        async run() {
          assert.fail("second manager must not run an agent without the lease");
        },
      },
    });
    assert.equal(await contender.resume(runId), false, "second manager should be refused by the live lease");

    ownerAgent.resolve("done");
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(owner.getRun(runId)?.status, "completed", "leased owner should still finish");
  }),
);

test(
  "cold-start recovery leaves a live leased running run untouched",
  withTempCwd(async (cwd) => {
    const pers = createRunPersistence(cwd);
    const runId = "live-running-lease";
    const lease = pers.acquireRunLease(runId, "new");
    assert.ok(lease, "test setup should acquire the live lease");
    pers.save(
      {
        runId,
        workflowName: "live",
        script: oneAgentScript,
        status: "running",
        phases: [],
        agents: [],
        logs: [],
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      lease,
    );

    try {
      const observer = new WorkflowManager({ cwd });
      observer.initialize();
      assert.equal(pers.load(runId)?.status, "running", "live leased run is not recovered to paused");
      await observer.dispose();
    } finally {
      pers.releaseRunLease(lease);
      pers.close();
    }
  }),
);

test(
  "cold-start resume releases the lease after failure so another manager can retry",
  withTempCwd(async (cwd) => {
    const failing = new WorkflowManager({
      cwd,
      agent: {
        async run() {
          throw new WorkflowError("boom", WorkflowErrorCode.UNKNOWN, { recoverable: false });
        },
      },
    });
    failing.on("error", () => {});
    const runId = "failed-lease-retry";
    seedRun(cwd, {
      runId,
      workflowName: "failed_once",
      script: oneAgentScript,
      status: "paused",
      phases: [],
      agents: [],
      logs: [],
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    assert.equal(await failing.resume(runId), true, "first resume starts");
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(failing.getRun(runId)?.status, "failed", "first resume failed");

    const retry = new WorkflowManager({ cwd, agent: fakeAgent() });
    assert.equal(await retry.resume(runId), true, "failed run can be resumed after lease release");
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(retry.getRun(runId)?.status, "completed", "retry manager completed the run");
  }),
);

// ─── getRun tests ──────────────────────────────────────────────────────────────

test(
  "getRun returns ManagedRun with correct fields for active background run",
  withTempCwd(async (cwd) => {
    const da = deferredAgent();
    const manager = new WorkflowManager({ cwd, agent: da.runner });
    manager.on("error", () => {});
    const { runId, promise } = manager.startInBackground(oneAgentScript);
    await new Promise((r) => setTimeout(r, 20));

    const run = manager.getRun(runId);
    assert.ok(run, "getRun should return the managed run");
    assert.equal(run?.runId, runId);
    assert.equal(run?.status, "running");
    assert.equal(run?.script, oneAgentScript);
    assert.ok(run?.controller instanceof AbortController, "should have an AbortController");
    assert.ok(run?.startedAt instanceof Date, "should have a startedAt date");
    assert.equal(run?.background, true, "should be marked as background");
    assert.ok(Array.isArray(run?.journal), "should have a journal array");

    // snapshot should be populated
    assert.equal(run?.snapshot.name, "tracked_demo");

    da.resolve("done");
    await promise.catch(() => {});
  }),
);

test(
  "getRun returns ManagedRun with status 'aborted' after stop",
  withTempCwd(async (cwd) => {
    const da = deferredAgent();
    const manager = new WorkflowManager({ cwd, agent: da.runner });
    manager.on("error", () => {});
    const { runId, promise } = manager.startInBackground(oneAgentScript);
    await new Promise((r) => setTimeout(r, 20));

    manager.stop(runId);
    const run = manager.getRun(runId);
    assert.equal(run?.status, "aborted");

    da.resolve("done");
    await promise.catch(() => {});
  }),
);

test(
  "getRun returns undefined after deleteRun",
  withTempCwd(async (cwd) => {
    const da = deferredAgent();
    const manager = new WorkflowManager({ cwd, agent: da.runner });
    manager.on("error", () => {});
    const { runId, promise } = manager.startInBackground(oneAgentScript);
    await new Promise((r) => setTimeout(r, 20));

    // Stop first, then delete
    manager.stop(runId);
    const deletion = manager.deleteRun(runId);
    da.resolve("done");
    const deleted = await deletion;
    assert.equal(deleted, "deleted");

    const run = manager.getRun(runId);
    assert.equal(run, undefined, "deleted run should not be accessible");

    await promise.catch(() => {});
  }),
);

// ─── deleteRun tests ───────────────────────────────────────────────────────────

test(
  "deleteRun can delete a running run (removes from memory and persistence)",
  withTempCwd(async (cwd) => {
    const da = deferredAgent();
    const manager = new WorkflowManager({ cwd, agent: da.runner });
    manager.on("error", () => {});
    const { runId, promise } = manager.startInBackground(oneAgentScript);
    await new Promise((r) => setTimeout(r, 20));

    // Delete while running — should succeed (removes from tracking)
    const deletion = manager.deleteRun(runId);
    da.resolve("done");
    const deleted = await deletion;
    assert.equal(deleted, "deleted");

    // Should not be in memory
    assert.equal(manager.getRun(runId), undefined);

    // Should not be in persistence
    const runs = manager.listRuns();
    assert.equal(
      runs.find((r) => r.runId === runId),
      undefined,
    );

    await promise.catch(() => {});
  }),
);

test(
  "deleteRun deletes persisted journal entries",
  withTempCwd(async (cwd) => {
    const manager = new WorkflowManager({ cwd, agent: fakeAgent() });
    const { runId } = manager.startInBackground(oneAgentScript);
    // Wait for completion
    await new Promise((r) => setTimeout(r, 30));

    const deleted = await manager.deleteRun(runId);
    assert.equal(deleted, "deleted");

    // Verify persistence file is gone by checking listRuns
    const runs = manager.listRuns();
    assert.equal(runs.length, 0, "no persisted runs should remain after delete");
  }),
);

// ─── startInBackground tests ───────────────────────────────────────────────────

test(
  "startInBackground with args propagates args to workflow script",
  withTempCwd(async (cwd) => {
    // Script that uses args
    const argsScript = `export const meta = { name: 'args_demo', description: 'args test' }
const a = await agent('do it', { label: 'a' })
return { args, a }`;

    const manager = new WorkflowManager({ cwd, agent: fakeAgent({ total: 50 }) });
    const { promise } = manager.startInBackground(argsScript, { mode: "test", value: 42 });
    const result = await promise;
    assert.ok(result, "should complete successfully");
  }),
);

test(
  "startInBackground runId is unique per call",
  withTempCwd(async (cwd) => {
    const manager = new WorkflowManager({ cwd, agent: fakeAgent() });
    const r1 = manager.startInBackground(oneAgentScript);
    const r2 = manager.startInBackground(oneAgentScript);
    assert.notEqual(r1.runId, r2.runId, "runIds should be unique");

    // Wait for both to complete
    await Promise.allSettled([r1.promise, r2.promise]);
  }),
);

test(
  "startInBackground snapshot is initially populated with workflow name",
  withTempCwd(async (cwd) => {
    const manager = new WorkflowManager({ cwd, agent: fakeAgent() });
    const { runId, promise } = manager.startInBackground(oneAgentScript);
    const snap = manager.getSnapshot(runId);
    assert.equal(snap?.name, "tracked_demo");
    assert.equal(snap?.description, "one agent");
    assert.ok(Array.isArray(snap?.phases), "snap.phases should be an array");
    assert.ok(Array.isArray(snap?.logs), "snap.logs should be an array");
    await promise.catch(() => {});
  }),
);

// ─── Multiple runs lifecycle tests ─────────────────────────────────────────────

test(
  "multiple background runs are independently managed",
  withTempCwd(async (cwd) => {
    const da = deferredAgent();
    const manager = new WorkflowManager({ cwd, agent: da.runner });
    manager.on("error", () => {});

    const r1 = manager.startInBackground(oneAgentScript);
    const r2 = manager.startInBackground(oneAgentScript);
    await new Promise((r) => setTimeout(r, 30));

    // Both should be running
    assert.equal(manager.getRun(r1.runId)?.status, "running");
    assert.equal(manager.getRun(r2.runId)?.status, "running");

    // Stop one independently
    manager.stop(r1.runId);
    assert.equal(manager.getRun(r1.runId)?.status, "aborted");
    assert.equal(manager.getRun(r2.runId)?.status, "running", "other run should still be running");

    // listRuns should show both
    const runs = manager.listRuns();
    assert.equal(runs.length, 2, "both runs should be listed");

    da.resolve("done");
    await Promise.allSettled([r1.promise, r2.promise]);
  }),
);

test(
  "listRuns reflects status changes after pause and stop",
  withTempCwd(async (cwd) => {
    const da = deferredAgent();
    const manager = new WorkflowManager({ cwd, agent: da.runner });
    manager.on("error", () => {});

    const { runId, promise } = manager.startInBackground(oneAgentScript);
    await new Promise((r) => setTimeout(r, 20));

    // Pause
    manager.pause(runId);
    let persisted = manager.listRuns().find((r) => r.runId === runId);
    assert.equal(persisted?.status, "paused", "listRuns should show paused status");

    // Stop
    manager.stop(runId);
    persisted = manager.listRuns().find((r) => r.runId === runId);
    assert.equal(persisted?.status, "aborted", "listRuns should show aborted status after stop");

    da.resolve("done");
    await promise.catch(() => {});
  }),
);

// ─── Event tests ───────────────────────────────────────────────────────────────

test(
  "listRuns reflects running status immediately after resume",
  withTempCwd(async (cwd) => {
    const da = deferredAgent();
    const manager = new WorkflowManager({ cwd, agent: da.runner });
    manager.on("error", () => {});

    const { runId, promise } = manager.startInBackground(oneAgentScript);
    await new Promise((resolve) => setTimeout(resolve, 20));
    manager.pause(runId);

    da.resolve("old-run-settled");
    await promise.catch(() => {});
    let releaseResumed: (() => void) | undefined;
    da.runner.run = async () => new Promise<void>((resolve) => (releaseResumed = resolve));

    const resumed = await manager.resume(runId);
    const persisted = manager.listRuns().find((run) => run.runId === runId);

    assert.equal(resumed, true);
    assert.equal(persisted?.status, "running", "listRuns should show running status after resume");

    releaseResumed?.();
  }),
);

test(
  "manager emits 'resumed' event on resume",
  withTempCwd(async (cwd) => {
    const da = deferredAgent();
    const manager = new WorkflowManager({ cwd, agent: da.runner });
    manager.on("error", () => {});

    let resumedEvent: { runId: string } | null = null;
    manager.on("resumed", (ev: { runId: string }) => {
      resumedEvent = ev;
    });

    const { runId, promise } = manager.startInBackground(oneAgentScript);
    await new Promise((r) => setTimeout(r, 20));
    manager.pause(runId);
    da.resolve("old-run-settled");
    await promise.catch(() => {});
    da.runner.run = async () => "done";
    await manager.resume(runId);

    assert.ok(resumedEvent, "resumed event should fire");
    assert.equal(resumedEvent?.runId, runId);
  }),
);

test(
  "manager emits 'error' event on abort with WorkflowError",
  withTempCwd(async (cwd) => {
    const ac = new AbortController();
    const da = deferredAgent();
    const manager = new WorkflowManager({ cwd, agent: da.runner });

    let capturedError: { runId: string; error: WorkflowError } | null = null;
    manager.on("error", (ev: { runId: string; error: WorkflowError }) => {
      capturedError = ev;
    });

    const runPromise = manager.runSync(oneAgentScript, undefined, {
      externalSignal: ac.signal,
    });
    await new Promise((r) => setTimeout(r, 20));
    ac.abort();
    da.resolve("done");

    try {
      await runPromise;
    } catch {
      /* expected */
    }

    assert.ok(capturedError, "error event should fire on abort");
    assert.ok(capturedError?.error instanceof WorkflowError, "error should be instance of WorkflowError");
    assert.equal(capturedError?.error.code, WorkflowErrorCode.WORKFLOW_ABORTED);
  }),
);

// ─── State transition tests ─────────────────────────────────────────────────

test(
  "state transition: running -> pause -> running (pause then resume cycle)",
  withTempCwd(async (cwd) => {
    const da = deferredAgent();
    const manager = new WorkflowManager({ cwd, agent: da.runner });
    manager.on("error", () => {});

    const { runId, promise: origPromise } = manager.startInBackground(oneAgentScript);
    await new Promise((r) => setTimeout(r, 20));

    // running -> pause -> running
    assert.equal(manager.getRun(runId)?.status, "running", "should start as running");
    assert.equal(manager.pause(runId), true);
    assert.equal(manager.getRun(runId)?.status, "paused", "should be paused after pause");

    da.resolve("old-run-settled");
    await origPromise.catch(() => {});
    da.runner.run = async () => "resumed-done";

    const resumed = await manager.resume(runId);
    assert.equal(resumed, true);
    assert.equal(manager.getRun(runId)?.status, "running", "should be running after resume");

    // Complete the resumed run
    await new Promise((r) => setTimeout(r, 30));

    assert.equal(manager.getRun(runId)?.status, "completed", "should complete after resume finishes");
  }),
);

test(
  "state transition: running -> stop (direct stop while running)",
  withTempCwd(async (cwd) => {
    const da = deferredAgent();
    const manager = new WorkflowManager({ cwd, agent: da.runner });
    manager.on("error", () => {});

    const { runId, promise } = manager.startInBackground(oneAgentScript);
    await new Promise((r) => setTimeout(r, 20));

    assert.equal(manager.getRun(runId)?.status, "running");
    assert.equal(manager.stop(runId), true);
    assert.equal(manager.getRun(runId)?.status, "aborted");

    da.resolve("done");
    await promise.catch(() => {});
  }),
);

test(
  "state transition: running -> pause -> stop (pause then stop)",
  withTempCwd(async (cwd) => {
    const da = deferredAgent();
    const manager = new WorkflowManager({ cwd, agent: da.runner });
    manager.on("error", () => {});

    const { runId, promise } = manager.startInBackground(oneAgentScript);
    await new Promise((r) => setTimeout(r, 20));

    assert.equal(manager.pause(runId), true);
    assert.equal(manager.getRun(runId)?.status, "paused");

    assert.equal(manager.stop(runId), true);
    assert.equal(manager.getRun(runId)?.status, "aborted");

    da.resolve("done");
    await promise.catch(() => {});
  }),
);

test(
  "state transition: running -> stop -> resume (stop then try resume -> false)",
  withTempCwd(async (cwd) => {
    const da = deferredAgent();
    const manager = new WorkflowManager({ cwd, agent: da.runner });
    manager.on("error", () => {});

    const { runId, promise } = manager.startInBackground(oneAgentScript);
    await new Promise((r) => setTimeout(r, 20));

    assert.equal(manager.stop(runId), true);
    assert.equal(manager.getRun(runId)?.status, "aborted");

    const resumed = await manager.resume(runId);
    assert.equal(resumed, false, "cannot resume a stopped/aborted run");

    da.resolve("done");
    await promise.catch(() => {});
  }),
);

test(
  "state transition: completed -> resume (completed run cannot be resumed -> false)",
  withTempCwd(async (cwd) => {
    const agentObj = fakeAgent();
    const runMock = test.mock.method(agentObj, "run");
    const manager = new WorkflowManager({ cwd, agent: agentObj });
    const { promise } = manager.startInBackground(oneAgentScript);
    await promise;

    const runs = manager.listRuns();
    const runId = runs[0]?.runId;
    assert.ok(runId);
    assert.equal(runs[0].status, "completed");
    assert.equal(runMock.mock.callCount(), 1, "agent.run should have been called once");

    const resumed = await manager.resume(runId);
    assert.equal(resumed, false, "cannot resume a completed run");
  }),
);

test(
  "state transition: running -> pause -> pause (double pause -> false)",
  withTempCwd(async (cwd) => {
    const da = deferredAgent();
    const manager = new WorkflowManager({ cwd, agent: da.runner });
    manager.on("error", () => {});

    const { runId, promise } = manager.startInBackground(oneAgentScript);
    await new Promise((r) => setTimeout(r, 20));

    assert.equal(manager.pause(runId), true);
    assert.equal(manager.getRun(runId)?.status, "paused");

    assert.equal(manager.pause(runId), false, "second pause should return false");
    assert.equal(manager.getRun(runId)?.status, "paused", "status should remain paused");

    da.resolve("done");
    await promise.catch(() => {});
  }),
);

// ─── Concurrency / race tests ──────────────────────────────────────────────────

test(
  "double resume on a persisted paused run returns false on second call",
  withTempCwd(async (cwd) => {
    const da = deferredAgent();
    const manager = new WorkflowManager({ cwd, agent: da.runner });
    manager.on("error", () => {});

    const { runId, promise: origPromise } = manager.startInBackground(oneAgentScript);
    await new Promise((r) => setTimeout(r, 20));

    // Pause while running so we can resume
    assert.equal(manager.pause(runId), true);
    assert.equal(manager.getRun(runId)?.status, "paused");

    da.resolve("old-run-settled");
    await origPromise.catch(() => {});
    let releaseResumed: (() => void) | undefined;
    da.runner.run = async () => new Promise<void>((resolve) => (releaseResumed = resolve));

    // First resume should succeed
    const firstResume = await manager.resume(runId);
    assert.equal(firstResume, true, "first resume should succeed");

    // The resumed run is now running; second resume should return false
    const secondResume = await manager.resume(runId);
    assert.equal(secondResume, false, "second resume should return false when the resumed run is already running");

    releaseResumed?.();
  }),
);

test(
  "concurrent pause and stop produces deterministic aborted state",
  withTempCwd(async (cwd) => {
    const da = deferredAgent();
    const manager = new WorkflowManager({ cwd, agent: da.runner });
    manager.on("error", () => {});

    const { runId, promise } = manager.startInBackground(oneAgentScript);
    await new Promise((r) => setTimeout(r, 20));

    // Call pause and stop without awaiting — synchronous in the event loop
    const _pauseResult = manager.pause(runId);
    const _stopResult = manager.stop(runId);

    // Final state must always be "aborted" because:
    //   pause transitions "running" → "paused"
    //   stop transitions "running" or "paused" → "aborted", never back to "paused"
    // Ordering 1: pause then stop → paused then aborted
    // Ordering 2: stop then pause → aborted, pause returns false
    // In every ordering: final status is "aborted".
    assert.equal(manager.getRun(runId)?.status, "aborted", "final status must be aborted regardless of ordering");

    da.resolve("done");
    await promise.catch(() => {});
  }),
);

test(
  "agent error during resume sets run to failed status",
  withTempCwd(async (cwd) => {
    const da = deferredAgent();
    const manager = new WorkflowManager({ cwd, agent: da.runner });
    manager.on("error", () => {});

    const { runId, promise: origPromise } = manager.startInBackground(oneAgentScript);
    await new Promise((r) => setTimeout(r, 20));

    // Pause while the deferred agent is in-flight
    assert.equal(manager.pause(runId), true);
    assert.equal(manager.getRun(runId)?.status, "paused");
    da.resolve("old-run-settled");
    await origPromise.catch(() => {});

    // Mock the agent runner to throw a non-recoverable WorkflowError on resume.
    // Regular Error/agent rejections get wrapped as recoverable (agent returns
    // null, workflow continues). A non-recoverable WorkflowError propagates up
    // to executeRun's catch block and sets status to "failed".
    test.mock.method(da.runner, "run", async (_prompt: string) => {
      throw new WorkflowError("fatal agent error", WorkflowErrorCode.AGENT_EXECUTION_ERROR, { recoverable: false });
    });

    try {
      // Resume — executeRun calls runWorkflow which calls the mocked runner
      const resumed = await manager.resume(runId);
      assert.equal(resumed, true, "resume should schedule the run");

      // Wait for the background executed run to process the agent error
      await new Promise((r) => setTimeout(r, 100));

      const finalRun = manager.getRun(runId);
      assert.equal(finalRun?.status, "failed", "resumed run should transition to failed when agent errors");
      assert.ok(finalRun?.error instanceof WorkflowError, "error should be a WorkflowError");
      assert.equal(
        (finalRun?.error as WorkflowError).code,
        WorkflowErrorCode.AGENT_EXECUTION_ERROR,
        "error code should be AGENT_EXECUTION_ERROR",
      );
    } finally {
      da.runner.run = async (_prompt: string) => "done";
    }
  }),
);

test(
  "two concurrent background runs are both tracked immediately in listRuns",
  withTempCwd(async (cwd) => {
    const da = deferredAgent();
    const manager = new WorkflowManager({ cwd, agent: da.runner });
    manager.on("error", () => {});

    const r1 = manager.startInBackground(oneAgentScript);
    const r2 = manager.startInBackground(oneAgentScript);

    // Both runs should be immediately visible in listRuns
    const runs = manager.listRuns();
    assert.equal(runs.length, 2, "both runs should appear in listRuns immediately after startInBackground");

    // Both should be in running status
    assert.equal(manager.getRun(r1.runId)?.status, "running");
    assert.equal(manager.getRun(r2.runId)?.status, "running");

    // Run IDs must be unique
    assert.notEqual(r1.runId, r2.runId);

    da.resolve("done");
    await Promise.allSettled([r1.promise, r2.promise]);
  }),
);

// ─── Failed state transition tests ─────────────────────────────────────────────

test(
  "pause returns false for failed run",
  withTempCwd(async (cwd) => {
    const da = deferredAgent();
    const manager = new WorkflowManager({ cwd, agent: da.runner });
    manager.on("error", () => {});

    const { runId, promise: origPromise } = manager.startInBackground(oneAgentScript);
    await new Promise((r) => setTimeout(r, 20));

    // Pause the running run so we can resume with a failing agent
    assert.equal(manager.pause(runId), true, "pause should succeed");
    assert.equal(manager.getRun(runId)?.status, "paused");
    da.resolve("old-run-settled");
    await origPromise.catch(() => {});

    // Mock agent to throw a non-recoverable WorkflowError, making the run fail
    test.mock.method(da.runner, "run", async (_prompt: string) => {
      throw new WorkflowError("fatal agent error", WorkflowErrorCode.AGENT_EXECUTION_ERROR, { recoverable: false });
    });

    try {
      // Resume — the run will fail because the mocked agent throws
      const resumed = await manager.resume(runId);
      assert.equal(resumed, true, "resume should schedule the run");
      await new Promise((r) => setTimeout(r, 100));

      // Verify the run is now in failed state
      const failedRun = manager.getRun(runId);
      assert.equal(failedRun?.status, "failed", "run should be in failed state");
      assert.ok(failedRun?.error instanceof WorkflowError, "error should be a WorkflowError");

      // pause() should return false for a failed run (requires status === "running")
      const paused = manager.pause(runId);
      assert.equal(paused, false, "pause should return false for failed run");
      assert.equal(manager.getRun(runId)?.status, "failed", "status should remain failed after rejected pause");
    } finally {
      da.runner.run = async (_prompt: string) => "done";
    }
  }),
);

test(
  "stop returns false for failed run",
  withTempCwd(async (cwd) => {
    const da = deferredAgent();
    const manager = new WorkflowManager({ cwd, agent: da.runner });
    manager.on("error", () => {});

    const { runId, promise: origPromise } = manager.startInBackground(oneAgentScript);
    await new Promise((r) => setTimeout(r, 20));

    // Pause the running run so we can resume with a failing agent
    assert.equal(manager.pause(runId), true, "pause should succeed");
    assert.equal(manager.getRun(runId)?.status, "paused");
    da.resolve("old-run-settled");
    await origPromise.catch(() => {});

    // Mock agent to throw a non-recoverable WorkflowError
    test.mock.method(da.runner, "run", async (_prompt: string) => {
      throw new WorkflowError("fatal agent error", WorkflowErrorCode.AGENT_EXECUTION_ERROR, { recoverable: false });
    });

    try {
      // Resume — the run will fail
      const resumed = await manager.resume(runId);
      assert.equal(resumed, true, "resume should schedule the run");
      await new Promise((r) => setTimeout(r, 100));

      // Verify the run is now in failed state
      const failedRun = manager.getRun(runId);
      assert.equal(failedRun?.status, "failed", "run should be in failed state");
      assert.ok(failedRun?.error instanceof WorkflowError, "error should be a WorkflowError");

      // stop() should return false for a failed run (requires "running" or "paused")
      const stopped = manager.stop(runId);
      assert.equal(stopped, false, "stop should return false for failed run");
      assert.equal(manager.getRun(runId)?.status, "failed", "status should remain failed after rejected stop");
    } finally {
      da.runner.run = async (_prompt: string) => "done";
    }
  }),
);

test(
  "resume restarts a failed run",
  withTempCwd(async (cwd) => {
    const da = deferredAgent();
    const manager = new WorkflowManager({ cwd, agent: da.runner });
    manager.on("error", () => {});

    const { runId, promise: origPromise } = manager.startInBackground(oneAgentScript);
    await new Promise((r) => setTimeout(r, 20));

    // Pause the running run
    assert.equal(manager.pause(runId), true, "pause should succeed");
    assert.equal(manager.getRun(runId)?.status, "paused");
    da.resolve("old-run-settled");
    await origPromise.catch(() => {});

    // Mock agent to throw a non-recoverable WorkflowError
    test.mock.method(da.runner, "run", async (_prompt: string) => {
      throw new WorkflowError("fatal agent error", WorkflowErrorCode.AGENT_EXECUTION_ERROR, { recoverable: false });
    });

    try {
      // Resume — the run will fail
      await manager.resume(runId);
      await new Promise((r) => setTimeout(r, 100));

      // Verify the run is now in failed state
      const failedRun = manager.getRun(runId);
      assert.equal(failedRun?.status, "failed", "run should be in failed state");
      assert.ok(failedRun?.error instanceof WorkflowError, "error should be a WorkflowError");
    } finally {
      // Restore the runner so the resumed run's agent call succeeds
      da.runner.run = async (_prompt: string) => "done";
    }

    // Resume the failed run — resume() allows failed status
    const resumed = await manager.resume(runId);
    assert.equal(resumed, true, "resume should return true for a failed run");
    assert.equal(manager.getRun(runId)?.status, "running", "resumed failed run should transition to running");

    // Wait for the resumed run to complete successfully
    await new Promise((r) => setTimeout(r, 100));

    const finalRun = manager.getRun(runId);
    assert.equal(finalRun?.status, "completed", "resumed failed run should complete successfully after restore");
  }),
);

// ─── parallel() concurrency tests ───────────────────────────────────────────

test(
  "parallel executes all items",
  withTempCwd(async (cwd) => {
    const manager = new WorkflowManager({ cwd, agent: fakeAgent() });
    const script = `export const meta = { name: 'parallel_count', description: 'count parallel agents' }
const results = await parallel([1,2,3].map(n => () => agent('task ' + n)))
return results`;
    const result = await manager.runSync(script);
    assert.equal(result.agentCount, 3, "parallel should execute all 3 agents");
    assert.ok(Array.isArray(result.result), "result should be an array");
    assert.equal(result.result.length, 3);
  }),
);

test(
  "parallel returns results in order",
  withTempCwd(async (cwd) => {
    const manager = new WorkflowManager({
      cwd,
      agent: {
        async run(prompt: string) {
          return prompt;
        },
      },
    });
    const script = `export const meta = { name: 'parallel_order', description: 'check parallel order' }
const results = await parallel([1,2,3].map(n => () => agent('task ' + n)))
return results`;
    const result = await manager.runSync(script);
    assert.equal(result.agentCount, 3, "3 agents should have run");
    assert.deepEqual(result.result, ["task 1", "task 2", "task 3"], "parallel should return results in input order");
  }),
);

test(
  "parallel with empty array returns empty",
  withTempCwd(async (cwd) => {
    const manager = new WorkflowManager({ cwd, agent: fakeAgent() });
    const script = `export const meta = { name: 'parallel_empty', description: 'empty parallel' }
const results = await parallel([])
return results`;
    const result = await manager.runSync(script);
    assert.ok(Array.isArray(result.result), "result should be an array");
    assert.equal(result.result.length, 0, "empty parallel should return empty array");
    assert.equal(result.agentCount, 0, "no agents should run with empty parallel");
  }),
);

test(
  "persistAgentSessions plumbs through the manager into runWorkflow options",
  withTempCwd(async (cwd) => {
    const manager = new WorkflowManager({ cwd, agent: fakeAgent(), persistAgentSessions: true });
    // The manager forwards the flag on every runWorkflow call; the flag is
    // captured at construction and defaults to false when omitted.
    assert.equal((manager as unknown as { persistAgentSessions: boolean }).persistAgentSessions, true);

    const defaulted = new WorkflowManager({ cwd, agent: fakeAgent() });
    assert.equal((defaulted as unknown as { persistAgentSessions: boolean }).persistAgentSessions, false);

    // The run still completes normally with the flag set (injected agent
    // runner, so no real session is created here).
    const result = await manager.runSync(oneAgentScript);
    assert.equal(result.agentCount, 1);
  }),
);

test(
  "agents receive an identifiable sessionName (workflow:<runId> <label>) for persisted sessions",
  withTempCwd(async (cwd) => {
    const seen: Array<{ label?: string; sessionName?: string }> = [];
    const manager = new WorkflowManager({
      cwd,
      persistAgentSessions: true,
      agent: {
        async run(_prompt: string, options?: { label?: string; sessionName?: string }) {
          seen.push({ label: options?.label, sessionName: options?.sessionName });
          return "ok";
        },
      },
    });
    const result = await manager.runSync(oneAgentScript);
    assert.equal(result.agentCount, 1);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].label, "a");
    assert.match(seen[0].sessionName ?? "", /^workflow:tracked-demo-[a-z0-9]+-[a-z0-9]+ a$/);
  }),
);

test(
  "same-label concurrent agents keep result and history on the correct invocation",
  withTempCwd(async (cwd) => {
    const manager = new WorkflowManager({
      cwd,
      agent: {
        async run(
          prompt: string,
          options?: { onHistory?: (history: Array<{ role: "assistant"; text: string }>) => void },
        ) {
          const delay = prompt === "A" ? 5 : 20;
          await new Promise((resolve) => setTimeout(resolve, delay));
          options?.onHistory?.([{ role: "assistant", text: `history-${prompt}` }]);
          return `result-${prompt}`;
        },
      },
    });
    const script = `export const meta = { name: 'same_label', description: 'stable invocation ids' }
return await parallel([
  () => agent('A', { label: 'same' }),
  () => agent('B', { label: 'same' }),
])`;

    const result = await manager.runSync(script, undefined, { concurrency: 2 });
    assert.deepEqual(result.result, ["result-A", "result-B"]);
    const managedRunId = manager.listRuns()[0]?.runId as string;
    const agents = manager.getSnapshot(managedRunId)?.agents ?? [];
    assert.equal(agents.length, 2);
    assert.equal(agents[0]?.prompt, "A");
    assert.equal(agents[1]?.prompt, "B");
    assert.equal(agents[0]?.resultPreview, "result-A");
    assert.equal(agents[1]?.resultPreview, "result-B");
    assert.equal(agents[0]?.history?.[0]?.text, "history-A");
    assert.equal(agents[1]?.history?.[0]?.text, "history-B");
  }),
);

test(
  "terminal run retention evicts heavy live state but preserves SQLite load and delete",
  withTempCwd(async (cwd) => {
    const manager = new WorkflowManager({ cwd, agent: fakeAgent(), maxTerminalRunsInMemory: 2 });
    const runIds: string[] = [];
    for (let index = 0; index < 4; index++) {
      await manager.runSync(oneAgentScript);
      runIds.push(manager.listRuns()[0]?.runId as string);
    }
    const unique = [...new Set(runIds)];
    assert.equal(unique.length, 4);
    assert.equal(manager.getRun(unique[0] as string), undefined);
    assert.equal(manager.getRun(unique[1] as string), undefined);
    assert.ok(manager.loadRun(unique[0] as string));
    assert.equal(manager.listRuns().length, 4);
    assert.equal(await manager.deleteRun(unique[0] as string), "deleted");
    assert.equal(manager.loadRun(unique[0] as string), null);
    assert.equal(manager.listRuns().length, 3);
  }),
);

test(
  "terminal run retention keeps a resumed run only once in the eviction queue",
  withTempCwd(async (cwd) => {
    let shouldFail = true;
    const manager = new WorkflowManager({
      cwd,
      maxTerminalRunsInMemory: 2,
      agent: {
        async run() {
          if (shouldFail) {
            throw new WorkflowError("first attempt failed", WorkflowErrorCode.UNKNOWN, { recoverable: false });
          }
          return "ok";
        },
      },
    });
    manager.on("error", () => {});

    await assert.rejects(() => manager.runSync(oneAgentScript), /first attempt failed/);
    const failedRunId = manager.listRuns().find((run) => run.status === "failed")?.runId;
    assert.ok(failedRunId);

    shouldFail = false;
    await manager.runSync(oneAgentScript);
    assert.equal(await manager.resume(failedRunId), true);
    await waitForRunStatus(manager, failedRunId, "completed");

    assert.ok(manager.getRun(failedRunId), "the resumed terminal run remains in the bounded live set");
  }),
);
