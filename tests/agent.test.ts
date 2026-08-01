import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import type { AgentRunOptions, AgentUsage } from "../src/agent.js";
import {
  awaitAbortableSubagentPrompt,
  listAvailableModelSpecs,
  resolveAgentModelSpec,
  WorkflowAgent,
} from "../src/agent.js";
import { WorkflowError, WorkflowErrorCode } from "../src/errors.js";
import { resolveAvailableModel } from "../src/model-selection.js";
import { runWorkflow } from "../src/workflow.js";
import { withFakeHome } from "./helpers/fake-home.js";

// Private methods used for testing - cast to this type to access them without `any`
type WorkflowAgentPrivates = {
  buildPrompt(prompt: string, options: AgentRunOptions<any>, structured: boolean): string;
  lastAssistantText(messages: unknown[]): string;
  createSessionManager(): { isPersisted(): boolean; getCwd(): string };
};

test("awaitAbortableSubagentPrompt waits for child session cancellation before rejecting", async () => {
  const controller = new AbortController();
  let promptStarted = false;
  let abortCalls = 0;
  let releaseAbort: (() => void) | undefined;
  const abortFinished = new Promise<void>((resolve) => {
    releaseAbort = resolve;
  });

  const run = awaitAbortableSubagentPrompt(
    async () => {
      promptStarted = true;
      return await new Promise<string>(() => {});
    },
    controller.signal,
    async () => {
      abortCalls++;
      await abortFinished;
    },
  );

  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(promptStarted, true);
  controller.abort();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(abortCalls, 1);

  let settled = false;
  void run.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(settled, false, "must not complete before the child session is idle");

  releaseAbort?.();
  await assert.rejects(run, /Subagent was aborted/);
  assert.equal(abortCalls, 1, "abort is issued exactly once");
});

test("awaitAbortableSubagentPrompt rejects a pre-aborted signal without invoking prompt", async () => {
  const controller = new AbortController();
  controller.abort();

  let promptCalls = 0;
  let abortCalls = 0;

  await assert.rejects(
    () =>
      awaitAbortableSubagentPrompt(
        async () => {
          promptCalls++;
          return "should-not-run";
        },
        controller.signal,
        async () => {
          abortCalls++;
        },
      ),
    /Subagent was aborted/,
  );

  assert.equal(promptCalls, 0, "prompt must never be scheduled or invoked");
  assert.equal(abortCalls, 1, "abort is issued exactly once");
});

// ═══════════════════════════════════════════════════════════════════════
// persistAgentSessions — in-memory by default, file-backed keyed by project cwd
// ═══════════════════════════════════════════════════════════════════════

test("WorkflowAgent uses an in-memory session manager by default", () => {
  const agent = new WorkflowAgent({ cwd: "/tmp" });
  const manager = (agent as unknown as WorkflowAgentPrivates).createSessionManager();
  assert.equal(manager.isPersisted(), false, "default must stay in-memory (back-compat)");
});

test("WorkflowAgent with persistAgentSessions=false explicitly stays in-memory", () => {
  const agent = new WorkflowAgent({ cwd: "/tmp", persistAgentSessions: false });
  const manager = (agent as unknown as WorkflowAgentPrivates).createSessionManager();
  assert.equal(manager.isPersisted(), false);
});

test("WorkflowAgent with persistAgentSessions=true creates a file-backed manager keyed by the project cwd", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-dynamic-workflows-persist-agent-"));
  const projectCwd = join(dir, "project");
  const fakeHome = join(dir, "home");
  try {
    withFakeHome(fakeHome, () => {
      const agent = new WorkflowAgent({ cwd: projectCwd, persistAgentSessions: true });
      const manager = (agent as unknown as WorkflowAgentPrivates).createSessionManager();
      assert.equal(manager.isPersisted(), true, "flag must yield a file-backed session manager");
      // Sessions must be keyed by the runner's project cwd — never a per-call
      // worktree cwd — so transcripts group under the project's session dir.
      // createSessionManager() takes no per-call cwd by design; assert the
      // manager saw the project cwd.
      assert.equal(manager.getCwd(), projectCwd);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("WorkflowAgent degrades to in-memory when the session directory can't be created", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-dynamic-workflows-persist-agent-fail-"));
  const projectCwd = join(dir, "project");
  const fakeHome = join(dir, "home");
  try {
    withFakeHome(fakeHome, () => {
      // Pre-occupy the sessions directory with a plain file so the SDK's
      // mkdirSync(recursive) inside SessionManager.create() throws ENOTDIR —
      // simulating a permissions/disk-full failure at session-creation time.
      const sessionsPath = join(fakeHome, ".pi", "agent", "sessions");
      mkdirSync(dirname(sessionsPath), { recursive: true });
      writeFileSync(sessionsPath, "not a directory");

      const originalWarn = console.warn;
      const warnings: unknown[][] = [];
      console.warn = (...args: unknown[]) => warnings.push(args);
      try {
        const agent = new WorkflowAgent({ cwd: projectCwd, persistAgentSessions: true });
        const manager = (agent as unknown as WorkflowAgentPrivates).createSessionManager();
        assert.equal(manager.isPersisted(), false, "must degrade to in-memory rather than throw");
        assert.ok(
          warnings.some((args) => String(args[0]).includes("persistAgentSessions")),
          "should log a warning about the degradation",
        );
      } finally {
        console.warn = originalWarn;
      }
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("listAvailableModelSpecs returns an array (empty when no auth configured)", () => {
  const result = listAvailableModelSpecs();
  assert.ok(Array.isArray(result), "should always return an array");
  // On CI or fresh installs there may be no models configured
  // The important thing is it doesn't throw
});

test("listAvailableModelSpecs entries have provider/model format when non-empty", () => {
  const result = listAvailableModelSpecs();
  for (const spec of result) {
    assert.ok(spec.includes("/"), `model spec "${spec}" should use provider/id format`);
    const [provider, id] = spec.split("/");
    assert.ok(provider.length > 0, "provider should not be empty");
    assert.ok(id.length > 0, "model id should not be empty");
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// Per-agent model selection is strict and has no tier fallback.
// ═══════════════════════════════════════════════════════════════════════════

test("resolveAgentModelSpec returns only an explicit model", () => {
  assert.equal(resolveAgentModelSpec({ model: " provider/model " }, "session/model"), "provider/model");
  assert.equal(resolveAgentModelSpec({}, "session/model"), undefined);
});

test("WorkflowAgent constructor accepts all option shapes without throwing", () => {
  const optionSets = [
    undefined,
    { cwd: "/tmp" },
    { cwd: "/tmp", instructions: "custom instruction" },
    { cwd: "/tmp", tools: [], session: {}, instructions: "test" },
    { cwd: "/tmp", mainModel: "openai/gpt-4.1" },
    { cwd: "/tmp", tools: [], session: {}, instructions: "test", mainModel: "openai/gpt-4.1" },
    {
      cwd: "/tmp",
      modelRegistry: {
        getAvailable: () => [{ provider: "mock", id: "model" }],
        find: () => undefined,
      } as any,
    },
  ];
  for (const opts of optionSets) {
    const agent = opts ? new WorkflowAgent(opts) : new WorkflowAgent();
    assert.ok(agent instanceof WorkflowAgent, `agent should be constructed for options: ${JSON.stringify(opts)}`);
  }
});

test("WorkflowAgent reuses an injected ModelRegistry for resolution", () => {
  const mockModel = { provider: "mock", id: "shared" } as any;
  const registry = {
    find: (provider: string, id: string) => (provider === "mock" && id === "shared" ? mockModel : undefined),
    getAvailable: () => [mockModel],
  } as any;

  const agent = new WorkflowAgent({ cwd: "/tmp", modelRegistry: registry });
  const host = (agent as any).getHostRegistry();
  assert.equal(host, registry);
  const resolved = resolveAvailableModel("mock/shared", host);
  assert.equal(resolved, mockModel, "should resolve via the injected registry");
});

test("WorkflowAgent creates a cached plugin ModelRuntime when none is injected", async () => {
  const agent = new WorkflowAgent({ cwd: "/tmp" });
  const runtime = await (agent as any).getModelRuntime();
  assert.ok(runtime);
  assert.equal(await (agent as any).getModelRuntime(), runtime, "runtime is cached");
});

test("WorkflowAgent.resolveModel resolves via a per-run registry when the constructor got none", () => {
  // Regression test for the per-run `modelRegistry` AgentRunOptions field: a
  // model present only in a registry passed to run() (not the constructor)
  // must still resolve.
  const perRunModel = { provider: "router", id: "per-run-only" } as any;
  const perRunRegistry = {
    find: (provider: string, id: string) => (provider === "router" && id === "per-run-only" ? perRunModel : undefined),
    getAvailable: () => [perRunModel],
  } as any;

  const agent = new WorkflowAgent({ cwd: "/tmp" });
  const host = (agent as any).getHostRegistry(perRunRegistry);
  const resolved = resolveAvailableModel("router/per-run-only", host);
  assert.equal(resolved, perRunModel, "should resolve via the per-run registry, not a disk registry");
});

test("WorkflowAgent.resolveModel: per-run registry takes precedence over the constructor's shared registry", () => {
  const constructorModel = { provider: "ctor", id: "shared" } as any;
  const constructorRegistry = {
    find: (provider: string, id: string) => (provider === "ctor" && id === "shared" ? constructorModel : undefined),
    getAvailable: () => [constructorModel],
  } as any;

  const perRunModel = { provider: "run", id: "override" } as any;
  const perRunRegistry = {
    find: (provider: string, id: string) => (provider === "run" && id === "override" ? perRunModel : undefined),
    getAvailable: () => [perRunModel],
  } as any;

  const agent = new WorkflowAgent({ cwd: "/tmp", modelRegistry: constructorRegistry });
  // The per-run registry, not the constructor's, is consulted when both are set.
  const resolved = resolveAvailableModel("run/override", (agent as any).getHostRegistry(perRunRegistry));
  assert.equal(resolved, perRunModel, "per-run registry should win over the constructor's shared registry");
  // And the constructor registry is still used when no per-run registry is given.
  const fallback = resolveAvailableModel("ctor/shared", (agent as any).getHostRegistry());
  assert.equal(fallback, constructorModel, "constructor registry should still apply without a per-run override");
});

test("WorkflowAgent.getHostRegistry: per-run registry wins, then constructor's shared registry", () => {
  const constructorRegistry = { getAvailable: () => [], find: () => undefined } as any;
  const perRunRegistry = { getAvailable: () => [], find: () => undefined } as any;

  const agent = new WorkflowAgent({ cwd: "/tmp", modelRegistry: constructorRegistry });
  assert.equal((agent as any).getHostRegistry(perRunRegistry), perRunRegistry);
  assert.equal((agent as any).getHostRegistry(), constructorRegistry);

  const bareAgent = new WorkflowAgent({ cwd: "/tmp" });
  assert.equal((bareAgent as any).getHostRegistry(), undefined);
});

// ═══════════════════════════════════════════════════════════════════════════
// buildPrompt — verifies that the agent's internal prompt assembly is correct
// ═══════════════════════════════════════════════════════════════════════════

test("buildPrompt includes base instructions, task label, and user prompt", () => {
  const agent = new WorkflowAgent({ cwd: "/tmp", instructions: "You are a helper." });
  const built: string = (agent as unknown as WorkflowAgentPrivates).buildPrompt(
    "analyze this",
    { label: "analyzer" },
    false,
  );
  assert.ok(built.includes("You are a helper."), "should include base instructions");
  assert.ok(built.includes("Task label: analyzer"), "should include task label");
  assert.ok(built.includes("analyze this"), "should include user prompt");
});

test("buildPrompt includes per-call instructions when provided", () => {
  const agent = new WorkflowAgent({ cwd: "/tmp", instructions: "Base." });
  const built: string = (agent as unknown as WorkflowAgentPrivates).buildPrompt(
    "do it",
    { label: "x", instructions: "Extra." },
    false,
  );
  assert.ok(built.includes("Base."), "base instructions");
  assert.ok(built.includes("Extra."), "per-call instructions");
  assert.ok(built.includes("do it"), "user prompt");
});

test("buildPrompt injects structured output contract when schema is used", () => {
  const agent = new WorkflowAgent({ cwd: "/tmp" });
  const built: string = (agent as unknown as WorkflowAgentPrivates).buildPrompt("return result", { label: "t" }, true);
  assert.ok(built.includes("structured_output"), "should mention structured_output");
  assert.ok(built.includes("Final output contract:"), "should include contract header");
  assert.ok(built.includes("Do not emit a prose final answer"), "should discourage prose");
  assert.ok(built.includes("call structured_output exactly once"), "should enforce single call");
});

test("buildPrompt works without base instructions", () => {
  const agent = new WorkflowAgent({ cwd: "/tmp" });
  const built: string = (agent as unknown as WorkflowAgentPrivates).buildPrompt("hello", { label: "greeter" }, false);
  assert.ok(built.includes("Task label: greeter"), "should contain Task label: greeter");
  assert.ok(built.includes("hello"), "should contain hello");
});

test("buildPrompt works without label", () => {
  const agent = new WorkflowAgent({ cwd: "/tmp", instructions: "Help." });
  const built: string = (agent as unknown as WorkflowAgentPrivates).buildPrompt("hello", {}, false);
  assert.ok(built.includes("Help."), "should contain Help.");
  assert.ok(built.includes("hello"), "should contain hello");
  assert.ok(!built.includes("Task label:"), "no label when omitted");
});

test("buildPrompt includes both instructions when both base and per-call are set", () => {
  const agent = new WorkflowAgent({ cwd: "/tmp", instructions: "You are a code reviewer." });
  const built: string = (agent as unknown as WorkflowAgentPrivates).buildPrompt(
    "check this file",
    { label: "reviewer", instructions: "Focus on security." },
    true,
  );
  // Order: base instructions, per-call instructions, label, prompt, structured contract
  assert.ok(built.indexOf("You are a code reviewer.") < built.indexOf("Focus on security."), "base before per-call");
  assert.ok(built.indexOf("Focus on security.") < built.indexOf("Task label: reviewer"), "per-call before label");
  assert.ok(built.indexOf("Task label: reviewer") < built.indexOf("check this file"), "label before prompt");
  assert.ok(
    built.indexOf("check this file") < built.indexOf("Final output contract:"),
    "prompt before structured contract",
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// lastAssistantText — verifies text extraction from session messages
// ═══════════════════════════════════════════════════════════════════════════

test("lastAssistantText extracts last assistant text content", () => {
  const agent = new WorkflowAgent({ cwd: "/tmp" });
  const messages = [
    { role: "user", content: [{ type: "text", text: "hello" }] },
    { role: "assistant", content: [{ type: "text", text: "hi there" }] },
  ];
  const text: string = (agent as unknown as WorkflowAgentPrivates).lastAssistantText(messages);
  assert.equal(text, "hi there");
});

test("lastAssistantText joins multiple text parts", () => {
  const agent = new WorkflowAgent({ cwd: "/tmp" });
  const messages = [
    {
      role: "assistant",
      content: [
        { type: "text", text: "part1" },
        { type: "text", text: "part2" },
      ],
    },
  ];
  const text: string = (agent as unknown as WorkflowAgentPrivates).lastAssistantText(messages);
  assert.equal(text, "part1part2");
});

test("lastAssistantText skips non-text content parts", () => {
  const agent = new WorkflowAgent({ cwd: "/tmp" });
  const messages = [
    {
      role: "assistant",
      content: [
        { type: "tool_use", id: "t1" },
        { type: "text", text: "result" },
      ],
    },
  ];
  const text: string = (agent as unknown as WorkflowAgentPrivates).lastAssistantText(messages);
  assert.equal(text, "result");
});

test("lastAssistantText returns empty string when no assistant text", () => {
  const agent = new WorkflowAgent({ cwd: "/tmp" });
  const text: string = (agent as unknown as WorkflowAgentPrivates).lastAssistantText([]);
  assert.equal(text, "");
});

test("lastAssistantText returns empty for non-assistant messages", () => {
  const agent = new WorkflowAgent({ cwd: "/tmp" });
  const messages = [{ role: "user", content: [{ type: "text", text: "hello" }] }];
  const text: string = (agent as unknown as WorkflowAgentPrivates).lastAssistantText(messages);
  assert.equal(text, "");
});

test("lastAssistantText picks the last assistant message, not first", () => {
  const agent = new WorkflowAgent({ cwd: "/tmp" });
  const messages = [
    { role: "assistant", content: [{ type: "text", text: "first" }] },
    { role: "user", content: [{ type: "text", text: "more" }] },
    { role: "assistant", content: [{ type: "text", text: "final" }] },
  ];
  const text: string = (agent as unknown as WorkflowAgentPrivates).lastAssistantText(messages);
  assert.equal(text, "final");
});

// ═══════════════════════════════════════════════════════════════════════════
// Full agent() pipeline inside runWorkflow — verifies the agent() function
// in workflow.ts correctly invokes the runner with all options.
// ═══════════════════════════════════════════════════════════════════════════

/** A smart mock agent runner that records every call and validates options shape. */
class CallRecordingAgent {
  calls: Array<{
    prompt: string;
    options: Record<string, unknown>;
  }> = [];

  result: unknown = "mock-result";

  async run(prompt: string, options: any) {
    this.calls.push({ prompt, options: { ...options } });
    // Fire callbacks with synthetic data to test the full pipeline
    options.onUsage?.({
      input: 20,
      output: 10,
      cacheRead: 0,
      cacheWrite: 0,
      total: 30,
      cost: 0.001,
    } satisfies AgentUsage);
    options.onModelResolved?.("openai/gpt-4.1-mini");
    return this.result;
  }
}

test("agent() in workflow passes prompt and label to runner", async () => {
  const rec = new CallRecordingAgent();
  await runWorkflow(
    `export const meta = { name: 'test', description: 't' }
     const r = await agent('analyze this', { label: 'analyzer' })
     return r`,
    { agent: rec, persistLogs: false },
  );
  assert.equal(rec.calls.length, 1);
  assert.equal(rec.calls[0].prompt, "analyze this");
});

test("agent() in workflow forwards modelRegistry to the runner", async () => {
  const rec = new CallRecordingAgent();
  const fakeRegistry = { getAvailable: () => [], find: () => undefined } as any;
  await runWorkflow(
    `export const meta = { name: 'test', description: 't' }
     const r = await agent('task', { label: 't' })
     return r`,
    { agent: rec, persistLogs: false, modelRegistry: fakeRegistry },
  );
  assert.equal(rec.calls.length, 1);
  assert.equal((rec.calls[0].options as { modelRegistry?: any }).modelRegistry, fakeRegistry);
});

test("agent() in workflow passes model spec to runner", async () => {
  const rec = new CallRecordingAgent();
  const model = { provider: "fast-llm", id: "model", name: "model", reasoning: false } as any;
  const modelRegistry = { getAvailable: () => [model], find: () => model } as any;
  await runWorkflow(
    `export const meta = { name: 'test', description: 't' }
     const r = await agent('task', { label: 't', model: 'fast-llm/model' })
     return r`,
    {
      agent: rec,
      persistLogs: false,
      modelRegistry,
      session: { model },
      workflowModelSetting: null,
    },
  );
  assert.equal(rec.calls.length, 1);
  assert.equal((rec.calls[0].options as { model?: string }).model, "fast-llm/model");
  assert.equal((rec.calls[0].options as { effort?: string }).effort, "off");
});

test("agent() rejects CLI-style effort suffixes in model identifiers", async () => {
  const rec = new CallRecordingAgent();
  const model = { provider: "fast-llm", id: "model", name: "model", reasoning: false } as any;
  const modelRegistry = { getAvailable: () => [model] };
  await assert.rejects(
    () =>
      runWorkflow(
        `export const meta = { name: 'test', description: 't' }
     const r = await agent('task', { label: 't', model: 'fast-llm/model:xhigh' })
     return r`,
        {
          agent: rec,
          modelRegistry: modelRegistry as never,
          session: { model },
          workflowModelSetting: null,
          persistLogs: false,
        },
      ),
    { code: "MODEL_SELECTION_ERROR" },
  );
});

test("agent() in workflow fires onAgentStart and onAgentEnd callbacks", async () => {
  const rec = new CallRecordingAgent();
  const events: string[] = [];
  await runWorkflow(
    `export const meta = { name: 'test', description: 't' }
     await agent('hello', { label: 'greeter' })
     return 1`,
    {
      agent: rec,
      persistLogs: false,
      onAgentStart: (e) => events.push(`start:${e.label}`),
      onAgentEnd: (e) => events.push(`end:${e.label}`),
    },
  );
  assert.deepEqual(events, ["start:greeter", "end:greeter"]);
});

test("agent() in workflow forwards compact subagent history snapshots", async () => {
  const historyRunner = {
    async run(_prompt: string, options: any) {
      options.onHistory?.([{ role: "assistant", kind: "text", text: "working" }]);
      return "done";
    },
  };
  const histories: Array<{ label: string; history: Array<{ text: string }> }> = [];

  await runWorkflow(
    `export const meta = { name: 'test', description: 't' }
     await agent('hello', { label: 'greeter' })
     return 1`,
    {
      agent: historyRunner,
      persistLogs: false,
      onAgentHistory: (event) => histories.push(event),
    },
  );

  assert.equal(histories.length, 1);
  assert.equal(histories[0].label, "greeter");
  assert.equal(histories[0].history[0].text, "working");
});

test("agent() in workflow fires onAgentStart with phase info", async () => {
  const rec = new CallRecordingAgent();
  const starts: Array<{ label: string; phase?: string }> = [];
  await runWorkflow(
    `export const meta = { name: 'test', description: 't', phases: [{ title: 'Phase1' }] }
     phase('Phase1')
     await agent('work', { label: 'w' })
     return 1`,
    {
      agent: rec,
      persistLogs: false,
      onAgentStart: (e) => starts.push({ label: e.label, phase: e.phase }),
    },
  );
  assert.equal(starts.length, 1);
  assert.equal(starts[0].phase, "Phase1");
});

test("agent() in workflow returns runner result", async () => {
  const rec = new CallRecordingAgent();
  rec.result = { findings: ["issue1"] };
  const result = await runWorkflow<{ findings: string[] }>(
    `export const meta = { name: 'test', description: 't' }
     const r = await agent('analyze', { label: 'a' })
     return r`,
    { agent: rec, persistLogs: false },
  );
  assert.deepEqual(result.result, { findings: ["issue1"] });
});

test("agent() in workflow returns null for recoverable errors", async () => {
  const failer = {
    async run() {
      throw new Error("HTTP 503 service unavailable");
    },
  };
  let end:
    | {
        result: unknown;
        error?: string;
        errorCode?: WorkflowErrorCode;
        recoverable?: boolean;
      }
    | undefined;
  const result = await runWorkflow<unknown>(
    `export const meta = { name: 'test', description: 't' }
     const r = await agent('failing task', { label: 'f' })
     return r`,
    { agent: failer, persistLogs: false, onAgentEnd: (e) => (end = e) },
  );
  assert.equal(result.result, null);
  assert.equal(end?.result, null);
  assert.equal(end?.error, "HTTP 503 service unavailable");
  assert.equal(end?.errorCode, WorkflowErrorCode.AGENT_EXECUTION_ERROR);
  assert.equal(end?.recoverable, true);
});

test("agent() in workflow treats empty text output as a recoverable failure", async () => {
  const rec = new CallRecordingAgent();
  rec.result = "   ";
  let end:
    | {
        result: unknown;
        error?: string;
        errorCode?: WorkflowErrorCode;
        recoverable?: boolean;
      }
    | undefined;
  const result = await runWorkflow<unknown>(
    `export const meta = { name: 'test', description: 't' }
     const r = await agent('empty task', { label: 'empty' })
     return r`,
    { agent: rec, persistLogs: false, onAgentEnd: (e) => (end = e) },
  );

  assert.equal(result.result, null);
  assert.equal(end?.result, null);
  assert.equal(end?.error, "Subagent produced no assistant output");
  assert.equal(end?.errorCode, WorkflowErrorCode.AGENT_EMPTY_OUTPUT);
  assert.equal(end?.recoverable, true);
});

test("agent() in workflow reports non-recoverable errors before throwing", async () => {
  const failer = {
    async run() {
      throw new WorkflowError("schema failed", WorkflowErrorCode.SCHEMA_NONCOMPLIANCE, { recoverable: false });
    },
  };
  let end:
    | {
        result: unknown;
        error?: string;
        errorCode?: WorkflowErrorCode;
        recoverable?: boolean;
      }
    | undefined;

  await assert.rejects(
    () =>
      runWorkflow<unknown>(
        `export const meta = { name: 'test', description: 't' }
         await agent('schema task', { label: 'schema' })
         return 1`,
        { agent: failer, persistLogs: false, onAgentEnd: (e) => (end = e) },
      ),
    (err) => err instanceof WorkflowError && err.code === WorkflowErrorCode.SCHEMA_NONCOMPLIANCE,
  );

  assert.equal(end?.result, null);
  assert.equal(end?.error, "schema failed");
  assert.equal(end?.errorCode, WorkflowErrorCode.SCHEMA_NONCOMPLIANCE);
  assert.equal(end?.recoverable, false);
});

test("agent() in workflow fires onTokenUsage after run", async () => {
  const rec = new CallRecordingAgent();
  const usageEvents: Array<{ input: number; output: number; total: number }> = [];
  await runWorkflow(
    `export const meta = { name: 'test', description: 't' }
     await agent('task', { label: 't' })
     return 1`,
    {
      agent: rec,
      persistLogs: false,
      onTokenUsage: (u) => usageEvents.push({ input: u.input, output: u.output, total: u.total }),
    },
  );
  assert.equal(usageEvents.length, 1, "should fire onTokenUsage once");
  assert.equal(usageEvents[0].total, 30, "should accumulate from agent usage");
});

test("agent() passes onModelResolved callback for display model updates", async () => {
  const rec = new CallRecordingAgent();
  const model = { provider: "some", id: "model", name: "model", reasoning: false } as any;
  await runWorkflow(
    `export const meta = { name: 'test', description: 't' }
     await agent('task', { label: 't', model: 'some/model' })
     return 1`,
    {
      agent: rec,
      persistLogs: false,
      modelRegistry: { getAvailable: () => [model] } as any,
      sessionModel: model,
      workflowModelSetting: null,
      onAgentEnd: (e) => {
        assert.equal(e.model, "openai/gpt-4.1-mini");
      },
    },
  );
  assert.ok(rec.calls.length > 0, "rec.calls should not be empty");
});

test("agent() accumulates usage across multiple agents", async () => {
  const rec = new CallRecordingAgent();
  const usageEvents: Array<{ total: number }> = [];
  await runWorkflow(
    `export const meta = { name: 'test', description: 't' }
     await agent('first', { label: 'a' })
     await agent('second', { label: 'b' })
     return 1`,
    {
      agent: rec,
      persistLogs: false,
      onTokenUsage: (u) => usageEvents.push({ total: u.total }),
    },
  );
  assert.equal(usageEvents.length, 1, "one final usage event");
  assert.equal(usageEvents[0].total, 60, "two agents × 30 tokens each");
});

test("agent() with timeout should handle gracefully (timeout returns null)", async () => {
  const slow = {
    async run() {
      await new Promise((r) => setTimeout(r, 50));
      return "slow";
    },
  };
  let errorMessage = "";
  const result = await runWorkflow<unknown>(
    `export const meta = { name: 'test', description: 't' }
     let val = null
     try { val = await agent('slow', { label: 's', timeoutMs: 5 }) } catch (e) { val = 'error:' + (e && e.message || e) }
     return { val }`,
    {
      agent: slow,
      persistLogs: false,
      onAgentEnd: (event) => {
        if (event.error) errorMessage = event.error;
      },
    },
  );
  const r = result.result as { val: unknown };
  // agent() catches timeout internally (recoverable) and returns null
  assert.equal(r.val, null, "timeout agent should return null (recoverable)");
  assert.match(errorMessage, /timed out after 5ms/);
  assert.match(errorMessage, /raise or omit timeoutMs\/agentTimeoutMs/);
});

test("agent() default timeout is unbounded", async () => {
  const slow = {
    async run() {
      await new Promise((r) => setTimeout(r, 25));
      return "slow";
    },
  };
  const result = await runWorkflow<{ val: string }>(
    `export const meta = { name: 'test', description: 't' }
     const val = await agent('slow', { label: 's' })
     return { val }`,
    { agent: slow, persistLogs: false },
  );

  assert.equal(result.result.val, "slow");
});

test("agent() timeoutMs null overrides a run-level timeout", async () => {
  const slow = {
    async run() {
      await new Promise((r) => setTimeout(r, 25));
      return "slow";
    },
  };
  const result = await runWorkflow<{ val: string }>(
    `export const meta = { name: 'test', description: 't' }
     const val = await agent('slow', { label: 's', timeoutMs: null })
     return { val }`,
    { agent: slow, agentTimeoutMs: 5, persistLogs: false },
  );

  assert.equal(result.result.val, "slow");
});

test("agent() with parallel invokes all agents", async () => {
  const rec = new CallRecordingAgent();
  await runWorkflow(
    `export const meta = { name: 'test', description: 't' }
     const rs = await parallel(['a','b','c'].map(p => () => agent(p, { label: p })))
     return rs`,
    { agent: rec, persistLogs: false },
  );
  assert.equal(rec.calls.length, 3);
  const prompts = rec.calls.map((c) => c.prompt).sort();
  assert.deepEqual(prompts, ["a", "b", "c"]);
});

test("agent() with pipeline invokes agent per stage per item", async () => {
  const rec = new CallRecordingAgent();
  await runWorkflow(
    `export const meta = { name: 'test', description: 't' }
     const rs = await pipeline(['x','y'],
       item => agent('stage1 ' + item, { label: 's1-' + item }),
       result => agent('stage2 ' + result, { label: 's2-' + result }),
     )
     return rs`,
    { agent: rec, persistLogs: false },
  );
  assert.equal(rec.calls.length, 4); // 2 items × 2 stages
});

test("agent() monitors agent count and calls onAgentStart/End for each", async () => {
  const rec = new CallRecordingAgent();
  const counts: number[] = [];
  await runWorkflow(
    `export const meta = { name: 'test', description: 't' }
     await agent('a', { label: 'a' })
     await agent('b', { label: 'b' })
     return 1`,
    {
      agent: rec,
      persistLogs: false,
      onAgentStart: () => {},
      onAgentEnd: (e) => counts.push(e.tokens ?? 0),
    },
  );
  assert.equal(counts.length, 2);
  assert.ok(counts[0] > 0, "first agent tokens");
  assert.ok(counts[1] > 0, "second agent tokens");
});
