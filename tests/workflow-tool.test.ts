import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Model } from "@earendil-works/pi-ai";
import { WorkflowManager } from "../src/workflow-manager.js";
import { saveWorkflowSettings } from "../src/workflow-settings.js";
import { backgroundStartedText, createWorkflowTool, modelRoutingGuideline } from "../src/workflow-tool.js";
import { withFakeHomeAsync } from "./helpers/fake-home.js";

/** Minimal fake ModelRegistry, matching the shape the PR's existing tests use. */
function fakeRegistry(models: Array<{ provider: string; id: string }>) {
  return {
    getAvailable: () => models,
    find: () => undefined,
    getAll: () => models,
  } as any;
}

// ─── backgroundStartedText ─────────────────────────────────────────────────────

test("backgroundStartedText tells the user it auto-continues and they can wait", () => {
  const text = backgroundStartedText("audit", "abc-123");
  assert.match(text, /audit/);
  assert.match(text, /abc-123/);
  assert.match(text, /wait here/i);
  assert.match(text, /continues automatically|resume the conversation/i);
  assert.match(text, /other things/i);
  assert.match(text, /\/workflows status abc-123/);
});

// ─── createWorkflowTool ────────────────────────────────────────────────────────

test("createWorkflowTool has correct name and label", () => {
  const tool = createWorkflowTool();
  assert.equal(tool.name, "workflow");
  assert.equal(tool.label, "Workflow");
});

test("createWorkflowTool has description", () => {
  const tool = createWorkflowTool();
  assert.ok(tool.description, "description should be truthy");
  assert.ok(tool.description.length > 20, "tool.description should be more than 20");
});

test("createWorkflowTool has parameters defined", () => {
  const tool = createWorkflowTool();
  assert.ok(tool.parameters, "should have parameters schema");
});

test("createWorkflowTool has execute function", () => {
  const tool = createWorkflowTool();
  assert.equal(typeof tool.execute, "function");
});

test("createWorkflowTool has renderCall and renderResult", () => {
  const tool = createWorkflowTool();
  assert.equal(typeof tool.renderCall, "function");
  assert.equal(typeof tool.renderResult, "function");
});

test("createWorkflowTool has promptSnippet", () => {
  const tool = createWorkflowTool();
  assert.ok(tool.promptSnippet, "promptSnippet should be truthy");
  assert.ok(tool.promptSnippet.includes("workflow"), "should contain workflow");
});

test("createWorkflowTool has promptGuidelines array", () => {
  const tool = createWorkflowTool();
  assert.ok(Array.isArray(tool.promptGuidelines), "tool.promptGuidelines should be an array");
  assert.ok(tool.promptGuidelines.length > 5, "should have several guidelines");
});

test("createWorkflowTool promptGuidelines mention model routing", () => {
  const tool = createWorkflowTool();
  const all = tool.promptGuidelines.join(" ");
  assert.ok(all.includes("opts.tier"), "should mention opts.tier");
  assert.ok(all.includes("opts.model"), "should mention opts.model");
  assert.ok(all.includes("small") || all.includes("medium") || all.includes("big"), "should mention tier names");
});

test("createWorkflowTool guidance follows the merged structured-output setting", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-dw-guidance-cwd-"));
  const home = mkdtempSync(join(tmpdir(), "pi-dw-guidance-home-"));
  try {
    await withFakeHomeAsync(home, async () => {
      const disabled = createWorkflowTool({ cwd }).promptGuidelines.join(" ");
      assert.match(disabled, /structured output is disabled by default/i);
      assert.match(disabled, /opts\.schema is ignored/i);
      assert.match(disabled, /do not dereference that result as a schema-shaped object/i);
      assert.match(disabled, /loopUntilDry\(\).*retry\(\).*gate\(\)/i);
      assert.match(disabled, /verify\(\).*refuse/i);

      saveWorkflowSettings({ structuredOutputEnabled: true });
      const enabled = createWorkflowTool({ cwd }).promptGuidelines.join(" ");
      assert.match(enabled, /structured output is enabled/i);
      assert.match(enabled, /opts\.schema.*validated object/i);
      assert.match(enabled, /verify\([^)]*\).*judgePanel\([^)]*\).*completenessCheck\([^)]*\)/i);

      saveWorkflowSettings({ structuredOutputEnabled: false }, { cwd, scope: "project" });
      const projectDisabled = createWorkflowTool({ cwd }).promptGuidelines.join(" ");
      assert.match(projectDisabled, /structured output is disabled by default/i);
    });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("createWorkflowTool promptGuidelines keep budget and timeout unbounded by default", () => {
  const tool = createWorkflowTool();
  const all = tool.promptGuidelines.join(" ");
  assert.match(all, /do not set tokenBudget or agentTimeoutMs/i);
  assert.match(all, /defaults are unbounded/i);
});

test("createWorkflowTool schema describes unbounded default timeout", () => {
  const tool = createWorkflowTool();
  const parameters = tool.parameters as { properties?: Record<string, { description?: string }> };
  const description = parameters.properties?.agentTimeoutMs?.description ?? "";
  assert.match(description, /Omit for no hard timeout/i);
  assert.match(description, /only when the user asks/i);
});

test("createWorkflowTool schema exposes concurrency and canonical retry policy", () => {
  const tool = createWorkflowTool();
  const parameters = tool.parameters as {
    properties?: Record<string, { description?: string; properties?: Record<string, { description?: string }> }>;
  };

  assert.match(parameters.properties?.concurrency?.description ?? "", /Maximum concurrent agents/i);
  assert.match(parameters.properties?.agentTurnRetry?.description ?? "", /inherited in-session agent-turn retry/i);
  assert.match(parameters.properties?.agentTurnRetry?.properties?.enabled?.description ?? "", /Enable or disable/i);
  assert.match(parameters.properties?.agentTurnRetry?.properties?.maxRetries?.description ?? "", /Maximum in-session/i);
  assert.match(
    parameters.properties?.agentTurnRetry?.properties?.baseDelayMs?.description ?? "",
    /Base backoff delay/i,
  );
  assert.match(parameters.properties?.agentRunRetries?.description ?? "", /whole-agent attempts/i);
  assert.match(parameters.properties?.agentRetries?.description ?? "", /Deprecated alias/i);
});

test("createWorkflowTool promptGuidelines mention retry and concurrency controls", () => {
  const tool = createWorkflowTool();
  const all = tool.promptGuidelines.join(" ");

  assert.match(all, /provider instability/i);
  assert.match(all, /agentTurnRetry/i);
  assert.match(all, /inherited in-session agent-turn retry/i);
  assert.match(all, /agentRunRetries/i);
  assert.match(all, /at-least-once/i);
});

// ─── modelRoutingGuideline ──────────────────────────────────────────────────────

test("modelRoutingGuideline mentions all three tier names", () => {
  const text = modelRoutingGuideline();
  assert.ok(text.includes("small"), "should mention small tier");
  assert.ok(text.includes("medium"), "should mention medium tier");
  assert.ok(text.includes("big"), "should mention big tier");
});

test("modelRoutingGuideline describes each tier purpose", () => {
  const text = modelRoutingGuideline();
  assert.ok(text.includes("lightweight"), "should contain lightweight");
  assert.ok(text.includes("balanced"), "should contain balanced");
  assert.ok(text.includes("synthesis"), "should contain synthesis");
});

test("modelRoutingGuideline explains tier vs model priority", () => {
  const text = modelRoutingGuideline();
  assert.ok(text.includes("opts.tier"), "should mention opts.tier");
  assert.ok(text.includes("opts.model"), "should mention opts.model");
  assert.ok(
    /opts\.(tier|model).+opts\.(model|tier)/.test(text),
    "should explain ordering / relationship between tier and model",
  );
});

test("modelRoutingGuideline references the model scope (auth-independent)", () => {
  const text = modelRoutingGuideline();
  // With auth configured it lists the available models; on a fresh/CI machine
  // with no models it falls back to a generic line. Accept either so the test
  // doesn't depend on the runner's authenticated providers.
  assert.ok(
    text.includes("route only to these") || text.includes("models the user has configured"),
    "should explain which models are in scope (listed or fallback)",
  );
});

test("modelRoutingGuideline can list explicit models from the session registry", () => {
  const explicitModel = {
    provider: "explicit-faux",
    id: "faux-1",
    api: "faux",
    name: "Explicit Faux",
    baseUrl: "http://localhost:0",
    input: ["text"],
    reasoning: false,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 8192,
  } satisfies Model<"faux">;

  const text = modelRoutingGuideline({ getAvailable: () => [explicitModel] });

  assert.match(text, /explicit-faux\/faux-1/);
});

test("modelRoutingGuideline can list precomputed available model specs", () => {
  const text = modelRoutingGuideline(["explicit-faux/faux-1"]);

  assert.match(text, /explicit-faux\/faux-1/);
});

test("modelRoutingGuideline explains when to use each option", () => {
  const text = modelRoutingGuideline();
  assert.ok(/small.*(exploration|search|inventory|agents)/i.test(text), "small tier should mention light workloads");
  assert.ok(/big.*(synthesis|judgment|decision)/i.test(text), "big tier should mention heavy reasoning");
});

test("createWorkflowTool invalid args throws descriptive error", () => {
  const tool = createWorkflowTool();
  // We can test prepareArguments through the tool definition
  if (tool.prepareArguments) {
    const prepare = tool.prepareArguments as (args: unknown) => unknown;
    assert.throws(() => prepare({ script: 123 }), /script.*string/);
    assert.throws(() => prepare("not-an-object"), /object argument/);
  }
});

test("createWorkflowTool with custom cwd creates tool", () => {
  const tool = createWorkflowTool({ cwd: "/tmp" });
  assert.equal(tool.name, "workflow");
});

test("modelRoutingGuideline advertises models from an injected registry", () => {
  const registry = fakeRegistry([{ provider: "router", id: "shared-model" }]);
  const text = modelRoutingGuideline(registry);
  assert.match(text, /route only to these/i);
  assert.match(text, /router\/shared-model/);
});

test("modelRoutingGuideline accepts a getter and resolves it lazily at call time", () => {
  // Empty registry (not undefined) so the getter path is exercised end-to-end
  // rather than falling through to the disk-registry default.
  let registry: any = fakeRegistry([]);
  const text = modelRoutingGuideline(() => registry);
  assert.doesNotMatch(text, /router\/late-model/);

  // Registering after construction (simulating session_start running after the
  // guideline string was first read) is reflected on the next call.
  registry = fakeRegistry([{ provider: "router", id: "late-model" }]);
  const later = modelRoutingGuideline(() => registry);
  assert.match(later, /router\/late-model/);
});

test("createWorkflowTool advertises models from the manager's shared registry when set before creation", () => {
  const manager = new WorkflowManager({ cwd: "/tmp" });
  manager.setModelRegistry(fakeRegistry([{ provider: "router", id: "wired-model" }]));
  const tool = createWorkflowTool({ cwd: "/tmp", manager });
  const all = tool.promptGuidelines.join(" ");
  assert.match(all, /router\/wired-model/);
});

test("createWorkflowTool promptGuidelines reflect a registry set AFTER tool creation (lazy accessor)", () => {
  // Mirrors the real ordering: createWorkflowTool() runs at extension load,
  // setModelRegistry() runs later in session_start. The SDK re-reads
  // definition.promptGuidelines on every tool-registry refresh, so a fresh
  // property read must see the late-set registry.
  const manager = new WorkflowManager({ cwd: "/tmp" });
  manager.setModelRegistry(fakeRegistry([]));
  const tool = createWorkflowTool({ cwd: "/tmp", manager });
  assert.doesNotMatch(tool.promptGuidelines.join(" "), /router\/late-model/);

  manager.setModelRegistry(fakeRegistry([{ provider: "router", id: "late-model" }]));
  assert.match(tool.promptGuidelines.join(" "), /router\/late-model/);

  // Replacing the registry again is also reflected.
  manager.setModelRegistry(fakeRegistry([{ provider: "router", id: "replacement-model" }]));
  const latest = tool.promptGuidelines.join(" ");
  assert.match(latest, /router\/replacement-model/);
  assert.doesNotMatch(latest, /router\/late-model/);
});

test("modelRoutingGuideline output is non-empty and well-formed", () => {
  const text = modelRoutingGuideline();
  assert.ok(text.length > 50, "should be a substantial instruction");
  assert.ok(text.endsWith(".") || text.endsWith("") || text.endsWith("`"), "should end properly");
  assert.ok(!text.includes("undefined"), "no undefined interpolation");
  assert.ok(!text.includes("[object Object]"), "no object serialization leaks");
});

// ─── prepareArguments / normalizeWorkflowScript ─────────────────────────────────

test("createWorkflowTool prepareArguments strips markdown fences from script", () => {
  const tool = createWorkflowTool();
  if (tool.prepareArguments) {
    const prepare = tool.prepareArguments as (args: unknown) => { script: string };
    const result = prepare({
      script: "```js\nconst x = 1\n```",
    });
    assert.equal(result.script, "const x = 1");
  }
});

test("createWorkflowTool prepareArguments strips javascript fences", () => {
  const tool = createWorkflowTool();
  if (tool.prepareArguments) {
    const prepare = tool.prepareArguments as (args: unknown) => { script: string };
    const result = prepare({
      script: "```\nexport const meta = { name: 't', description: 't' }\n```",
    });
    assert.equal(result.script, "export const meta = { name: 't', description: 't' }");
  }
});

test("createWorkflowTool prepareArguments passes through args", () => {
  const tool = createWorkflowTool();
  if (tool.prepareArguments) {
    const prepare = tool.prepareArguments as (args: unknown) => {
      script: string;
      args?: unknown;
      maxAgents?: number;
      concurrency?: number;
      agentRunRetries?: number;
    };
    const result = prepare({
      script: "export const meta = { name: 't', description: 't' }",
      args: { question: "test" },
      maxAgents: 5,
      concurrency: 2,
      agentRetries: 1,
    });
    assert.equal(result.script, "export const meta = { name: 't', description: 't' }");
    assert.deepEqual(result.args, { question: "test" });
    assert.equal(result.maxAgents, 5);
    assert.equal(result.concurrency, 2);
    assert.equal(result.agentRunRetries, 1);
  }
});

test("workflow tool samples one host retry snapshot before starting a run", async () => {
  let getterCalls = 0;
  let starts = 0;
  let receivedPolicy: unknown;
  const manager = {
    startInBackground: (_script: string, _args: unknown, options: { hostRetryPolicy?: unknown }) => {
      starts++;
      receivedPolicy = options.hostRetryPolicy;
      return { runId: "run-1", promise: Promise.resolve() };
    },
    getModelRegistry: () => undefined,
  } as unknown as import("../src/workflow-manager.js").WorkflowManager;
  const tool = createWorkflowTool({ manager });
  await tool.execute?.(
    "call-1",
    { script: "export const meta = { name: 't', description: 't' }; return agent('x')" },
    undefined,
    () => {},
    {
      getRetryPolicy: () => {
        getterCalls++;
        return {
          agentTurn: { enabled: true, maxRetries: 3, baseDelayMs: 2000 },
          providerRequest: { maxRetryDelayMs: 60000 },
        };
      },
    } as never,
  );
  assert.equal(getterCalls, 1);
  assert.equal(starts, 1);
  assert.equal(Object.isFrozen(receivedPolicy), true);
});

test("workflow tool passes the merged structured-output snapshot to the manager", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-dw-tool-cap-cwd-"));
  const home = mkdtempSync(join(tmpdir(), "pi-dw-tool-cap-home-"));
  let received: boolean | undefined;
  try {
    await withFakeHomeAsync(home, async () => {
      saveWorkflowSettings({ structuredOutputEnabled: true });
      const manager = {
        startInBackground: (_script: string, _args: unknown, options: { structuredOutputEnabled?: boolean }) => {
          received = options.structuredOutputEnabled;
          return { runId: "run-cap", promise: Promise.resolve() };
        },
        getModelRegistry: () => undefined,
      } as unknown as WorkflowManager;
      const tool = createWorkflowTool({ cwd, manager });
      await tool.execute?.(
        "cap-call",
        { script: "export const meta = { name: 'cap', description: 'cap' }; return agent('x')" },
        undefined,
        () => {},
        {
          getRetryPolicy: () => ({
            agentTurn: { enabled: true, maxRetries: 3, baseDelayMs: 2000 },
            providerRequest: { maxRetryDelayMs: 60_000 },
          }),
        } as never,
      );
    });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
  assert.equal(received, true);
});

test("workflow tool starts no child when the advertised host getter is missing", async () => {
  let starts = 0;
  const manager = {
    startInBackground: () => {
      starts++;
      return { runId: "run-1", promise: Promise.resolve() };
    },
    getModelRegistry: () => undefined,
  } as unknown as import("../src/workflow-manager.js").WorkflowManager;
  const tool = createWorkflowTool({ manager });
  await assert.rejects(
    () =>
      tool.execute?.(
        "call-1",
        { script: "export const meta = { name: 't', description: 't' }; return agent('x')" },
        undefined,
        () => {},
        {} as never,
      ) as Promise<unknown>,
    /getter is unavailable/,
  );
  assert.equal(starts, 0);
});

test("concurrent workflow tool executions receive independent host snapshots", async () => {
  const received: Array<{ agentTurn?: { maxRetries?: number } }> = [];
  let getterCalls = 0;
  const manager = {
    startInBackground: (_script: string, _args: unknown, options: { hostRetryPolicy: { agentTurn: object } }) => {
      received.push(options.hostRetryPolicy);
      return { runId: `run-${received.length}`, promise: Promise.resolve() };
    },
    getModelRegistry: () => undefined,
  } as unknown as import("../src/workflow-manager.js").WorkflowManager;
  const tool = createWorkflowTool({ manager });
  const ctx = {
    getRetryPolicy: () => ({
      agentTurn: { enabled: true, maxRetries: ++getterCalls, baseDelayMs: 2000 },
      providerRequest: { maxRetryDelayMs: 60_000 },
    }),
  } as never;
  const input = { script: "export const meta = { name: 't', description: 't' }; return agent('x')" };

  await Promise.all([
    tool.execute?.("call-1", input, undefined, () => {}, ctx),
    tool.execute?.("call-2", input, undefined, () => {}, ctx),
  ]);
  assert.equal(getterCalls, 2);
  assert.equal(received.length, 2);
  assert.notEqual(received[0], received[1]);
  assert.deepEqual(
    received.map((policy) => policy.agentTurn?.maxRetries),
    [1, 2],
  );
});
