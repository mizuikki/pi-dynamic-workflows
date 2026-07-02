import assert from "node:assert/strict";
import test from "node:test";
import { registerBuiltinWorkflows } from "../src/builtin-commands.js";
import { makeCommandRegistryPi, makeNotifyCtx } from "./helpers/mock-pi.js";

test("registerBuiltinWorkflows registers deep-research and adversarial-review commands", () => {
  const { pi, commands } = makeCommandRegistryPi();
  registerBuiltinWorkflows(pi, { cwd: "/tmp" });
  assert.equal(commands.length, 2);
  const names = commands.map((c) => c.name).sort();
  assert.deepEqual(names, ["adversarial-review", "deep-research"]);
});

test("registerBuiltinWorkflows is idempotent — skips already registered commands", () => {
  const { pi, commands } = makeCommandRegistryPi(["deep-research", "adversarial-review"]);
  registerBuiltinWorkflows(pi, { cwd: "/tmp" });
  assert.equal(commands.length, 0, "should not re-register when already present");
});

test("registerBuiltinWorkflows registers only missing commands", () => {
  const { pi, commands } = makeCommandRegistryPi(["deep-research"]);
  registerBuiltinWorkflows(pi, { cwd: "/tmp" });
  assert.deepEqual(
    commands.map((c) => c.name),
    ["adversarial-review"],
    "should only register the missing command",
  );
});

test("registerBuiltinWorkflows deep-research handler validates empty args (returns early)", async () => {
  const { pi, commands } = makeCommandRegistryPi();
  registerBuiltinWorkflows(pi, { cwd: "/tmp" });
  const deepResearchHandler = commands.find((c) => c.name === "deep-research")?.handler;
  assert.ok(deepResearchHandler, "deep-research handler should exist");

  // Calling with empty args should warn and return early (before running any workflow)
  const { ctx, notified } = makeNotifyCtx();
  await deepResearchHandler("", ctx);
  assert.equal(notified.length, 1, "should notify with warning");
  assert.equal(notified[0].type, "warning", "should be a warning");
  assert.ok(notified[0].message.includes("Usage"), "should tell the user how to use it");
});

test("registerBuiltinWorkflows adversarial-review handler validates empty args (returns early)", async () => {
  const { pi, commands } = makeCommandRegistryPi();
  registerBuiltinWorkflows(pi, { cwd: "/tmp" });
  const advHandler = commands.find((c) => c.name === "adversarial-review")?.handler;
  assert.ok(advHandler, "adversarial-review handler should exist");

  const { ctx, notified } = makeNotifyCtx();
  await advHandler("", ctx);
  assert.equal(notified.length, 1, "should notify with warning");
  assert.equal(notified[0].type, "warning", "should be a warning");
  assert.ok(notified[0].message.includes("Usage"), "should tell the user how to use it");
});

test("registerBuiltinWorkflows creates handlers with expected structure", () => {
  const { pi, commands } = makeCommandRegistryPi();
  registerBuiltinWorkflows(pi, { cwd: "/tmp" });

  const deepResearchCmd = commands.find((c) => c.name === "deep-research");
  assert.ok(deepResearchCmd, "deep-research should be registered");
  assert.ok(deepResearchCmd.description?.includes("Research"), "should have research description");
  assert.equal(typeof deepResearchCmd.handler, "function");

  const advReviewCmd = commands.find((c) => c.name === "adversarial-review");
  assert.ok(advReviewCmd, "adversarial-review should be registered");
  assert.ok(
    advReviewCmd.description?.includes("Investigate") || advReviewCmd.description?.includes("Review"),
    "should contain Investigate",
  );
  assert.equal(typeof advReviewCmd.handler, "function");
});

test("registerBuiltinWorkflows syncs the live session model into manager-backed runs", async () => {
  const commands: Array<{ name: string; handler: (args: string, ctx: unknown) => Promise<void> }> = [];
  const sent: Array<{ customType?: string; content?: string }> = [];
  const managerCalls: Array<[string, unknown]> = [];
  let runOptions: { tools?: unknown[]; onPhase?: (title: string) => void } | undefined;

  const pi = {
    getCommands: () => [],
    registerCommand: (name: string, spec: { handler: (args: string, ctx: unknown) => Promise<void> }) => {
      commands.push({ name, handler: spec.handler });
    },
    sendMessage: async (message: { customType?: string; content?: string }) => {
      sent.push(message);
    },
    getThinkingLevel: () => "high",
  };

  const manager = {
    setSessionOptions: (options: unknown) => managerCalls.push(["session", options]),
    setMainModel: (model: unknown) => managerCalls.push(["mainModel", model]),
    setThinkingLevel: (level: unknown) => managerCalls.push(["thinking", level]),
    setSessionId: (sessionId: unknown) => managerCalls.push(["sessionId", sessionId]),
    runSync: async (
      _script: string,
      _args: unknown,
      options: { tools?: unknown[]; onPhase?: (title: string) => void },
    ) => {
      runOptions = options;
      options.onPhase?.("Research");
      return {
        meta: { name: "deep_research", description: "d" },
        result: { report: "manager result" },
        logs: [],
        phases: ["Research"],
        agentCount: 1,
        durationMs: 1,
      };
    },
  };

  registerBuiltinWorkflows(pi as never, { cwd: "/tmp", manager: manager as never });
  const deepResearchHandler = commands.find((command) => command.name === "deep-research")?.handler;
  assert.ok(deepResearchHandler, "deep-research handler should exist");

  const ctx = {
    modelRegistry: { getAvailable: async () => [] },
    model: { provider: "explicit-faux", id: "selected-model" },
    sessionManager: { getSessionId: () => "session-123" },
    ui: {
      notify: () => {},
      setStatus: () => {},
    },
  };

  await deepResearchHandler("trace auth flows", ctx as never);

  assert.deepEqual(managerCalls, [
    ["session", { modelRegistry: ctx.modelRegistry, model: ctx.model }],
    ["mainModel", "explicit-faux/selected-model"],
    ["thinking", "high"],
    ["sessionId", "session-123"],
  ]);
  assert.ok((runOptions?.tools?.length ?? 0) > 0, "deep-research should pass workflow tools to manager.runSync");
  assert.equal(sent[0]?.customType, "deep-research");
  assert.equal(sent[0]?.content, "manager result");
});
