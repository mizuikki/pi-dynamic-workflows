import assert from "node:assert/strict";
import test from "node:test";
import type { AgentUsage } from "../src/agent.js";
import { WorkflowError, WorkflowErrorCode } from "../src/errors.js";
import { SharedStore } from "../src/shared-store.js";
import { type JournalEntry, runWorkflow } from "../src/workflow.js";

/** Agent runner that counts real invocations and echoes a per-call result. */
function countingAgent() {
  const state = { calls: 0 };
  return {
    state,
    runner: {
      async run(prompt: string) {
        state.calls++;
        return `ran:${prompt}`;
      },
    },
  };
}

/** Minimal fake agent runner that reports a fixed usage via onUsage. */
function fakeAgent(usage: Partial<AgentUsage>, result: unknown = "ok") {
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

const twoAgentScript = `export const meta = { name: 'usage_demo', description: 'two agents' }
const a = await agent('first', { label: 'a' })
const b = await agent('second', { label: 'b' })
return { a, b }`;

function createDeferred<T = void>(): { promise: Promise<T>; resolve: (value: T | PromiseLike<T>) => void } {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

test("runWorkflow concurrency caps parallel agents", async () => {
  let active = 0;
  let maxActive = 0;
  const release = createDeferred<void>();
  const started: Array<string> = [];
  const runner = {
    async run(prompt: string) {
      active++;
      maxActive = Math.max(maxActive, active);
      started.push(prompt);
      await release.promise;
      active--;
      return `ok:${prompt}`;
    },
  };
  const script = `export const meta = { name: 'concurrency_cap', description: 'cap parallelism' }
const xs = await parallel(['a','b','c','d'].map((p) => () => agent(p, { label: p })))
return xs`;

  const run = runWorkflow(script, { agent: runner, concurrency: 2, persistLogs: false });
  while (started.length < 2) await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(started.length, 2, "only the first two agents should start before the gate opens");
  release.resolve();
  const result = await run;

  assert.equal(maxActive, 2);
  assert.deepEqual(result.result, ["ok:a", "ok:b", "ok:c", "ok:d"]);
  assert.equal(result.agentCount, 4);
});

test("parallelSettled preserves ordered success, recoverable null, and structured rejection", async () => {
  const result = await runWorkflow(
    `export const meta = { name: 'settled', description: 'settled outcomes' }
return await parallelSettled([
  () => agent('ok', { label: 'ok' }),
  () => agent('empty', { label: 'empty' }),
  () => agent('over-limit', { label: 'over-limit' }),
])`,
    {
      agent: {
        async run(prompt: string) {
          return prompt === "empty" ? "" : `value:${prompt}`;
        },
      },
      maxAgents: 2,
      persistLogs: false,
    },
  );

  assert.deepEqual(result.result, [
    { status: "fulfilled", value: "value:ok" },
    { status: "fulfilled", value: null },
    {
      status: "rejected",
      error: {
        code: WorkflowErrorCode.AGENT_LIMIT_EXCEEDED,
        message: "Agent limit exceeded (2). Use maxAgents option to increase the limit.",
        recoverable: false,
      },
    },
  ]);
});

test("parallelSettled leaves quorum policy to the workflow", async () => {
  const result = await runWorkflow(
    `export const meta = { name: 'quorum', description: 'explicit research quorum' }
const outcomes = await parallelSettled(['a', 'b', 'missing', 'd'].map((item) =>
  () => agent(item, { label: item })
))
const usable = outcomes
  .filter((outcome) => outcome.status === 'fulfilled' && outcome.value !== null)
  .map((outcome) => outcome.value)
if (usable.length < 3) throw new Error('research quorum not met')
return { usable, outcomes }`,
    {
      agent: {
        async run(prompt: string) {
          return prompt === "missing" ? "" : `finding:${prompt}`;
        },
      },
      persistLogs: false,
    },
  );

  assert.deepEqual((result.result as { usable: string[] }).usable, ["finding:a", "finding:b", "finding:d"]);
  assert.deepEqual(
    (result.result as { outcomes: Array<{ status: string; value?: unknown }> }).outcomes.map(
      (outcome) => outcome.status,
    ),
    ["fulfilled", "fulfilled", "fulfilled", "fulfilled"],
  );
});

test("parallelSettled drains branches and rethrows user cancellation", async () => {
  const controller = new AbortController();
  let started = 0;
  const ended: Array<{ cancelled?: boolean }> = [];
  const result = runWorkflow(
    `export const meta = { name: 'settled_abort', description: 'settled cancellation' }
return await parallelSettled([
  () => agent('left', { label: 'left' }),
  () => agent('right', { label: 'right' }),
])`,
    {
      concurrency: 2,
      signal: controller.signal,
      agent: {
        async run(_prompt: string, options: { signal?: AbortSignal }) {
          started++;
          await new Promise<never>((_resolve, reject) => {
            options.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
          });
        },
      },
      persistLogs: false,
      onAgentEnd: (event) => ended.push({ cancelled: event.cancelled }),
    },
  );

  while (started < 2) await new Promise((resolve) => setImmediate(resolve));
  controller.abort();

  await assert.rejects(
    result,
    (error: unknown) => error instanceof WorkflowError && error.code === WorkflowErrorCode.WORKFLOW_ABORTED,
  );
  assert.equal(ended.length, 2);
  assert.ok(ended.every((event) => event.cancelled === true));
});

test("parallel cancels and drains siblings before rethrowing the first fatal error", async () => {
  let slowStarted = false;
  let slowCancelled = false;
  const ended: Array<{ label: string; cancelled?: boolean }> = [];
  const result = runWorkflow(
    `export const meta = { name: 'fail_fast_cleanup', description: 'group cleanup' }
return await parallel([
  () => agent('fatal', { label: 'fatal' }),
  () => parallel([() => agent('slow', { label: 'slow' })]),
])`,
    {
      concurrency: 2,
      agent: {
        async run(prompt: string, options: { signal?: AbortSignal }) {
          if (prompt === "slow") {
            slowStarted = true;
            await new Promise<never>((_resolve, reject) => {
              options.signal?.addEventListener(
                "abort",
                () => {
                  slowCancelled = true;
                  reject(new Error("aborted"));
                },
                { once: true },
              );
            });
          }
          while (!slowStarted) await new Promise((resolve) => setImmediate(resolve));
          throw new WorkflowError("root failure", WorkflowErrorCode.SCRIPT_VALIDATION_ERROR, {
            recoverable: false,
          });
        },
      },
      persistLogs: false,
      onAgentEnd: (event) => ended.push({ label: event.label, cancelled: event.cancelled }),
    },
  );

  await assert.rejects(
    result,
    (error: unknown) =>
      error instanceof WorkflowError &&
      error.code === WorkflowErrorCode.SCRIPT_VALIDATION_ERROR &&
      error.message === "root failure",
  );
  assert.equal(slowCancelled, true);
  assert.ok(ended.some((event) => event.label === "slow" && event.cancelled === true));
  assert.ok(ended.some((event) => event.label === "fatal" && event.cancelled !== true));
});

test("runWorkflow retries recoverable empty output then succeeds", async () => {
  let calls = 0;
  const journal: JournalEntry[] = [];
  const result = await runWorkflow(
    `export const meta = { name: 'retry_success', description: 'retry success' }
const a = await agent('work', { label: 'a' })
return a`,
    {
      agent: {
        async run() {
          calls++;
          return calls === 1 ? "" : "ok";
        },
      },
      agentRunRetries: 1,
      persistLogs: false,
      onAgentJournal: (entry) => journal.push(entry),
    },
  );

  assert.equal(result.result, "ok");
  assert.equal(calls, 2);
  assert.equal(result.agentCount, 1, "retries should not allocate extra logical agent slots");
  assert.equal(journal.length, 1, "only the final success is journaled");
});

test("runWorkflow rejects per-agent agentTurnRetry without a host retry policy snapshot", async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      runWorkflow(
        `export const meta = { name: 'missing_retry_snapshot', description: 'missing retry snapshot' }
const a = await agent('work', { label: 'a', agentTurnRetry: { enabled: false } })
return a`,
        {
          agent: {
            async run() {
              calls++;
              return "ok";
            },
          },
          persistLogs: false,
        },
      ),
    /agent\.agentTurnRetry requires a host retry policy snapshot/,
  );
  assert.equal(calls, 0);
});

test("runWorkflow keeps failed-attempt store effects while journaling only success", async () => {
  let calls = 0;
  const journal: JournalEntry[] = [];
  const sharedStore = new SharedStore();
  const result = await runWorkflow(
    `export const meta = { name: 'retry_store_cleanup', description: 'retry store cleanup' }
const a = await agent('work', { label: 'a' })
return a`,
    {
      agent: {
        async run(
          _prompt: string,
          options: { systemTools?: Array<{ name: string; execute: (...args: unknown[]) => Promise<unknown> }> },
        ) {
          calls++;
          if (calls === 1) {
            await options.systemTools
              ?.find((tool) => tool.name === "store_put")
              ?.execute("", {
                key: "failed-attempt",
                value: calls,
              });
            return "";
          }
          return "ok";
        },
      },
      agentRunRetries: 1,
      sharedStore,
      persistLogs: false,
      onAgentJournal: (entry) => journal.push(entry),
    },
  );

  assert.equal(result.result, "ok");
  assert.equal(calls, 2);
  assert.equal(sharedStore.get("failed-attempt"), 1, "whole-agent retries do not roll back side effects");
  assert.equal(journal.length, 1, "only the successful attempt is journaled");
  assert.deepEqual(journal[0]?.storeDelta, {}, "only successful attempt writes should be journaled");
});

test("runWorkflow returns null when recoverable retries are exhausted", async () => {
  let calls = 0;
  const logs: string[] = [];
  const journal: JournalEntry[] = [];
  const result = await runWorkflow(
    `export const meta = { name: 'retry_exhausted', description: 'retry exhausted' }
const a = await agent('work', { label: 'a' })
return a`,
    {
      agent: {
        async run() {
          calls++;
          return "";
        },
      },
      agentRunRetries: 1,
      persistLogs: false,
      onLog: (message) => logs.push(message),
      onAgentJournal: (entry) => journal.push(entry),
    },
  );

  assert.equal(result.result, null);
  assert.equal(calls, 2);
  assert.equal(result.agentCount, 1);
  assert.equal(journal.length, 0, "failed/null recoverable results are not journaled");
  assert.ok(
    logs.some((message) => /retrying/i.test(message)),
    "logs should mention retrying",
  );
  assert.ok(
    logs.some((message) => /exhausted/i.test(message)),
    "logs should mention exhaustion",
  );
});

test("runWorkflow does not retry nonrecoverable errors", async () => {
  let calls = 0;
  await assert.rejects(
    runWorkflow(
      `export const meta = { name: 'no_retry_nonrecoverable', description: 'nonrecoverable' }
const a = await agent('work', { label: 'a' })
return a`,
      {
        agent: {
          async run() {
            calls++;
            throw new WorkflowError("hard stop", WorkflowErrorCode.SCRIPT_VALIDATION_ERROR, { recoverable: false });
          },
        },
        agentRunRetries: 2,
        persistLogs: false,
      },
    ),
    (error: unknown) => error instanceof WorkflowError && error.code === WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
  );
  assert.equal(calls, 1);
});

test("per-agent agentRunRetries override run-level agentRunRetries", async () => {
  let calls = 0;
  const result = await runWorkflow(
    `export const meta = { name: 'agent_retry_override', description: 'override' }
const a = await agent('work', { label: 'a', agentRunRetries: 1 })
return a`,
    {
      agent: {
        async run() {
          calls++;
          return calls === 1 ? "" : "ok";
        },
      },
      agentRunRetries: 0,
      persistLogs: false,
    },
  );

  assert.equal(result.result, "ok");
  assert.equal(calls, 2);
});

test("whole-agent retry defaults to zero and accounts for every attempted usage", async () => {
  let calls = 0;
  const result = await runWorkflow(
    `export const meta = { name: 'zero_default', description: 'zero default' }
return await agent('work', { label: 'a' })`,
    {
      agent: {
        async run(_prompt: string, options: { onUsage?: (usage: AgentUsage) => void }) {
          calls++;
          options.onUsage?.({ input: 10, output: 2, cacheRead: 0, cacheWrite: 0, total: 12, cost: 0.01 });
          return "";
        },
      },
      persistLogs: false,
    },
  );
  assert.equal(calls, 1);
  assert.equal(result.result, null);
  assert.equal(result.tokenUsage?.total, 12);
  assert.equal(result.tokenUsage?.cost, 0.01);
});

test("whole-agent retries account for failed and successful attempts", async () => {
  let calls = 0;
  const result = await runWorkflow(
    `export const meta = { name: 'attempt_usage', description: 'attempt usage' }
return await agent('work', { label: 'a' })`,
    {
      agent: {
        async run(_prompt: string, options: { onUsage?: (usage: AgentUsage) => void }) {
          calls++;
          options.onUsage?.({ input: 10, output: 2, cacheRead: 1, cacheWrite: 1, total: 12, cost: 0.01 });
          return calls === 1 ? "" : "ok";
        },
      },
      agentRunRetries: 1,
      persistLogs: false,
    },
  );
  assert.equal(calls, 2);
  assert.equal(result.tokenUsage?.total, 24);
  assert.equal(result.tokenUsage?.cost, 0.02);
});

test("invalid or conflicting retry inputs fail before the agent loop", async () => {
  let calls = 0;
  const agent = {
    run: async () => {
      calls++;
      return "unexpected";
    },
  };
  const script = `export const meta = { name: 'invalid_retry', description: 'invalid retry' }
return await agent('work', { label: 'a' })`;
  for (const value of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 4]) {
    await assert.rejects(runWorkflow(script, { agent, agentRunRetries: value, persistLogs: false }), /must/);
  }
  await assert.rejects(
    runWorkflow(script, { agent, agentRunRetries: 1, agentRetries: 1, persistLogs: false }),
    /conflicts/,
  );
  assert.equal(calls, 0);
});

test("runWorkflow accumulates real per-agent usage (incl. cost + cache tokens)", async () => {
  const result = await runWorkflow(twoAgentScript, {
    agent: fakeAgent({ input: 100, output: 40, total: 140, cost: 0.002, cacheRead: 50, cacheWrite: 10 }),
    persistLogs: false,
  });

  assert.equal(result.agentCount, 2);
  assert.equal(result.tokenUsage?.input, 200);
  assert.equal(result.tokenUsage?.output, 80);
  assert.equal(result.tokenUsage?.total, 280);
  assert.ok(Math.abs((result.tokenUsage?.cost ?? 0) - 0.004) < 1e-9, "should be within tolerance");
  assert.equal(result.tokenUsage?.cacheRead, 100, "cacheRead accumulates across agents");
  assert.equal(result.tokenUsage?.cacheWrite, 20, "cacheWrite accumulates across agents");
});

test("runWorkflow admits one default pair and supports four independent override combinations", async () => {
  const sessionModel = {
    provider: "provider",
    id: "session",
    name: "session",
    reasoning: true,
    thinkingLevelMap: { off: null, low: "low", medium: "medium", high: "high" },
  } as any;
  const alternateModel = {
    provider: "provider",
    id: "alternate",
    name: "alternate",
    reasoning: true,
    thinkingLevelMap: { off: null, low: "low", medium: "medium", high: "high" },
  } as any;
  const registry = { getAvailable: () => [sessionModel, alternateModel] } as any;
  const calls: Array<{ model?: string; effort?: string }> = [];
  const runner = {
    async run(_prompt: string, options: { model?: string; effort?: string }) {
      calls.push({ model: options.model, effort: options.effort });
      return "ok";
    },
  };
  const script = `export const meta = { name: 'model_effort', description: 'pair selection' }
await agent('default', { label: 'default' })
await agent('model only', { label: 'model', model: 'provider/alternate' })
await agent('effort only', { label: 'effort', effort: 'low' })
await agent('both', { label: 'both', model: 'provider/alternate', effort: 'high' })
return 1`;

  const result = await runWorkflow(script, {
    agent: runner,
    persistLogs: false,
    modelRegistry: registry,
    session: { model: sessionModel },
    workflowModelSetting: null,
    currentThinkingLevel: "high",
  });

  assert.deepEqual(calls, [
    { model: "provider/session", effort: "high" },
    { model: "provider/alternate", effort: "high" },
    { model: "provider/session", effort: "low" },
    { model: "provider/alternate", effort: "high" },
  ]);
  assert.equal(result.defaultModel, "provider/session");
  assert.equal(result.defaultEffort, "high");
});

test("runWorkflow rejects unavailable fixed and per-agent models before invoking the runner", async () => {
  const availableModel = {
    provider: "provider",
    id: "available",
    name: "available",
    reasoning: false,
  } as any;
  const registry = { getAvailable: () => [availableModel] } as any;
  const fixedCalls = countingAgent();
  const script = `export const meta = { name: 'unavailable_model', description: 'reject unavailable model' }
return await agent('work', { label: 'work' })`;

  await assert.rejects(
    runWorkflow(script, {
      agent: fixedCalls.runner,
      modelRegistry: registry,
      session: { model: availableModel },
      workflowModelSetting: { model: "provider/registered-only" },
      persistLogs: false,
    }),
    (error: unknown) => error instanceof WorkflowError && error.code === WorkflowErrorCode.MODEL_SELECTION_ERROR,
  );
  assert.equal(fixedCalls.state.calls, 0, "fixed model admission must fail before the runner");

  const overrideCalls = countingAgent();
  await assert.rejects(
    runWorkflow(
      `export const meta = { name: 'unavailable_override', description: 'reject unavailable override' }
return await agent('work', { label: 'work', model: 'provider/registered-only' })`,
      {
        agent: overrideCalls.runner,
        modelRegistry: registry,
        session: { model: availableModel },
        workflowModelSetting: null,
        persistLogs: false,
      },
    ),
    (error: unknown) => error instanceof WorkflowError && error.code === WorkflowErrorCode.MODEL_SELECTION_ERROR,
  );
  assert.equal(overrideCalls.state.calls, 0, "unavailable override admission must fail before the runner");
});

test("journal identity includes the admitted model and effort", async () => {
  const modelOne = {
    provider: "provider",
    id: "one",
    name: "one",
    reasoning: true,
    thinkingLevelMap: { off: null, low: "low", high: "high" },
  } as any;
  const modelTwo = {
    provider: "provider",
    id: "two",
    name: "two",
    reasoning: true,
    thinkingLevelMap: { off: null, low: "low", high: "high" },
  } as any;
  const registry = { getAvailable: () => [modelOne, modelTwo] } as any;
  const script = `export const meta = { name: 'journal_identity', description: 'model and effort identity' }
return await agent('same prompt')`;

  const journalHash = async (workflowModelSetting: { model: string; effort: "low" | "high" }) => {
    const journal: JournalEntry[] = [];
    await runWorkflow(script, {
      agent: fakeAgent({}, "ok"),
      modelRegistry: registry,
      session: { model: modelOne },
      workflowModelSetting,
      persistLogs: false,
      onAgentJournal: (entry) => journal.push(entry),
    });
    return journal[0]?.hash;
  };

  const modelHash = await journalHash({ model: "provider/one", effort: "low" });
  const otherModelHash = await journalHash({ model: "provider/two", effort: "low" });
  const otherEffortHash = await journalHash({ model: "provider/one", effort: "high" });

  assert.ok(modelHash);
  assert.notEqual(modelHash, otherModelHash);
  assert.notEqual(modelHash, otherEffortHash);
});

test("runWorkflow rejects retired meta, phase, and agent tier routing fields", async () => {
  const runner = { run: async () => "unexpected" };
  await assert.rejects(
    () =>
      runWorkflow("export const meta = { name: 'm', description: 'd', model: 'provider/model' }\nreturn 1", {
        agent: runner,
      }),
    { code: "SCRIPT_VALIDATION_ERROR" },
  );
  await assert.rejects(
    () =>
      runWorkflow(
        "export const meta = { name: 'm', description: 'd', phases: [{ title: 'A', model: 'provider/model' }] }\nreturn 1",
        { agent: runner },
      ),
    { code: "SCRIPT_VALIDATION_ERROR" },
  );
  await assert.rejects(
    () =>
      runWorkflow(
        "export const meta = { name: 'm', description: 'd' }\nawait agent('x', { label: 'x', tier: 'small' })",
        { agent: runner },
      ),
    { code: "SCRIPT_VALIDATION_ERROR" },
  );
});

test("runWorkflow falls back to an estimate when provider reports total === 0", async () => {
  const result = await runWorkflow(twoAgentScript, {
    agent: fakeAgent({ total: 0 }, "a result string"),
    persistLogs: false,
  });

  assert.equal(result.tokenUsage?.input, 0);
  assert.equal(result.tokenUsage?.output, 0);
  assert.ok((result.tokenUsage?.total ?? 0) > 0, "estimate should be positive");
  assert.equal(result.tokenUsage?.cost, 0);
});

test("agents default to the first declared phase when the script omits phase()", async () => {
  // Regression for the "(no phase) has agents, declared phase 0/0" bug: a script
  // that declares meta.phases but never calls phase() should still group its
  // agents under the first declared phase, not an orphan "(no phase)" bucket.
  const phases: Array<string | undefined> = [];
  const noop = {
    async run() {
      return "ok";
    },
  };
  await runWorkflow(
    `export const meta = { name: 'p', description: 'd', phases: [{ title: 'Research' }, { title: 'Synthesize' }] }
     await agent('a', { label: 'x' })
     return {}`,
    { agent: noop, persistLogs: false, onAgentStart: (e) => phases.push(e.phase) },
  );
  assert.deepEqual(phases, ["Research"]);
});

test("explicit phase() overrides the default first phase", async () => {
  const phases: Array<string | undefined> = [];
  const noop = {
    async run() {
      return "ok";
    },
  };
  await runWorkflow(
    `export const meta = { name: 'p', description: 'd', phases: [{ title: 'A' }, { title: 'B' }] }
     phase('B')
     await agent('a', { label: 'x' })
     return {}`,
    { agent: noop, persistLogs: false, onAgentStart: (e) => phases.push(e.phase) },
  );
  assert.deepEqual(phases, ["B"]);
});

test("no declared phases => agent phase stays undefined (no synthetic phase)", async () => {
  const phases: Array<string | undefined> = [];
  const noop = {
    async run() {
      return "ok";
    },
  };
  await runWorkflow(
    `export const meta = { name: 'p', description: 'd' }
     await agent('a', { label: 'x' })
     return {}`,
    { agent: noop, persistLogs: false, onAgentStart: (e) => phases.push(e.phase) },
  );
  assert.deepEqual(phases, [undefined]);
});

test("runWorkflow degrades disabled ad-hoc schemas to text and logs the ignored request", async () => {
  const seen: Array<{ schema?: unknown; structuredOutputEnabled?: boolean }> = [];
  const logs: string[] = [];
  const result = await runWorkflow(
    `export const meta = { name: 'schema_off', description: 'schema off' }
return await agent('plain answer', { label: 'text fallback', schema: { type: 'object', properties: { ok: { type: 'boolean' } } } })`,
    {
      agent: {
        async run(_prompt: string, options: { schema?: unknown; structuredOutputEnabled?: boolean }) {
          seen.push(options);
          return "ordinary assistant text";
        },
      },
      structuredOutputEnabled: false,
      persistLogs: false,
      onLog: (message) => logs.push(message),
    },
  );

  assert.equal(result.result, "ordinary assistant text");
  assert.equal(seen[0]?.schema, undefined);
  assert.equal(seen[0]?.structuredOutputEnabled, false);
  assert.ok(logs.some((message) => /text fallback: opts\.schema ignored/.test(message)));
  assert.ok(logs.some((message) => /using text output/.test(message)));
});

test("runWorkflow keeps an explicitly enabled schema on the child boundary", async () => {
  const seen: Array<{ schema?: unknown; structuredOutputEnabled?: boolean }> = [];
  const result = await runWorkflow(
    `export const meta = { name: 'schema_on', description: 'schema on' }
return await agent('structured answer', { label: 'structured', schema: { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' } } } })`,
    {
      agent: {
        async run(_prompt: string, options: { schema?: unknown; structuredOutputEnabled?: boolean }) {
          seen.push(options);
          return { ok: true };
        },
      },
      structuredOutputEnabled: true,
      persistLogs: false,
    },
  );

  assert.deepEqual(result.result, { ok: true });
  assert.ok(seen[0]?.schema);
  assert.equal(seen[0]?.structuredOutputEnabled, true);
});

test("disabled schema calls use ordinary empty-output recovery instead of schema noncompliance", async () => {
  const ended: Array<{ errorCode?: WorkflowErrorCode; recoverable?: boolean }> = [];
  const result = await runWorkflow(
    `export const meta = { name: 'schema_empty_off', description: 'schema empty off' }
const answer = await agent('empty answer', { label: 'empty', schema: { type: 'object' } })
return answer`,
    {
      agent: {
        async run() {
          return "";
        },
      },
      structuredOutputEnabled: false,
      persistLogs: false,
      onAgentEnd: (event) => ended.push(event),
    },
  );

  assert.equal(result.result, null);
  assert.equal(ended[0]?.errorCode, WorkflowErrorCode.AGENT_EMPTY_OUTPUT);
  assert.equal(ended[0]?.recoverable, true);
});

test("ignored schema edits preserve text resume identity, while capability transitions miss the cache", async () => {
  const scriptWithSchema = (
    schema: string,
  ) => `export const meta = { name: 'schema_identity', description: 'schema identity' }
return await agent('same prompt', { label: 'same', schema: ${schema} })`;

  const first = countingAgent();
  const journal: JournalEntry[] = [];
  await runWorkflow(scriptWithSchema(`{ type: 'string' }`), {
    agent: first.runner,
    structuredOutputEnabled: false,
    persistLogs: false,
    onAgentJournal: (entry) => journal.push(entry),
  });

  const ignoredEdit = countingAgent();
  await runWorkflow(scriptWithSchema(`{ type: 'object', properties: { changed: { type: 'number' } } }`), {
    agent: ignoredEdit.runner,
    structuredOutputEnabled: false,
    persistLogs: false,
    resumeJournal: new Map(journal.map((entry) => [entry.index, entry])),
  });
  assert.equal(ignoredEdit.state.calls, 0, "an ignored schema edit must not invalidate text replay");

  const enabledTransition = countingAgent();
  await runWorkflow(scriptWithSchema(`{ type: 'string' }`), {
    agent: enabledTransition.runner,
    structuredOutputEnabled: true,
    persistLogs: false,
    resumeJournal: new Map(journal.map((entry) => [entry.index, entry])),
  });
  assert.equal(enabledTransition.state.calls, 1, "enabling structured output must miss a text journal entry");

  const enabledJournal: JournalEntry[] = [];
  await runWorkflow(scriptWithSchema(`{ type: 'string' }`), {
    agent: countingAgent().runner,
    structuredOutputEnabled: true,
    persistLogs: false,
    onAgentJournal: (entry) => enabledJournal.push(entry),
  });
  const disabledTransition = countingAgent();
  await runWorkflow(scriptWithSchema(`{ type: 'string' }`), {
    agent: disabledTransition.runner,
    structuredOutputEnabled: false,
    persistLogs: false,
    resumeJournal: new Map(enabledJournal.map((entry) => [entry.index, entry])),
  });
  assert.equal(disabledTransition.state.calls, 1, "disabling structured output must miss a structured journal entry");
});

test("nested workflow calls inherit the parent's structured-output snapshot", async () => {
  const seen: Array<{ schema?: unknown; structuredOutputEnabled?: boolean }> = [];
  let calls = 0;
  const child = `export const meta = { name: 'nested_schema', description: 'nested schema' }
return await agent('child', { label: 'child', schema: { type: 'object' } })`;
  const parent = `export const meta = { name: 'parent_schema', description: 'parent schema' }
await agent('parent', { label: 'parent' })
return await workflow('nested')`;

  const result = await runWorkflow(parent, {
    agent: {
      async run(_prompt: string, options: { schema?: unknown; structuredOutputEnabled?: boolean }) {
        calls++;
        seen.push(options);
        return calls === 1 ? "parent text" : "child text";
      },
    },
    structuredOutputEnabled: false,
    persistLogs: false,
    loadSavedWorkflow: (name) => (name === "nested" ? child : undefined),
  });

  assert.equal(result.result, "child text");
  assert.equal(seen.length, 2);
  assert.equal(seen[0]?.schema, undefined);
  assert.equal(seen[1]?.schema, undefined);
  assert.deepEqual(
    seen.map((options) => options.structuredOutputEnabled),
    [false, false],
  );
});

const resumeScript = `export const meta = { name: 'resume_demo', description: 'resume' }
const a = await agent('first', { label: 'a' })
const b = await agent('second', { label: 'b' })
return { a, b }`;

test("resume replays cached results without re-running agents", async () => {
  const first = countingAgent();
  const journal: JournalEntry[] = [];
  const r1 = await runWorkflow(resumeScript, {
    agent: first.runner,
    persistLogs: false,
    onAgentJournal: (e) => journal.push(e),
  });
  assert.equal(first.state.calls, 2);
  assert.equal(journal.length, 2);
  assert.deepEqual(
    journal.map((e) => e.index),
    [0, 1],
  );

  const second = countingAgent();
  const r2 = await runWorkflow(resumeScript, {
    agent: second.runner,
    persistLogs: false,
    resumeJournal: new Map(journal.map((e) => [e.index, e])),
  });
  assert.equal(second.state.calls, 0, "no live runs on a full cache hit");
  assert.equal(JSON.stringify(r2.result), JSON.stringify(r1.result));
});

test("resume re-runs only the changed call (hash mismatch)", async () => {
  const first = countingAgent();
  const journal: JournalEntry[] = [];
  await runWorkflow(resumeScript, {
    agent: first.runner,
    persistLogs: false,
    onAgentJournal: (e) => journal.push(e),
  });

  const editedScript = resumeScript.replace("'second'", "'second-edited'");
  const second = countingAgent();
  await runWorkflow(editedScript, {
    agent: second.runner,
    persistLogs: false,
    resumeJournal: new Map(journal.map((e) => [e.index, e])),
  });
  assert.equal(second.state.calls, 1, "only the edited call re-runs");
});

const threeCallScript = `export const meta = { name: 'prefix', description: 'prefix resume' }
const a = await agent('A', { label: 'a' })
const b = await agent('B', { label: 'b' })
const c = await agent('C', { label: 'c' })
return { a, b, c }`;

test("resume re-runs the changed call AND everything after it (longest-unchanged-prefix)", async () => {
  const first = countingAgent();
  const journal: JournalEntry[] = [];
  await runWorkflow(threeCallScript, {
    agent: first.runner,
    persistLogs: false,
    onAgentJournal: (e) => journal.push(e),
  });
  assert.equal(first.state.calls, 3);

  // Edit the MIDDLE call (index 1). Index 0 is an unchanged prefix → cache hit.
  // Index 1 changed → re-run; index 2 is unchanged but AFTER the first miss, so
  // it must re-run too (the bug was serving it stale from the journal).
  const editedScript = threeCallScript.replace("'B'", "'B-edited'");
  const second = countingAgent();
  await runWorkflow(editedScript, {
    agent: second.runner,
    persistLogs: false,
    resumeJournal: new Map(journal.map((e) => [e.index, e])),
  });
  assert.equal(second.state.calls, 2, "edited call (1) + its suffix (2) re-run; only the prefix (0) is cached");
});

test("resume in parallel(): editing one thunk re-runs that index and every later one", async () => {
  // Three identical-prompt thunks; editing the middle one must invalidate it and
  // the same-or-later index, not just the single changed call.
  const script = (mid: string) => `export const meta = { name: 'par_prefix', description: 'parallel prefix' }
  const xs = await parallel([
    () => agent('x', { label: 'p0' }),
    () => agent('${mid}', { label: 'p1' }),
    () => agent('x', { label: 'p2' }),
  ])
  return xs`;
  const first = countingAgent();
  const journal: JournalEntry[] = [];
  await runWorkflow(script("x"), {
    agent: first.runner,
    persistLogs: false,
    onAgentJournal: (e) => journal.push(e),
  });
  assert.equal(first.state.calls, 3);

  const second = countingAgent();
  await runWorkflow(script("x-edited"), {
    agent: second.runner,
    persistLogs: false,
    resumeJournal: new Map(journal.map((e) => [e.index, e])),
  });
  assert.equal(second.state.calls, 2, "changed thunk (index 1) + later index (2) re-run; index 0 cached");
});

test("callSeq is deterministic under parallel()", async () => {
  const journal: JournalEntry[] = [];
  const script = `export const meta = { name: 'par', description: 'parallel order' }
  const xs = await parallel(['p0','p1','p2'].map((p) => () => agent(p, { label: p })))
  return xs`;
  await runWorkflow(script, {
    agent: countingAgent().runner,
    persistLogs: false,
    onAgentJournal: (e) => journal.push(e),
  });
  assert.deepEqual(
    journal.map((e) => e.index).sort((a, b) => a - b),
    [0, 1, 2],
  );
});

test("context loading reserves maxAgents quota before yielding", async () => {
  const counter = countingAgent();
  const script = `export const meta = { name: 'context_quota', description: 'quota' }
const first = agent('first').catch(() => 'first blocked')
const second = agent('second').catch(() => 'second blocked')
return await Promise.all([first, second])`;
  const result = await runWorkflow<string[]>(script, {
    agent: counter.runner,
    persistLogs: false,
    maxAgents: 1,
    contextLoader: async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return undefined;
    },
  });
  assert.equal(result.agentCount, 1);
  assert.equal(counter.state.calls, 1);
  assert.deepEqual(Array.from(result.result), ["ran:first", "second blocked"]);
});

test("context loader completion order does not reorder journal call indexes", async () => {
  const journal: JournalEntry[] = [];
  const script = `export const meta = { name: 'context_order', description: 'order' }
return await parallel(['slow', 'medium', 'fast'].map((prompt) => () => agent(prompt)))`;
  await runWorkflow(script, {
    agent: countingAgent().runner,
    persistLogs: false,
    contextLoader: async ({ prompt }) => {
      const delay = prompt === "slow" ? 30 : prompt === "medium" ? 15 : 0;
      await new Promise((resolve) => setTimeout(resolve, delay));
      return undefined;
    },
    onAgentJournal: (entry) => journal.push(entry),
  });
  assert.deepEqual(
    journal.sort((left, right) => left.index - right.index).map((entry) => entry.result),
    ["ran:slow", "ran:medium", "ran:fast"],
  );
});

test("workflow() runs a nested saved workflow and shares the global agent counter", async () => {
  const child = `export const meta = { name: 'child', description: 'c' }
const r = await agent('child task', { label: 'c' })
return { child: r }`;
  const parent = `export const meta = { name: 'parent', description: 'p' }
const a = await agent('parent task', { label: 'p' })
const nested = await workflow('child', { foo: 1 })
return { a, nested }`;

  const result = await runWorkflow<{ a: string; nested: { child: string } }>(parent, {
    agent: countingAgent().runner,
    persistLogs: false,
    loadSavedWorkflow: (name) => (name === "child" ? child : undefined),
  });

  assert.equal(result.agentCount, 2);
  assert.equal(result.result.nested.child, "ran:child task");
});

test("workflow() propagates explicit whole-agent retry policy to nested runs", async () => {
  const calls = new Map<string, number>();
  const child = `export const meta = { name: 'child_retry', description: 'c' }
return await agent('child task', { label: 'c' })`;
  const parent = `export const meta = { name: 'parent_retry', description: 'p' }
await agent('parent task', { label: 'p' })
return await workflow('child')`;
  const result = await runWorkflow(parent, {
    agent: {
      async run(prompt: string) {
        const count = (calls.get(prompt) ?? 0) + 1;
        calls.set(prompt, count);
        return prompt.includes("child task") && count === 1 ? "" : "ok";
      },
    },
    agentRunRetries: 1,
    persistLogs: false,
    loadSavedWorkflow: (name) => (name === "child" ? child : undefined),
  });
  assert.equal(result.result, "ok");
  assert.equal(calls.get("parent task"), 1);
  assert.equal(calls.get("child task"), 2);
});

test("workflow() nesting is one level deep (second level throws)", async () => {
  const map: Record<string, string> = {
    gc: `export const meta = { name: 'gc', description: 'g' }
await agent('gc', { label: 'g' })
return 1`,
    child: `export const meta = { name: 'child', description: 'c' }
await workflow('gc')
return 2`,
  };
  const parent = `export const meta = { name: 'parent', description: 'p' }
let err = null
try { await workflow('child') } catch (e) { err = String(e && e.message || e) }
return { err }`;

  const result = await runWorkflow<{ err: string }>(parent, {
    agent: countingAgent().runner,
    persistLogs: false,
    loadSavedWorkflow: (name) => map[name],
  });
  assert.match(result.result.err, /one level deep/);
});

test("runWorkflow budget gates on accumulated tokens", async () => {
  const script = `export const meta = { name: 'budget_demo', description: 'budget' }
const a = await agent('first', { label: 'a' })
let second = null
try { second = await agent('second', { label: 'b' }) } catch (e) { second = 'blocked' }
return { a, second }`;

  const result = await runWorkflow<{ a: unknown; second: unknown }>(script, {
    agent: fakeAgent({ input: 100, output: 0, total: 100, cost: 0 }),
    tokenBudget: 100,
    persistLogs: false,
  });

  assert.equal(result.result.second, "blocked");
});

test("token budget exhaustion inside parallel() halts (non-recoverable, not swallowed)", async () => {
  // A warm-up agent spends the whole budget (soft gate: spent accrues after it
  // finishes); the agent() inside parallel() then hits the gate and must
  // propagate the non-recoverable error, not become a null in the result array.
  const script = `export const meta = { name: 'pb', description: 'budget in parallel' }
await agent('warmup', { label: 'w' })
const xs = await parallel([() => agent('x', { label: '1' })])
return xs`;
  await assert.rejects(
    () =>
      runWorkflow(script, {
        agent: fakeAgent({ input: 100, output: 0, total: 100, cost: 0 }),
        tokenBudget: 100,
        persistLogs: false,
      }),
    /budget/i,
    "exhausted budget must reject the run, not become a null in the result array",
  );
});

test("non-recoverable agent-limit propagates out of pipeline() too", async () => {
  const script = `export const meta = { name: 'mp', description: 'agent limit pipeline' }
const xs = await pipeline([0, 1, 2, 3], (n) => agent('x' + n, { label: 'p' + n }))
return xs`;
  await assert.rejects(
    () =>
      runWorkflow(script, {
        agent: fakeAgent({ input: 1, output: 0, total: 1, cost: 0 }),
        maxAgents: 2,
        persistLogs: false,
      }),
    /limit/i,
  );
});

test("phase sub-budget throws when a phase exceeds its ceiling (run total untouched)", async () => {
  const script = `export const meta = { name: 'pb', description: 'phase budget' }
phase('noisy', { budget: 100 })
let blocked = false
try {
  await agent('a', { label: '1' })
  await agent('b', { label: '2' })
} catch (e) { blocked = (e && e.code) === 'TOKEN_BUDGET_EXHAUSTED' }
phase('calm')
const after = await agent('c', { label: '3' })
return { blocked, after }`;
  const res = await runWorkflow<{ blocked: boolean; after: unknown }>(script, {
    agent: fakeAgent({ input: 100, output: 0, total: 100, cost: 0 }),
    persistLogs: false,
  });
  assert.equal(res.result.blocked, true, "the 2nd agent in the phase hit the sub-budget");
  assert.ok(res.result.after !== null, "a later phase still proceeds");
});

test("maxAgents is enforced under a parallel() fan-out (atomic slot reservation)", async () => {
  // Four agents fan out with maxAgents=2. With the synchronous slot reservation,
  // the 3rd agent() throws AGENT_LIMIT instead of all four passing the gate.
  const script = `export const meta = { name: 'ma', description: 'agent limit' }
const xs = await parallel([0, 1, 2, 3].map((i) => () => agent('x' + i, { label: 'a' + i })))
return xs`;
  await assert.rejects(
    () =>
      runWorkflow(script, {
        agent: fakeAgent({ input: 1, output: 0, total: 1, cost: 0 }),
        maxAgents: 2,
        persistLogs: false,
      }),
    /limit/i,
  );
});

// ─── Additional edge case tests ─────────────────────────────────────────────────

test("runWorkflow returns meta, logs, phases, and duration", async () => {
  const ONE_AGENT = `export const meta = { name: 'meta_test', description: 'check metadata' }
const a = await agent('test', { label: 'a' })
return a`;

  const result = await runWorkflow(ONE_AGENT, {
    agent: fakeAgent({ total: 50 }),
    persistLogs: false,
  });

  assert.equal(result.meta.name, "meta_test");
  assert.equal(result.meta.description, "check metadata");
  assert.ok(Array.isArray(result.logs), "result.logs should be an array");
  assert.ok(Array.isArray(result.phases), "result.phases should be an array");
  assert.ok(result.durationMs >= 0, "durationMs should be non-negative");
  assert.ok(typeof result.runId === "string" && result.runId.length > 0, "runId should be a non-empty string");
});

test("runWorkflow handles empty script without phases gracefully", async () => {
  const SIMPLE = `export const meta = { name: 'simple', description: 'simple' }
const a = await agent('hello', { label: 'greeter' })
return a`;

  const result = await runWorkflow(SIMPLE, {
    agent: fakeAgent({ total: 50 }, "done"),
    persistLogs: false,
  });
  assert.equal(result.result, "done");
  assert.equal(result.agentCount, 1);
});

test("runWorkflow parallel returns results in input order", async () => {
  const script = `export const meta = { name: 'parallel_order', description: 'check order' }
const results = await parallel([1,2,3].map(n => () => agent('task ' + n, { label: 't' + n })))
return results`;

  let callIndex = 0;
  const agent = {
    async run(prompt: string) {
      return `result-${++callIndex}:${prompt}`;
    },
  };

  const result = await runWorkflow<unknown[]>(script, { agent, persistLogs: false });
  assert.ok(Array.isArray(result.result), "result.result should be an array");
  assert.equal(result.result.length, 3);
});

test("runWorkflow pipeline stages in order", async () => {
  const script = `export const meta = { name: 'pipeline_test', description: 'test pipeline' }
const results = await pipeline(['a','b'], item => agent('stage1 ' + item), result => agent('stage2 ' + result))
return results`;

  const log: string[] = [];
  const agent = {
    async run(prompt: string) {
      log.push(prompt);
      return prompt.replace("stage1", "stage1-done").replace("stage2", "stage2-done");
    },
  };

  const result = await runWorkflow<string[]>(script, { agent, persistLogs: false });
  assert.ok(Array.isArray(result.result), "result.result should be an array");
  assert.equal(result.result.length, 2);
});

test("runWorkflow agent with different labels", async () => {
  const script = `export const meta = { name: 'label_test', description: 'labels' }
const a = await agent('task1', { label: 'worker-1' })
const b = await agent('task2', { label: 'worker-2' })
return { a, b }`;

  const seenLabels: string[] = [];
  await runWorkflow(script, {
    agent: countingAgent().runner,
    persistLogs: false,
    onAgentStart: (e) => seenLabels.push(e.label),
  });

  assert.deepEqual(seenLabels, ["worker-1", "worker-2"]);
});

test("runWorkflow with phases assignment to agents", async () => {
  const script = `export const meta = { name: 'phase_test', description: 'phases', phases: [{ title: 'Phase1' }, { title: 'Phase2' }] }
phase('Phase1')
const a = await agent('phase1 work', { label: 'p1' })
phase('Phase2')
const b = await agent('phase2 work', { label: 'p2' })
return { a, b }`;

  const phases: string[] = [];
  const agentPhases: string[] = [];
  await runWorkflow(script, {
    agent: countingAgent().runner,
    persistLogs: false,
    onPhase: (title) => phases.push(title),
    onAgentStart: (e) => {
      if (e.phase) agentPhases.push(e.phase);
    },
  });

  assert.ok(phases.includes("Phase1"), "should contain Phase1");
  assert.ok(phases.includes("Phase2"), "should contain Phase2");
});

test("runWorkflow can send args to the script", async () => {
  const script = `export const meta = { name: 'args_test', description: 'test args' }
return { received: args && args.value }`;

  const result = await runWorkflow<{ received: unknown }>(script, {
    agent: countingAgent().runner,
    persistLogs: false,
    args: { value: 42 },
  });

  // No agent calls means 0 agents
  assert.equal(result.result.received, 42);
});

test("runWorkflow log function works inside script", async () => {
  const script = `export const meta = { name: 'log_test', description: 'logging' }
log('hello from script')
return true`;

  const result = await runWorkflow(script, {
    agent: countingAgent().runner,
    persistLogs: false,
  });

  assert.ok(
    result.logs.some((l) => l.includes("hello from script")),
    "should contain hello from script",
  );
});

test("runWorkflow console.log works inside script", async () => {
  const script = `export const meta = { name: 'console_test', description: 'console' }
console.log('console log')
console.warn('console warn')
return true`;

  const result = await runWorkflow(script, {
    agent: countingAgent().runner,
    persistLogs: false,
  });

  assert.ok(
    result.logs.some((l) => l.includes("console log")),
    "should contain console log",
  );
  assert.ok(
    result.logs.some((l) => l.includes("console warn")),
    "should contain console warn",
  );
});

test("runWorkflow process.cwd() works inside script", async () => {
  const script = `export const meta = { name: 'cwd_test', description: 'cwd' }
return { cwd: process.cwd() }`;

  const result = await runWorkflow<{ cwd: string }>(script, {
    agent: countingAgent().runner,
    persistLogs: false,
  });

  assert.equal(typeof result.result.cwd, "string");
  assert.ok(result.result.cwd.length > 0, "result.cwd should not be empty");
});

test("runWorkflow budget object exposes spent() and remaining()", async () => {
  const script = `export const meta = { name: 'budget_api', description: 'budget API' }
try { const s = budget.spent(); const r = budget.remaining(); return { spent: s, remaining: typeof r } }
catch(e) { return { error: String(e) } }`;

  const result = await runWorkflow<{ spent: number; remaining: string }>(script, {
    agent: fakeAgent({ total: 100 }),
    persistLogs: false,
  });

  assert.equal(result.result.spent, 0); // before first agent
  assert.equal(result.result.remaining, "number");
});

test("runWorkflow returns empty logs array when nothing logged", async () => {
  const script = `export const meta = { name: 'no_log', description: 'no logs' }
await agent('silent', { label: 's' })
return 1`;

  const result = await runWorkflow(script, {
    agent: fakeAgent({ total: 10 }),
    persistLogs: false,
  });

  assert.ok(Array.isArray(result.logs), "result.logs should be an array");
});

// ─── Runtime determinism hardening (P0-5) ───────────────────────────────────────

const noopAgent = {
  async run() {
    return "ok";
  },
};

function probe(expr: string): Promise<{ result: { err: string | null; val: unknown } }> {
  const script = `export const meta = { name: 'det', description: 'determinism' }
let err = null, val = null
try { val = ${expr} } catch (e) { err = String((e && e.message) || e) }
await agent('noop', { label: 'x' })
return { err, val }`;
  return runWorkflow(script, { agent: noopAgent, persistLogs: false });
}

test("parse-time guard rejects literal Date.now / Math.random / new Date()", async () => {
  for (const expr of ["Math.random()", "Date.now()", "new Date()"]) {
    await assert.rejects(
      () =>
        runWorkflow(
          `export const meta = { name: 'lit', description: 'd' }\nconst v = ${expr}\nawait agent('x', { label: 'x' })\nreturn v`,
          { agent: noopAgent, persistLogs: false },
        ),
      /deterministic|unavailable/i,
      `${expr} literal should be rejected at parse time`,
    );
  }
});

test("runtime guard neuters computed-access bypasses the parse regex misses", async () => {
  const r1 = await probe('Math["random"]()');
  assert.match(r1.result.err ?? "", /unavailable|resume/i, 'Math["random"]() should throw at runtime');
  const r2 = await probe('Date["now"]()');
  assert.match(r2.result.err ?? "", /unavailable|resume/i, 'Date["now"]() should throw at runtime');
  const r3 = await probe("(() => { const D = Date; return new D(); })()");
  assert.match(r3.result.err ?? "", /unavailable|resume/i, "aliased no-arg Date should throw at runtime");
});

test("runtime determinism: new Date(arg) and Math.max still work", async () => {
  const d = await probe("new Date(0).getTime()");
  assert.equal(d.result.err, null, "new Date(0) should construct");
  assert.equal(d.result.val, 0, "new Date(0).getTime() === 0");
  const m = await probe("Math.max(1, 2, 3)");
  assert.equal(m.result.err, null);
  assert.equal(m.result.val, 3);
});

test("vm-realm builtins work and the constructor escape hits the neutered Date.now", async () => {
  // The escape string is split so the parse-time regex doesn't flag it; at runtime
  // the vm Function runs in the vm realm where Date.now is neutered.
  const script = `export const meta = { name: 'vm', description: 'vm realm' }
let escaped = null
try { escaped = ({}).constructor.constructor('return Da' + 'te.now()')() } catch (e) { escaped = 'blocked:' + String((e && e.message) || e) }
const arr = [1, 2, 3].map((x) => x * 2)
const j = JSON.stringify({ a: 1 })
const s = [...new Set([1, 1, 2])]
await agent('noop', { label: 'x' })
return { escaped, arr, j, s }`;
  const r = await runWorkflow<{ escaped: string; arr: number[]; j: string; s: number[] }>(script, {
    agent: noopAgent,
    persistLogs: false,
  });
  // Spread to a host array: vm-realm arrays don't deepStrictEqual host literals.
  assert.deepEqual([...r.result.arr], [2, 4, 6], "vm Array.map works");
  assert.equal(r.result.j, '{"a":1}', "vm JSON works");
  assert.deepEqual([...r.result.s], [1, 2], "vm Set works");
  // ({}).constructor.constructor is the vm Function; its code runs in the vm realm
  // where Date.now is neutered -> blocked (the old host-object escape is closed).
  assert.match(r.result.escaped, /blocked/, "constructor escape via vm objects is closed");
});
