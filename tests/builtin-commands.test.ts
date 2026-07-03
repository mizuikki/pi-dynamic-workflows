import assert from "node:assert/strict";
import test from "node:test";
import { registerBuiltinWorkflows, tokenizeArgs } from "../src/builtin-commands.js";
import { makeCommandRegistryPi, makeNotifyCtx } from "./helpers/mock-pi.js";

test("registerBuiltinWorkflows registers all four built-in workflow commands", () => {
  const { pi, commands } = makeCommandRegistryPi();
  registerBuiltinWorkflows(pi, { cwd: "/tmp" });
  assert.equal(commands.length, 4);
  const names = commands.map((c) => c.name).sort();
  assert.deepEqual(names, ["adversarial-review", "codebase-audit", "deep-research", "multi-perspective"]);
});

test("registerBuiltinWorkflows is idempotent — skips already registered commands", () => {
  const { pi, commands } = makeCommandRegistryPi([
    "deep-research",
    "adversarial-review",
    "multi-perspective",
    "codebase-audit",
  ]);
  registerBuiltinWorkflows(pi, { cwd: "/tmp" });
  assert.equal(commands.length, 0, "should not re-register when already present");
});

test("registerBuiltinWorkflows registers only missing commands", () => {
  const { pi, commands } = makeCommandRegistryPi(["deep-research", "adversarial-review"]);
  registerBuiltinWorkflows(pi, { cwd: "/tmp" });
  assert.deepEqual(
    commands.map((c) => c.name).sort(),
    ["codebase-audit", "multi-perspective"],
    "should only register the commands that aren't already present",
  );
});

test("tokenizeArgs handles quoted and unquoted tokens", () => {
  assert.deepEqual(tokenizeArgs('topic "two words" plain'), ["topic", "two words", "plain"]);
});

test("tokenizeArgs preserves empty quoted tokens", () => {
  assert.deepEqual(tokenizeArgs("cmd \"\" '' tail"), ["cmd", "", "", "tail"]);
});

test("tokenizeArgs handles adjacent quoted tokens independently", () => {
  assert.deepEqual(tokenizeArgs('"first""second" plain'), ["first", "second", "plain"]);
});

test("tokenizeArgs treats unmatched quotes as ordinary non-space tokens", () => {
  assert.deepEqual(tokenizeArgs('"unterminated topic'), ['"unterminated', "topic"]);
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

test("registerBuiltinWorkflows multi-perspective handler validates empty args (returns early)", async () => {
  const { pi, commands } = makeCommandRegistryPi();
  registerBuiltinWorkflows(pi, { cwd: "/tmp" });
  const handler = commands.find((c) => c.name === "multi-perspective")?.handler;
  assert.ok(handler, "multi-perspective handler should exist");

  const { ctx, notified } = makeNotifyCtx();
  await handler("", ctx);
  assert.equal(notified.length, 1, "should notify with warning");
  assert.equal(notified[0].type, "warning", "should be a warning");
  assert.ok(notified[0].message.includes("Usage"), "should tell the user how to use it");
});

test("registerBuiltinWorkflows codebase-audit handler validates missing checks (returns early)", async () => {
  const { pi, commands } = makeCommandRegistryPi();
  registerBuiltinWorkflows(pi, { cwd: "/tmp" });
  const handler = commands.find((c) => c.name === "codebase-audit")?.handler;
  assert.ok(handler, "codebase-audit handler should exist");

  const { ctx, notified } = makeNotifyCtx();
  // scope but no checks → should warn and return early
  await handler("src/", ctx);
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

function makeManagerBackedCommandHarness() {
  const commands: Array<{ name: string; handler: (args: string, ctx: unknown) => Promise<void> }> = [];
  const notified: Array<{ message: string; type?: string }> = [];
  let capturedScript = "";

  const pi = {
    getCommands: () => [],
    registerCommand: (name: string, spec: { handler: (args: string, ctx: unknown) => Promise<void> }) => {
      commands.push({ name, handler: spec.handler });
    },
    sendMessage: async () => {},
    getThinkingLevel: () => undefined,
  };
  const manager = {
    setSessionOptions: () => {},
    setModelRegistry: () => {},
    setMainModel: () => {},
    setThinkingLevel: () => {},
    setSessionId: () => {},
    runSync: async (script: string) => {
      capturedScript = script;
      return {
        meta: { name: "builtin", description: "d" },
        result: { synthesis: "ok", report: "ok" },
        logs: [],
        phases: [],
        agentCount: 1,
        durationMs: 1,
      };
    },
  };
  const ctx = {
    modelRegistry: { getAvailable: async () => [] },
    sessionManager: { getSessionId: () => "session-123" },
    ui: {
      notify: (message: string, type?: string) => notified.push({ message, type }),
      setStatus: () => {},
    },
  };

  registerBuiltinWorkflows(pi as never, { cwd: "/tmp", manager: manager as never });
  return { commands, ctx, notified, getScript: () => capturedScript };
}

test("multi-perspective caps user-supplied perspectives", async () => {
  const { commands, ctx, notified, getScript } = makeManagerBackedCommandHarness();
  const handler = commands.find((command) => command.name === "multi-perspective")?.handler;
  assert.ok(handler, "multi-perspective handler should exist");

  const perspectives = Array.from({ length: 12 }, (_, i) => `angle-${i + 1}`).join(" ");
  await handler(`"topic" ${perspectives}`, ctx as never);

  assert.ok(notified.some((n) => n.type === "warning" && n.message.includes("first 10 perspectives")));
  assert.ok(getScript().includes("angle-10"));
  assert.ok(!getScript().includes("angle-11"));
});

test("codebase-audit caps user-supplied checks", async () => {
  const { commands, ctx, notified, getScript } = makeManagerBackedCommandHarness();
  const handler = commands.find((command) => command.name === "codebase-audit")?.handler;
  assert.ok(handler, "codebase-audit handler should exist");

  const checks = Array.from({ length: 12 }, (_, i) => `check-${i + 1}`).join(" ");
  await handler(`src ${checks}`, ctx as never);

  assert.ok(notified.some((n) => n.type === "warning" && n.message.includes("first 10 checks")));
  assert.ok(getScript().includes("check-10"));
  assert.ok(!getScript().includes("check-11"));
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
    setModelRegistry: (registry: unknown) => managerCalls.push(["registry", registry]),
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
    ["registry", ctx.modelRegistry],
    ["mainModel", "explicit-faux/selected-model"],
    ["thinking", "high"],
    ["sessionId", "session-123"],
  ]);
  assert.ok((runOptions?.tools?.length ?? 0) > 0, "deep-research should pass workflow tools to manager.runSync");
  assert.equal(sent[0]?.customType, "deep-research");
  assert.equal(sent[0]?.content, "manager result");
});
